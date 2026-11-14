"""The review scenario table, one test each (several are covered by older tests, noted below). Each checks the answer against the rules, not against the solver's own words."""
import threading
import time
from collections import defaultdict

import pytest

import backends
import scheduling
import wfm_pb2

SPD = 96


def _req(days=1, **kw):
    return wfm_pb2.ScheduleRequest(days=days, first_dow=0, time_limit_sec=kw.pop("time_limit_sec", 6), w_under=100, w_over=1, workers=2, **kw)


def _person(req, e, skills=(), rest=0, **kw):
    req.employees.add(id=e, max_week_slots=kw.pop("max_week_slots", 600), max_consecutive=kw.pop("max_consecutive", 7), rest_slots=rest, max_days_week=7, skill_ids=list(skills), **kw)


# 1. One skill, qualified and unqualified employees: test_scheduling.py::test_one_skill_requirement_is_not_met_by_people_who_lack_the_skill

def test_two_overlapping_skills_one_person_serves_one_at_a_time():
    need = [1 if 36 <= g < 68 else 0 for g in range(SPD)]

    def run(people):
        req = _req()
        req.required.extend([2 * v for v in need])
        req.skill_requirements.add(id=1, required=need)
        req.skill_requirements.add(id=2, required=need)
        for e in range(people):
            _person(req, e, skills=[1, 2])
            req.options.add(employee=e, day=0, template=0, start_slot=36, length_slots=32)
        return scheduling.solve(req)
    one, two = run(1), run(2)
    assert one.under_slots == 32, f"one person holding both skills covers one of the two needs, not both: {one.under_slots} short"
    assert two.under_slots == 0


def _four_weeks(mode, tolerance=2):
    req = wfm_pb2.ScheduleRequest(days=28, first_dow=0, time_limit_sec=24, w_under=100, w_over=10, w_hours=0, w_consist=200, workers=4,
                                  consistency_mode=mode, start_tol_slots=tolerance, end_tol_slots=tolerance)
    for d in range(28):
        for g in range(SPD):
            req.required.append(2 if (20 <= g < 52 or 60 <= g < 92) else 0)
    for e in range(6):
        _person(req, e, max_consecutive=28)       # nobody has to rest at a week boundary, so nothing forces a change of shift
        for d in range(28):
            for st in (20, 60):
                req.options.add(employee=e, day=d, template=0 if st == 20 else 1, start_slot=st, length_slots=32)
    return req


def _usual_times_kept(res, tolerance=2):
    by = defaultdict(list)
    for a in sorted(res.assignments, key=lambda a: a.day):
        by[a.employee].append((a.start_slot, a.start_slot + a.length_slots))
    return all(abs(s - by[e][0][0]) <= tolerance and abs(t - by[e][0][1]) <= tolerance for e, shifts in by.items() for s, t in shifts)


def test_required_consistency_over_four_weeks_allows_no_change_of_times():
    res = scheduling.solve_period(_four_weeks(2))
    assert res.assignments and _usual_times_kept(res)


def test_preferred_consistency_over_four_weeks_is_kept_when_nothing_asks_for_a_change():
    res = scheduling.solve_period(_four_weeks(1))
    assert res.assignments and _usual_times_kept(res), "with no reason to move, the penalty keeps people on their usual times"
    # and it is a penalty, not a ban: see test_people_who_must_keep_their_usual_times_do_and_people_who_prefer_them_may_move


def test_no_shift_near_a_required_usual_time_is_reported_not_hidden():
    req = _four_weeks(2)
    keep = [o for o in req.options if o.day < 7 or o.start_slot == 60]          # from week two only the late shift exists
    del req.options[:]
    req.options.extend(keep)
    res = scheduling.solve_period(req)
    assert any("no shift near them" in a and "must" in a for a in res.attempts), res.attempts
    assert res.assignments and res.status in ("OPTIMAL", "FEASIBLE")


def test_a_meal_gap_is_not_coverage():
    req = _req()
    req.required.extend([1 if 36 <= g < 68 else 0 for g in range(SPD)])
    _person(req, 0)
    req.options.add(employee=0, day=0, template=0, start_slot=36, length_slots=32, gap_start_slot=48, gap_slots=4)
    res = scheduling.solve(req)
    assert len(res.assignments) == 1 and res.under_slots == 4


def test_overnight_shift_covers_the_next_morning_and_rest_counts_across_midnight():
    req = _req(days=2)
    req.required.extend([1 if SPD <= g < SPD + 24 else 0 for g in range(2 * SPD)])      # the first six hours of day two
    _person(req, 0, rest=44)
    req.options.add(employee=0, day=0, template=0, start_slot=88, length_slots=32)           # 22:00-06:00
    res = scheduling.solve(req)
    assert len(res.assignments) == 1 and res.under_slots == 0, "the night shift covers the next morning"
    both = _req(days=2)
    both.required.extend([1] * (2 * SPD))
    _person(both, 0, rest=44)
    both.options.add(employee=0, day=0, template=0, start_slot=88, length_slots=32)
    both.options.add(employee=0, day=1, template=1, start_slot=40, length_slots=32)          # 10:00: only 4 h after the night shift ended
    assert len(scheduling.solve(both).assignments) == 1
    later = _req(days=2)
    later.required.extend([1] * (2 * SPD))
    _person(later, 0, rest=44)
    later.options.add(employee=0, day=0, template=0, start_slot=88, length_slots=32)
    later.options.add(employee=0, day=1, template=1, start_slot=70, length_slots=20)         # 17:30: 11.5 h after
    assert len(scheduling.solve(later).assignments) == 2


