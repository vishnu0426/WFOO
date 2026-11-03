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

import wfm_pb2

SPD = 96
DEFAULT_CHAIN = "cpsat,highs,scip,greedy"


class Cancelled(Exception):
    """The caller gave up on the solve."""


def chain_for(req):
    raw = (req.backend or os.environ.get("SOLVER_CHAIN") or DEFAULT_CHAIN).lower()
    raw = DEFAULT_CHAIN if raw == "auto" else raw
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
        rest = emps[e].rest_slots
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
        if run > 0:
            span = max(0, k - run)
            if run >= k:
                for v in worked[0]:
                    lp.row([(v, 1)], hi=0)
            else:
                first = [v for d in range(min(span + 1, days)) for v in worked[d]]
                if len(first) > span:
                    lp.row([(v, 1) for v in first], hi=span)
        if k >= days:
            continue
        for d0 in range(0, days - k):
            window = [v for d in range(d0, d0 + k + 1) for v in worked[d]]
            if len(window) > k:
                lp.row([(v, 1) for v in window], hi=k)

    under_cols, over_cols = [], []
    for e, emp in emps.items():                                  # weekly hours and days; contract minimum is soft
        weeks = defaultdict(list)
        for i in by_e.get(e, []):
            weeks[(week_offset(req) + opts[i].day) // 7].append(i)
        for w, idx in weeks.items():
            done_slots, done_days, lead = (emp.prior_week_slots, emp.prior_week_days, emp.prior_lead_days) if w == 0 else (0, 0, 0)
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

    cover, cover_e = defaultdict(list), defaultdict(list)
    skill_req = {s.id: list(s.required) + [0] * max(0, total - len(s.required)) for s in req.skill_requirements}
    by_skill = 2 <= len(skill_req) <= 5
    for i, o in enumerate(opts):
        base = o.day * SPD + o.start_slot
        for g in range(base, min(base + o.length_slots, total)):
            cover[g].append(x[i])
            if by_skill:
                cover_e[g].append((o.employee, x[i]))
        if req.wrap:
            for g in range(total, min(base + o.length_slots, 2 * total)):
                cover[g - total].append(x[i])
                if by_skill:
                    cover_e[g - total].append((o.employee, x[i]))
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
        ids = sorted(skill_req)
        has = {e: {k for k in emp.skill_ids if k in skill_req} for e, emp in emps.items()}
        subsets = [[k for b, k in enumerate(ids) if mask >> b & 1] for mask in range(1, 1 << len(ids))]
        for g in range(total):
            need_tot = sum(skill_req[k][g] for k in ids)
            ce = cover_e.get(g, [])
            if not ce and need_tot == 0:
                continue
            under = lp.var(0, need_tot, req.w_under)
            over = lp.var(0, max(len(ce), 1), req.w_over)
            for S in subsets:
                need_s = sum(skill_req[k][g] for k in S)
                if need_s == 0:
                    continue
                heads = [v for e, v in ce if has[e] & set(S)]
                lp.row([(under, 1)] + [(v, 1) for v in heads], lo=need_s)
            if ce:
                lp.row([(over, 1)] + [(v, -1) for e, v in ce if has[e]], lo=-need_tot)
            under_cols.append(under)
            over_cols.append(over)
            heavy(over, need_tot, len(ce))
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

    if req.w_fair > 0:                                            # weekend shifts spread evenly
        wk = {}
        for e in emps:
            idx = [i for i in by_e.get(e, []) if (req.first_dow + opts[i].day) % 7 >= 5]
            if idx:
                wk[e] = idx
        if len(wk) > 1:
            top = days + max(weekend_prior.values(), default=0)
            hi, lo = lp.var(0, top, req.w_fair, True), lp.var(0, top, -req.w_fair, True)
            for e, idx in wk.items():
                prior = weekend_prior.get(e, 0)
                lp.row([(x[i], 1) for i in idx] + [(hi, -1)], hi=-prior)
                lp.row([(x[i], 1) for i in idx] + [(lo, -1)], lo=-prior)
    return lp, x, under_cols, over_cols


# ---------------------------------------------------------------- reading an answer back

def coverage_gaps(req, opts, chosen, required, total):
    cov = [0] * total
    for i in chosen:
        o = opts[i]
        for g in range(o.day * SPD + o.start_slot, o.day * SPD + o.start_slot + o.length_slots):
            if g < total:
                cov[g] += 1
            elif req.wrap and g - total < total:
                cov[g - total] += 1
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

def solve_timefold(req, prep, pick, t0, limit, cancel):
    """Timefold Solver is a Java library with no Python package, so it runs as its own service. The service takes the same problem as JSON
    (people, candidate shifts, per-slot need, limits) at POST {TIMEFOLD_URL}/solve and answers {status, chosen: [option index]}. Not configured: raises."""
    url = os.environ.get("TIMEFOLD_URL")
    if not url:
        raise RuntimeError("TIMEFOLD_URL is not set; Timefold runs as a separate JVM service (see docs/SOLVER_BACKENDS.md)")
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    body = {
        "days": req.days, "firstDow": req.first_dow, "weekStart": req.week_start, "required": required, "limitSec": max(1, int(limit - (time.time() - t0))),
        "employees": [{"id": e.id, "maxWeekSlots": e.max_week_slots, "minWeekSlots": e.min_week_slots, "maxConsecutive": e.max_consecutive, "restSlots": e.rest_slots,
                       "maxDaysWeek": e.max_days_week, "priorRun": carry.get(e.id, 0), "priorWeekSlots": e.prior_week_slots, "priorWeekDays": e.prior_week_days} for e in emps.values()],
        "options": [{"employee": o.employee, "day": o.day, "start": o.start_slot, "length": o.length_slots, "paid": o.paid_slots or o.length_slots, "pref": o.preference} for o in opts],
        "weights": {"under": req.w_under, "over": req.w_over, "hours": req.w_hours, "pref": req.w_pref, "fair": req.w_fair}, "hint": sorted(pick),
    }
    r = urllib.request.Request(url.rstrip("/") + "/solve", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=limit + 30) as f:
        ans = json.loads(f.read())
    if ans.get("status") not in ("OPTIMAL", "FEASIBLE"):
        return wfm_pb2.ScheduleResponse(status=ans.get("status", "UNKNOWN"), backend="timefold", wall_sec=round(time.time() - t0, 2))
    return respond(req, opts, set(ans.get("chosen", [])), required, total, ans["status"], "timefold", t0, float(ans.get("objective", 0)), float(ans.get("bound", 0)))


BACKUPS = {"highs": solve_highs, "scip": solve_scip, "greedy": solve_greedy, "timefold": solve_timefold}


def score(req, r):
    return req.w_under * r.under_slots + req.w_over * r.over_slots


BACKUP_MIN_SEC = float(os.environ.get("ENGINE_BACKUP_MIN_SEC", "3"))
BACKUP_MAX_OPTIONS = int(os.environ.get("ENGINE_BACKUP_MAX_OPTIONS", "60000"))


def run_chain(req, prep, pick, primary, t0, cancel=None):
    """Try the solvers in order. Stop at the first good answer; a weak one (nothing but the starting roster) is kept while the next is tried.
    The response lists every attempt, so a fallback is never silent."""
    limit = float(max(1, req.time_limit_sec or 20))
    attempts, best = [], None
    opts = prep[1]
    for name in chain_for(req):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
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
                r = BACKUPS[name](req, prep, pick, t0, limit, cancel)
            else:
                attempts.append(f"{name}: unknown solver")
                continue
        except Cancelled:
            raise
        except MemoryError:
            attempts.append(f"{name}: out of memory")
            continue
        except Exception as e:                                    # a backup must never take the request down with it
            print(f"[engine] solver {name} failed: {type(e).__name__}: {str(e)[:300]}", flush=True)
            attempts.append(f"{name}: failed ({str(e)[:160]})")
            continue
        r.backend = r.backend or name
        # an answer that places nobody while there is demand and there were shifts to choose from is not an answer, whatever status it carries
        empty = r.status in ("OPTIMAL", "FEASIBLE") and not r.assignments and bool(opts) and sum(req.required) > 0
        if empty and name != "greedy":
            # placing nobody is sometimes the true best (the only shifts on offer would add cover nobody needs); it is only wrong when a roster that places people scores better
            try:
                g = BACKUPS["greedy"](req, prep, pick, t0, limit, cancel)
                empty = bool(g.assignments) and score(req, g) < score(req, r)
            except Cancelled:
                raise
            except Exception:
                empty = False
        weak = empty or r.status not in ("OPTIMAL", "FEASIBLE") or (name == "cpsat" and r.status == "FEASIBLE" and r.gap >= 1.0 and bool(pick))
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
    if best is None:
        best = wfm_pb2.ScheduleResponse(status="UNKNOWN")
    del best.attempts[:]
    best.attempts.extend(attempts)
    return best


def _has(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False
