"""Shift assignment with OR-Tools CP-SAT.

The gateway has already turned availability, time off, eligibility and shift-template rules into a list of candidate
shifts (employee x day x template x start). This module chooses which candidates to work so that coverage follows the
forecast's staffing requirement, while every hard rule (one shift a day, rest between shifts, weekly maximum, days in a
row, days per week) always holds. Coverage, contract hours, preferences and weekend fairness are weighed in the objective.
"""
import time
from collections import defaultdict

from ortools.sat.python import cp_model

import wfm_pb2

SPD = 96  # 15-minute slots per day


def paid(o):
    """Slots that count toward weekly hours: the shift without its unpaid meal."""
    return o.paid_slots or o.length_slots


def solve(req):
    t0 = time.time()
    days = req.days
    total = days * SPD
    required = list(req.required) + [0] * max(0, total - len(req.required))
    emps = {e.id: e for e in req.employees}
    opts = list(req.options)

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
        if k <= 0 or k >= days:
            continue
        worked = {d: [x[i] for i in by_ed.get((e, d), [])] for d in range(days)}
        for d0 in range(0, days - k):
            window = [v for d in range(d0, d0 + k + 1) for v in worked[d]]
            if len(window) > k:
                m.Add(sum(window) <= k)

    # weekly hours (hard max, soft contract minimum for weeks fully inside the period) and days per week
    penalties = []
    for e, emp in emps.items():
        weeks = defaultdict(list)
        for i in by_e.get(e, []):
            weeks[(req.first_dow + opts[i].day) // 7].append(i)
        for w, idx in weeks.items():
            if emp.max_week_slots > 0:
                m.Add(sum(paid(opts[i]) * x[i] for i in idx) <= emp.max_week_slots)
            if emp.max_days_week > 0:
                m.Add(sum(x[i] for i in idx) <= emp.max_days_week)
            first = w * 7 - req.first_dow
            full = first >= 0 and first + 6 < days
            if full and emp.min_week_slots > 0 and req.w_hours > 0:
                short = m.NewIntVar(0, emp.min_week_slots, f"short{e}_{w}")
                m.Add(short >= emp.min_week_slots - sum(paid(opts[i]) * x[i] for i in idx))
                penalties.append(req.w_hours * short)

    # coverage: people on shift in each slot against the requirement
    cover = defaultdict(list)
    for i, o in enumerate(opts):
        base = o.day * SPD + o.start_slot
        for g in range(base, min(base + o.length_slots, total)):
            cover[g].append(x[i])
    under_vars, over_vars = [], []
    for g in range(total):
        need = required[g]
        cv = cover.get(g)
        if not cv and need == 0:
            continue
        cap = len(cv) if cv else 0
        under = m.NewIntVar(0, need, f"u{g}")
        over = m.NewIntVar(0, max(cap, 1), f"o{g}")
        m.Add((sum(cv) if cv else 0) + under - over == need)
        under_vars.append(under)
        over_vars.append(over)
    if under_vars:
        penalties.append(req.w_under * sum(under_vars))
        penalties.append(req.w_over * sum(over_vars))

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
                wk[e] = sum(x[i] for i in idx)
        if len(wk) > 1:
            hi, lo = m.NewIntVar(0, days, "wk_hi"), m.NewIntVar(0, days, "wk_lo")
            for v in wk.values():
                m.Add(v <= hi)
                m.Add(v >= lo)
            penalties.append(req.w_fair * (hi - lo))

    m.Minimize(sum(penalties) if penalties else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(max(1, req.time_limit_sec or 20))
    solver.parameters.num_workers = int(req.workers or 8)
    solver.parameters.random_seed = 7           # same input, same schedule
    status = solver.Solve(m)
    name = solver.StatusName(status)

    out = wfm_pb2.ScheduleResponse(status=name, wall_sec=round(time.time() - t0, 2),
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
    return out