def test_the_solver_is_not_launched_when_memory_is_short(monkeypatch):
    launched = []
    monkeypatch.setattr(scheduling, "_run_worker", lambda *a, **k: launched.append(1))
    monkeypatch.setattr(scheduling, "free_memory_mb", lambda *a, **k: 5)
    monkeypatch.setenv("ENGINE_MEMORY_WAIT_SEC", "0.3")
    req = _req()
    req.required.extend([1] * SPD)
    _person(req, 0)
    req.options.add(employee=0, day=0, template=0, start_slot=36, length_slots=32)
    with pytest.raises(backends.MemoryPressure):
        scheduling.solve_cpsat_isolated(req, {}, {}, None, None)
    assert launched == [], "no solver process was started"


# A contract in a part week: test_scheduling.py::test_week_target_scales_a_part_week_in_whole_shifts

def test_a_solve_cancelled_while_queued_leaves_without_waiting_for_capacity():
    held = scheduling._SOLVE_GATE.take(scheduling.MAX_SOLVES)          # all the capacity there is
    try:
        req = _req()
        req.required.extend([1] * SPD)
        _person(req, 0)
        req.options.add(employee=0, day=0, template=0, start_slot=36, length_slots=32)
        cancel, outcome = threading.Event(), {}

        def go():
            t0 = time.time()
            try:
                scheduling.solve_cpsat_isolated(req, {}, {}, cancel, None)
            except backends.Cancelled:
                outcome["left_after"] = time.time() - t0
        th = threading.Thread(target=go)
        th.start()
        time.sleep(0.5)
        assert th.is_alive(), "it is queued behind the full gate"
        cancel.set()
        th.join(5)
        assert not th.is_alive() and outcome["left_after"] < 3
        assert scheduling._SOLVE_GATE.queue == [], "and it no longer holds a place in the queue"
    finally:
        scheduling._SOLVE_GATE.give(held)


def test_deterministic_mode_gives_the_same_schedule_every_time():
    def run():
        req = _four_weeks(0)
        req.days = 7
        del req.required[7 * SPD:]
        keep = [o for o in req.options if o.day < 7]
        del req.options[:]
        req.options.extend(keep)
        req.deterministic = True
        req.time_limit_sec = 8
        return sorted((a.employee, a.day, a.template) for a in scheduling.solve_period(req).assignments)
    first = run()
    assert first and first == run() == run()


# ---- skill demand that differs from week to week (the regression behind the review's first finding)

def _skill_weeks(per_week):
    """Four qualified people, one skill, `per_week[w]` people needed from 09:00 to 17:00 on every day of week w."""
    days = 7 * len(per_week)
    need = [0] * (days * SPD)
    for d in range(days):
        for g in range(36, 68):
            need[d * SPD + g] = per_week[d // 7]
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=0, time_limit_sec=8, w_under=100, w_over=1, workers=2)
    req.required.extend(need)
    req.skill_requirements.add(id=1, required=need)
    for e in range(4):
        _person(req, e, skills=[1], max_consecutive=days)
        for d in range(days):
            req.options.add(employee=e, day=d, template=0, start_slot=36, length_slots=32)
    return req


def test_skill_demand_of_each_week_is_what_that_week_is_solved_for():
    per_week = [0, 2, 0, 3]
    res = scheduling.solve_period(_skill_weeks(per_week))
    worked = defaultdict(int)
    for a in res.assignments:
        worked[a.day // 7] += 1
    assert [worked[w] for w in range(4)] == [0, 14, 0, 21], f"people on shift per week: {dict(worked)}"
    assert res.under_slots == 0


def test_skill_demand_only_in_a_later_week_is_not_lost():
    res = scheduling.solve_period(_skill_weeks([0, 2]))
    assert len([a for a in res.assignments if a.day >= 7]) == 14


def test_skills_asking_for_more_than_the_total_are_refused():
    import validation
    req = _skill_weeks([2])
    req.required[40] = 0                                   # the total says nobody is needed at a slot where the skill needs two
    with pytest.raises(Exception, match="skills together ask"):
        validation.validate_schedule_request(req, 1_000_000)


def test_demand_that_exists_only_per_skill_is_not_treated_as_empty():
    req = _skill_weeks([2])
    del req.required[:]                                    # no total, only the skill's own requirement
    res = scheduling.solve(req)
    assert res.assignments and res.under_slots == 0


def test_a_plan_solved_in_windows_gives_no_gap_figure():
    res = scheduling.solve_period(_skill_weeks([1, 1]))
    assert res.windowed and res.gap == 1.0 and res.best_bound == 0.0
    assert any("no figure exists for the whole plan" in a for a in res.attempts)
