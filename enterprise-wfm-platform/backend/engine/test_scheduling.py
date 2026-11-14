"""Scheduling tests: the solver's answer is re-checked against the rules by code that does not share the model."""
from collections import defaultdict

import pytest
import scheduling
import wfm_pb2

SPD = 96
CURVE = [0, 0, 0, 0, 1, 2, 4, 8, 12, 15, 16, 15, 12, 13, 15, 14, 12, 10, 7, 4, 2, 1, 0, 0]  # people needed per hour


def build(n_emp=14, days=7, first_dow=0, starts=(20, 28, 36, 44, 52, 60), length=32, weekend=False):
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=first_dow, time_limit_sec=10, w_under=100, w_over=10, w_hours=20, w_pref=2, w_fair=5, workers=4)
    for d in range(days):
        for s in range(SPD):
            req.required.append(int(CURVE[s // 4] * (0.4 if (first_dow + d) % 7 >= 5 else 1) * n_emp * 0.5 / 16))
    for e in range(n_emp):
        req.employees.add(id=e, max_week_slots=40 * 4, min_week_slots=32 * 4, max_consecutive=5, rest_slots=44, max_days_week=5)
        for d in range(days):
            if (first_dow + d) % 7 >= 5 and not weekend:
                continue
            for t, st in enumerate(starts):
                req.options.add(employee=e, day=d, template=t, start_slot=st, length_slots=length, preference=0)
    return req


def check(req, res):
    """Independent verification of every hard rule."""
    per = defaultdict(dict)
    for a in res.assignments:
        assert (a.day) not in per[a.employee], "two shifts on one day"
        per[a.employee][a.day] = a
    emps = {e.id: e for e in req.employees}
    for e, shifts in per.items():
        emp = emps[e]
        weeks = defaultdict(lambda: [0, 0])
        for d, a in shifts.items():
            w = weeks[(req.first_dow + d) // 7]
            w[0] += a.length_slots
            w[1] += 1
            if d + 1 in shifts:
                gap = SPD + shifts[d + 1].start_slot - (a.start_slot + a.length_slots)
                assert gap >= emp.rest_slots, f"rest {gap} < {emp.rest_slots}"
        for slots, n in weeks.values():
            assert slots <= emp.max_week_slots and n <= emp.max_days_week
        days_sorted = sorted(shifts)
        run = 1
        for a, b in zip(days_sorted, days_sorted[1:]):
            run = run + 1 if b == a + 1 else 1
            assert run <= emp.max_consecutive, "too many days in a row"


def test_covers_the_forecast_and_respects_every_rule():
    req = build()
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    check(req, res)
    need = sum(req.required)
    assert res.under_slots <= 0.15 * need, f"{res.under_slots} of {need} person-slots uncovered"
    assert res.assignments


def test_no_option_means_no_shift_and_full_shortfall():
    req = build()
    del req.options[:]
    res = scheduling.solve(req)
    assert len(res.assignments) == 0 and res.under_slots == sum(req.required)


def test_weekday_offset_and_weekend_fairness():
    req = build(first_dow=3, days=14, weekend=True)   # starts on a Thursday, two weekends
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    check(req, res)
    wk = defaultdict(int)
    for a in res.assignments:
        if (req.first_dow + a.day) % 7 >= 5:
            wk[a.employee] += 1
    if wk:
        assert max(wk.values()) - min(list(wk.values()) + [0] * (14 - len(wk))) <= 4


def test_same_input_same_schedule():
    a = scheduling.solve(build(n_emp=8))
    b = scheduling.solve(build(n_emp=8))
    key = lambda r: sorted((x.employee, x.day, x.template) for x in r.assignments)
    assert a.objective == b.objective
    assert key(a) == key(b) or a.status != "OPTIMAL"  # ties may differ only when the answer is not proven optimal


def starts_by_person(res):
    per = defaultdict(set)
    for a in res.assignments:
        per[a.employee].add(a.start_slot)
    return per


def test_required_consistency_gives_everyone_one_start_time():
    req = build()
    req.consistency_mode, req.start_tol_slots, req.end_tol_slots = 2, 0, 0
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE") and len(res.assignments) > 0
    check(req, res)
    assert all(len(s) == 1 for s in starts_by_person(res).values())


def test_required_consistency_tolerance_is_respected():
    req = build()
    req.consistency_mode, req.start_tol_slots, req.end_tol_slots = 2, 4, 4   # +/- 1 hour
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    for s in starts_by_person(res).values():
        assert max(s) - min(s) <= 8        # two shifts can sit at opposite edges of the band


def test_prefer_consistency_reduces_start_time_changes():
    plain = scheduling.solve(build())
    req = build()
    req.consistency_mode, req.start_tol_slots, req.end_tol_slots, req.w_consist = 1, 0, 0, 200
    pref = scheduling.solve(req)
    check(req, pref)
    spread = lambda r: sum(len(s) - 1 for s in starts_by_person(r).values())
    assert spread(pref) <= spread(plain)


def test_three_weeks_with_a_large_crew_still_gets_a_schedule():
    req = build(n_emp=120, days=21, first_dow=3, weekend=True)
    req.time_limit_sec = 45
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert len(res.assignments) > 0
    check(req, res)


def test_one_person_can_be_required_to_keep_one_start_while_others_are_free():
    req = build()
    req.employees[0].consist_mode = 3          # require, for this person only
    res = scheduling.solve(req)
    check(req, res)
    per = starts_by_person(res)
    assert len(per.get(0, {0})) <= 1


def test_per_person_off_overrides_a_required_default():
    req = build(n_emp=6)
    req.consistency_mode = 2
    for e in req.employees:
        e.consist_mode = 1                      # off for everyone: the default must not apply
    res = scheduling.solve(req)
    free = scheduling.solve(build(n_emp=6))
    assert res.under_slots <= free.under_slots + 1


def skills_request(n_emp=10, a_need=3, b_need=3):
    """Half the people hold skill 1, half skill 2; every slot of day 0 needs a_need of skill 1 and b_need of skill 2."""
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=10, w_under=100, w_over=10, workers=2)
    ra, rb = req.skill_requirements.add(id=1), req.skill_requirements.add(id=2)
    for s in range(SPD):
        on = 1 if 32 <= s < 64 else 0
        ra.required.append(a_need * on)
        rb.required.append(b_need * on)
        req.required.append((a_need + b_need) * on)
    for e in range(n_emp):
        emp = req.employees.add(id=e, max_week_slots=40 * 4, min_week_slots=0, max_consecutive=5, rest_slots=44, max_days_week=5)
        emp.skill_ids.append(1 if e < n_emp // 2 else 2)
        req.options.add(employee=e, day=0, template=0, start_slot=32, length_slots=32, preference=0)
    return req


def test_coverage_is_judged_per_skill():
    res = scheduling.solve(skills_request())
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert res.under_slots == 0, "5 people per skill can cover 3 + 3"
    assert len(res.assignments) >= 6


def test_a_skill_with_too_few_people_stays_short_even_when_headcount_is_enough():
    req = skills_request(n_emp=10, a_need=7, b_need=1)    # 8 needed in total and 10 people, but only 5 hold skill 1
    res = scheduling.solve(req)
    assert res.under_slots > 0, "headcount alone would have hidden this shortage"


# ---- contract hours in a week the period only partly covers

def contract_request(days, first_dow, n_emp=8, contract_h=40, max_days=5):
    """Nobody is needed anywhere, so the only reason to work is the contract: a shift costs for overstaffing and pays back only through the contract target."""
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=first_dow, time_limit_sec=30, w_under=900, w_over=30, w_hours=50, w_pref=0, w_fair=0, workers=2)
    req.required.extend([0] * (days * SPD))
    for e in range(n_emp):
        req.employees.add(id=e, max_week_slots=40 * 4, min_week_slots=contract_h * 4, max_consecutive=6, rest_slots=44, max_days_week=max_days)
        for d in range(days):
            req.options.add(employee=e, day=d, template=0, start_slot=32, length_slots=34, paid_slots=32)
    return req


def shifts_by_day(res):
    per = defaultdict(set)
    for a in res.assignments:
        per[a.employee].add(a.day)
    return per


def test_week_target_scales_a_part_week_in_whole_shifts():
    wt = scheduling.week_target
    eight = [32] * 5                                        # 8 paid hours a shift
    assert wt(160, 7, eight) == 160                         # a whole week: the full contract, as before
    assert wt(160, 6, eight) == 128                         # six of seven days: four shifts, not five
    assert wt(160, 1, eight) == 0                           # a single Sunday: nothing worth pushing for
    assert wt(160, 4, eight) == 64                          # 4/7 of 40 h is 22.9 h: two whole shifts
    assert wt(80, 6, eight) == 64                           # a 20 h part-timer: 17 h, two shifts
    assert wt(160, 6, eight, max_days_week=3) == 96         # never more shifts than the person may work
    assert wt(160, 6, eight, max_week_slots=100) == 96      # nor more hours than their weekly maximum
    assert wt(160, 6, []) == 0 and wt(0, 6, eight) == 0 and wt(160, 0, eight) == 0


def test_a_schedule_starting_on_sunday_still_gives_people_their_contract_in_the_part_weeks():
    req = contract_request(days=7, first_dow=6)             # Sunday, then Monday to Saturday
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    per = shifts_by_day(res)
    assert len(per) == 8, "everybody is given work"
    for e, days_worked in per.items():
        assert 0 not in days_worked, "a one-day week asks for nothing, so nobody is pushed into the Sunday"
        assert len(days_worked) == 4, f"person {e} works {len(days_worked)} days in the six-day week"


def test_a_schedule_starting_on_monday_is_unchanged():
    res = scheduling.solve(contract_request(days=7, first_dow=0))
    per = shifts_by_day(res)
    assert len(per) == 8 and all(len(d) == 5 for d in per.values())


def test_a_long_period_from_a_sunday_gets_each_week_its_share():
    req = contract_request(days=14, first_dow=6, n_emp=6)   # Sun | Mon-Sun | Mon-Sat
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    for e, d in shifts_by_day(res).items():
        assert 0 not in d
        assert len([x for x in d if 1 <= x <= 7]) == 5, "the whole middle week gets the full contract"
        assert len([x for x in d if x >= 8]) == 4, "the last six-day week gets four shifts"


def test_a_person_who_cannot_work_the_part_week_does_not_make_it_infeasible():
    req = contract_request(days=7, first_dow=6, n_emp=3)
    keep = [o for o in req.options if not (o.employee == 0 and o.day >= 1)]      # person 0 has no possible shift Monday to Saturday
    del req.options[:]
    req.options.extend(keep)
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    per = shifts_by_day(res)
    assert 0 not in per and all(len(per[e]) == 4 for e in (1, 2))


# ---- what people worked just before the schedule starts (previous published schedule)

def history_request(days=4, first_dow=0, n_emp=3, need=1):
    """Everyone is needed all day on every day, so a person is only left out when a rule keeps them out."""
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=first_dow, time_limit_sec=20, w_under=900, w_over=30, w_hours=50, w_pref=0, w_fair=0, workers=2)
    req.required.extend([need] * (days * SPD))
    for e in range(n_emp):
        req.employees.add(id=e, max_week_slots=40 * 4, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5)
        for d in range(days):
            for st in (20, 80):
                req.options.add(employee=e, day=d, template=0, start_slot=st, length_slots=32, paid_slots=32)
    return req


def test_rest_after_a_night_shift_carries_into_the_first_day():
    req = history_request(days=1, n_emp=1)
    emp = req.employees[0]
    emp.prior_has_end, emp.prior_end_slot = True, 20          # the last shift ended at 05:00 on day 0; 11 hours of rest means no start before 16:00 (slot 64)
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert res.assignments and all(a.start_slot >= 64 for a in res.assignments), [a.start_slot for a in res.assignments]


def test_a_shift_that_ended_long_ago_blocks_nothing():
    req = history_request(days=1, n_emp=1)
    emp = req.employees[0]
    emp.prior_has_end, emp.prior_end_slot = True, -60         # ended the evening before
    res = scheduling.solve_period(req)
    assert {a.start_slot for a in res.assignments} <= {20, 80} and res.assignments


def test_days_in_a_row_continue_across_the_boundary():
    req = history_request(days=2, n_emp=1)
    emp = req.employees[0]
    emp.max_consecutive, emp.prior_run = 3, 2                  # two days already worked: one more is allowed, not two
    res = scheduling.solve_period(req)
    assert len({a.day for a in res.assignments}) <= 1, [a.day for a in res.assignments]


def test_hours_already_worked_this_week_count_against_the_weekly_maximum():
    req = history_request(days=4, first_dow=3, n_emp=1)       # starts on a Thursday
    emp = req.employees[0]
    emp.max_week_slots = 80                                    # 20 h a week
    emp.prior_week_slots, emp.prior_week_days, emp.prior_lead_days = 48, 2, 3    # Mon-Wed already used 12 h
    res = scheduling.solve_period(req)
    assert sum(a.length_slots for a in res.assignments) <= 80 - 48, "the week's maximum was exceeded once the earlier days are counted"


def test_days_already_worked_this_week_count_against_days_per_week():
    req = history_request(days=4, first_dow=3, n_emp=1)
    emp = req.employees[0]
    emp.max_days_week = 3
    emp.prior_week_slots, emp.prior_week_days, emp.prior_lead_days = 64, 2, 3
    res = scheduling.solve_period(req)
    assert len(res.assignments) <= 1


def test_contract_hours_count_what_was_worked_earlier_in_the_week():
    # Thursday start, nobody needed: the contract is the only reason to work. 40 h contract, 24 h already worked Mon-Wed -> about 16 h more (2 shifts), not 5 days.
    req = contract_request(days=4, first_dow=3, n_emp=4, contract_h=40, max_days=5)
    for e in req.employees:
        e.prior_week_slots, e.prior_week_days, e.prior_lead_days = 24 * 4 * 32 // 96 * 3, 3, 3   # three 8-hour shifts
    res = scheduling.solve_period(req)
    per = shifts_by_day(res)
    assert all(len(d) == 2 for d in per.values()) and len(per) == 4, per


def test_no_history_changes_nothing():
    plain = scheduling.solve_period(contract_request(days=4, first_dow=3, n_emp=4))
    req = contract_request(days=4, first_dow=3, n_emp=4)       # prior fields left at zero
    again = scheduling.solve_period(req)
    # two separate multi-worker solves may pick different but equally good rosters under load, so compare the outcome, not the exact people
    assert (plain.under_slots, plain.over_slots, len(plain.assignments)) == (again.under_slots, again.over_slots, len(again.assignments))


# ---- a period that repeats, shift lengths that vary, a starting roster that spreads the days

def wrap_request(wrap):
    req = wfm_pb2.ScheduleRequest(days=7, first_dow=0, time_limit_sec=20, w_under=900, w_over=30, w_hours=0, w_pref=0, w_fair=0, workers=2, wrap=wrap)
    req.required.extend([1 if s < 20 else 0 for s in range(SPD)] + [0] * (6 * SPD))        # one person on the phones from midnight to 05:00 on Monday only
    req.employees.add(id=1, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5)
    req.options.add(employee=1, day=6, template=0, start_slot=84, length_slots=34, paid_slots=32)   # Sunday 21:00 to Monday 05:30
    return req


def test_a_repeating_week_counts_the_last_night_for_the_first_hours():
    plain = scheduling.solve(wrap_request(False))
    assert plain.under_slots == 20, "without the repeat, Monday's first hours have nobody"
    wrapped = scheduling.solve(wrap_request(True))
    assert wrapped.under_slots == 0 and len(wrapped.assignments) == 1, (wrapped.under_slots, len(wrapped.assignments))


def test_a_shorter_shift_is_chosen_when_less_cover_is_needed():
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=10, w_under=900, w_over=30, w_hours=0, workers=2)
    req.required.extend([1 if 32 <= s < 48 else 0 for s in range(SPD)])                  # four hours, 08:00 to 12:00
    req.employees.add(id=1, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5)
    for length in (16, 24, 34):
        req.options.add(employee=1, day=0, template=0, start_slot=32, length_slots=length, paid_slots=length - (2 if length > 16 else 0))
    res = scheduling.solve(req)
    assert [a.length_slots for a in res.assignments] == [16] and res.over_slots == 0


def test_the_starting_roster_spreads_days_instead_of_filling_the_early_week():
    req = build(n_emp=30, days=7, first_dow=0, weekend=True)
    req.time_limit_sec = 3
    for e in req.employees:
        e.min_week_slots = 40 * 4
    emps = {e.id: e for e in req.employees}
    opts = list(req.options)
    by_ed = defaultdict(list)
    for i, o in enumerate(opts):
        by_ed[(o.employee, o.day)].append(i)
    pick = scheduling.greedy(req, emps, opts, by_ed, list(req.required), {})
    per_day = [sum(1 for i in pick if opts[i].day == d) for d in range(7)]
    assert min(per_day) > 0, f"a day was left without anyone: {per_day}"        # weekends need fewer people here, but not nobody
    weekdays = per_day[:5]
    assert max(weekdays) <= min(weekdays) + 4, f"the weekdays are uneven: {per_day}"
    per_person = defaultdict(int)
    for i in pick:
        per_person[opts[i].employee] += 1
    assert max(per_person.values()) <= 5, "nobody works more than their days per week"


def test_a_big_problem_gets_fewer_workers_so_the_engine_does_not_run_out_of_memory():
    assert scheduling.workers_for(10_000) == 8
    assert scheduling.workers_for(70_000) == 8
    assert scheduling.workers_for(100_000) == 4
    assert scheduling.workers_for(150_000) == 2
    assert scheduling.workers_for(250_000) == 1
    assert scheduling.workers_for(10_000, asked=2) == 2, "never more than asked for"
    assert scheduling.workers_for(10_000, asked=0) == 8


def test_a_last_night_that_runs_past_the_end_counts_as_surplus_unless_the_week_repeats():
    def request(wrap):
        req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=10, w_under=900, w_over=30, w_hours=0, workers=2, wrap=wrap)
        req.required.extend([1 if 84 <= s < 94 else 0 for s in range(SPD)])
        req.employees.add(id=1, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5)
        req.options.add(employee=1, day=0, template=0, start_slot=84, length_slots=34, paid_slots=32)   # runs 22 slots past midnight
        req.options.add(employee=1, day=0, template=1, start_slot=70, length_slots=24, paid_slots=24)   # covers the same hours, ends at 94, and wastes less
        return req
    plain = scheduling.solve(request(False))
    assert [a.template for a in plain.assignments] == [1], "the shift that ends inside the period is the cheaper one"
    wrapped = scheduling.solve(request(True))
    assert wrapped.under_slots == 0 and len(wrapped.assignments) == 1


