"""A request that cannot be solved as sent is refused with the reason, before any solver sees it."""
import pytest

import validation
import wfm_pb2

SPD = 96


def good(days=2):
    req = wfm_pb2.ScheduleRequest(days=days, first_dow=0, time_limit_sec=5, w_under=900, w_over=30, workers=1)
    req.required.extend([1] * (days * SPD))
    req.employees.add(id=1, max_week_slots=160, min_week_slots=0, max_consecutive=6, rest_slots=44, max_days_week=5)
    req.options.add(employee=1, day=0, template=0, start_slot=32, length_slots=32, paid_slots=30)
    return req


def refused(req, text, max_options=300_000):
    with pytest.raises(validation.InvalidRequest) as e:
        validation.validate_schedule_request(req, max_options)
    assert text in str(e.value), str(e.value)


def test_a_consistent_request_is_accepted():
    validation.validate_schedule_request(good(), 300_000)


def test_values_outside_what_they_mean_are_refused_with_the_reason():
    r = good(); r.days = 0; refused(r, "days must be between 1 and")
    r = good(); r.first_dow = 9; refused(r, "first_dow")
    r = good(); r.time_limit_sec = 99999; refused(r, "time_limit_sec")
    r = good(); r.w_under = -1; refused(r, "w_under cannot be negative")
    r = good(); r.required[3] = -2; refused(r, "negative number of people")
    r = good(); r.backend = "cpsat; rm -rf"; refused(r, "backend")


def test_options_that_do_not_fit_the_request_are_refused():
    r = good(); r.options[0].employee = 99; refused(r, "employee 99 is not in the request")
    r = good(); r.options[0].day = 5; refused(r, "outside the period")
    r = good(); r.options[0].start_slot = 200; refused(r, "not a slot of the day")
    r = good(); r.options[0].length_slots = 0; refused(r, "empty or longer than 48 hours")
    r = good(); r.options[0].paid_slots = 99; refused(r, "paid_slots")
    r = good(); r.options[0].gap_start_slot, r.options[0].gap_slots = 70, 10; refused(r, "not inside the shift")


def test_people_must_be_distinct_and_make_sense():
    r = good(); r.employees.add(id=1); refused(r, "appears twice")
    r = good(); r.employees[0].min_week_slots, r.employees[0].max_week_slots = 200, 100; refused(r, "above the weekly maximum")
    r = good(); r.employees[0].max_days_week = 9; refused(r, "max_days_week")
    r = good(); r.skill_requirements.add(id=1); r.skill_requirements.add(id=1); refused(r, "not a unique positive number")


def test_too_many_candidate_shifts_is_refused_with_the_limit():
    refused(good(), "more than the solver can take", max_options=0)


def test_a_repeating_period_must_be_a_week_or_less():
    r = good(days=14); r.wrap = True; refused(r, "one week or less")
    r = good(days=7); r.wrap = True; validation.validate_schedule_request(r, 300_000)


def test_several_problems_are_listed_together():
    r = good(); r.first_dow = 9; r.w_over = -5; r.options[0].employee = 42
    with pytest.raises(validation.InvalidRequest) as e:
        validation.validate_schedule_request(r, 300_000)
    assert all(t in str(e.value) for t in ("first_dow", "w_over", "employee 42"))
