"""Shift assignment with OR-Tools CP-SAT.

The gateway has already turned availability, time off, eligibility and shift-template rules into a list of candidate
shifts (employee x day x template x start). This module chooses which candidates to work so that coverage follows the
forecast's staffing requirement, while every hard rule (one shift a day, rest between shifts, weekly maximum, days in a
row, days per week) always holds. Coverage, contract hours, preferences and weekend fairness are weighed in the objective.
"""
import json
import os
import pickle
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict

from ortools.sat.python import cp_model

import backends
import wfm_pb2

SPD = 96  # 15-minute slots per day


MAX_OPTIONS = 300_000


def workers_for(n_options, asked=8, share=1):
    """Every solver worker holds its own copy of the model, so memory grows with workers times candidate shifts. Past about 70,000 candidates eight workers can
    exhaust a normal machine and the whole engine process aborts: use fewer workers for a bigger problem instead."""
    cap = 8 if n_options <= 70_000 else 4 if n_options <= 130_000 else 2 if n_options <= 200_000 else 1
    # more search threads than the machine has cores only slows every solve down (and two solves at once then fight for the same cores)
    cores = max(1, int(os.environ.get("ENGINE_SOLVER_THREADS", "0")) or (os.cpu_count() or 4))
    cap = min(cap, max(1, cores // max(1, share)))     # `share` solves running at once split the cores between them
    return max(1, min(asked or 8, cap))


def free_memory_mb():
    """Memory the machine can still give out, in MB, or None when this system does not say."""
    try:
        if sys.platform == "win32":
            import ctypes

            class _Mem(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("totalPage", ctypes.c_ulonglong), ("availPage", ctypes.c_ulonglong), ("totalVirt", ctypes.c_ulonglong), ("availVirt", ctypes.c_ulonglong),
                            ("availExt", ctypes.c_ulonglong)]
            m = _Mem()
            m.length = ctypes.sizeof(_Mem)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return int(m.avail / 1048576)
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except Exception:
        return None
    return None


def total_memory_mb():
    """The memory this process may use, in MB: the container limit when there is one, otherwise the machine's. None when this system does not say."""
    try:
        if sys.platform == "win32":
            import ctypes

            class _Mem(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("totalPage", ctypes.c_ulonglong), ("availPage", ctypes.c_ulonglong), ("totalVirt", ctypes.c_ulonglong), ("availVirt", ctypes.c_ulonglong),
                            ("availExt", ctypes.c_ulonglong)]
            m = _Mem()
            m.length = ctypes.sizeof(_Mem)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return int(m.total / 1048576)
        total = None
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    total = int(line.split()[1]) // 1024
        for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):      # a container limit, when set, is what really applies
            try:
                with open(path) as f:
                    raw = f.read().strip()
                if raw.isdigit() and int(raw) < (1 << 50):
                    total = min(total or 1 << 40, int(raw) // 1048576)
            except OSError:
                pass
        return total
    except Exception:
        return None


def auto_solves(cores=None, ram_mb=None):
    """How many CP-SAT solves may run at the same time on this machine: one for every 4 cores and every 4 GB, at least 2 where there are 6 GB or more, at most 8.
    ENGINE_MAX_SOLVES overrides it. (A large solve takes the whole gate, so this is how many small and medium ones go side by side.)"""
    cores = cores or os.cpu_count() or 4
    ram_mb = ram_mb if ram_mb is not None else total_memory_mb()
    if not ram_mb:
        return 2
    return max(2 if ram_mb >= 6144 else 1, min(8, cores // 4, ram_mb // 4096))


def wait_for_memory(need_mb, give_up_sec=300):
    """A solver process that starts when the machine has no memory left is killed by the system with no message. Wait (up to give_up_sec) until there is room."""
    t0 = time.time()
    while time.time() - t0 < give_up_sec:
        free = free_memory_mb()
        if free is None or free >= need_mb:
            return
        time.sleep(2)


def week_offset(req):
    """How many days of its pay week day 0 already is: 0 when day 0 is the first day of a week. Weeks start on `week_start` (Monday by default)."""
    return (req.first_dow - req.week_start) % 7


def paid(o):
    """Slots that count toward weekly hours: the shift without its unpaid meal."""
    return o.paid_slots or o.length_slots


def week_target(min_week_slots, days_in_period, paid_slots, max_days_week=0, max_week_slots=0):
    """Paid slots a person's contract asks for in one calendar week, when `days_in_period` of its seven days fall inside the schedule.

    A whole week asks for the full contract. A part week asks for the same share of it, rounded down to whole shifts of the person's usual
    length, so a schedule that starts on a Sunday does not push everyone into a one-day week for a few hours, and a six-day week asks for four
    shifts, not five. Never more than the person's own limits allow."""
    if min_week_slots <= 0 or days_in_period <= 0:
        return 0
    if days_in_period >= 7:
        return min_week_slots
    sizes = sorted(p for p in paid_slots if p > 0)
    if not sizes:
        return 0
    typical = sizes[len(sizes) // 2]                               # the usual shift length among this person's options
    shifts = (min_week_slots * days_in_period // 7) // typical      # whole shifts that share of the contract is worth
    if max_days_week > 0:
        shifts = min(shifts, max_days_week, days_in_period)
    if max_week_slots > 0:
        shifts = min(shifts, max_week_slots // typical)
    return shifts * typical


def effective_mode(req, emp):
    """Same start and end every day, for one person: 0 off, 1 prefer, 2 require. The person's own setting wins over the request default."""
    return {1: 0, 2: 1, 3: 2}.get(emp.consist_mode, req.consistency_mode)


def greedy(req, emps, opts, by_ed, required, carry, anchors_out=None):
    """Starting roster by cheapest insertion, in rounds: every person in turn takes the one shift (any day, any length) that most improves the
    objective, until they have their contract shifts or no shift helps. Because each pick looks at all days and counts both shortage and
    surplus, the days balance themselves instead of Monday to Friday filling first. Where one usual start and end is required, a person's first
    shift sets them and every later shift keeps within the tolerance, so the roster obeys that rule too (anchors_out receives each person's anchors)."""
    total = req.days * SPD
    anch = {} if anchors_out is None else anchors_out
    left = list(required) + [0] * max(0, total - len(required))
    chosen = {}                                    # (employee, day) -> option index
    on_day = defaultdict(int)                      # people given a shift that day so far
    wk_slots, wk_days = defaultdict(int), defaultdict(int)
    for e, emp in emps.items():
        wk_slots[(e, 0)], wk_days[(e, 0)] = emp.prior_week_slots, emp.prior_week_days
    carry = carry or {}

    # paid slots each person's contract asks for in each calendar week, the same figure the solver's contract goal uses
    by_week = defaultdict(list)
    for (e, d), idx in by_ed.items():
        by_week[(e, (week_offset(req) + d) // 7)].extend(paid(opts[i]) for i in idx)
    target = {}
    for (e, w), sizes in by_week.items():
        emp = emps[e]
        first = w * 7 - week_offset(req)
        n_days = min(first + 6, req.days - 1) - max(first, 0) + 1
        lead = emp.prior_lead_days if w == 0 else 0
        done = emp.prior_week_slots if w == 0 else 0
        target[(e, w)] = max(0, week_target(emp.min_week_slots, n_days + lead, sizes, emp.max_days_week, emp.max_week_slots) - done)

    def run_through(e, d):
        a = 0
        while (e, d - 1 - a) in chosen:
            a += 1
        if d - 1 - a < 0 and a == d:
            a += carry.get(e, 0)
        b = 0
        while (e, d + 1 + b) in chosen:
            b += 1
        return a + 1 + b

    def allowed(e, emp, d, o):
        wk = (week_offset(req) + d) // 7
        a = anch.get(e)
        if a is not None and effective_mode(req, emp) == 2 and (abs(o.start_slot - a[0]) > req.start_tol_slots or abs(o.start_slot + o.length_slots - a[1]) > req.end_tol_slots):
            return False
        if emp.max_days_week > 0 and wk_days[(e, wk)] >= emp.max_days_week:
            return False
        if emp.max_week_slots > 0 and wk_slots[(e, wk)] + paid(o) > emp.max_week_slots:
            return False
        prev, nxt = chosen.get((e, d - 1)), chosen.get((e, d + 1))
        if prev is not None and (opts[prev].start_slot + opts[prev].length_slots) - SPD > o.start_slot - emp.rest_slots:
            return False
        if nxt is not None and (o.start_slot + o.length_slots) - SPD > opts[nxt].start_slot - emp.rest_slots:
            return False
        if emp.max_consecutive > 0 and run_through(e, d) > emp.max_consecutive:
            return False
        return True

    # When the queues need different skills the shortage is kept per skill as well as in total: a person is judged on the skills they hold (their best one), so people whose skill is
    # short are the ones picked. Without it the roster fills the total from whoever comes first and never uses, say, the Spanish speakers while the Spanish queue is uncovered.
    skill_need = {sk.id: list(sk.required) + [0] * max(0, total - len(sk.required)) for sk in req.skill_requirements}
    lefts = {None: left}
    for k, arr in skill_need.items():
        lefts[k] = arr
    kinds_of = {e: ([k for k in emp.skill_ids if k in skill_need] or [None]) for e, emp in emps.items()}
    poss = {k: [0] * (total + 1) for k in lefts}    # poss[k][s]: how many slots before s are still short (of skill k, or in total for None)
    pos = poss[None]

    def refresh(only=None):
        for k in (list(lefts) if only is None else only):
            L, P = lefts[k], poss[k]
            for s in range(total):
                P[s + 1] = P[s] + (1 if L[s] > 0 else 0)
    refresh()

    order = sorted(emps)
    rounds = max([e.max_days_week for e in emps.values()] + [1])
    for r in range(rounds):
        for e in order[r % max(1, len(order)):] + order[:r % max(1, len(order))]:
            emp = emps[e]
            best, best_gain = None, 0
            for d in range(req.days):
                if (e, d) in chosen:
                    continue
                wk = (week_offset(req) + d) // 7
                want = max(0, target.get((e, wk), 0) - wk_slots[(e, wk)])
                for i in by_ed.get((e, d), []):
                    o = opts[i]
                    base = d * SPD + o.start_slot
                    end = min(base + o.length_slots, total)
                    arrs = [poss[k] for k in kinds_of[e]]
                    g = max(pa[end] - pa[base] for pa in arrs)
                    past = max(0, base + o.length_slots - total)      # time past the end of the period is surplus ...
                    if req.wrap and past:                              # ... unless the period repeats: then it covers the first hours again
                        wend = min(past, total)
                        g = max((pa[end] - pa[base]) + (pa[wend] - pa[0]) for pa in arrs)
                        past = 0
                        end += wend
                    gain = req.w_under * g - req.w_over * ((end - base) - g + past) + req.w_hours * min(paid(o), want) + req.w_pref * o.preference - 0.5 * on_day[d]   # a small push toward the quieter day when two shifts cost about the same
                    if gain > best_gain and allowed(e, emp, d, o):
                        best, best_gain = (d, i), gain
            if best is None:
                continue
            d, i = best
            o = opts[i]
            chosen[(e, d)] = i
            anch.setdefault(e, (o.start_slot, o.start_slot + o.length_slots))
            on_day[d] += 1
            wk = (week_offset(req) + d) // 7
            wk_slots[(e, wk)] += paid(o)
            wk_days[(e, wk)] += 1
            base = d * SPD + o.start_slot
            stop = min(base + o.length_slots, total)
            kk = max(kinds_of[e], key=lambda k: poss[k][stop] - poss[k][base])       # the skill this shift helps most
            touched = [None] if kk is None else [kk, None]
            for k in touched:
                L = lefts[k]
                for s in range(base, stop):
                    L[s] -= 1
                if req.wrap:
                    for s in range(0, min(base + o.length_slots - total, total)):
                        L[s] -= 1
            refresh(touched)
    return set(chosen.values())


def prepare(req, carry=None, weekend_prior=None):
    """What every solver starts from: the people, the candidate shifts that survive what was worked just before day 0, and the need per slot."""
    total = req.days * SPD
    required = list(req.required) + [0] * max(0, total - len(req.required))
    emps = {e.id: e for e in req.employees}
    # what people worked just before day 0 (previous published schedule): days in a row carry over, and a first shift that starts too soon after
    # a shift that ended after midnight is not an option
    carry = dict(carry or {})
    weekend_prior = dict(weekend_prior or {})
    for e in emps.values():
        if e.prior_run:
            carry.setdefault(e.id, e.prior_run)
        if e.prior_weekend:
            weekend_prior.setdefault(e.id, e.prior_weekend)
    opts = [o for o in req.options if not (o.day == 0 and emps[o.employee].prior_has_end and emps[o.employee].prior_end_slot > o.start_slot - emps[o.employee].rest_slots)]
    return emps, opts, required, carry, weekend_prior, total


def solve(req, carry=None, weekend_prior=None, cancel=None):
    """Solve one stretch of days with the first solver in the chain that gives a usable answer (CP-SAT first). carry maps employee -> days already worked
    in a row just before day 0; weekend_prior maps employee -> weekend shifts worked in the windows solved before, so fairness spans the whole plan."""
    t0 = time.time()
    emps, opts, required, carry, weekend_prior, total = prepare(req, carry, weekend_prior)
    helpers = dict(week_offset=week_offset, paid=paid, week_target=week_target, effective_mode=effective_mode)
    by_ed = defaultdict(list)
    for i, o in enumerate(opts):
        by_ed[(o.employee, o.day)].append(i)
    # the greedy roster is the starting point for every solver and the answer of last resort; building it twice is wasteful, so it is built once here
    anchors = {}
    pick = greedy(req, emps, opts, by_ed, required, carry, anchors)
    return backends.run_chain(req, (emps, opts, required, carry, weekend_prior, total, helpers), pick,
                              lambda: solve_cpsat_isolated(req, carry, weekend_prior, cancel, (pick, anchors)), t0, cancel)


# How many CP-SAT solves may run at the same time. Each holds a copy of the model per worker thread, and several large ones together have exhausted
# memory and aborted the process; extra requests wait their turn.
# ortools builds a sum of thousands of variables far faster in one call than by adding them one at a time (the built-in sum): the model took 22 s to build for 70,000 candidate shifts
def _next_solver(prev):
    """A fresh solver with the same settings, for the next search stage. OR-Tools changed what `parameters` is between releases (a protobuf message with CopyFrom up to about
    9.11, its own class with copy_from after), so both are tried, and if neither works the same solver is simply used again: its settings are already right."""
    nxt = cp_model.CpSolver()
    for name in ("copy_from", "CopyFrom"):
        copy = getattr(nxt.parameters, name, None)
        if copy is not None:
            try:
                copy(prev.parameters)
                return nxt
            except Exception:
                break
    return prev


def _clear_hints(model):
    """Remove a model's solution hints (the method is spelled differently in older OR-Tools)."""
    (getattr(model, "clear_hints", None) or model.ClearHints)()


def LSUM(terms):
    return cp_model.LinearExpr.sum(list(terms))


MAX_SOLVES = max(1, int(os.environ.get("ENGINE_MAX_SOLVES") or auto_solves()))


STATS = {"gate_takes": 0, "gate_wait_sec": 0.0, "gate_wait_max_sec": 0.0, "solves_done": 0, "workers_died": 0, "weak_results": 0, "rpcs_active": 0, "rpcs_total": 0}


class _Gate:
    """Counts solver capacity in units. A small solve takes one unit; a large one (its memory grows with candidate shifts times workers) takes the whole gate, so two big
    solves are never in memory together. Waiting solves are served in arrival order."""
    def __init__(self, units):
        self.units, self.free, self.cv, self.queue = units, units, threading.Condition(), []

    def take(self, n):
        n = min(n, self.units)
        t0 = time.time()
        with self.cv:
            me = object()
            self.queue.append(me)
            while self.free < n or self.queue[0] is not me:
                self.cv.wait()
            self.queue.pop(0)
            waited = time.time() - t0
            STATS["gate_takes"] += 1
            STATS["gate_wait_sec"] += waited
            STATS["gate_wait_max_sec"] = max(STATS["gate_wait_max_sec"], waited)
            self.free -= n
            self.cv.notify_all()
        return n

    def give(self, n):
        with self.cv:
            self.free += n
            self.cv.notify_all()


_SOLVE_GATE = _Gate(MAX_SOLVES)


def metrics_text():
    """Prometheus text format: how busy this engine is, for the autoscaler and for anyone watching. Cheap, and safe to call at any time."""
    g = _SOLVE_GATE
    with g.cv:
        waiting, used = len(g.queue), g.units - g.free
    free_mb, total_mb = free_memory_mb(), total_memory_mb()
    rows = [
        ("wfm_engine_solve_slots", "gauge", "Solve slots this engine has", MAX_SOLVES),
        ("wfm_engine_solve_slots_used", "gauge", "Solve slots in use", used),
        ("wfm_engine_solves_waiting", "gauge", "Solves waiting for a slot", waiting),
        ("wfm_engine_solve_wait_seconds_sum", "counter", "Total time solves waited for a slot", round(STATS["gate_wait_sec"], 3)),
        ("wfm_engine_solve_wait_seconds_count", "counter", "Solves that waited for a slot", STATS["gate_takes"]),
        ("wfm_engine_solve_wait_seconds_max", "gauge", "Longest wait for a slot", round(STATS["gate_wait_max_sec"], 3)),
        ("wfm_engine_solves_done_total", "counter", "Solver processes that finished", STATS["solves_done"]),
        ("wfm_engine_solver_process_deaths_total", "counter", "Solver processes that ended without an answer", STATS["workers_died"]),
        ("wfm_engine_weak_results_total", "counter", "Solves that gave back the starting roster only", STATS["weak_results"]),
        ("wfm_engine_rpcs_active", "gauge", "Calls being served", STATS["rpcs_active"]),
        ("wfm_engine_rpcs_total", "counter", "Calls received", STATS["rpcs_total"]),
        ("wfm_engine_warm_workers", "gauge", "Solver processes ready", len(_warm)),
        ("wfm_engine_memory_free_mb", "gauge", "Memory still free", free_mb if free_mb is not None else -1),
        ("wfm_engine_memory_total_mb", "gauge", "Memory this engine may use", total_mb if total_mb is not None else -1),
    ]
    out = []
    for name, kind, helptext, value in rows:
        out += [f"# HELP {name} {helptext}", f"# TYPE {name} {kind}", f"{name} {value}"]
    return "\n".join(out) + "\n"
BIG_SOLVE_OPTIONS = int(os.environ.get("ENGINE_BIG_SOLVE_OPTIONS", "70000"))


WORKER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "solve_worker.py")   # a test points this at a script that dies


def solve_cpsat_isolated(req, carry, weekend_prior, cancel, start):
    """solve_cpsat in a separate process, so a native abort inside the solver library fails this one attempt (the chain then tries the next solver)
    instead of ending the engine. ENGINE_ISOLATE_SOLVES=0 runs it in-process as before."""
    if os.environ.get("ENGINE_ISOLATE_SOLVES", "1") == "0":
        return solve_cpsat(req, carry, weekend_prior, cancel, start)
    units = _SOLVE_GATE.take(MAX_SOLVES if len(req.options) > BIG_SOLVE_OPTIONS else 1)
    try:
        # a big solve takes the whole gate and so the whole machine; small ones run side by side and split the cores
        threads = workers_for(len(req.options), int(req.workers or 8), share=1 if len(req.options) > BIG_SOLVE_OPTIONS else MAX_SOLVES)
        last_error = None
        tries = max(1, int(os.environ.get("ENGINE_WORKER_TRIES", "3")))
        for attempt in range(tries):
            # about 3 MB for each thousand candidate shifts for each search thread, and a little for the process itself
            wait_for_memory(250 + len(req.options) * threads * 0.003)
            req.workers = threads
            try:
                res = _run_worker(req, carry, weekend_prior, cancel, start)
                STATS["solves_done"] += 1
                if res.gap >= 1.0 and res.status == "FEASIBLE":
                    STATS["weak_results"] += 1
                return res
            except _WorkerDied as e:
                STATS["workers_died"] += 1
                last_error = e
                print(f"[engine] solver process died (attempt {attempt + 1} of {tries}, {threads} threads): {e}", flush=True)
                if cancel is not None and cancel.is_set():
                    raise backends.Cancelled()
                threads = max(1, threads // 2)                    # most deaths are the system running out of memory: a smaller try, after a pause for others to finish
                time.sleep(3 + 5 * attempt)
        raise RuntimeError(str(last_error))
    finally:
        _SOLVE_GATE.give(units)


class _WorkerDied(RuntimeError):
    """The solver process ended without writing an answer (killed, or aborted natively)."""


_DEFAULT_WORKER = WORKER_SCRIPT
WARM_SPARE = max(0, int(os.environ.get("ENGINE_WARM_WORKERS") or min(2, MAX_SOLVES)))
_warm, _warm_lock, _warm_dir = [], threading.Lock(), None


def _spawn_warm():
    """Start a solver process that has already loaded its libraries and is waiting for a job."""
    global _warm_dir
    with _warm_lock:
        if _warm_dir is None:
            _warm_dir = tempfile.mkdtemp(prefix="wfm-warm-")
        if len(_warm) >= WARM_SPARE:
            return
        log = os.path.join(_warm_dir, f"warm-{time.time_ns()}.log")
        with open(log, "wb") as lf:
            proc = subprocess.Popen([sys.executable, WORKER_SCRIPT, "--warm"], cwd=os.path.dirname(WORKER_SCRIPT), stdin=subprocess.PIPE, stdout=lf, stderr=subprocess.STDOUT)
        _warm.append((proc, log))


def prewarm():
    """Called when the engine starts, so even the first solve finds a ready process."""
    if WARM_SPARE and WORKER_SCRIPT == _DEFAULT_WORKER and os.environ.get("ENGINE_ISOLATE_SOLVES", "1") != "0":
        threading.Thread(target=_spawn_warm, daemon=True).start()


def _take_warm():
    with _warm_lock:
        while _warm:
            proc, log = _warm.pop(0)
            if proc.poll() is None:
                return proc, log
    return None


def _run_worker(req, carry, weekend_prior, cancel, start):
    worker = WORKER_SCRIPT
    if True:
      with tempfile.TemporaryDirectory(prefix="wfm-solve-") as tmp:
        inp, outp, flag, log = (os.path.join(tmp, n) for n in ("in.pkl", "out.pkl", "cancel.flag", "worker.log"))
        with open(inp, "wb") as f:
            pickle.dump((req.SerializeToString(), carry, weekend_prior, start), f)
        ready = _take_warm() if WARM_SPARE and worker == _DEFAULT_WORKER else None
        proc = None
        if ready is not None:
            try:
                proc, log = ready
                proc.stdin.write((json.dumps([inp, outp, flag]) + chr(10)).encode())
                proc.stdin.close()
            except OSError:                       # it died while it waited: start one the ordinary way
                proc = None
        if proc is None:
            log = os.path.join(tmp, "worker.log")
            with open(log, "wb") as lf:
                proc = subprocess.Popen([sys.executable, worker, inp, outp, flag], cwd=os.path.dirname(worker), stdout=lf, stderr=subprocess.STDOUT)
        if WARM_SPARE and worker == _DEFAULT_WORKER:
            threading.Thread(target=_spawn_warm, daemon=True).start()      # the next solve's process loads its libraries while this one solves
        cancelled_at = None
        try:
            while proc.poll() is None:
                time.sleep(0.2)
                if cancel is not None and cancel.is_set():
                    if cancelled_at is None:
                        cancelled_at = time.time()
                        open(flag, "w").close()
                    elif time.time() - cancelled_at > 10:      # it did not stop by itself: end it
                        proc.kill()
                        break
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
        if cancel is not None and cancel.is_set():
            raise backends.Cancelled()
        if os.path.exists(outp):
            with open(outp, "rb") as f:
                kind, payload = pickle.load(f)
            if kind == "ok":
                res = wfm_pb2.ScheduleResponse()
                res.ParseFromString(payload)
                return res
            if kind == "cancelled":
                raise backends.Cancelled()
            raise RuntimeError(payload)
        tail = ""
        try:
            with open(log, "rb") as lf:
                tail = lf.read()[-300:].decode("utf-8", "replace").strip().replace("\n", " | ")
        except OSError:
            pass
        raise _WorkerDied(f"the solver process ended without an answer (exit code {proc.returncode}){': ' + tail if tail else ''}")



def solve_cpsat(req, carry=None, weekend_prior=None, cancel=None, start=None):
    """The primary solver: OR-Tools CP-SAT."""
    t0 = time.time()
    days = req.days
    emps, opts, required, carry, weekend_prior, total = prepare(req, carry, weekend_prior)

    m = cp_model.CpModel()
    x = [m.NewBoolVar(f"x{i}") for i in range(len(opts))]

    by_ed = defaultdict(list)          # (employee, day) -> option indexes
    by_e = defaultdict(list)
    for i, o in enumerate(opts):
        by_ed[(o.employee, o.day)].append(i)
        by_e[o.employee].append(i)

    # one shift per person per day
    for idx in by_ed.values():
        if len(idx) > 1:
            m.AddAtMostOne(x[i] for i in idx)

    # rest between the end of one shift and the start of the next day's shift.
    # at most one option per (employee, day) is chosen, so "b plus every conflicting a" can total at most 1.
    for (e, d), idx_b in by_ed.items():
        prev = by_ed.get((e, d - 1))
        if not prev:
            continue
        rest = emps[e].rest_slots
        for b in idx_b:
            start_b = SPD + opts[b].start_slot
            clash = [a for a in prev if opts[a].start_slot + opts[a].length_slots > start_b - rest]
            if clash:
                m.AddAtMostOne([x[b]] + [x[a] for a in clash])

    # most days in a row
    for e, emp in emps.items():
        k = emp.max_consecutive
        if k <= 0:
            continue
        worked = {d: [x[i] for i in by_ed.get((e, d), [])] for d in range(days)}
        run = (carry or {}).get(e, 0)
        if run > 0:  # the run before day 0 continues, so the first k-run+1 days cannot all be worked
            span = max(0, k - run)
            if run >= k:
                for v in worked[0]:
                    m.Add(v == 0)
            else:
                first = [v for d in range(min(span + 1, days)) for v in worked[d]]
                if len(first) > span:
                    m.Add(LSUM(first) <= span)
        if k >= days:
            continue
        for d0 in range(0, days - k):
            window = [v for d in range(d0, d0 + k + 1) for v in worked[d]]
            if len(window) > k:
                m.Add(LSUM(window) <= k)

    # weekly hours (hard max, soft contract minimum for weeks fully inside the period) and days per week
    fair_hint = None
    penalties = []
    short_hint = []                    # contract-hours gaps, hinted below so the greedy roster is a complete starting point
    for e, emp in emps.items():
        weeks = defaultdict(list)
        for i in by_e.get(e, []):
            weeks[(week_offset(req) + opts[i].day) // 7].append(i)
        for w, idx in weeks.items():
            done_slots, done_days, lead = (emp.prior_week_slots, emp.prior_week_days, emp.prior_lead_days) if w == 0 else (0, 0, 0)
            if emp.max_week_slots > 0:
                m.Add(LSUM(paid(opts[i]) * x[i] for i in idx) <= max(0, emp.max_week_slots - done_slots))
            if emp.max_days_week > 0:
                m.Add(LSUM(x[i] for i in idx) <= max(0, emp.max_days_week - done_days))
            # contract hours: a whole week aims for the full contract; a week the period only partly covers (it starts or ends mid-week)
            # aims for the same share of it, in whole shifts, instead of being ignored
            first = w * 7 - week_offset(req)
            n_days = min(first + 6, days - 1) - max(first, 0) + 1
            # days of this week that came before the schedule count toward it: the contract is for the whole week, less what was already worked
            target = week_target(emp.min_week_slots, n_days + lead, [paid(opts[i]) for i in idx], emp.max_days_week, emp.max_week_slots)
            target = max(0, target - done_slots)
            if target > 0 and req.w_hours > 0:
                short = m.NewIntVar(0, target, f"short{e}_{w}")
                m.Add(short >= target - LSUM(paid(opts[i]) * x[i] for i in idx))
                penalties.append(req.w_hours * short)
                short_hint.append((short, target, idx))

    # coverage: people on shift in each slot against the requirement
    cover = defaultdict(list)
    cover_e = defaultdict(list)        # slot -> (employee, variable), only needed when coverage is judged per skill
    skill_req = {s.id: list(s.required) + [0] * max(0, total - len(s.required)) for s in req.skill_requirements}
    by_skill = 2 <= len(skill_req) <= 5
    for i, o in enumerate(opts):
        base = o.day * SPD + o.start_slot
        for g in range(base, min(base + o.length_slots, total)):
            cover[g].append(x[i])
            if by_skill:
                cover_e[g].append((o.employee, x[i]))
        if req.wrap:                       # the period repeats: what runs past the last midnight covers the first hours again
            for g in range(total, min(base + o.length_slots, 2 * total)):
                cover[g - total].append(x[i])
                if by_skill:
                    cover_e[g - total].append((o.employee, x[i]))
    under_vars, over_vars, hint = [], [], {}
    heavy_vars = []

    def heavy(g, over, need_g, ub):
        """Surplus beyond 100% of the slot's need counts again. Paying everyone their hours leaves a fixed amount of surplus, and
        with a flat price the solver is free to pile it all into one night; a rising price spreads it in line with demand."""
        h = m.NewIntVar(0, max(ub, 1), f"h{g}")
        m.Add(h >= over - need_g - 2)
        heavy_vars.append(h)

    if not req.wrap:
        # a shift that runs past the end of the period covers nothing the period asks for: count that time as surplus, or the last night looks free
        for i, o in enumerate(opts):
            past = o.day * SPD + o.start_slot + o.length_slots - total
            if past > 0:
                penalties.append(req.w_over * past * x[i])
    if by_skill:
        # Per-skill coverage. Each person on shift serves one skill at a time, so the requirement can be met exactly when, for every
        # group of skills S, the people who hold at least one skill in S are no fewer than the requirement summed over S (Hall's
        # condition). The shortfall in a slot is the worst such gap; a surplus is anyone on shift beyond the total requirement.
        ids = sorted(skill_req)
        has = {e: {k for k in emp.skill_ids if k in skill_req} for e, emp in emps.items()}
        subsets = [[k for b, k in enumerate(ids) if mask >> b & 1] for mask in range(1, 1 << len(ids))]
        for g in range(total):
            need_tot = sum(skill_req[k][g] for k in ids)
            ce = cover_e.get(g, [])
            if not ce and need_tot == 0:
                continue
            under = m.NewIntVar(0, need_tot, f"u{g}")
            over = m.NewIntVar(0, max(len(ce), 1), f"o{g}")
            for S in subsets:
                need_s = sum(skill_req[k][g] for k in S)
                if need_s == 0:
                    continue
                heads = [v for e, v in ce if has[e] & set(S)]
                m.Add(under >= need_s - (LSUM(heads) if heads else 0))
            m.Add(over >= LSUM(v for e, v in ce if has[e]) - need_tot) if ce else None
            under_vars.append(under)
            over_vars.append(over)
            heavy(g, over, need_tot, len(ce))
    for g in ([] if by_skill else range(total)):
        need = required[g]
        cv = cover.get(g)
        if not cv and need == 0:
            continue
        cap = len(cv) if cv else 0
        under = m.NewIntVar(0, need, f"u{g}")
        over = m.NewIntVar(0, max(cap, 1), f"o{g}")
        m.Add((LSUM(cv) if cv else 0) + under - over == need)
        under_vars.append(under)
        hint[g] = (under, over)
        over_vars.append(over)
        heavy(g, over, need, cap)
    if under_vars:
        penalties.append(req.w_under * LSUM(under_vars))
        penalties.append(req.w_over * LSUM(over_vars))
        if heavy_vars:
            penalties.append(max(1, req.w_over // 3) * LSUM(heavy_vars))   # small enough that paying contract hours still wins

    # consistent start and end times: each person gets one usual start and one usual end for the whole period, and a
    # shift may differ from them by at most the tolerance. Required: the shift is not allowed otherwise.
    # Prefer: the shift is allowed but costs w_consist. Both anchors are picked by the solver, per person.
    consist_off = 0
    anchor_vars = {}                            # (employee, "start"/"end") -> {anchor value: variable}, hinted from the greedy roster below
    for e, emp in emps.items():
        mode = effective_mode(req, emp)
        idx = by_e.get(e, [])
        if mode not in (1, 2) or not idx:
            continue
        for key, tol in (("start", req.start_tol_slots), ("end", req.end_tol_slots)):
            val = (lambda o: o.start_slot) if key == "start" else (lambda o: o.start_slot + o.length_slots)
            anchors = sorted({val(opts[i]) for i in idx})
            y = {a: m.NewBoolVar(f"y{key}{e}_{a}") for a in anchors}
            m.AddAtMostOne(y.values())
            anchor_vars[(e, key)] = y
            for i in idx:
                v = val(opts[i])
                near = [y[a] for a in anchors if abs(a - v) <= tol]
                if mode == 2:
                    m.Add(LSUM(near) >= x[i])
                else:
                    off = m.NewBoolVar(f"off{key}{i}")
                    m.Add(LSUM(near) + off >= x[i])
                    penalties.append(req.w_consist * off)
                    consist_off += 1

    # preferences
    if req.w_pref:
        for i, o in enumerate(opts):
            if o.preference:
                penalties.append(-req.w_pref * o.preference * x[i])

    # fairness: keep the number of weekend shifts similar between people who could work them
    if req.w_fair > 0:
        wk = {}
        for e in emps:
            idx = [i for i in by_e.get(e, []) if (req.first_dow + opts[i].day) % 7 >= 5]
            if idx:
                wk[e] = LSUM(x[i] for i in idx) + weekend_prior.get(e, 0)
        if len(wk) > 1:
            top = days + max(weekend_prior.values(), default=0)
            hi, lo = m.NewIntVar(0, top, "wk_hi"), m.NewIntVar(0, top, "wk_lo")
            for v in wk.values():
                m.Add(v <= hi)
                m.Add(v >= lo)
            penalties.append(req.w_fair * (hi - lo))
            fair_hint = (hi, lo, wk)

    m.Minimize(LSUM(penalties) if penalties else 0)
    # starting point for the solver: a greedy roster that already obeys the hard rules. Without it the solver can spend the
    # whole time limit on a large crew without finding any answer.
    pick, anchors = start if start is not None else (None, {})
    if pick is None:
        pick = greedy(req, emps, opts, by_ed, required, carry, anchors)
    for i, v in enumerate(x):
        m.AddHint(v, 1 if i in pick else 0)
    for (e, key), y in anchor_vars.items():
        a = anchors.get(e)
        want = None if a is None else a[0 if key == "start" else 1]
        for val_, var in y.items():
            m.AddHint(var, 1 if val_ == want else 0)
    cov = [0] * total
    for i in pick:
        for g in range(opts[i].day * SPD + opts[i].start_slot, opts[i].day * SPD + opts[i].start_slot + opts[i].length_slots):
            if g < total:
                cov[g] += 1
            elif req.wrap and g - total < total:
                cov[g - total] += 1
    if fair_hint:   # the spread of weekend shifts between people: without a value here the hint is incomplete and a large crew often cannot use it
        hi_v, lo_v, wk_idx = fair_hint
        counts = [weekend_prior.get(e, 0) + sum(1 for i in by_e.get(e, []) if i in pick and (req.first_dow + opts[i].day) % 7 >= 5) for e in wk_idx]
        m.AddHint(hi_v, max(counts))
        m.AddHint(lo_v, min(counts))
    for sv, target, idx in short_hint:
        m.AddHint(sv, max(0, target - sum(paid(opts[i]) for i in idx if i in pick)))
    for g, (u, o) in hint.items():
        m.AddHint(u, max(0, required[g] - cov[g]))
        m.AddHint(o, max(0, cov[g] - required[g]))

    solver = cp_model.CpSolver()
    # the limit is what the person asked to wait, so building the model counts against it (but never more than half of it)
    limit = float(max(1, req.time_limit_sec or 20))
    solver.parameters.max_time_in_seconds = max(limit * 0.5, limit - (time.time() - t0))
    solver.parameters.num_workers = workers_for(len(opts), int(req.workers or 8))
    # on large crews presolve can use the entire time limit and return nothing, which the user sees as "no valid schedule"
    solver.parameters.cp_model_presolve = False
    solver.parameters.random_seed = 7           # same input, same schedule
    # Stop as soon as the answer is proven within a small share of the best possible, instead of using the whole time allowance on a gain nobody could see. A big group almost
    # never proves a perfect answer, so without this every part of every build ran for its full limit.
    # Only for big models: a small one is quick anyway, and an early stop there would give up the small gains (spreading weekend shifts fairly) that are worth less than 1% of the cost.
    if len(opts) > int(os.environ.get("ENGINE_GAP_MIN_OPTIONS", "20000")):
        solver.parameters.relative_gap_limit = max(0.0, float(os.environ.get("ENGINE_GAP_LIMIT", "0.01")))
    # Cancel from inside the solver's own callback (every solution found, and the hints give a first one at once). Calling StopSearch from
    # another thread aborted the whole process natively, which took every forecast and schedule request down with it.
    class _Stop(cp_model.CpSolverSolutionCallback):
        def on_solution_callback(self):
            if cancel is not None and cancel.is_set():
                self.StopSearch()
    # Search in stages, each starting from the best roster so far, and stop when a stage no longer improves the answer. A model this size rarely proves its best answer,
    # so searching for the whole allowance meant waiting the full time for gains of a fraction of a percent.
    stage_sec = max(float(os.environ.get("ENGINE_STAGE_MIN_SEC", "6")), limit / 4)
    stall = float(os.environ.get("ENGINE_STALL_PCT", "0.3")) / 100.0
    budget = solver.parameters.max_time_in_seconds
    started = time.time()
    last_obj, kept = None, None
    while True:
        solver.parameters.max_time_in_seconds = min(stage_sec, max(1.0, budget - (time.time() - started))) if stall > 0 and budget > stage_sec * 1.5 else budget - (time.time() - started)
        status = solver.Solve(m, _Stop()) if cancel is not None else solver.Solve(m)
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            kept = (solver, status)
        if cancel is not None and cancel.is_set():
            break
        left_sec = budget - (time.time() - started)
        if stall <= 0 or status not in (cp_model.FEASIBLE, cp_model.UNKNOWN) or left_sec < 2.0:
            break                                                    # proven, or refused, or no time for another stage
        if status == cp_model.FEASIBLE:
            obj = solver.ObjectiveValue()
            if last_obj is not None and (last_obj - obj) / max(1.0, abs(last_obj)) < stall:
                break                                                # the last stage gained less than the threshold
            last_obj = obj
            _clear_hints(m)
            hint = m.Proto().solution_hint
            sol = solver.ResponseProto().solution
            hint.vars.extend(range(len(sol)))
            hint.values.extend(sol)
        solver = _next_solver(solver)
    if kept is not None and status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        solver, status = kept                                        # a later stage found nothing better to report: keep the roster an earlier one found
    name = solver.StatusName(status)

    out = wfm_pb2.ScheduleResponse(status=name, wall_sec=round(time.time() - t0, 2), backend="cpsat",
                                   variables=len(m.Proto().variables), constraints=len(m.Proto().constraints))
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for i, o in enumerate(opts):
            if solver.Value(x[i]):
                out.assignments.add(employee=o.employee, day=o.day, template=o.template, start_slot=o.start_slot, length_slots=o.length_slots)
        out.objective = solver.ObjectiveValue()
        out.best_bound = solver.BestObjectiveBound()
        out.gap = round(max(0.0, out.objective - out.best_bound) / max(1.0, abs(out.objective)), 4)
        out.under_slots = int(sum(solver.Value(v) for v in under_vars))
        out.over_slots = int(sum(solver.Value(v) for v in over_vars))
    elif pick:
        # nothing better than the starting roster was found in time: hand that back (it obeys every hard rule) instead of failing.
        # gap 1 says honestly that its quality is unproven
        for i in sorted(pick):
            o = opts[i]
            out.assignments.add(employee=o.employee, day=o.day, template=o.template, start_slot=o.start_slot, length_slots=o.length_slots)
        out.status = "FEASIBLE"
        out.gap = 1.0
        out.under_slots = sum(max(0, required[g] - cov[g]) for g in range(total))
        out.over_slots = sum(max(0, cov[g] - required[g]) for g in range(total))
    return out


def baseline_coverage(req):
    """Under and over slots of the greedy starting roster alone: what the solver has to beat."""
    emps = {e.id: e for e in req.employees}
    opts = list(req.options)
    by_ed = defaultdict(list)
    for i, o in enumerate(opts):
        by_ed[(o.employee, o.day)].append(i)
    total = req.days * SPD
    required = list(req.required) + [0] * max(0, total - len(req.required))
    cov = [0] * total
    for i in greedy(req, emps, opts, by_ed, required, {}):
        for g in range(opts[i].day * SPD + opts[i].start_slot, min(total, opts[i].day * SPD + opts[i].start_slot + opts[i].length_slots)):
            cov[g] += 1
    return sum(max(0, required[g] - cov[g]) for g in range(total)), sum(max(0, cov[g] - required[g]) for g in range(total))


def solve_period(req, chunk_days=7, cancel=None, progress=None):
    """Long periods are solved one calendar week at a time: the model grows with people x days x starts, and past two
    weeks the solver can spend the whole time limit preparing it and return nothing. Rest between shifts and days in a
    row are carried across the week boundary, weekly limits already sit inside a calendar week.
    `progress(done, total, note)` is called as each week finishes; `cancel` (a threading.Event) stops the run between and inside weeks."""
    if req.days <= chunk_days:
        if progress:
            progress(0, 1, "Solving")
        r = solve(req, cancel=cancel)
        if progress:
            progress(1, 1, "Done")
        return r
    t0 = time.time()
    total_limit = float(max(1, req.time_limit_sec or 20))
    anchor = {}                                 # employee -> (start, end) of the last shift solved: the usual times the next week keeps to
    first = min(req.days, 7 - week_offset(req) % 7)
    bounds, d = [], 0
    while d < req.days:
        n = first if d == 0 else min(7, req.days - d)
        bounds.append((d, n))
        d += n
    emps = {e.id: e for e in req.employees}
    by_day = defaultdict(list)
    for o in req.options:
        by_day[o.day].append(o)
    out = wfm_pb2.ScheduleResponse(status="OPTIMAL")
    last = {}                                   # employee -> (day, end slot, run of days worked in a row)
    fallback = False
    weekend = defaultdict(int, {e.id: e.prior_weekend for e in req.employees if e.prior_weekend})   # employee -> weekend shifts in the weeks already solved
    used, attempts = [], []
    for w, (d0, n) in enumerate(bounds):
        if cancel is not None and cancel.is_set():
            raise backends.Cancelled()
        if progress:
            progress(w, len(bounds), f"Solving week {w + 1} of {len(bounds)}")
        sub = wfm_pb2.ScheduleRequest()
        sub.CopyFrom(req)
        del sub.required[:]
        del sub.options[:]
        sub.days = n
        sub.first_dow = (req.first_dow + d0) % 7
        sub.required.extend(req.required[d0 * SPD:(d0 + n) * SPD])
        for e in sub.employees:
            e.ClearField('prior_weekend')           # already counted in `weekend`
        # each week gets its share of the time, but whatever the earlier weeks spent preparing comes out of the rest, so the whole run stays inside the limit
        left = max(1.0, total_limit - (time.time() - t0))
        sub.time_limit_sec = max(1, round(min(total_limit * n / req.days, left * n / (req.days - d0))))
        if d0 > 0:                              # the history only applies to the first calendar week; later chunks follow the weeks solved before them
            for e in sub.employees:
                for f in ('prior_run', 'prior_has_end', 'prior_end_slot', 'prior_week_slots', 'prior_week_days', 'prior_lead_days'):
                    e.ClearField(f)
        def near(o):                            # same usual times as the week before, within the company's tolerance
            a = anchor.get(o.employee)
            return a is None or (abs(o.start_slot - a[0]) <= req.start_tol_slots and abs(o.start_slot + o.length_slots - a[1]) <= req.end_tol_slots)
        held = {e for e in anchor if effective_mode(req, emps[e]) in (1, 2) and any(near(o) for dd in range(d0, d0 + n) for o in by_day.get(dd, []) if o.employee == e)}
        for dd in range(d0, d0 + n):
            for o in by_day.get(dd, []):
                if o.employee in held and not near(o):
                    continue
                prev = last.get(o.employee)
                if dd == d0 and prev and prev[0] == d0 - 1:
                    if prev[1] - SPD > o.start_slot - emps[o.employee].rest_slots:
                        continue
                sub.options.add(employee=o.employee, day=dd - d0, template=o.template, start_slot=o.start_slot,
                                length_slots=o.length_slots, paid_slots=o.paid_slots, preference=o.preference)
        carry = {e: p[2] for e, p in last.items() if p[0] == d0 - 1} if d0 else {e.id: e.prior_run for e in req.employees if e.prior_run}
        r = solve(sub, carry, dict(weekend), cancel)
        if r.backend and r.backend not in used:
            used.append(r.backend)
        attempts.extend(f"week {w + 1}: {a}" for a in r.attempts if not a.startswith("cpsat: optimal") and not a.startswith("cpsat: feasible"))
        if r.status not in ("OPTIMAL", "FEASIBLE"):
            out.status = r.status
            out.backend = ",".join(used)
            out.attempts.extend(attempts[:20])
            return out
        if r.status == "FEASIBLE":
            out.status = "FEASIBLE"
        worked = defaultdict(dict)
        for a in r.assignments:
            out.assignments.add(employee=a.employee, day=a.day + d0, template=a.template, start_slot=a.start_slot, length_slots=a.length_slots)
            worked[a.employee][a.day] = a.start_slot + a.length_slots
            anchor[a.employee] = (a.start_slot, a.start_slot + a.length_slots)
            if (req.first_dow + a.day + d0) % 7 >= 5:
                weekend[a.employee] += 1
        for e in emps:
            days_w = worked.get(e, {})
            run = 0
            while (n - 1 - run) in days_w:
                run += 1
            if run:
                run += (carry.get(e, 0) if run == n else 0)
                last[e] = (d0 + n - 1, days_w[n - 1], run)
            else:
                last.pop(e, None)
        fallback = fallback or (r.gap >= 1.0 and r.best_bound == 0)
        out.objective += r.objective
        out.best_bound += r.best_bound
        out.under_slots += r.under_slots
        out.over_slots += r.over_slots
        out.variables += r.variables
        out.constraints += r.constraints
    out.gap = 1.0 if fallback else round(max(0.0, out.objective - out.best_bound) / max(1.0, abs(out.objective)), 4)
    out.wall_sec = round(time.time() - t0, 2)
    out.backend = ",".join(used)
    out.attempts.extend(attempts[:20])
    if progress:
        progress(len(bounds), len(bounds), "Done")
    return out