def test_time_limit_is_respected_including_model_build():
    req = build(n_emp=200, days=7, weekend=True)
    req.time_limit_sec = 10
    res = scheduling.solve_period(req)
    assert res.wall_sec < 10 * 1.4, res.wall_sec


def test_a_solver_that_finds_nothing_still_returns_the_starting_roster():
    req = build(n_emp=60, days=7)
    req.time_limit_sec = 1
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE") and len(res.assignments) > 0
    check(req, res)


def test_weekend_shifts_are_spread_over_a_long_period():
    req = build(n_emp=30, days=28, weekend=True)
    req.time_limit_sec = 30
    res = scheduling.solve_period(req)
    per = defaultdict(int)
    for a in res.assignments:
        if (req.first_dow + a.day) % 7 >= 5:
            per[a.employee] += 1
    counts = [per.get(e.id, 0) for e in req.employees]
    assert max(counts) - min(counts) <= 4, counts
    check(req, res)


def test_a_sunday_pay_week_is_one_week_for_hours_and_days():
    """Nov 1 2026 is a Sunday. With Monday weeks that 7-day schedule is a 1-day week plus a 6-day week, so someone can work 6 days; with
    a Sunday pay week it is one whole week: nobody works more than the 5 days / 40 hours a week allows, and everyone is brought to 40."""
    req = build(n_emp=20, days=7, first_dow=6, weekend=True, starts=(24, 32, 40, 48, 56, 64), length=34)
    req.week_start = 6
    for e in req.employees:
        e.min_week_slots = 160
        e.max_week_slots = 160
    for o in req.options:
        o.paid_slots = 32
    for need in range(len(req.required)):
        req.required[need] = req.required[need] * 3
    req.time_limit_sec = 20
    res = scheduling.solve_period(req)
    days = defaultdict(int)
    for a in res.assignments:
        days[a.employee] += 1
    assert max(days.values()) <= 5
    assert sum(1 for e in req.employees if days[e.id] == 5) >= 18, dict(days)


