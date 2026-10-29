"""Scheduling tests: the solver's answer is re-checked against the rules by code that does not share the model."""
from collections import defaultdict

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
    assert sorted((a.employee, a.day) for a in plain.assignments) == sorted((a.employee, a.day) for a in again.assignments)


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
