"""The schedule validator: an independent check of a roster, made from first principles.

It shares nothing with CP-SAT, HiGHS, SCIP or the greedy start, and does not look at how a roster was made: it is given the shifts (with what people do inside them), the people's
limits, and everything else each person is committed to, and says whether the roster obeys the rules. It is the check a schedule must pass to be published, whichever solver
produced it, and the check the solver tests are judged by.

Findings are HARD (the roster breaks a rule: it must not be published) or SOFT (it can go ahead where policy allows, with the reason on record). A roster can be fully valid and still
understaffed: validity (`status`) and staffing (`coverage_status`) are reported apart, so a schedule that obeys every rule but leaves a queue short is never called perfect.

Hard rules checked: overlapping shifts; more than one shift a day; shifts that clash with anything else the person is committed to (another group's shift, leave, training, a time
they are unavailable); rest between consecutive shifts (across midnight and across groups, in real elapsed time where the clocks change); the most days in a row (counting days worked
for other groups and the run before the period); the most paid hours and days in a week (counting other groups and what was worked earlier in the week) and in a day; overnight and weekend
work for people not allowed it; activities (meals, breaks, training) that fall outside their shift, overlap each other or are of an unknown kind.
Soft findings: hours below the contract or beyond it, uncovered demand per day and per skill, people on shift who hold none of the skills asked for, a meal at the very edge of a shift,
and an unfair spread of weekend and holiday hours.
"""
import time
from collections import defaultdict
from types import SimpleNamespace

from coverage import SPD, consistency_mode, generic_need, signatures, unmet

MAX_FINDINGS = 500

# What each kind of activity usually is: (paid, productive). Productive means the person answers contacts, so it counts toward coverage. A break is paid and counts as covered because the
# group's shrinkage already allows for breaks; a meal and a split-shift gap are unpaid and cover nothing; training and coaching are paid but not on the phones.
ACTIVITY = {
    "WORK": (True, True), "OVERTIME": (True, True), "BREAK": (True, True), "TEA_BREAK": (True, True), "MEAL": (False, False), "SPLIT_GAP": (False, False),
    "TRAINING": (True, False), "COACHING": (True, False), "MEETING": (True, False), "SYSTEM_DOWNTIME": (True, False), "PERSONAL_TIME": (False, False),
}
WORK_COMMITMENTS = ("SHIFT",)                     # kinds that are work for someone else: they count toward hours, days in a row and rest


def _week_offset(first_dow, week_start):
    return (first_dow - week_start) % 7


def _activity_meaning(a):
    return (a.paid, a.productive) if a.explicit else ACTIVITY.get(a.type)


