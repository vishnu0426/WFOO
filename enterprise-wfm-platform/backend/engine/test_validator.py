"""The schedule validator: every rule it enforces, tried with a roster that breaks it and one that does not, and a check that every solver's roster passes it."""
import pytest

import scheduling
import test_scheduling as ts
import validator
import wfm_pb2

SPD = 96


def base(days=7, first_dow=0, people=2, **limits):
    req = wfm_pb2.ValidateRequest(days=days, first_dow=first_dow, week_start=0)
    for e in range(1, people + 1):
        v = req.employees.add(name=f"P{e}", allow_overnight=True, allow_weekend=True)
        v.limits.id = e
        v.limits.max_week_slots = limits.get("max_week_slots", 40 * 4)
        v.limits.min_week_slots = limits.get("min_week_slots", 0)
        v.limits.max_consecutive = limits.get("max_consecutive", 5)
        v.limits.rest_slots = limits.get("rest_slots", 44)
        v.limits.max_days_week = limits.get("max_days_week", 5)
    return req


def shift(req, e, day, start=36, length=32, **kw):
    s = req.shifts.add(employee=e, day=day, start_slot=start, length_slots=length, **kw)
    return s


def codes(res, severity=None):
    return sorted({f.code for f in res.findings if severity is None or f.severity == severity})


def test_a_roster_that_obeys_every_rule_is_validated():
    req = base()
    for d in range(5):
        shift(req, 1, d)
    res = validator.validate(req)
    assert res.valid and res.status == "VALIDATED" and res.hard_violations == 0 and res.soft_warnings == 0, [(f.code, f.message) for f in res.findings]


def test_overlapping_shifts_and_two_shifts_in_a_day_are_refused():
    req = base()
    shift(req, 1, 0, 36, 32)
    shift(req, 1, 0, 50, 32)
    assert "OVERLAP" in codes(validator.validate(req), "HARD")
    req2 = base()
    shift(req2, 1, 0, 0, 16)
    shift(req2, 1, 0, 64, 16)                 # 12 hours after the first ended: rest is fine, but it is a second shift in the day
    assert codes(validator.validate(req2), "HARD") == ["DOUBLE_SHIFT_DAY"]


def test_rest_is_measured_across_midnight_and_must_be_at_least_what_the_person_needs():
    req = base()
    shift(req, 1, 0, 88, 32)                  # 22:00 to 06:00
    shift(req, 1, 1, 40, 32)                  # 10:00: four hours later
    res = validator.validate(req)
    assert "REST" in codes(res, "HARD") and "4 hours" in [f.message for f in res.findings if f.code == "REST"][0]
    ok = base()
    shift(ok, 1, 0, 88, 32)
    shift(ok, 1, 1, 70, 20)                   # 17:30: eleven and a half hours later
    assert "REST" not in codes(validator.validate(ok))


def test_rest_counts_the_clocks_changing_overnight():
    def rest_broken(adjust):
        r = base()
        shift(r, 1, 0, 60, 32)                # 15:00-23:00
        shift(r, 1, 1, 40, 32)                # 10:00: eleven hours on the wall clock
        r.dst_rest_adjust.extend([0, adjust])
        return "REST" in codes(validator.validate(r), "HARD")
    assert not rest_broken(0) and rest_broken(4) and not rest_broken(-4)


def test_rest_is_checked_against_the_end_of_the_schedule_before():
    req = base()
    req.employees[0].limits.prior_has_end = True
    req.employees[0].limits.prior_end_slot = 20           # the last earlier shift ended at 05:00 on day 1
    shift(req, 1, 0, 36, 32)                              # starts 09:00: four hours later
    assert "REST" in codes(validator.validate(req), "HARD")


