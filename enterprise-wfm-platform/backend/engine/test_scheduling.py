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
