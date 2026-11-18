"""'At least N days off side by side in every pay week': the solvers keep to it, the validator reports a roster that breaks it, and a rule nobody set changes nothing."""
import pytest

import backends
import scheduling
import test_scheduling as ts
import test_validator as tv
import validator
import wfm_pb2

SPD = 96


def request(n_emp=10, days=14, first_dow=0, off_together=2, max_days_week=5, weekend=True):
    req = ts.build(n_emp=n_emp, days=days, first_dow=first_dow, weekend=weekend)
    for e in req.employees:
        e.min_days_off_together = off_together
        e.max_days_week = max_days_week
    return req


def blocks_ok(req, res, need):
    """Every pay week inside the period has `need` neighbouring days with no shift, for every person."""
    worked = {}
    for a in res.assignments:
        worked.setdefault(a.employee, set()).add(a.day)
    woff = scheduling.week_offset(req)
    bad = []
    for e in req.employees:
        mine = worked.get(e.id, set())
        for w in range(0, req.days // 7 + 2):
            first = 7 * w - woff
            if first < 0 or first + 6 > req.days - 1:
                continue
            best = run = 0
            for d in range(first, first + 7):
                run = 0 if d in mine else run + 1
                best = max(best, run)
            if best < need:
                bad.append((e.id, w, sorted(mine)))
    return bad


def test_the_solver_gives_two_days_off_together_in_every_full_week():
    req = request()
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert res.assignments
    assert blocks_ok(req, res, 2) == []


def test_three_days_together_when_asked_and_days_per_week_allow_it():
    req = request(off_together=3, max_days_week=4)
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert blocks_ok(req, res, 3) == []


def test_it_holds_when_the_pay_week_starts_mid_week():
    req = request(days=21, first_dow=3)              # starts on a Thursday: the first and last weeks are part weeks and are not held to it
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert blocks_ok(req, res, 2) == []


def test_a_person_with_no_rule_is_not_held_to_it():
    req = request(off_together=0)
    assert all(not v for v in [backends.off_blocks(e, req.days, 0) for e in req.employees]), "no blocks are asked for"
    res = scheduling.solve(req)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    ts.check(req, res)


def test_a_week_with_a_day_worked_for_another_group_only_offers_blocks_that_avoid_it():
    req = request(n_emp=1)
    e = req.employees[0]
    e.ext_paid.extend([0, 0, 28, 0, 0, 0, 0] + [0] * 7)          # works for another group on day 3 (Wednesday)
    blocks = backends.off_blocks(e, req.days, 0)
    assert 0 in blocks and all(2 not in b for b in blocks[0]), blocks[0]
    assert (3, 4) in blocks[0] and (0, 1) in blocks[0]


def test_a_part_week_is_not_judged():
    req = request(n_emp=1, days=10, first_dow=0)
    assert sorted(backends.off_blocks(req.employees[0], req.days, 0)) == [0], "only days 1-7 are a whole week; days 8-10 are not"


def test_the_validator_flags_a_roster_that_splits_the_days_off():
    req = tv.base(people=1, max_days_week=6)
    req.employees[0].limits.min_days_off_together = 2
    for d in (0, 1, 3, 4, 5):                      # off on Wednesday and Sunday, never side by side
        tv.shift(req, 1, d)
    res = validator.validate(req)
    assert "DAYS_OFF_TOGETHER" in tv.codes(res, "HARD"), [(f.code, f.message) for f in res.findings]
    assert any("at most 1 day off together" in f.message for f in res.findings)


def test_the_validator_accepts_days_off_side_by_side_and_a_rule_nobody_set():
    req = tv.base(people=1)
    req.employees[0].limits.min_days_off_together = 2
    for d in range(5):
        tv.shift(req, 1, d)                        # Saturday and Sunday off together
    assert "DAYS_OFF_TOGETHER" not in tv.codes(validator.validate(req))
    loose = tv.base(people=1, max_days_week=6)
    for d in (0, 1, 3, 4, 5):
        tv.shift(loose, 1, d)
    assert "DAYS_OFF_TOGETHER" not in tv.codes(validator.validate(loose))


def test_the_validator_judges_only_whole_weeks_in_the_period():
    req = tv.base(days=10, people=1, max_days_week=6)
    req.employees[0].limits.min_days_off_together = 2
    for d in (0, 1, 2, 3, 4, 7, 9):                # days 8-10 are a part week
        tv.shift(req, 1, d)
    assert "DAYS_OFF_TOGETHER" not in tv.codes(validator.validate(req))


def test_the_engine_refuses_a_value_a_week_cannot_hold():
    import test_validation as tval
    import validation
    req = tval.good()
    req.employees[0].min_days_off_together = 8
    tval.refused(req, "min_days_off_together")
    req.employees[0].min_days_off_together = 3
    validation.validate_schedule_request(req, 300_000)
