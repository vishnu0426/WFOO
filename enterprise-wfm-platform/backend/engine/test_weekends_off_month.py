"""'At least N full weekends off in a calendar month': every solver keeps to it, the validator reports a roster that breaks it, and a rule nobody set changes nothing."""
import pytest

import backends
import scheduling
import test_scheduling as ts
import test_validator as tv
import validator
import wfm_pb2


def weekends(days, first_dow=0, weekend=(5, 6)):
    """Day tuples of each weekend wholly inside the period."""
    out, d = [], 0
    while d < days:
        if (first_dow + d) % 7 == weekend[0] and d + len(weekend) <= days:
            out.append(tuple(range(d, d + len(weekend))))
            d += 7
        else:
            d += 1
    return out


def add_month(req, first, last, wk, need_for_all=None):
    m = req.weekend_months.add(first_day=first, last_day=last)
    for w in wk:
        m.weekends.add().days.extend(w)
    return m


def request(n_emp=10, days=28, need=2, max_days_week=5, backend="", first_dow=0):
    req = ts.build(n_emp=n_emp, days=days, first_dow=first_dow, weekend=True)
    req.backend = backend
    for e in req.employees:
        e.max_days_week = max_days_week
        if need:
            e.weekend_need.append(need)
    add_month(req, 0, days - 1, weekends(days, first_dow))
    return req


def weekends_off(req, res):
    worked = {}
    for a in res.assignments:
        worked.setdefault(a.employee, set()).add(a.day)
    wk = weekends(req.days, req.first_dow)
    return {e.id: sum(1 for w in wk if not any(d in worked.get(e.id, set()) for d in w)) for e in req.employees}


@pytest.mark.parametrize("backend", ["", "highs", "scip", "greedy"])
def test_every_solver_gives_two_full_weekends_off(backend):
    req = request(backend=backend)
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE"), res.status
    assert res.assignments
    off = weekends_off(req, res)
    assert all(n >= 2 for n in off.values()), off


def test_three_of_four_weekends():
    req = request(need=3)
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert all(n >= 3 for n in weekends_off(req, res).values())


def test_a_person_with_no_need_is_not_held_to_it():
    req = request(need=0)
    assert backends.off_weekends(req.employees[0], req) == []
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    ts.check(req, res)


def test_a_weekend_touched_by_work_for_another_group_is_not_offered_and_the_need_shrinks_to_what_is_left():
    req = request(n_emp=1, need=3)
    e = req.employees[0]
    ext = [0] * 28
    for d in (5, 12, 19):
        ext[d] = 28                                              # works the Saturday of weekends 1, 2 and 3 for another group
    e.ext_paid.extend(ext)
    (free, need), = backends.off_weekends(e, req)
    assert free == [(26, 27)] and need == 1, (free, need)


def test_a_month_that_only_part_of_the_period_covers_asks_for_what_the_gateway_says():
    req = request(n_emp=4, days=14, need=0)
    req.weekend_months[0].last_day = 13
    for e in req.employees:
        e.weekend_need[:] = [1]
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert all(n >= 1 for n in weekends_off(req, res).values())


# ---------------------------------------------------------------- the validator

def roster(days_worked, need=2, days=28):
    req = tv.base(days=days, people=1, max_days_week=6)
    req.employees[0].limits.weekend_need.append(need)
    add_month(req, 0, days - 1, weekends(days))
    for d in days_worked:
        tv.shift(req, 1, d)
    return req


def test_the_validator_flags_a_month_with_too_few_weekends_off():
    # works one day of every weekend: no weekend is fully off
    res = validator.validate(roster([0, 1, 2, 3, 5, 7, 8, 9, 12, 14, 19, 26]))
    assert "WEEKENDS_OFF" in tv.codes(res, "HARD"), [(f.code, f.message) for f in res.findings]
    assert any("has 0 full weekends off" in f.message for f in res.findings)


def test_the_validator_accepts_enough_weekends_off_and_a_rule_nobody_set():
    ok = roster([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])    # works the first two weekends, off the other two
    assert "WEEKENDS_OFF" not in tv.codes(validator.validate(ok))
    none = roster([0, 5, 12, 19, 26], need=0)
    assert "WEEKENDS_OFF" not in tv.codes(validator.validate(none))


def test_the_validator_judges_a_month_only_when_the_person_works_in_it():
    req = roster([], need=2)
    assert "WEEKENDS_OFF" not in tv.codes(validator.validate(req))


def test_days_worked_for_another_group_count_as_worked():
    req = roster([0, 1, 2, 3, 4])
    ext = [0] * 28
    for d in (12, 19, 26):
        ext[d] = 28                                              # the Saturday of weekends 2, 3 and 4 is worked elsewhere
    req.employees[0].limits.ext_paid.extend(ext)
    assert "WEEKENDS_OFF" in tv.codes(validator.validate(req), "HARD")


def test_the_engine_refuses_nonsense():
    import test_validation as tval
    req = tval.good()
    req.employees[0].weekend_need.append(2)
    tval.refused(req, "weekend_need")
    req = tval.good()
    req.weekend_months.add().weekends.add().days.append(req.days + 5)
    tval.refused(req, "weekend")