def test_everything_else_a_person_is_committed_to_is_part_of_the_check():
    req = base()
    shift(req, 1, 2, 36, 32)
    req.commitments.add(employee=1, day=2, start_slot=60, length_slots=16, kind="SHIFT", label="Billing")
    assert "COMMITMENT_CLASH" in codes(validator.validate(req), "HARD")
    leave = base()
    shift(leave, 1, 3, 36, 32)
    leave.commitments.add(employee=1, day=3, start_slot=0, length_slots=96, kind="LEAVE", label="approved leave")
    assert "COMMITMENT_CLASH" in codes(validator.validate(leave), "HARD")
    rest = base()
    shift(rest, 1, 1, 40, 32)
    rest.commitments.add(employee=1, day=0, start_slot=72, length_slots=24, kind="SHIFT", label="Billing")     # ends at midnight: ten hours before this roster's shift
    res = validator.validate(rest)
    assert "REST" in codes(res, "HARD") and "Billing" in [f.message for f in res.findings if f.code == "REST"][0]
    assert "REST" not in codes(validator.validate(_with_leave_before()), "HARD"), "leave before a shift is not work that needs rest"


def _with_leave_before():
    r = base()
    shift(r, 1, 1, 40, 32)
    r.commitments.add(employee=1, day=0, start_slot=72, length_slots=24, kind="LEAVE", label="leave")
    return r


def test_days_in_a_row_count_other_groups_and_the_run_before_the_period():
    req = base(max_consecutive=5, max_days_week=7, max_week_slots=10 ** 6)
    for d in range(4):
        shift(req, 1, d)
    req.employees[0].limits.prior_run = 2
    assert "CONSECUTIVE_DAYS" in codes(validator.validate(req), "HARD")            # 2 earlier + 4 = 6
    other = base(max_consecutive=5, max_days_week=7, max_week_slots=10 ** 6)
    for d in range(3):
        shift(other, 1, d)
    for d in range(3, 6):
        other.commitments.add(employee=1, day=d, start_slot=36, length_slots=32, kind="SHIFT", label="Billing")
    assert "CONSECUTIVE_DAYS" not in codes(validator.validate(other)), "the violation is only reported on a day the roster itself has the person working"
    third = base(max_consecutive=5, max_days_week=7, max_week_slots=10 ** 6)
    for d in range(5):
        shift(third, 1, d)
    third.commitments.add(employee=1, day=5, start_slot=36, length_slots=32, kind="SHIFT", label="Billing")
    third.commitments.add(employee=1, day=6, start_slot=36, length_slots=32, kind="SHIFT", label="Billing")
    assert validator.validate(third).valid is True, "days after the roster's last working day are not this roster's doing"


def test_weekly_limits_count_other_groups_and_what_was_worked_earlier_in_the_week():
    req = base(max_week_slots=40 * 4, max_days_week=5)
    for d in range(4):
        shift(req, 1, d, 36, 40)                               # 4 x 10 h = 40 h
    assert validator.validate(req).valid
    req.commitments.add(employee=1, day=4, start_slot=36, length_slots=16, kind="SHIFT", label="Billing")      # four more hours elsewhere
    assert "WEEKLY_MAX" in codes(validator.validate(req), "HARD")
    earlier = base(max_week_slots=40 * 4, max_days_week=5, first_dow=3)           # starts on a Thursday
    earlier.employees[0].limits.prior_week_slots = 30 * 4
    earlier.employees[0].limits.prior_week_days = 3
    shift(earlier, 1, 0, 36, 48)
    shift(earlier, 1, 1, 36, 32)
    res = validator.validate(earlier)
    assert {"WEEKLY_MAX", "DAYS_PER_WEEK"} & set(codes(res, "HARD")), "30 hours and 3 days already this week, plus 20 hours and 2 days"


def test_a_day_has_its_own_limit():
    req = base()
    req.employees[0].max_day_slots = 10 * 4
    shift(req, 1, 0, 24, 52)                                # 13 hours
    assert "DAILY_MAX" in codes(validator.validate(req), "HARD")


def test_people_who_may_not_work_nights_or_weekends_are_not_given_them():
    req = base(first_dow=4)                                 # day 0 is a Friday
    req.employees[0].allow_overnight = False
    req.employees[1].allow_weekend = False
    shift(req, 1, 0, 88, 32)
    shift(req, 2, 1, 36, 32)                                # Saturday
    assert codes(validator.validate(req), "HARD") == ["OVERNIGHT_NOT_ALLOWED", "WEEKEND_NOT_ALLOWED"]