# ---- a mixed crew: full-timers, part-timers and contract workers with limited availability

def mixed_request(n_ft=10, n_pt20=6, n_pt30=4, n_flex=4, days=7, first_dow=0):
    """Full-time (40 h, 5 days), part-time 20 h (3 days), part-time 30 h (4 days) and on-call contract workers (evenings only, up to 3 days, no guaranteed hours)."""
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=first_dow, time_limit_sec=40, w_under=900, w_over=30, w_hours=50, w_pref=0, w_fair=0, workers=4)
    total = n_ft + n_pt20 + n_pt30 + n_flex
    for d in range(days):
        for s in range(SPD):
            req.required.append(int(CURVE[s // 4] * (0.6 if (first_dow + d) % 7 >= 5 else 1) * total * 0.55 / 16))
    kinds = {}
    eid = 0
    def add(kind, n, contract_h, max_h, max_days, starts):
        nonlocal eid
        for _ in range(n):
            req.employees.add(id=eid, max_week_slots=max_h * 4, min_week_slots=contract_h * 4, max_consecutive=5, rest_slots=44, max_days_week=max_days)
            kinds[eid] = (kind, contract_h * 4, max_h * 4, max_days, set(starts))
            for d in range(days):
                for t, st in enumerate(starts):
                    req.options.add(employee=eid, day=d, template=t, start_slot=st, length_slots=32, paid_slots=32, preference=0)
            eid += 1
    add("full-time", n_ft, 40, 40, 5, (24, 32, 40, 48, 56, 64))
    add("part-time 20h", n_pt20, 20, 24, 3, (32, 40, 48, 56))
    add("part-time 30h", n_pt30, 30, 34, 4, (32, 40, 48, 56, 64))
    add("on-call evenings", n_flex, 0, 24, 3, (60, 64))
    return req, kinds


def test_a_mixed_crew_keeps_every_persons_own_contract_and_limits():
    req, kinds = mixed_request()
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    check(req, res)                                                      # rest, days in a row, weekly hours and days per person
    paid = defaultdict(int)
    days_worked = defaultdict(set)
    for a in res.assignments:
        kind, _, _, _, starts = kinds[a.employee]
        assert a.start_slot in starts, f"{kind} person {a.employee} was given a start they do not offer"
        paid[a.employee] += 32
        days_worked[a.employee].add(a.day)
    for e, (kind, contract, cap, max_days, _) in kinds.items():
        assert paid[e] <= cap, f"{kind} person {e} works {paid[e] / 4} h, over their {cap / 4} h limit"
        assert len(days_worked[e]) <= max_days, f"{kind} person {e} works {len(days_worked[e])} days"
        if contract:
            assert paid[e] >= contract - 32, f"{kind} person {e} gets {paid[e] / 4} h against a {contract / 4} h contract"
    by = defaultdict(list)
    for e, (kind, *_rest) in kinds.items():
        by[kind].append(paid[e] / 4)
    print({k: (min(v), max(v)) for k, v in by.items()})
    assert res.under_slots <= 0.2 * sum(req.required)


def test_part_timers_are_not_used_to_make_up_a_gap_beyond_their_limit():
    req, kinds = mixed_request(n_ft=2, n_pt20=6, n_pt30=0, n_flex=0)     # far too few people: the gap stays, nobody is overworked
    res = scheduling.solve(req)
    check(req, res)
    paid = defaultdict(int)
    for a in res.assignments:
        paid[a.employee] += 32
    assert all(paid[e] <= kinds[e][2] for e in kinds)
    assert res.under_slots > 0


# ---- part-timers on shifts of the right length, capped at contract plus a small tolerance

def part_time_request(n_ft=8, n_20=6, n_30=4, tolerance_h=1, days=7, lengths=(16, 20, 24)):
    """Full-timers on 8 h shifts; part-timers choose between 4, 5 and 6 h shifts and may not go more than `tolerance_h` past their contract."""
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=0, time_limit_sec=40, w_under=900, w_over=30, w_hours=50, w_pref=0, w_fair=0, workers=4)
    total = n_ft + n_20 + n_30
    for d in range(days):
        for s in range(SPD):
            req.required.append(int(CURVE[s // 4] * (0.6 if d >= 5 else 1) * total * 0.55 / 16))
    kinds, eid = {}, 0
    def add(kind, n, contract_h, max_days, shift_lengths, starts):
        nonlocal eid
        for _ in range(n):
            cap = (contract_h + tolerance_h) * 4
            req.employees.add(id=eid, max_week_slots=cap, min_week_slots=contract_h * 4, max_consecutive=5, rest_slots=44, max_days_week=max_days)
            kinds[eid] = (kind, contract_h * 4, cap)
            for d in range(days):
                for t, st in enumerate(starts):
                    for ln in shift_lengths:
                        req.options.add(employee=eid, day=d, template=t, start_slot=st, length_slots=ln, paid_slots=ln, preference=0)
            eid += 1
    add("full-time", n_ft, 40, 5, (32,), (24, 32, 40, 48, 56, 64))
    add("part-time 20h", n_20, 20, 5, lengths, (32, 40, 48, 56, 64))
    add("part-time 30h", n_30, 30, 5, lengths, (32, 40, 48, 56, 64))
    return req, kinds


def test_part_timers_get_their_contract_hours_when_shifts_can_be_the_right_length():
    req, kinds = part_time_request()
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    check(req, res)
    paid = defaultdict(int)
    for a in res.assignments:
        paid[a.employee] += a.length_slots
    got = {}
    for e, (kind, contract, cap) in kinds.items():
        assert paid[e] <= cap, f"{kind} person {e} works {paid[e] / 4} h, past the {cap / 4} h cap"
        assert contract - 4 <= paid[e], f"{kind} person {e} gets {paid[e] / 4} h against a {contract / 4} h contract"
        got.setdefault(kind, []).append(paid[e] / 4)
    print(got)


def test_without_a_cap_part_timers_drift_over_contract_with_long_shifts_only():
    req, kinds = part_time_request(lengths=(32,), tolerance_h=4)          # only 8 h shifts: the 20 h contract can only be 16 or 24
    res = scheduling.solve(req)
    paid = defaultdict(int)
    for a in res.assignments:
        paid[a.employee] += a.length_slots
    assert any(paid[e] != kinds[e][1] for e in kinds if kinds[e][0] != "full-time"), "8 h shifts cannot make a 20 h or 30 h week exactly"


def test_a_required_same_start_holds_even_when_the_solver_has_no_time_to_improve_the_roster():
    """With one usual start required and almost no time, whatever comes back must still keep every person to one start and one end: the starting
    roster the engine falls back on has to obey that rule too, not only the solver's own answers."""
    req, kinds = mixed_request(n_ft=40, n_pt20=0, n_pt30=0, n_flex=0)
    req.consistency_mode, req.start_tol_slots, req.end_tol_slots = 2, 0, 0
    req.time_limit_sec = 1
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE") and len(res.assignments) > 0
    starts, ends = {}, {}
    for a in res.assignments:
        starts.setdefault(a.employee, set()).add(a.start_slot)
        ends.setdefault(a.employee, set()).add(a.start_slot + a.length_slots)
    assert all(len(v) == 1 for v in starts.values()), {e: v for e, v in starts.items() if len(v) > 1}
    assert all(len(v) == 1 for v in ends.values())


# ---- every kind of pay week: the week starts on any weekday, and a schedule can start on any weekday

def pay_week_request(days, first_dow, week_start, n_emp=3):
    req = contract_request(days=days, first_dow=first_dow, n_emp=n_emp)
    req.week_start = week_start
    return req


def part_week_days(days, first_dow, week_start):
    """For each pay week the schedule touches: how many of its seven days fall inside the schedule."""
    off = (first_dow - week_start) % 7
    return {w: min(w * 7 - off + 6, days - 1) - max(w * 7 - off, 0) + 1 for w in range((off + days + 6) // 7)}


@pytest.mark.parametrize("week_start", range(7))
def test_a_schedule_that_starts_on_the_pay_week_gives_every_week_the_full_contract(week_start):
    req = pay_week_request(days=14, first_dow=week_start, week_start=week_start)
    assert scheduling.week_offset(req) == 0
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    for e, d in shifts_by_day(res).items():
        assert len([x for x in d if x < 7]) == 5 and len([x for x in d if x >= 7]) == 5, f"person {e} on a week starting weekday {week_start}"


@pytest.mark.parametrize("week_start", range(7))
def test_a_schedule_that_starts_mid_week_gives_part_weeks_their_share_and_whole_weeks_the_full_contract(week_start):
    first_dow = (week_start + 3) % 7                       # starts on the fourth day of the pay week
    req = pay_week_request(days=14, first_dow=first_dow, week_start=week_start)
    assert scheduling.week_offset(req) == 3
    res = scheduling.solve_period(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    parts = part_week_days(14, first_dow, week_start)       # {0: 4 days, 1: 7 days, 2: 3 days}
    assert parts == {0: 4, 1: 7, 2: 3}
    eight = [32] * 5
    for e, d in shifts_by_day(res).items():
        for w, n in parts.items():
            first = w * 7 - 3
            got = len([x for x in d if first <= x <= first + 6])
            want = scheduling.week_target(160, n, eight, 5, 160) // 32
            assert got == want, f"person {e}, pay week {w} ({n} days in the schedule): {got} shifts, wanted {want}"


def test_the_week_offset_is_right_for_every_start_and_every_first_day():
    for ws in range(7):
        for fd in range(7):
            req = wfm_pb2.ScheduleRequest(days=7, first_dow=fd, week_start=ws)
            off = scheduling.week_offset(req)
            assert 0 <= off < 7 and (ws + off) % 7 == fd, (ws, fd, off)


def test_a_53_week_year_and_a_leap_year_do_not_change_the_week_counting():
    # the engine counts days, not dates: 371 days (53 weeks) from any weekday still means exactly 53 whole pay weeks when it starts on the pay week
    for ws in (0, 6):
        req = wfm_pb2.ScheduleRequest(days=371, first_dow=ws, week_start=ws)
        assert scheduling.week_offset(req) == 0 and (scheduling.week_offset(req) + 370) // 7 == 52


def test_the_starting_roster_uses_the_people_whose_skill_is_short():
    """Two English speakers come first in the list, then a Spanish speaker; the need is one English and one Spanish speaker. Filling the total from whoever
    comes first would use both English speakers and leave the Spanish speaker with nothing to do while the Spanish queue is uncovered."""
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=900, w_over=30, w_hours=0, workers=1, backend="greedy")
    need = [2 if 32 <= s < 48 else 0 for s in range(SPD)]
    req.required.extend(need)
    for sid in (1, 2):
        sk = req.skill_requirements.add(id=sid)
        sk.required.extend([1 if 32 <= s < 48 else 0 for s in range(SPD)])
    for eid, skills in ((1, [1]), (2, [1]), (3, [2])):
        req.employees.add(id=eid, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5, skill_ids=skills)
        req.options.add(employee=eid, day=0, template=0, start_slot=32, length_slots=16, paid_slots=16)
    res = scheduling.solve(req)
    assert sorted(a.employee for a in res.assignments) in ([1, 3], [2, 3]), [a.employee for a in res.assignments]


# ---- days already worked for another group (the same person is in several WFM groups)

def other_group_request(days=7, first_dow=0, worked_elsewhere=(), paid=32, **limits):
    """One person needed all day every day, who already works the given days of the request for another group (so no option is offered on them)."""
    req = history_request(days=days, first_dow=first_dow, n_emp=1)
    emp = req.employees[0]
    for k, v in limits.items():
        setattr(emp, k, v)
    keep = [o for o in req.options if o.day not in worked_elsewhere]
    del req.options[:]
    req.options.extend(keep)
    emp.ext_paid.extend([paid if d in worked_elsewhere else 0 for d in range(days)])
    return req


@pytest.mark.parametrize("backend", ["", "cpsat", "highs", "scip", "greedy"])
def test_days_worked_for_another_group_count_against_days_per_week(backend):
    req = other_group_request(worked_elsewhere={0, 1, 2, 3}, max_days_week=5, max_consecutive=7)
    req.backend = backend
    res = scheduling.solve_period(req)
    assert len(res.assignments) <= 1, f"{backend}: 4 days elsewhere + a 5-day maximum leaves one day, got {len(res.assignments)}"


@pytest.mark.parametrize("backend", ["", "cpsat", "highs", "scip", "greedy"])
def test_hours_worked_for_another_group_count_against_the_weekly_maximum(backend):
    req = other_group_request(worked_elsewhere={0, 1, 2}, max_week_slots=160, max_days_week=7, max_consecutive=7)   # 40 h; 3 x 8 h elsewhere
    req.backend = backend
    res = scheduling.solve_period(req)
    assert sum(a.length_slots for a in res.assignments) <= 160 - 3 * 32, f"{backend}: {sum(a.length_slots for a in res.assignments)}"


@pytest.mark.parametrize("backend", ["", "cpsat", "highs", "scip", "greedy"])
def test_days_worked_for_another_group_count_toward_days_in_a_row(backend):
    # five days in a row elsewhere (Mon-Fri), a six-day maximum, no weekly limits: Saturday is the sixth, Sunday would be the seventh
    req = other_group_request(worked_elsewhere={0, 1, 2, 3, 4}, max_consecutive=6, max_days_week=7, max_week_slots=0)
    req.backend = backend
    res = scheduling.solve_period(req)
    assert len(res.assignments) <= 1, f"{backend}: {[a.day for a in res.assignments]}"


def test_other_group_days_are_counted_in_each_week_of_a_long_plan():
    # two weeks: 4 days elsewhere in week 1, none in week 2. Week 1 has one day left (5-day maximum), week 2 has five.
    req = other_group_request(days=14, worked_elsewhere={0, 1, 2, 3}, max_days_week=5, max_consecutive=7)
    res = scheduling.solve_period(req)
    per_week = [sum(1 for a in res.assignments if (a.day // 7) == w) for w in (0, 1)]
    assert per_week[0] <= 1, per_week
    assert per_week[1] <= 5 and per_week[1] >= 4, per_week


def test_a_run_of_days_elsewhere_carries_across_the_week_boundary():
    # Thu-Sun elsewhere in week 1 (4 days) and a five-day maximum in a row: Monday and Tuesday of week 2 can be worked, the third day in a row cannot
    req = other_group_request(days=14, worked_elsewhere={3, 4, 5, 6}, max_consecutive=5, max_days_week=7, max_week_slots=0)
    res = scheduling.solve_period(req)
    run, longest = 0, 0
    worked = {a.day for a in res.assignments} | {3, 4, 5, 6}
    for d in range(14):
        run = run + 1 if d in worked else 0
        longest = max(longest, run)
    assert longest <= 5, sorted(worked)


def test_without_other_group_days_nothing_changes():
    req = other_group_request(worked_elsewhere=(), max_days_week=5)
    res = scheduling.solve_period(req)
    assert len(res.assignments) == 5


# ---------------------------------------------------------------- a meal is not coverage, any number of skills, the starting roster's day limit

def _one_person_request(backend, gap=True):
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=900, w_over=30, w_hours=0, workers=1, backend=backend)
    req.required.extend([1 if 32 <= s < 48 else 0 for s in range(SPD)])
    req.employees.add(id=1, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5)
    o = req.options.add(employee=1, day=0, template=0, start_slot=32, length_slots=16, paid_slots=14)
    if gap:
        o.gap_start_slot, o.gap_slots = 38, 2             # half an hour away from the phones in the middle of the shift
    return req


@pytest.mark.parametrize("backend", ["cpsat", "highs", "scip", "greedy"])
def test_a_meal_in_the_middle_of_a_shift_is_not_coverage(backend):
    res = scheduling.solve(_one_person_request(backend))
    assert [a.employee for a in res.assignments] == [1], res.attempts
    assert res.under_slots == 2, f"{backend}: the two meal slots are uncovered, not counted as covered"
    assert scheduling.solve(_one_person_request(backend, gap=False)).under_slots == 0


def _skills_request(holders, n_skills, backend="cpsat"):
    """One person per entry of `holders` (the skills each holds); every skill needs one person from 08:00 to 12:00."""
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=10, w_under=900, w_over=30, w_hours=0, workers=1, backend=backend)
    window = [1 if 32 <= s < 48 else 0 for s in range(SPD)]
    req.required.extend([n_skills * v for v in window])
    for k in range(1, n_skills + 1):
        req.skill_requirements.add(id=k).required.extend(window)
    for eid, skills in enumerate(holders, start=1):
        req.employees.add(id=eid, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5, skill_ids=skills)
        req.options.add(employee=eid, day=0, template=0, start_slot=32, length_slots=16, paid_slots=16)
    return req


@pytest.mark.parametrize("backend", ["cpsat", "highs"])
def test_coverage_is_judged_per_skill_for_eight_skills(backend):
    full = _skills_request([[k] for k in range(1, 9)], 8, backend)
    assert scheduling.solve(full).under_slots == 0, "one person for each of eight skills covers all eight"
    # skills 1 and 2 are held by three people between them, but nobody holds skill 8: that skill stays short however many people there are
    holders = [[1], [2], [3], [4], [5], [6], [7], [1, 2]]
    res = scheduling.solve(_skills_request(holders, 8, backend))
    assert res.under_slots == 16, (backend, res.under_slots)       # one person short for the 16 slots of 08:00 to 12:00
    # a person who holds two skills serves one of them at a time: two people for three skills leave one skill short
    res = scheduling.solve(_skills_request([[1, 2], [2, 3]], 3, backend))
    assert res.under_slots == 16, (backend, res.under_slots)


def test_the_starting_roster_gives_people_without_a_day_limit_a_full_week():
    def shifts(limit, days=7):
        req = build(n_emp=6, days=days, weekend=True)
        req.backend, req.time_limit_sec = "greedy", 5
        for e in req.employees:
            e.max_days_week, e.min_week_slots = limit, 40 * 4
        res = scheduling.solve(req)
        return sorted(collections_counter(a.employee for a in res.assignments).values())
    assert shifts(5) == [5] * 6
    assert min(shifts(0)) >= 4, "no limit set means no limit, not one shift"


def collections_counter(items):
    import collections
    return collections.Counter(items)


# ---- enterprise policies: holidays, overtime, DST rest, fairness in hours

def test_a_priced_holiday_is_staffed_only_where_it_pays():
    req = build(n_emp=10, days=7)
    for o in req.options:
        if o.day == 2:
            o.cost = 100000                                   # a holiday the organisation would rather leave alone: dearer than the cover it buys
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert not [a for a in res.assignments if a.day == 2]


def test_planned_overtime_is_used_only_when_it_is_priced_low_enough():
    def worked(price):
        req = build(n_emp=6, days=7)
        req.w_overtime = price
        for e in req.employees:
            e.max_week_slots, e.min_week_slots, e.max_days_week = 48 * 4, 32 * 4, 6
        for o in list(req.options):
            o.length_slots = 36
        for g in range(len(req.required)):
            req.required[g] = req.required[g] * 3             # far more need than the contract hours can cover
        res = scheduling.solve(req)
        return sum(a.length_slots for a in res.assignments)
    cheap, dear = worked(0), worked(100000)
    assert dear <= 6 * 32 * 4 + 6 * 4, f"overtime used although it cost more than the cover: {dear}"
    assert cheap > dear


def test_rest_is_real_elapsed_time_across_a_clock_change():
    def solve_with(adjust):
        req = wfm_pb2.ScheduleRequest(days=2, first_dow=0, time_limit_sec=5, w_under=100, w_over=1, workers=2)
        req.employees.add(id=0, rest_slots=44, max_week_slots=400, min_week_slots=0, max_consecutive=5, max_days_week=5)
        req.required.extend([1 if (60 <= g < 92 or SPD + 40 <= g < SPD + 72) else 0 for g in range(2 * SPD)])
        req.options.add(employee=0, day=0, template=0, start_slot=60, length_slots=32)          # 15:00-23:00
        req.options.add(employee=0, day=1, template=0, start_slot=40, length_slots=32)          # 10:00-18:00: exactly 11 h later on the wall clock
        req.dst_rest_adjust.extend(adjust)
        return len(scheduling.solve(req).assignments)
    assert solve_with([0, 0]) == 2                       # an ordinary night: 11 h is enough
    assert solve_with([0, 4]) == 1                       # the clocks go forward in between: only 10 h really pass
    assert solve_with([0, -4]) == 2                      # the clocks go back: 12 h really pass


def test_unsocial_hours_are_spread_by_hours_not_by_shifts():
    req = build(n_emp=8, days=14, weekend=True)
    for o in req.options:
        if (req.first_dow + o.day) % 7 >= 5:
            o.length_slots = 32 if o.employee % 2 == 0 else 16
    for e in req.employees:
        e.max_week_slots = 40 * 4
    res = scheduling.solve(req)
    hours = defaultdict(int)
    for a in res.assignments:
        if (req.first_dow + a.day) % 7 >= 5:
            hours[a.employee] += a.length_slots // 4
    assert hours and max(hours.values()) - min(hours.get(e.id, 0) for e in req.employees) <= 16


def test_a_public_holiday_counts_as_unsocial_time_for_fairness():
    import coverage
    req = wfm_pb2.ScheduleRequest(days=7, first_dow=0)
    o = wfm_pb2.ShiftOption(day=2, start_slot=20, length_slots=32, paid_slots=30)
    assert coverage.unsocial_hours(req, o) == 0
    o.unsocial = True
    assert coverage.unsocial_hours(req, o) == 8              # 30 slots, rounded to whole hours


# ---- single skill, memory refusal, windowed plans, usual times across weeks

def test_one_skill_requirement_is_not_met_by_people_who_lack_the_skill():
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=100, w_over=1, workers=2)
    need = [2 if 36 <= g < 68 else 0 for g in range(SPD)]
    req.required.extend(need)
    req.skill_requirements.add(id=7, required=need)
    for e in range(4):
        req.employees.add(id=e, max_week_slots=400, max_consecutive=5, rest_slots=0, max_days_week=5, skill_ids=[7] if e >= 2 else [])
        req.options.add(employee=e, day=0, template=0, start_slot=36, length_slots=32)
    res = scheduling.solve(req)
    skilled = {a.employee for a in res.assignments}
    assert skilled == {2, 3}, f"only people with the skill were worth scheduling: {skilled}"
    assert res.under_slots == 0
    # the same demand with nobody skilled is a full shortage, however many people are on shift
    only_unskilled = wfm_pb2.ScheduleRequest()
    only_unskilled.CopyFrom(req)
    for e in only_unskilled.employees:
        del e.skill_ids[:]
    res2 = scheduling.solve(only_unskilled)
    assert res2.under_slots == sum(need)


def test_the_solver_is_not_started_when_memory_is_known_to_be_short(monkeypatch):
    import backends
    monkeypatch.setattr(scheduling, "free_memory_mb", lambda *a, **k: 10)
    with pytest.raises(backends.MemoryPressure, match="ENGINE_BUSY"):
        scheduling.wait_for_memory(5000, give_up_sec=0.2)
    monkeypatch.setattr(scheduling, "free_memory_mb", lambda *a, **k: 9000)
    scheduling.wait_for_memory(5000, give_up_sec=0.2)          # room: returns at once


def test_a_plan_solved_week_by_week_is_not_called_optimal():
    one = build(n_emp=6, days=7)
    one.time_limit_sec = 5
    r1 = scheduling.solve_period(one)
    assert not r1.windowed
    two = build(n_emp=6, days=14)
    two.time_limit_sec = 8
    r2 = scheduling.solve_period(two)
    assert r2.windowed and r2.status == "FEASIBLE"
    assert any("one after another" in a for a in r2.attempts)


def _two_part_plan(mode):
    """Six people, three weeks. Week 1 needs the early shift, weeks 2 and 3 the late one. `mode`: 1 = prefer the usual times, 2 = require them."""
    req = wfm_pb2.ScheduleRequest(days=21, first_dow=0, time_limit_sec=18, w_under=100, w_over=10, w_hours=0, w_consist=200, workers=4, consistency_mode=mode, start_tol_slots=2, end_tol_slots=2)
    for d in range(21):
        for g in range(SPD):
            early = 20 <= g < 52 and d < 7
            late = 60 <= g < 92 and d >= 7
            req.required.append(3 if early or late else 0)
    for e in range(6):
        req.employees.add(id=e, max_week_slots=400, max_consecutive=7, rest_slots=0, max_days_week=7)
        for d in range(21):
            for st in (20, 60):
                req.options.add(employee=e, day=d, template=0 if st == 20 else 1, start_slot=st, length_slots=32)
    return req


def test_people_who_must_keep_their_usual_times_do_and_people_who_prefer_them_may_move():
    must = scheduling.solve_period(_two_part_plan(2))
    late_must = [a for a in must.assignments if a.day >= 7 and a.start_slot == 60]
    early_first = {a.employee for a in must.assignments if a.day < 7 and a.start_slot == 20}
    assert early_first, "week one used the early shift"
    # whoever worked the early shift in week one is held to it afterwards: they never work the late one
    assert not [a for a in late_must if a.employee in early_first]
    prefer = scheduling.solve_period(_two_part_plan(1))
    moved = [a for a in prefer.assignments if a.day >= 7 and a.start_slot == 60 and a.employee in {b.employee for b in prefer.assignments if b.day < 7}]
    assert moved, "people who only prefer their usual times move when the cover needs it"
    assert prefer.under_slots < must.under_slots or len(moved) > len(late_must)
