"""Backup solvers for shift assignment, and the failover between them.

CP-SAT (scheduling.solve_cpsat) is the primary. The same rules and the same objective are written here once as a mixed-integer
program (`build_lp`) and handed to HiGHS or SCIP, so a backup answers the same question and obeys the same hard rules. The greedy
roster is the last resort: it always exists and always obeys them. Timefold has no Python package; it runs as a JVM service and is
reached over HTTP (`solve_timefold`, TIMEFOLD_URL). Every solver here is open source (CP-SAT and SCIP: Apache 2.0, HiGHS: MIT).

Which solvers are tried, and in what order, comes from the request (`backend`) or SOLVER_CHAIN (default "cpsat,highs,scip,greedy").
A solver is abandoned when it raises, returns nothing, or only hands back the greedy starting roster; the best answer seen wins.
"""
import json
import os
import threading
import time
import urllib.request
from collections import defaultdict

import numpy as np
from scipy import sparse

import capabilities
import scoring
import verdict
import wfm_pb2
from coverage import away_from_anchor, cover_slots, generic_need, rest_needed, signatures, slot_groups, unmet, unsocial_hours

SPD = 96
DEFAULT_CHAIN = "cpsat,highs,scip,greedy"


from resources import Cancelled, MemoryPressure, RequestTooLarge       # the caller gave up on the solve / not enough memory to start one safely (retryable): defined with the resource manager that raises them


def default_chain():
    """The automatic order: CP-SAT (the best, and the only one that can prove a roster optimal), then HiGHS and SCIP (the same model, other algorithms), then Timefold when its service is set up
    (a different kind of search: local search, useful when the exact solvers run out of time on a very large problem; it is only ever tried for requests whose rules it implements and
    is never first, because on the problems tested CP-SAT found the better roster), and the starting roster last, which always exists and always obeys the rules."""
    if os.environ.get("TIMEFOLD_URL"):
        return "cpsat,highs,scip,timefold,greedy"
    return DEFAULT_CHAIN


def chain_for(req):
    raw = (req.backend or os.environ.get("SOLVER_CHAIN") or default_chain()).lower()
    raw = default_chain() if raw == "auto" else raw
    out = []
    for part in raw.replace(" ", "").split(","):
        if part and part not in out:
            out.append(part)
    return out or ["cpsat"]


# ---------------------------------------------------------------- the model as plain rows

class LP:
    """Columns with bounds and cost, rows with a low and a high side."""

    def __init__(self):
        self.lb, self.ub, self.cost, self.integer = [], [], [], []
        self.rows = []          # (columns, values, low, high)
        self.goals = []         # a person's paid time in a week against the contract and overtime: handed to services that are not linear programs (Timefold)
        self.fair = None        # the spread of weekend and holiday time between people, likewise

    def var(self, lb=0.0, ub=1.0, cost=0.0, integer=False):
        self.lb.append(lb)
        self.ub.append(ub)
        self.cost.append(cost)
        self.integer.append(1 if integer else 0)
        return len(self.lb) - 1

    def row(self, coefs, lo=-np.inf, hi=np.inf):
        acc = defaultdict(float)
        for j, v in coefs:
            acc[j] += v
        if acc:
            self.rows.append((list(acc.keys()), list(acc.values()), lo, hi))

    def matrix(self):
        indptr, idx, val = [0], [], []
        for cols, vals, _, _ in self.rows:
            idx.extend(cols)
            val.extend(vals)
            indptr.append(len(idx))
        return sparse.csr_matrix((val, idx, indptr), shape=(len(self.rows), len(self.lb)))


def ext_on(emp, d):
    """True when this person already works for another group on day `d` of the request."""
    return 0 <= d < len(emp.ext_paid) and emp.ext_paid[d] > 0