def test_activities_must_be_inside_the_shift_apart_from_each_other_and_of_a_known_kind():
    req = base()
    s = shift(req, 1, 0, 36, 32)
    s.activities.add(type="MEAL", start_slot=50, slots=4)
    s.activities.add(type="BREAK", start_slot=52, slots=1)           # on top of the meal
    s.activities.add(type="TRAINING", start_slot=200, slots=4)       # nowhere near the shift
    s.activities.add(type="NAP", start_slot=40, slots=1)
    assert {"ACTIVITY_OVERLAP", "ACTIVITY_OUTSIDE_SHIFT", "UNKNOWN_ACTIVITY"} == set(codes(validator.validate(req), "HARD"))
    edge = base()
    e = shift(edge, 1, 0, 36, 32)
    e.activities.add(type="MEAL", start_slot=36, slots=2)
    assert "ACTIVITY_AT_EDGE" in codes(validator.validate(edge), "SOFT")


def test_shift_duration_paid_time_and_productive_time_are_three_different_things():
    req = base()
    s = shift(req, 1, 0, 36, 36)                                      # 9 hours on shift
    s.activities.add(type="MEAL", start_slot=52, slots=4)             # an unpaid hour: not paid, not on the phones
    s.activities.add(type="TEA_BREAK", start_slot=44, slots=1)        # paid, and counted as covered (the shrinkage allows for it)
    s.activities.add(type="TRAINING", start_slot=60, slots=4)         # paid, but not on the phones
    req.required.extend([1 if 36 <= g < 72 else 0 for g in range(7 * SPD)])
    res = validator.validate(req)
    assert next(l for l in res.loads if l.employee == 1).paid_slots == 36 - 4, "only the meal is unpaid"
    assert res.under_slots == 4 + 4, "the meal and the training are not coverage: eight slots short"
    assert res.coverage_status == "UNDERSTAFFED"


def test_a_roster_can_obey_every_rule_and_still_be_understaffed_which_is_not_called_perfect():
    req = base()
    shift(req, 1, 0, 36, 32)
    req.required.extend([3 if 36 <= g < 68 else 0 for g in range(7 * SPD)])
    res = validator.validate(req)
    assert res.valid and res.hard_violations == 0
    assert res.coverage_status == "UNDERSTAFFED" and res.status == "VALIDATED_WITH_WARNINGS" and "COVERAGE_SHORT" in codes(res, "SOFT")
    assert res.days[0].under_slots == 64 and res.days[0].coverage_percent == pytest.approx(100 * (1 - 64 / 96), abs=0.01)


def test_hours_below_and_above_the_contract_are_reported_for_weeks_the_period_covers_in_full():
    req = base(min_week_slots=40 * 4)
    for d in range(4):
        shift(req, 1, d, 36, 32)                                       # 32 h
    for d in range(5):
        shift(req, 2, d, 36, 36)                                       # 45 h
    res = validator.validate(req)
    assert {"BELOW_CONTRACT", "OVERTIME"} <= set(codes(res, "SOFT"))
    assert next(l for l in res.loads if l.employee == 2).overtime_slots == 5 * 36 - 160
    part = base(min_week_slots=40 * 4, first_dow=3)
    shift(part, 1, 0, 36, 32)
    assert "BELOW_CONTRACT" not in codes(validator.validate(part)), "a week the period only partly covers has no contract target here"


def test_skill_demand_is_judged_per_skill_and_people_without_any_asked_for_are_flagged():
    req = base(people=3)
    req.employees[1].limits.skill_ids.extend([7, 8])                  # only the second person holds either skill, and holds both
    for e in (1, 2, 3):
        shift(req, e, 0, 36, 32)
    window = [g for g in range(7 * SPD)]
    req.skill_requirements.add(id=7, required=[2 if 36 <= g < 68 else 0 for g in window])
    req.skill_requirements.add(id=8, required=[1 if 36 <= g < 68 else 0 for g in window])
    res = validator.validate(req)
    assert res.under_slots == 2 * 32, "three people are needed on skills (2 + 1) and the one person who holds them serves one at a time: two are short"
    assert {"SKILL_SHORT", "NO_USEFUL_SKILL", "COVERAGE_SHORT"} <= set(codes(res, "SOFT"))


