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


MAX_OPTIONS = 300_000


def workers_for(n_options, asked=8):
    """Every solver worker holds its own copy of the model, so memory grows with workers times candidate shifts. Past about 70,000 candidates eight workers can
    exhaust a normal machine and the whole engine process aborts: use fewer workers for a bigger problem instead."""
    cap = 8 if n_options <= 70_000 else 4 if n_options <= 130_000 else 2 if n_options <= 200_000 else 1
    return max(1, min(asked or 8, cap))


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


def greedy(req, emps, opts, by_ed, required, carry):
    """Starting roster by cheapest insertion, in rounds: every person in turn takes the one shift (any day, any length) that most improves the
    objective, until they have their contract shifts or no shift helps. Because each pick looks at all days and counts both shortage and
    surplus, the days balance themselves instead of Monday to Friday filling first."""
    total = req.days * SPD
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

    pos = [0] * (total + 1)                         # pos[s]: how many slots before s are still short
    def refresh():
        for s in range(total):
            pos[s + 1] = pos[s] + (1 if left[s] > 0 else 0)
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
                    g = pos[end] - pos[base]
                    past = max(0, base + o.length_slots - total)      # time past the end of the period is surplus ...
                    if req.wrap and past:                              # ... unless the period repeats: then it covers the first hours again
                        wend = min(past, total)
                        wg = pos[wend] - pos[0]
                        g += wg
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
            on_day[d] += 1
            wk = (week_offset(req) + d) // 7
            wk_slots[(e, wk)] += paid(o)
            wk_days[(e, wk)] += 1
            base = d * SPD + o.start_slot
            for s in range(base, min(base + o.length_slots, total)):
                left[s] -= 1
            if req.wrap:
                for s in range(0, min(base + o.length_slots - total, total)):
                    left[s] -= 1
            refresh()
    return set(chosen.values())


def solve(req, carry=None, weekend_prior=None):
    """Solve one stretch of days. carry maps employee -> days already worked in a row just before day 0; weekend_prior maps
    employee -> weekend shifts worked in the weeks solved before, so fairness is judged over the whole period."""
    t0 = time.time()
    days = req.days
    total = days * SPD
    required = list(req.required) + [0] * max(0, total - len(req.required))
    emps = {e.id: e for e in req.employees}
    # what people worked just before day 0 (previous published schedule): days in a row carry over, and a first shift that starts too soon after
    # a shift that ended after midnight is not an option
    carry = dict(carry or {})
    weekend_prior = weekend_prior or {}
    for e in emps.values():
        if e.prior_run:
            carry.setdefault(e.id, e.prior_run)
    opts = [o for o in req.options if not (o.day == 0 and emps[o.employee].prior_has_end and emps[o.employee].prior_end_slot > o.start_slot - emps[o.employee].rest_slots)]

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
                    m.Add(sum(first) <= span)
        if k >= days:
            continue
        for d0 in range(0, days - k):
            window = [v for d in range(d0, d0 + k + 1) for v in worked[d]]
            if len(window) > k:
                m.Add(sum(window) <= k)

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
                m.Add(sum(paid(opts[i]) * x[i] for i in idx) <= max(0, emp.max_week_slots - done_slots))
            if emp.max_days_week > 0:
                m.Add(sum(x[i] for i in idx) <= max(0, emp.max_days_week - done_days))
            # contract hours: a whole week aims for the full contract; a week the period only partly covers (it starts or ends mid-week)
            # aims for the same share of it, in whole shifts, instead of being ignored
            first = w * 7 - week_offset(req)
            n_days = min(first + 6, days - 1) - max(first, 0) + 1
            # days of this week that came before the schedule count toward it: the contract is for the whole week, less what was already worked
            target = week_target(emp.min_week_slots, n_days + lead, [paid(opts[i]) for i in idx], emp.max_days_week, emp.max_week_slots)
            target = max(0, target - done_slots)
            if target > 0 and req.w_hours > 0:
                short = m.NewIntVar(0, target, f"short{e}_{w}")
                m.Add(short >= target - sum(paid(opts[i]) * x[i] for i in idx))
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
                m.Add(under >= need_s - (sum(heads) if heads else 0))
            m.Add(over >= sum(v for e, v in ce if has[e]) - need_tot) if ce else None
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
        m.Add((sum(cv) if cv else 0) + under - over == need)
        under_vars.append(under)
        hint[g] = (under, over)
        over_vars.append(over)
        heavy(g, over, need, cap)
    if under_vars:
        penalties.append(req.w_under * sum(under_vars))
        penalties.append(req.w_over * sum(over_vars))
        if heavy_vars:
            penalties.append(max(1, req.w_over // 3) * sum(heavy_vars))   # small enough that paying contract hours still wins

    # consistent start and end times: each person gets one usual start and one usual end for the whole period, and a
    # shift may differ from them by at most the tolerance. Required: the shift is not allowed otherwise.
    # Prefer: the shift is allowed but costs w_consist. Both anchors are picked by the solver, per person.
    consist_off = 0
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
            for i in idx:
                v = val(opts[i])
                near = [y[a] for a in anchors if abs(a - v) <= tol]
                if mode == 2:
                    m.Add(sum(near) >= x[i])
                else:
                    off = m.NewBoolVar(f"off{key}{i}")
                    m.Add(sum(near) + off >= x[i])
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
                wk[e] = sum(x[i] for i in idx) + weekend_prior.get(e, 0)
        if len(wk) > 1:
            top = days + max(weekend_prior.values(), default=0)
            hi, lo = m.NewIntVar(0, top, "wk_hi"), m.NewIntVar(0, top, "wk_lo")
            for v in wk.values():
                m.Add(v <= hi)
                m.Add(v >= lo)
            penalties.append(req.w_fair * (hi - lo))
            fair_hint = (hi, lo, wk)

    m.Minimize(sum(penalties) if penalties else 0)
    # starting point for the solver: a greedy roster that already obeys the hard rules. Without it the solver can spend the
    # whole time limit on a large crew without finding any answer.
    pick = greedy(req, emps, opts, by_ed, required, carry)
    for i, v in enumerate(x):
        m.AddHint(v, 1 if i in pick else 0)
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


def solve_period(req, chunk_days=7):
    """Long periods are solved one calendar week at a time: the model grows with people x days x starts, and past two
    weeks the solver can spend the whole time limit preparing it and return nothing. Rest between shifts and days in a
    row are carried across the week boundary, weekly limits already sit inside a calendar week."""
    if req.days <= chunk_days:
        return solve(req)
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
    weekend = defaultdict(int)                  # employee -> weekend shifts in the weeks already solved
    gaps = []
    for d0, n in bounds:
        sub = wfm_pb2.ScheduleRequest()
        sub.CopyFrom(req)
        del sub.required[:]
        del sub.options[:]
        sub.days = n
        sub.first_dow = (req.first_dow + d0) % 7
        sub.required.extend(req.required[d0 * SPD:(d0 + n) * SPD])
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
        r = solve(sub, carry, dict(weekend))
        if r.status not in ("OPTIMAL", "FEASIBLE"):
            out.status = r.status
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
    return out
