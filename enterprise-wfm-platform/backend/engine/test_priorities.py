"""Cover comes first: soft goals can never be worth more than leaving demand uncovered. Instead of seven solves in a chain, the weights are checked against a bound, and a property
test shows the bound does what it is for."""
import pytest

import scheduling
import scoring
import test_scheduling as ts
import validation
import wfm_pb2


def _instance(w_pref, w_consist, w_fair, w_under=900):
    r = ts.build(n_emp=7, days=7, weekend=True)
    r.time_limit_sec = 10
    r.w_under, r.w_over, r.w_hours = w_under, 30, 50
    r.w_pref, r.w_consist, r.w_fair = w_pref, w_consist, w_fair
    r.consistency_mode, r.start_tol_slots, r.end_tol_slots = 1, 2, 2
    for i, o in enumerate(r.options):
        # an attractive preference on the shift that covers least: the temptation to give cover up for it
        if o.start_slot == 20:
            o.preference = 1
    return r


def test_the_bound_is_what_a_shift_can_gain_from_the_soft_goals():
    req = _instance(100, 200, 100)
    swing, price, ok = scoring.dominance(req)
    assert swing == 100 + 2 * 200 + (100 // 8) * 24 and price == 900 and ok
    bad = _instance(100, 200, 100, w_under=300)
    assert scoring.dominance(bad)[2] is False
    off = _instance(100, 200, 100)
    off.consistency_mode = 0
    assert scoring.dominance(off)[0] == 100 + (100 // 8) * 24, "usual times are not a goal when nobody asks for them"
    free = _instance(100, 200, 100, w_under=0)
    assert scoring.dominance(free)[2], "no cover goal at all: nothing for the soft goals to outweigh"


def test_weights_that_would_let_a_preference_beat_cover_are_refused_with_the_figure_to_use():
    req = _instance(100, 200, 100, w_under=300)
    with pytest.raises(validation.InvalidRequest, match="Raise the cost of understaffing to at least 788"):
        validation.validate_schedule_request(req, 10 ** 6)
    try:
        validation.validate_schedule_request(_instance(100, 200, 100), 10 ** 6)       # (this builder numbers people from 0, which the checks refuse for another reason)
    except validation.InvalidRequest as e:
        assert "understaffing" not in str(e)


def test_turning_every_soft_goal_to_its_maximum_never_costs_cover():
    slow = lambda r: (setattr(r, "time_limit_sec", 40), r)[1]                 # proven optimal, whatever else the machine is doing
    quiet = scheduling.solve(slow(_instance(0, 0, 0)))
    loud = scheduling.solve(slow(_instance(100, 200, 100)))
    assert quiet.status == "OPTIMAL" and loud.status == "OPTIMAL", (quiet.status, loud.status)
    assert loud.under_slots <= quiet.under_slots, f"cover {quiet.under_slots} short without the soft goals, {loud.under_slots} with them"
    ts.check(_instance(100, 200, 100), loud)


def test_without_the_bound_the_inversion_it_prevents_is_real():
    """One shift that is the only way to cover a slot, against a preference for an alternative that leaves it short: with cover priced below the soft goals, the solver gives cover up."""
    req = wfm_pb2.ScheduleRequest(days=1, first_dow=0, time_limit_sec=5, w_under=1, w_over=0, w_pref=100, workers=1)
    req.required.extend([1 if 36 <= g < 37 else 0 for g in range(96)])                          # one slot to cover
    req.employees.add(id=1, max_week_slots=400, max_consecutive=5, rest_slots=0, max_days_week=5)
    req.options.add(employee=1, day=0, template=0, start_slot=36, length_slots=4, preference=0)      # covers the slot
    req.options.add(employee=1, day=0, template=1, start_slot=60, length_slots=4, preference=1)      # does not, but is preferred
    res = scheduling.solve(req)
    assert res.under_slots == 1, "with a slot of cover worth 1 and a preference worth 100, the preference wins: this is what the guard exists to forbid"
    req.w_under = 900
    assert scheduling.solve(req).under_slots == 0