def validate(req):
    import wfm_pb2
    t0 = time.time()
    findings = []
    counts = {"HARD": 0, "SOFT": 0}

    def add(severity, code, employee, day, message, ref=""):
        counts[severity] += 1
        if len(findings) < MAX_FINDINGS * 2:
            findings.append(wfm_pb2.Finding(severity=severity, code=code, employee=employee, day=day, message=message, ref=ref))

    emps = {e.limits.id: e for e in req.employees}
    name = lambda e: (emps[e].name if e in emps and emps[e].name else f"employee {e}")
    spd_total = req.days * SPD
    woff = _week_offset(req.first_dow, req.week_start)
    weekend = lambda day: bool(((req.weekend_mask or 0b1100000) >> ((req.first_dow + day) % 7)) & 1)
    rest_adj = lambda day: req.dst_rest_adjust[day] if 0 <= day < len(req.dst_rest_adjust) else 0

    # plain copies of the shifts: protobuf hands out a new wrapper object each time it is iterated, so nothing here is keyed by object identity
    shifts = [SimpleNamespace(employee=s.employee, day=s.day, start_slot=s.start_slot, length_slots=s.length_slots, paid_slots=s.paid_slots, activities=list(s.activities),
                              unsocial=s.unsocial, ref=s.ref, paid=0, away=set(), ok=False) for s in req.shifts]
    shifts_by = defaultdict(list)
    for s in shifts:
        if s.employee not in emps:
            add("HARD", "UNKNOWN_EMPLOYEE", s.employee, s.day, f"a shift is given to employee {s.employee}, who is not in the request", s.ref)
            continue
        if not 0 <= s.day < req.days or s.length_slots <= 0 or not 0 <= s.start_slot < SPD:
            add("HARD", "BAD_SHIFT", s.employee, s.day, f"{name(s.employee)} has a shift that is not inside the period (day {s.day}, from slot {s.start_slot}, {s.length_slots} slots)", s.ref)
            continue
        s.ok = True
        shifts_by[s.employee].append(s)

    # ---- activities: inside the shift, not on top of each other, of a known kind; and what each shift pays and covers
    for s in shifts:
        if not s.ok:
            continue
        lo, hi = s.start_slot, s.start_slot + s.length_slots
        unpaid, unproductive, spans = 0, set(), []
        for a in s.activities:
            meaning = _activity_meaning(a)
            if meaning is None:
                add("HARD", "UNKNOWN_ACTIVITY", s.employee, s.day, f"{name(s.employee)} on day {s.day + 1}: '{a.type}' is not a kind of activity the validator knows", s.ref)
                continue
            if a.slots <= 0 or a.start_slot < lo or a.start_slot + a.slots > hi:
                add("HARD", "ACTIVITY_OUTSIDE_SHIFT", s.employee, s.day, f"{name(s.employee)} on day {s.day + 1}: {a.type.lower()} at slot {a.start_slot} ({a.slots} slots) is not inside the shift (slots {lo} to {hi})", s.ref)
                continue
            for b0, b1, bt in spans:
                if a.start_slot < b1 and b0 < a.start_slot + a.slots:
                    add("HARD", "ACTIVITY_OVERLAP", s.employee, s.day, f"{name(s.employee)} on day {s.day + 1}: {a.type.lower()} overlaps {bt.lower()}", s.ref)
            spans.append((a.start_slot, a.start_slot + a.slots, a.type))
            paid, productive = meaning
            if not paid:
                unpaid += a.slots
            if not productive:
                unproductive.update(range(a.start_slot, a.start_slot + a.slots))
            if a.type in ("MEAL", "SPLIT_GAP") and (a.start_slot == lo or a.start_slot + a.slots == hi):
                add("SOFT", "ACTIVITY_AT_EDGE", s.employee, s.day, f"{name(s.employee)} on day {s.day + 1}: the {a.type.lower().replace('_', ' ')} is at the very start or end of the shift, which is not a break in it", s.ref)
        s.paid = s.paid_slots if s.paid_slots and not s.activities else max(0, s.length_slots - unpaid)
        s.away = unproductive

    # ---- everything each person has on, as intervals on one timeline (slots from the start of day 0)
    def interval(day, start, length):
        a = day * SPD + start
        return a, a + length

    commitments = defaultdict(list)
    for c in req.commitments:
        if c.employee in emps and c.length_slots > 0:
            commitments[c.employee].append(c)

    for e, emp in emps.items():
        lim = emp.limits
        mine = sorted(shifts_by.get(e, []), key=lambda s: (s.day, s.start_slot))
        # one shift a day, and no two shifts overlapping
        spans = [(interval(s.day, s.start_slot, s.length_slots), s) for s in mine]
        for i in range(len(spans)):
            for j in range(i + 1, len(spans)):
                (a0, a1), sa = spans[i]
                (b0, b1), sb = spans[j]
                if b0 >= a1:
                    break
                add("HARD", "OVERLAP", e, sb.day, f"{name(e)} has two shifts at the same time on day {sb.day + 1}", sb.ref)
        by_day = defaultdict(list)
        for s in mine:
            by_day[s.day].append(s)
        for d, ss in by_day.items():
            if len(ss) > 1 and not any(x for x in findings if x.code == "OVERLAP" and x.employee == e and x.day == d):
                add("HARD", "DOUBLE_SHIFT_DAY", e, d, f"{name(e)} has {len(ss)} shifts on day {d + 1} (one shift a day)", ss[1].ref)
        # clashes with other commitments
        others = sorted(commitments.get(e, []), key=lambda c: (c.day, c.start_slot))
        for (a0, a1), s in spans:
            for c in others:
                c0, c1 = interval(c.day, c.start_slot, c.length_slots)
                if c0 < a1 and a0 < c1:
                    add("HARD", "COMMITMENT_CLASH", e, s.day, f"{name(e)} on day {s.day + 1} is {c.label or c.kind.lower()} at the same time ({c.kind.lower()})", s.ref)
        # rest: between the end of any piece of work and the start of the next, across groups
        work = sorted([(a0, a1, s.day, s, None) for (a0, a1), s in spans] + [(*interval(c.day, c.start_slot, c.length_slots), c.day, None, c) for c in others if c.kind in WORK_COMMITMENTS], key=lambda w: (w[0], w[1]))
        for k in range(1, len(work)):
            p0, p1, _pd, ps, pc = work[k - 1]
            n0, n1, nd, ns, nc = work[k]
            if ps is None and ns is None:
                continue                                 # two things for other groups: not this roster's concern
            need = max(0, lim.rest_slots + rest_adj(nd))
            gap = n0 - p1
            if 0 <= gap < need:
                who = (ns or ps)
                add("HARD", "REST", e, nd, f"{name(e)} has {gap / 4:g} hours between shifts before day {nd + 1} and needs {need / 4:g}" + (f" ({(pc or nc).label or 'another group'})" if (pc or nc) else ""), who.ref)
        if lim.prior_has_end and mine:
            first = mine[0]
            gap = first.day * SPD + first.start_slot - lim.prior_end_slot
            need = max(0, lim.rest_slots + rest_adj(first.day))
            if gap < need and first.day == 0:
                add("HARD", "REST", e, 0, f"{name(e)} starts day 1 {max(gap, 0) / 4:g} hours after the last shift of the schedule before and needs {need / 4:g}", first.ref)
        # days in a row (days worked for other groups count, and so does the run before the period)
        worked = {s.day for s in mine} | {c.day for c in others if c.kind in WORK_COMMITMENTS} | {d for d, v in enumerate(lim.ext_paid) if v > 0}
        run = lim.prior_run
        for d in range(req.days):
            if d in worked:
                run += 1
                if lim.max_consecutive > 0 and run == lim.max_consecutive + 1 and d in by_day:             # once for each run that goes past the limit
                    add("HARD", "CONSECUTIVE_DAYS", e, d, f"{name(e)} works {run} days in a row (at most {lim.max_consecutive})", by_day[d][0].ref)
            else:
                run = 0
        # hours and days in each pay week; the day's hours
        weeks = defaultdict(lambda: [0, 0, set()])         # week -> [paid slots, (unused), days seen]
        own_weeks = {(woff + s.day) // 7 for s in mine}     # weeks this roster puts the person to work in: the others are not judged here
        # days off side by side: a pay week that lies wholly inside the period needs a block of them (days worked for other groups and approved leave count as worked / off as above)
        need_off = lim.min_days_off_together
        if 0 < need_off <= 7:
            for wk in sorted(own_weeks):
                first_day = wk * 7 - woff
                if first_day < 0 or first_day + 6 > req.days - 1:
                    continue
                best = run_off = 0
                for d in range(first_day, first_day + 7):
                    run_off = 0 if d in worked else run_off + 1
                    best = max(best, run_off)
                if best < need_off:
                    add("HARD", "DAYS_OFF_TOGETHER", e, first_day, f"{name(e)} has at most {best} {'day' if best == 1 else 'days'} off together in the week from day {first_day + 1} (needs {need_off})")
        # full weekends off in a calendar month: judged for a month the roster puts the person to work in (days worked for other groups count as worked)
        mine_days = {s.day for s in mine}
        for mi, month in enumerate(req.weekend_months):
            need = lim.weekend_need[mi] if mi < len(lim.weekend_need) else 0
            if need <= 0 or not any(month.first_day <= d <= month.last_day for d in mine_days):
                continue
            sets = [list(w.days) for w in month.weekends if w.days]
            need = min(need, len(sets))
            off = sum(1 for days in sets if not any(d in worked for d in days))
            if off < need:
                add("HARD", "WEEKENDS_OFF", e, month.first_day, f"{name(e)} has {off} full {'weekend' if off == 1 else 'weekends'} off in the stretch from day {month.first_day + 1} (needs {need})")
        for s in mine:
            w = weeks[(woff + s.day) // 7]
            w[0] += s.paid
            w[2].add(s.day)
        for c in others:
            if c.kind in WORK_COMMITMENTS:
                w = weeks[(woff + c.day) // 7]
                w[0] += c.paid_slots or c.length_slots
                w[2].add(c.day)
        for d, v in enumerate(lim.ext_paid):
            if v > 0 and not any(c.day == d and c.kind in WORK_COMMITMENTS for c in others):
                w = weeks[(woff + d) // 7]
                w[0] += v
                w[2].add(d)
        overtime = 0
        for wk, (paid, _, days_in) in sorted(weeks.items()):
            if wk not in own_weeks:
                continue
            before_slots, before_days, lead = (lim.prior_week_slots, lim.prior_week_days, lim.prior_lead_days) if wk == 0 else (0, 0, 0)
            total, ndays = paid + before_slots, len(days_in) + before_days
            first_day = wk * 7 - woff
            where = max(first_day, 0)
            if lim.max_week_slots > 0 and total > lim.max_week_slots:
                add("HARD", "WEEKLY_MAX", e, where, f"{name(e)} works {total / 4:g} hours in the week from day {where + 1} (at most {lim.max_week_slots / 4:g})")
            if lim.max_days_week > 0 and ndays > lim.max_days_week:
                add("HARD", "DAYS_PER_WEEK", e, where, f"{name(e)} works {ndays} days in the week from day {where + 1} (at most {lim.max_days_week})")
            n_days = min(first_day + 6, req.days - 1) - max(first_day, 0) + 1
            if lim.min_week_slots > 0 and n_days + lead >= 7:                        # a week the period covers completely
                if total < lim.min_week_slots:
                    add("SOFT", "BELOW_CONTRACT", e, where, f"{name(e)} has {total / 4:g} paid hours in the week from day {where + 1}, below their contract of {lim.min_week_slots / 4:g}")
                elif total > lim.min_week_slots:
                    overtime += total - lim.min_week_slots
                    add("SOFT", "OVERTIME", e, where, f"{name(e)} has {(total - lim.min_week_slots) / 4:g} hours of overtime in the week from day {where + 1}")
        if emp.max_day_slots > 0:
            per_day = defaultdict(int)
            for s in mine:
                per_day[s.day] += s.paid
            for c in others:
                if c.kind in WORK_COMMITMENTS:
                    per_day[c.day] += c.paid_slots or c.length_slots
            for d, v in per_day.items():
                if v > emp.max_day_slots and d in by_day:
                    add("HARD", "DAILY_MAX", e, d, f"{name(e)} works {v / 4:g} hours on day {d + 1} (at most {emp.max_day_slots / 4:g})", by_day[d][0].ref)
        for s in mine:
            if not emp.allow_overnight and s.start_slot + s.length_slots > SPD:
                add("HARD", "OVERNIGHT_NOT_ALLOWED", e, s.day, f"{name(e)} is not allowed shifts that run past midnight (day {s.day + 1})", s.ref)
            if not emp.allow_weekend and weekend(s.day):
                add("HARD", "WEEKEND_NOT_ALLOWED", e, s.day, f"{name(e)} does not work weekends (day {s.day + 1})", s.ref)

    # ---- required shift consistency: a person who must keep one usual start and one usual end has every shift within the tolerance of them. With no usual times given, "within the
    # tolerance of one time" means the starts (and the ends) lie no further apart than twice the tolerance; with usual times given (from the weeks solved before), each shift is
    # within the tolerance of those
    hm = lambda slot: f"{(slot % SPD) // 4:02d}:{(slot % 4) * 15:02d}"
    for e, emp in emps.items():
        if consistency_mode(req.consistency_mode, emp.limits.consist_mode) != 2:
            continue
        mine = sorted(shifts_by.get(e, []), key=lambda s: (s.day, s.start_slot))
        for what, tol, usual, val in (("start", req.start_tol_slots, emp.limits.anchor_start, lambda s: s.start_slot), ("end", req.end_tol_slots, emp.limits.anchor_end, lambda s: s.start_slot + s.length_slots)):
            vals = [val(s) for s in mine]
            if not vals:
                continue
            if emp.limits.has_anchor:
                bad = next((s for s in mine if abs(val(s) - usual) > tol), None)
                detail = f"usual {what} {hm(usual)}" if bad else ""
            else:
                lo, hi = min(vals), max(vals)
                bad = next((s for s in mine if val(s) - lo > 2 * tol), None) if hi - lo > 2 * tol else None
                detail = f"{what} times from {hm(lo)} to {hm(hi)}" if bad else ""
            if bad is not None:
                add("HARD", "CONSISTENCY", e, bad.day, f"{name(e)} must keep one usual {what} time (within {tol / 4:g} hours) but works {detail} (day {bad.day + 1})", bad.ref)

    # ---- cover: only what people do productively counts; per skill when the queues need different skills
    skill_req = {k.id: list(k.required) + [0] * max(0, spd_total - len(k.required)) for k in req.skill_requirements}
    required = list(req.required) + [0] * max(0, spd_total - len(req.required))
    on = defaultdict(lambda: defaultdict(int))
    heads = defaultdict(int)
    sig = signatures({e: emp.limits for e, emp in emps.items()}, skill_req) if skill_req else {}
    for s in shifts:
        if not s.ok:
            continue
        away = s.away
        for k in range(s.start_slot, s.start_slot + s.length_slots):
            if k in away:
                continue
            g = s.day * SPD + k
            if g >= spd_total:
                if not req.wrap:
                    continue
                g -= spd_total
            heads[g] += 1
            if skill_req and sig.get(s.employee):
                on[g][sig[s.employee]] += 1
    day_rows = []
    under_total = over_total = need_total = 0
    for d in range(req.days):
        req_d = under_d = over_d = 0
        for k in range(SPD):
            g = d * SPD + k
            if skill_req:
                need = {x: skill_req[x][g] for x in skill_req if skill_req[x][g] > 0}
                extra = generic_need(required[g], need)            # the part of the total any person on shift can serve
                need_sum = sum(need.values()) + extra
                skilled = sum(on[g].values()) if g in on else 0
                u = unmet(need, on[g] if g in on else {}, extra, max(0, heads.get(g, 0) - skilled))
                o = max(0, heads.get(g, 0) - need_sum)
            else:
                need_sum = required[g]
                u = max(0, need_sum - heads.get(g, 0))
                o = max(0, heads.get(g, 0) - need_sum)
            req_d += need_sum
            under_d += u
            over_d += o
        pct = 100.0 if req_d == 0 else round(100.0 * (1 - under_d / req_d), 2)
        day_rows.append((d, req_d, under_d, over_d, pct))
        under_total += under_d
        over_total += over_d
        need_total += req_d
        target = (req.target_coverage or 0) * 100
        if under_d and (pct < target if target else True):
            add("SOFT", "COVERAGE_SHORT", 0, d, f"day {d + 1} is {under_d / 4:g} person-hours short of what is needed ({pct:g}% covered)")
    if skill_req:
        for k, arr in skill_req.items():
            lack = 0
            for g in range(spd_total):
                if arr[g] > 0:
                    have = sum(n for s_, n in on[g].items() if k in s_) if g in on else 0
                    lack += max(0, arr[g] - have)
            if lack:
                add("SOFT", "SKILL_SHORT", 0, 0, f"skill {k} is {lack / 4:g} person-hours short even if everyone who holds it served it all the time")
        for e, ss in shifts_by.items():
            if not sig.get(e) and ss:
                add("SOFT", "NO_USEFUL_SKILL", e, ss[0].day, f"{name(e)} is on shift {len(ss)} times but holds none of the skills asked for, so covers nothing of them", ss[0].ref)

    # ---- per person load and the fairness of weekend and holiday hours
    loads, unsocial = [], {}
    for e, emp in emps.items():
        ss = shifts_by.get(e, [])
        hours = sum(max(1, round(s.paid / 4)) for s in ss if s.unsocial or weekend(s.day))
        unsocial[e] = hours
        ot = 0
        wk = defaultdict(int)
        for s in ss:
            wk[(woff + s.day) // 7] += s.paid
        for w, v in wk.items():
            first_day = w * 7 - woff
            n_days = min(first_day + 6, req.days - 1) - max(first_day, 0) + 1
            lead = emp.limits.prior_lead_days if w == 0 else 0
            if emp.limits.min_week_slots > 0 and n_days + lead >= 7 and v > emp.limits.min_week_slots:
                ot += v - emp.limits.min_week_slots
        loads.append(wfm_pb2.EmployeeLoad(employee=e, shifts=len(ss), paid_slots=sum(s.paid for s in ss), unsocial_hours=hours, overtime_slots=ot))
    able = [h for e, h in unsocial.items() if emps[e].allow_weekend]
    spread = (max(able) - min(able)) if len(able) > 1 else 0
    tolerance = req.fairness_tolerance_hours or 16
    if spread > tolerance:
        top = max(unsocial, key=lambda e: unsocial[e] if emps[e].allow_weekend else -1)
        add("SOFT", "UNFAIR_WEEKEND_LOAD", top, 0, f"weekend and holiday hours are spread unevenly: {name(top)} has {unsocial[top]} hours and the lightest load is {min(able)} (more than {tolerance} apart)")

    findings.sort(key=lambda f: (f.severity != "HARD", f.code, f.employee, f.day))
    coverage_status = "UNDERSTAFFED" if under_total > 0 else "ADEQUATE"
    status = "INVALID" if counts["HARD"] else "VALIDATED_WITH_WARNINGS" if counts["SOFT"] else "VALIDATED"
    out = wfm_pb2.ValidateResponse(valid=counts["HARD"] == 0, status=status, coverage_status=coverage_status, hard_violations=counts["HARD"], soft_warnings=counts["SOFT"],
                                   under_slots=under_total, over_slots=over_total, coverage_percent=100.0 if need_total == 0 else round(100.0 * (1 - under_total / need_total), 2),
                                   fairness_spread_hours=spread, wall_sec=round(time.time() - t0, 3))
    out.findings.extend(findings[:MAX_FINDINGS])
    for d, r, u, o, p in day_rows:
        out.days.add(day=d, required_slots=r, under_slots=u, over_slots=o, coverage_percent=p)
    out.loads.extend(loads)
    return out