def test_an_uneven_spread_of_weekend_and_holiday_hours_is_reported():
    req = base(first_dow=0, max_week_slots=10 ** 6, max_days_week=7)
    for d in (5, 6):
        shift(req, 1, d, 36, 40)
    res = validator.validate(req)
    assert res.fairness_spread_hours == 20 and "UNFAIR_WEEKEND_LOAD" in codes(res, "SOFT")
    shift(req, 2, 5, 36, 40)
    shift(req, 2, 6, 36, 40)
    assert validator.validate(req).fairness_spread_hours == 0


def test_a_shift_for_someone_who_is_not_there_or_outside_the_period_is_refused():
    req = base()
    shift(req, 9, 0)
    shift(req, 1, 40)
    assert {"UNKNOWN_EMPLOYEE", "BAD_SHIFT"} == set(codes(validator.validate(req), "HARD"))


# ---------------------------------------------------------------- the solvers' rosters pass it

def _request_from(req, res, extra_commitments=()):
    """The validator's input for a solver request and the roster it returned, built without anything the solver computed."""
    v = wfm_pb2.ValidateRequest(days=req.days, first_dow=req.first_dow, week_start=req.week_start, weekend_mask=req.weekend_mask, wrap=req.wrap, required=req.required)
    v.skill_requirements.extend(req.skill_requirements)
    v.dst_rest_adjust.extend(req.dst_rest_adjust)
    for e in req.employees:
        ve = v.employees.add(allow_overnight=True, allow_weekend=True, name=f"P{e.id}")
        ve.limits.CopyFrom(e)
    paid = {(o.employee, o.day, o.template, o.start_slot, o.length_slots): o.paid_slots or o.length_slots for o in req.options}
    for a in res.assignments:
        v.shifts.add(employee=a.employee, day=a.day, start_slot=a.start_slot, length_slots=a.length_slots, paid_slots=paid.get((a.employee, a.day, a.template, a.start_slot, a.length_slots), a.length_slots))
    v.commitments.extend(extra_commitments)
    return v


@pytest.mark.parametrize("backend", ["cpsat", "highs", "scip", "greedy"])
def test_every_backends_roster_passes_the_validator(backend):
    req = ts.build(n_emp=8, days=14, weekend=True)
    req.time_limit_sec = 10
    req.backend = backend
    res = scheduling.solve(req)
    out = validator.validate(_request_from(req, res))
    assert out.valid, [(f.code, f.message) for f in out.findings if f.severity == "HARD"][:5]
    ts.check(req, res)


# ---------------------------------------------------------------- over the wire

def test_the_validator_is_served_over_grpc_and_refuses_a_malformed_request():
    import grpc
    from test_server import _cfg, _stub, serving
    req = base()
    shift(req, 1, 0)
    with serving(_cfg()) as port:
        res = _stub(port).Validate(req)
        assert res.valid and res.status == "VALIDATED"
        dup = base()
        dup.employees[1].limits.id = 1
        with pytest.raises(grpc.RpcError) as e:
            _stub(port).Validate(dup)
        assert e.value.code() == grpc.StatusCode.INVALID_ARGUMENT and "same id" in e.value.details()


def test_work_for_another_group_counts_by_its_paid_time_not_its_length():
    def over(paid):
        req = base(max_week_slots=40 * 4, max_days_week=5)
        for d in range(3):
            shift(req, 1, d, 36, 40)                                                          # 3 x 10 h = 30 h
        for d in (3, 4):
            req.commitments.add(employee=1, day=d, start_slot=36, length_slots=22, kind="SHIFT", label="Billing", paid_slots=paid)
        return "WEEKLY_MAX" in codes(validator.validate(req), "HARD")
    assert over(0), "30 h here and two shifts of 5.5 h elsewhere, all counted: 41 h"
    assert not over(20), "the same shifts, each with an unpaid half hour: 40 h"