def ext_week(emp, offset):
    """{calendar week index: (paid slots, days)} this person already works for other groups, by the same week numbering the weekly limits use."""
    out = {}
    for d, v in enumerate(emp.ext_paid):
        if v > 0:
            s, n = out.get((offset + d) // 7, (0, 0))
            out[(offset + d) // 7] = (s + v, n + 1)
    return out


def build_lp(req, emps, opts, required, carry, weekend_prior, week_offset, paid, week_target, effective_mode):
    """Every hard rule and every objective term of the CP-SAT model, as rows. Variables 0..len(opts)-1 are the shift choices."""
    days, total = req.days, req.days * SPD
    lp = LP()
    x = [lp.var(0, 1, 0.0, True) for _ in opts]
    by_ed, by_e = defaultdict(list), defaultdict(list)
    for i, o in enumerate(opts):
        by_ed[(o.employee, o.day)].append(i)
        by_e[o.employee].append(i)

    for idx in by_ed.values():                                   # one shift a day
        if len(idx) > 1:
            lp.row([(x[i], 1) for i in idx], hi=1)
    for (e, d), idx_b in by_ed.items():                          # rest between shifts
        prev = by_ed.get((e, d - 1))
        if not prev:
            continue
        rest = rest_needed(req, emps[e], d)
        for b in idx_b:
            start_b = SPD + opts[b].start_slot
            clash = [a for a in prev if opts[a].start_slot + opts[a].length_slots > start_b - rest]
            if clash:
                lp.row([(x[b], 1)] + [(x[a], 1) for a in clash], hi=1)
    for e, emp in emps.items():                                  # most days in a row
        k = emp.max_consecutive
        if k <= 0:
            continue
        worked = {d: [x[i] for i in by_ed.get((e, d), [])] for d in range(days)}
        run = carry.get(e, 0)
        extd = [ext_on(emp, d) for d in range(days)]       # days already worked for another group count as worked, without a variable
        if run > 0:
            span = max(0, k - run)
            if run >= k:
                for v in worked[0]:
                    lp.row([(v, 1)], hi=0)
            else:
                first = [v for d in range(min(span + 1, days)) for v in worked[d]]
                n_ext = sum(extd[:span + 1])
                if first and len(first) + n_ext > span:
                    lp.row([(v, 1) for v in first], hi=max(0, span - n_ext))
        if k >= days:
            continue
        for d0 in range(0, days - k):
            window = [v for d in range(d0, d0 + k + 1) for v in worked[d]]
            n_ext = sum(extd[d0:d0 + k + 1])
            if window and len(window) + n_ext > k:
                lp.row([(v, 1) for v in window], hi=max(0, k - n_ext))

    under_cols, over_cols = [], []
    for e, emp in emps.items():                                  # weekly hours and days; contract minimum is soft
        weeks = defaultdict(list)
        for i in by_e.get(e, []):
            weeks[(week_offset(req) + opts[i].day) // 7].append(i)
        for w, idx in weeks.items():
            done_slots, done_days, lead = (emp.prior_week_slots, emp.prior_week_days, emp.prior_lead_days) if w == 0 else (0, 0, 0)
            xs, xd = ext_week(emp, week_offset(req)).get(w, (0, 0))      # worked for other groups in this week
            done_slots, done_days = done_slots + xs, done_days + xd
            if emp.max_week_slots > 0:
                lp.row([(x[i], paid(opts[i])) for i in idx], hi=max(0, emp.max_week_slots - done_slots))
            if emp.max_days_week > 0:
                lp.row([(x[i], 1) for i in idx], hi=max(0, emp.max_days_week - done_days))
            first = w * 7 - week_offset(req)
            n_days = min(first + 6, days - 1) - max(first, 0) + 1
            target = max(0, week_target(emp.min_week_slots, n_days + lead, [paid(opts[i]) for i in idx], emp.max_days_week, emp.max_week_slots) - done_slots)
            if target > 0 and req.w_hours > 0:
                s = lp.var(0, target, req.w_hours)
                lp.row([(s, 1)] + [(x[i], paid(opts[i])) for i in idx], lo=target)
            if req.w_overtime > 0 and emp.min_week_slots > 0 and n_days + lead >= 7 and idx:      # planned overtime, priced a slot
                ot = lp.var(0, max(1, sum(paid(opts[i]) for i in idx)), req.w_overtime)
                lp.row([(ot, 1)] + [(x[i], -paid(opts[i])) for i in idx], lo=done_slots - emp.min_week_slots)
            short = target if (target > 0 and req.w_hours > 0) else 0
            full = bool(req.w_overtime > 0 and emp.min_week_slots > 0 and n_days + lead >= 7 and idx)
            if short or full:
                lp.goals.append({"c": idx, "v": [paid(opts[i]) for i in idx], "target": int(short), "full": full, "otBase": int(done_slots - emp.min_week_slots)})

    cover, cover_e = defaultdict(list), defaultdict(list)
    skill_req = {s.id: list(s.required) + [0] * max(0, total - len(s.required)) for s in req.skill_requirements}
    by_skill = len(skill_req) >= 1
    for i, o in enumerate(opts):
        for g in cover_slots(o, total, req.wrap):
            cover[g].append(x[i])
            if by_skill:
                cover_e[g].append((o.employee, x[i]))
    if not req.wrap:                                              # time past the end of the period is surplus
        for i, o in enumerate(opts):
            past = o.day * SPD + o.start_slot + o.length_slots - total
            if past > 0:
                lp.cost[x[i]] += req.w_over * past
    heavy_cost = max(1, req.w_over // 3)

    def heavy(over, need, ub):
        h = lp.var(0, max(ub, 1), heavy_cost)
        lp.row([(h, 1), (over, -1)], lo=-need - 2)

    if by_skill:
        sig = signatures(emps, skill_req)
        for g in range(total):
            need_k, by_sig = slot_groups(g, skill_req, sig, cover_e.get(g, []))
            extra = generic_need(required[g] if g < len(required) else 0, need_k)      # the part of the total that anybody on shift can serve
            need_tot = sum(need_k.values()) + extra
            heads = sum(len(vs) for vs in by_sig.values())
            everyone = [v for _, v in cover_e.get(g, [])]                       # people without any of the skills asked for count as surplus
            if not everyone and need_tot == 0:
                continue
            served = {k: [] for k in need_k}
            all_flows = []
            for s, vs in by_sig.items():
                flows = []
                for k in need_k:
                    if k in s:
                        f = lp.var(0, len(vs), 0.0)
                        served[k].append(f)
                        flows.append(f)
                        all_flows.append(f)
                if flows:
                    lp.row([(v, -1) for v in vs] + [(f, 1) for f in flows], hi=0)          # a person serves at most one skill at a time
            shorts = []
            for k, nk in need_k.items():
                u = lp.var(0, nk, 0.0)
                lp.row([(u, 1)] + [(f, 1) for f in served[k]], lo=nk)
                shorts.append(u)
            if extra > 0:                                                  # the rest of the total: whoever is on shift and not serving a skill
                u2 = lp.var(0, extra, 0.0)
                lp.row([(u2, 1)] + [(v, 1) for v in everyone] + [(f, -1) for f in all_flows], lo=extra)
                shorts.append(u2)
            under = lp.var(0, max(need_tot, 0), req.w_under)
            lp.row([(under, 1)] + [(u, -1) for u in shorts], lo=0, hi=0)
            over = lp.var(0, max(len(everyone), 1), req.w_over)
            if everyone:
                lp.row([(over, 1)] + [(v, -1) for v in everyone], lo=-need_tot)
            under_cols.append(under)
            over_cols.append(over)
            heavy(over, need_tot, len(everyone))
    else:
        for g in range(total):
            need = required[g]
            cv = cover.get(g)
            if not cv and need == 0:
                continue
            cap = len(cv) if cv else 0
            under = lp.var(0, need, req.w_under)
            over = lp.var(0, max(cap, 1), req.w_over)
            lp.row([(v, 1) for v in (cv or [])] + [(under, 1), (over, -1)], lo=need, hi=need)
            under_cols.append(under)
            over_cols.append(over)
            heavy(over, need, cap)

    for e, emp in emps.items():                                   # one usual start and end per person
        mode = effective_mode(req, emp)
        idx = by_e.get(e, [])
        if mode not in (1, 2) or not idx:
            continue
        for key, tol in (("start", req.start_tol_slots), ("end", req.end_tol_slots)):
            val = (lambda o: o.start_slot) if key == "start" else (lambda o: o.start_slot + o.length_slots)
            anchors = sorted({val(opts[i]) for i in idx})
            y = {a: lp.var(0, 1, 0.0, True) for a in anchors}
            lp.row([(v, 1) for v in y.values()], hi=1)
            for i in idx:
                v = val(opts[i])
                near = [y[a] for a in anchors if abs(a - v) <= tol]
                if mode == 2:
                    lp.row([(c, 1) for c in near] + [(x[i], -1)], lo=0)
                else:
                    off = lp.var(0, 1, req.w_consist, True)
                    lp.row([(c, 1) for c in near] + [(off, 1), (x[i], -1)], lo=0)

    if req.w_pref:
        for i, o in enumerate(opts):
            if o.preference:
                lp.cost[x[i]] -= req.w_pref * o.preference
    for i, o in enumerate(opts):
        if o.cost:
            lp.cost[x[i]] += o.cost
        if effective_mode(req, emps[o.employee]) == 1 and away_from_anchor(req, emps[o.employee], o):      # prefers the usual times of the earlier weeks
            lp.cost[x[i]] += req.w_consist

    if req.w_fair > 0:                                            # unsocial hours (weekend and holiday time) spread evenly
        wk = {}
        for e in emps:
            idx = [i for i in by_e.get(e, []) if unsocial_hours(req, opts[i])]
            if idx:
                wk[e] = idx
        if len(wk) > 1:
            fw = max(1, req.w_fair // 8)
            lp.fair = {"unit": fw, "people": [{"employee": e, "prior": int(weekend_prior.get(e, 0)), "picks": idx, "hours": [unsocial_hours(req, opts[i]) for i in idx]} for e, idx in wk.items()]}
            top = max(sum(unsocial_hours(req, opts[i]) for i in idx) for idx in wk.values()) + max(weekend_prior.values(), default=0) + 1
            hi, lo = lp.var(0, top, fw, True), lp.var(0, top, -fw, True)
            for e, idx in wk.items():
                prior = weekend_prior.get(e, 0)
                lp.row([(x[i], unsocial_hours(req, opts[i])) for i in idx] + [(hi, -1)], hi=-prior)
                lp.row([(x[i], unsocial_hours(req, opts[i])) for i in idx] + [(lo, -1)], lo=-prior)
    return lp, x, under_cols, over_cols


# ---------------------------------------------------------------- reading an answer back

def coverage_gaps(req, opts, chosen, required, total):
    """(person-slots short, person-slots surplus) of a roster. When the queues need different skills, shortage is judged per skill (each person serves one skill at a time)."""
    skill_req = {sk.id: list(sk.required) + [0] * max(0, total - len(sk.required)) for sk in req.skill_requirements}
    if len(skill_req) >= 1:
        sig = signatures({e.id: e for e in req.employees}, skill_req)
        on = defaultdict(lambda: defaultdict(int))                    # slot -> {skills held: people on shift}
        heads = defaultdict(int)                                      # slot -> everyone on shift, skilled or not
        for i in chosen:
            o = opts[i]
            for g in cover_slots(o, total, req.wrap):
                heads[g] += 1
                if sig[o.employee]:
                    on[g][sig[o.employee]] += 1
        short = surplus = 0
        for g in range(total):
            need = {k: skill_req[k][g] for k in skill_req if skill_req[k][g] > 0}
            have = heads[g] if g in heads else 0
            extra = generic_need(required[g] if g < len(required) else 0, need)
            skilled = sum(on[g].values()) if g in on else 0
            short += unmet(need, on[g] if g in on else {}, extra, max(0, have - skilled))
            surplus += max(0, have - sum(need.values()) - extra)
        return short, surplus
    cov = [0] * total
    for i in chosen:
        for g in cover_slots(opts[i], total, req.wrap):
            cov[g] += 1
    return sum(max(0, required[g] - cov[g]) for g in range(total)), sum(max(0, cov[g] - required[g]) for g in range(total))


def respond(req, opts, chosen, required, total, status, backend, t0, objective=0.0, bound=0.0, variables=0, constraints=0):
    out = wfm_pb2.ScheduleResponse(status=status, wall_sec=round(time.time() - t0, 2), variables=variables, constraints=constraints, backend=backend)
    for i in sorted(chosen):
        o = opts[i]
        out.assignments.add(employee=o.employee, day=o.day, template=o.template, start_slot=o.start_slot, length_slots=o.length_slots)
    out.under_slots, out.over_slots = coverage_gaps(req, opts, chosen, required, total)
    out.objective = objective
    out.best_bound = bound
    out.gap = round(max(0.0, objective - bound) / max(1.0, abs(objective)), 4) if status == "FEASIBLE" and bound else (0.0 if status == "OPTIMAL" else 1.0)
    return out


# ---------------------------------------------------------------- SCIP (through OR-Tools)

def solve_scip(req, prep, pick, t0, limit, cancel):
    from ortools.linear_solver import pywraplp
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    lp, x, _, _ = build_lp(req, emps, opts, required, carry, weekend_prior, **helpers)
    m = pywraplp.Solver.CreateSolver("SCIP")
    if m is None:
        raise RuntimeError("SCIP is not available in this OR-Tools build")
    inf = m.infinity()
    v = [m.IntVar(lp.lb[j], lp.ub[j], f"v{j}") if lp.integer[j] else m.NumVar(lp.lb[j], lp.ub[j], f"v{j}") for j in range(len(lp.lb))]
    for cols, vals, lo, hi in lp.rows:
        c = m.Constraint(-inf if lo == -np.inf else lo, inf if hi == np.inf else hi)
        for j, a in zip(cols, vals):
            c.SetCoefficient(v[j], a)
    obj = m.Objective()
    for j, c in enumerate(lp.cost):
        if c:
            obj.SetCoefficient(v[j], c)
    obj.SetMinimization()
    hint_vars = [v[x[i]] for i in range(len(opts))]
    m.SetHint(hint_vars, [1.0 if i in pick else 0.0 for i in range(len(opts))])
    m.SetTimeLimit(int(max(1.0, limit - (time.time() - t0)) * 1000))
    st = m.Solve()
    if cancel is not None and cancel.is_set():
        raise Cancelled()
    if st == pywraplp.Solver.INFEASIBLE:
        return wfm_pb2.ScheduleResponse(status="INFEASIBLE", backend="scip", wall_sec=round(time.time() - t0, 2))
    if st not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        return wfm_pb2.ScheduleResponse(status="UNKNOWN", backend="scip", wall_sec=round(time.time() - t0, 2))
    chosen = [i for i in range(len(opts)) if v[x[i]].solution_value() > 0.5]
    return respond(req, opts, chosen, required, total, "OPTIMAL" if st == pywraplp.Solver.OPTIMAL else "FEASIBLE", "scip", t0,
                   m.Objective().Value(), m.Objective().BestBound() if st != pywraplp.Solver.OPTIMAL else m.Objective().Value(), len(lp.lb), len(lp.rows))


# ---------------------------------------------------------------- HiGHS

def solve_highs(req, prep, pick, t0, limit, cancel):
    from scipy.optimize import LinearConstraint, Bounds, milp
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    lp, x, _, _ = build_lp(req, emps, opts, required, carry, weekend_prior, **helpers)
    A = lp.matrix()
    lo = np.array([r[2] for r in lp.rows])
    hi = np.array([r[3] for r in lp.rows])
    left = max(1.0, limit - (time.time() - t0))
    res = milp(c=np.array(lp.cost), constraints=LinearConstraint(A, lo, hi), integrality=np.array(lp.integer), bounds=Bounds(np.array(lp.lb), np.array(lp.ub)),
               options={"time_limit": left, "disp": False, "mip_rel_gap": 0.005})
    if cancel is not None and cancel.is_set():
        raise Cancelled()
    if res.status == 2:
        return wfm_pb2.ScheduleResponse(status="INFEASIBLE", backend="highs", wall_sec=round(time.time() - t0, 2))
    if res.x is None:
        return wfm_pb2.ScheduleResponse(status="UNKNOWN", backend="highs", wall_sec=round(time.time() - t0, 2))
    chosen = [i for i in range(len(opts)) if res.x[x[i]] > 0.5]
    bound = getattr(res, "mip_dual_bound", None)
    return respond(req, opts, chosen, required, total, "OPTIMAL" if res.status == 0 else "FEASIBLE", "highs", t0,
                   float(res.fun), float(bound) if bound is not None and np.isfinite(bound) else 0.0, len(lp.lb), len(lp.rows))


# ---------------------------------------------------------------- greedy (last resort)

def solve_greedy(req, prep, pick, t0, limit, cancel):
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    return respond(req, opts, set(pick), required, total, "FEASIBLE", "greedy", t0, 0.0, 0.0)


# ---------------------------------------------------------------- Timefold (JVM service)

def timefold_problem(req, prep, pick, limit_sec):
    """The engine's compiled problem for the Timefold service: the same hard limits as rows over the shift choices (built once, by build_lp, so the rules cannot drift apart), the cover
    needed in each slot, each person's contract and overtime goals, the weekend and holiday spread, and the per-shift costs. The service searches; the engine judges the answer."""
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    lp, x, _, _ = build_lp(req, emps, opts, required, carry, weekend_prior, **helpers)
    n = len(opts)
    rows = []
    for cols, vals, lo, hi in lp.rows:
        if not all(c < n for c in cols):
            continue                                                    # involves the model's own bookkeeping variables: coverage, goals, anchors (the service has its own)
        if lo != -np.inf and lo > 0:
            raise RuntimeError("a lower limit on shift choices alone: the service takes upper limits only")
        if hi != np.inf:
            rows.append({"c": list(cols), "v": [int(v) for v in vals], "hi": int(hi)})
    options = []
    for o in opts:
        emp = emps[o.employee]
        past = max(0, o.day * SPD + o.start_slot + o.length_slots - total) if not req.wrap else 0
        unit = o.cost - req.w_pref * o.preference + req.w_over * past
        if effective_mode_of(req, emp) == 1 and away_from_anchor(req, emp, o):
            unit += req.w_consist
        options.append({"employee": o.employee, "day": o.day, "start": o.start_slot, "length": o.length_slots, "gapStart": o.gap_start_slot, "gapSlots": o.gap_slots,
                        "unitCost": int(unit), "requireConsistency": effective_mode_of(req, emp) == 2})
    return {"total": total, "wrap": req.wrap, "need": [int(v) for v in required], "options": options, "rows": rows, "goals": lp.goals, "fair": lp.fair or {},
            "weights": {"under": req.w_under, "over": req.w_over, "hours": req.w_hours, "overtime": req.w_overtime},
            "startTol": req.start_tol_slots, "endTol": req.end_tol_slots, "limitSec": max(1, int(limit_sec)), "hint": sorted(pick)}


def effective_mode_of(req, emp):
    from coverage import consistency_mode
    return consistency_mode(req.consistency_mode, emp.consist_mode)


class Breaker:
    """Stops asking a service that keeps failing: after `threshold` failures in a row it is skipped for `cooloff` seconds, then asked once again. A build never waits on a service that
    is known to be down, and the service is not hammered while it recovers."""

    def __init__(self, threshold=3, cooloff=60.0, clock=time.monotonic):
        self.threshold, self.cooloff, self.clock = threshold, cooloff, clock
        self.failures, self.opened_at = 0, None
        self.lock = threading.Lock()

    def allow(self):
        with self.lock:
            if self.opened_at is None:
                return True
            if self.clock() - self.opened_at >= self.cooloff:
                self.opened_at = self.clock()                       # one trial call; if it fails the breaker stays open for another cool-off
                return True
            return False

    def ok(self):
        with self.lock:
            self.failures, self.opened_at = 0, None

    def failed(self):
        with self.lock:
            self.failures += 1
            if self.failures >= self.threshold:
                self.opened_at = self.clock()

    def state(self):
        with self.lock:
            return "open" if self.opened_at is not None else "closed"


TIMEFOLD_BREAKER = Breaker(int(os.environ.get("TIMEFOLD_BREAKER_FAILURES", "3")), float(os.environ.get("TIMEFOLD_BREAKER_COOLOFF_SEC", "60")))


def solve_timefold(req, prep, pick, t0, limit, cancel):
    if not TIMEFOLD_BREAKER.allow():
        raise RuntimeError("the Timefold service failed several times in a row, so it is being left alone for a minute")
    try:
        r = _solve_timefold(req, prep, pick, t0, limit, cancel)
    except Cancelled:
        raise
    except Exception:
        TIMEFOLD_BREAKER.failed()
        raise
    TIMEFOLD_BREAKER.ok()
    return r


def _solve_timefold(req, prep, pick, t0, limit, cancel):
    """Timefold Solver is a Java library with no Python package, so it runs as its own service (backend/timefold-service). The engine sends it the compiled problem (timefold_problem) at
    POST {TIMEFOLD_URL}/solve and gets back the chosen shifts. It is only called for a request whose rules the service declares at /capabilities (capabilities.py), and whatever it
    answers is judged by the engine's validator and scorer like every other solver's roster. Not configured: raises."""
    url = os.environ.get("TIMEFOLD_URL")
    if not url:
        raise RuntimeError("TIMEFOLD_URL is not set; Timefold runs as a separate JVM service (see docs/SOLVER_BACKENDS.md)")
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    body = timefold_problem(req, prep, pick, limit - (time.time() - t0))
    headers = {"Content-Type": "application/json"}
    if os.environ.get("TIMEFOLD_TOKEN"):
        headers["X-Token"] = os.environ["TIMEFOLD_TOKEN"]
    r = urllib.request.Request(url.rstrip("/") + "/solve", data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(r, timeout=limit + 30) as f:
        ans = json.loads(f.read())
    if cancel is not None and cancel.is_set():
        raise Cancelled()
    if ans.get("status") not in ("OPTIMAL", "FEASIBLE"):
        return wfm_pb2.ScheduleResponse(status=ans.get("status", "UNKNOWN"), backend="timefold", wall_sec=round(time.time() - t0, 2))
    return respond(req, opts, set(ans.get("chosen", [])), required, total, ans["status"], "timefold", t0, float(ans.get("objective", 0)), float(ans.get("bound", 0)))


BACKUPS = {"highs": solve_highs, "scip": solve_scip, "greedy": solve_greedy, "timefold": solve_timefold}


def score(req, r):
    """How good a response's roster is, in the terms every solver is judged by (scoring.evaluate), lower being better. Every response the chain accepts has been scored; the coverage-only
    figure is the fallback for one that was not."""
    return r.score if r.scored else req.w_under * r.under_slots + req.w_over * r.over_slots


BACKUP_MIN_SEC = float(os.environ.get("ENGINE_BACKUP_MIN_SEC", "3"))
BACKUP_MAX_OPTIONS = int(os.environ.get("ENGINE_BACKUP_MAX_OPTIONS", "60000"))


def _beats_start(req, prep, pick, r, t0, limit, cancel):
    """Did the optimiser's roster score better than the plain starting roster? A solver that could not prove how close it is to the best (a gap of 100% or more) is called weak only
    when it also returned nothing better than the start: a large gap on a roster that was improved is a bound that is hard to prove, not a roster that was not tuned."""
    try:
        g = BACKUPS["greedy"](req, prep, pick, t0, limit, cancel)
        scoring.attach(req, prep, g)
        return score(req, r) < score(req, g)
    except Cancelled:
        raise
    except Exception:
        return False


def run_chain(req, prep, pick, primary, t0, cancel=None, reserve=None, backup_need=None):
    """Try the solvers in order. Stop at the first good answer; a weak one (nothing but the starting roster) is kept while the next is tried.
    The response lists every attempt, so a fallback is never silent."""
    limit = float(max(1, req.time_limit_sec or 20))
    attempts, best, rejected, notes = [], None, None, []
    opts = prep[1]
    for name in chain_for(req):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        absent = capabilities.missing(name, req)
        if absent:                                                # not offered as an equivalent solver: it does not implement every rule this request uses
            why = f"{name}: not used, it does not implement {', '.join(absent)}"
            attempts.append(why)
            notes.append(why)
            continue
        if name in ("highs", "scip") and len(opts) > BACKUP_MAX_OPTIONS:      # the slower solvers need minutes just to build a model this big and do no better than the starting roster
            attempts.append(f"{name}: skipped ({len(opts):,} candidate shifts is too many for it)")
            continue
        try:
            if name == "cpsat":
                r = primary()
            elif name in BACKUPS:
                # the backups share what is left of the person's time allowance; they used to get 60% of the whole limit each, on top of what CP-SAT had used
                left = limit - (time.time() - t0)
                if best is not None and name != "greedy" and left < BACKUP_MIN_SEC:
                    attempts.append(f"{name}: skipped (the time allowance is used up)")
                    continue
                if reserve is not None and backup_need is not None and name in ("highs", "scip"):
                    try:                                              # these run inside the engine: their memory is held for them like a worker process's
                        with reserve("backup", backup_need(len(opts))):
                            r = BACKUPS[name](req, prep, pick, t0, limit, cancel)
                    except RequestTooLarge as e:
                        attempts.append(f"{name}: skipped, {str(e).split(': ', 1)[-1][:140]}")
                        continue
                else:
                    r = BACKUPS[name](req, prep, pick, t0, limit, cancel)
            else:
                attempts.append(f"{name}: unknown solver")
                continue
        except (Cancelled, MemoryPressure):
            raise
        except MemoryError:
            attempts.append(f"{name}: out of memory")
            continue
        except Exception as e:                                    # a backup must never take the request down with it
            print(f"[engine] solver {name} failed: {type(e).__name__}: {str(e)[:300]}", flush=True)
            attempts.append(f"{name}: failed ({str(e)[:160]})")
            continue
        r.backend = r.backend or name
        scoring.attach(req, prep, r)                              # every backend's roster is priced by the same evaluator, so they can be compared
        if r.status in ("OPTIMAL", "FEASIBLE"):
            verdict.attach(req, r)                                # and judged by the same validator: a roster that breaks a rule is not an answer, whoever made it
            if r.verdict.checked and not r.verdict.valid:
                attempts.append(f"{name}: rejected, its roster broke {r.verdict.hard_violations} rule{'s' if r.verdict.hard_violations != 1 else ''} (first: {verdict.first_problem(r.verdict)})")
                if rejected is None or score(req, r) < score(req, rejected):
                    rejected = r
                continue
        # an answer that places nobody while there is demand and there were shifts to choose from is not an answer, whatever status it carries
        demand = sum(req.required) + sum(sum(sk.required) for sk in req.skill_requirements)        # skill-only demand counts too
        empty = r.status in ("OPTIMAL", "FEASIBLE") and not r.assignments and bool(opts) and demand > 0
        if empty and name != "greedy":
            # placing nobody is sometimes the true best (the only shifts on offer would add cover nobody needs); it is only wrong when a roster that places people scores better
            try:
                g = BACKUPS["greedy"](req, prep, pick, t0, limit, cancel)
                scoring.attach(req, prep, g)
                empty = bool(g.assignments) and score(req, g) < score(req, r)
            except Cancelled:
                raise
            except Exception:
                empty = False
        weak = empty or r.status not in ("OPTIMAL", "FEASIBLE") or (name == "cpsat" and r.status == "FEASIBLE" and r.gap >= 1.0 and bool(pick) and not _beats_start(req, prep, pick, r, t0, limit, cancel))
        attempts.append(f"{name}: {r.status.lower()}{' (placed nobody)' if empty else ' (starting roster only)' if weak and r.status == 'FEASIBLE' else ''}")
        if empty:
            r.status = "UNKNOWN"
        if r.status == "INFEASIBLE":                              # the rules cannot be met; another solver will not change that
            best = best or r
            break
        if r.status in ("OPTIMAL", "FEASIBLE") and (best is None or best.status not in ("OPTIMAL", "FEASIBLE") or score(req, r) < score(req, best)):
            best = r
        if not weak:
            break
    if best is None and rejected is not None:
        best = rejected                                           # nothing valid was found: the nearest is returned, marked INVALID in its verdict, never passed off as good
        best.status = "FEASIBLE" if best.status == "OPTIMAL" else best.status
    if best is None:
        best = wfm_pb2.ScheduleResponse(status="UNKNOWN")
    if not best.verdict.checked and best.status in ("OPTIMAL", "FEASIBLE"):
        verdict.attach(req, best)
    if best.status not in ("OPTIMAL", "FEASIBLE") and not best.verdict.note:
        best.verdict.note = "there is no roster to check"
    del best.attempts[:]
    best.attempts.extend(attempts)
    del best.capability_notes[:]
    best.capability_notes.extend(notes)
    best.advice = advise(req, best, attempts, rejected is not None and best is rejected)
    return best


def advise(req, best, attempts, invalid):
    """What a person should make of the solver that answered, in plain words."""
    who = {"cpsat": "CP-SAT", "highs": "HiGHS", "scip": "SCIP", "timefold": "Timefold", "greedy": "the starting roster"}.get(best.backend, best.backend or "no solver")
    if invalid:
        return f"No solver could make a roster that obeys every rule. The nearest ({who}) is marked INVALID and cannot be published: relax the rules that clash (see the findings), or give the solver more time."
    if best.status not in ("OPTIMAL", "FEASIBLE"):
        return "No solver found a roster. See the attempts for why; the usual causes are too few people or shifts for the rules, or too little time."
    if best.backend == "cpsat":
        if best.status == "OPTIMAL":
            return "CP-SAT proved this roster the best possible under the rules and weights. No other solver can do better."
        return "CP-SAT made this roster and is the right solver for it; it was not proven the very best within the time given. More time may improve it a little."
    skipped = [a for a in attempts if a.startswith("cpsat")]
    first = f" CP-SAT did not give a usable roster ({skipped[0].split(': ', 1)[-1]})." if skipped else ""
    tail = " It is a valid roster; CP-SAT's, had it finished, could be better: give CP-SAT more time or fewer shift choices to get it back." if best.backend != "greedy" else \
        " It is valid, and it is the starting roster: the solvers found nothing better in the time given, so it may already be close to the best. If cover or contract hours look weak, give the solvers more time or fewer shift choices."
    return f"This roster comes from {who}, a backup.{first}{tail}"


def _has(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False
