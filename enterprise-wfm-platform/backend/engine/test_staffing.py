"""Staffing: the maths against independent references, the limits it reports instead of hiding, and the requests it refuses."""
import math

import pytest

import staffing
import validation
import wfm_pb2


def _erlang_c_reference(n, a):
    """P(wait) from the textbook sum, with no iteration shared with the code under test."""
    top = (a ** n / math.factorial(n)) * (n / (n - a))
    return top / (sum(a ** k / math.factorial(k) for k in range(n)) + top)


@pytest.mark.parametrize("n,a", [(12, 10.0), (30, 24.5), (5, 3.2), (60, 52.0), (3, 1.0)])
def test_erlang_c_waiting_probability_matches_the_textbook_formula(n, a):
    assert staffing.erlang_c_wait_prob(n, a) == pytest.approx(_erlang_c_reference(n, a), rel=1e-9)


def test_erlang_c_service_level_matches_its_closed_form():
    n, a, aht, answer = 12, 10.0, 300.0, 20
    sl, asa, _ = staffing.erlang_c_metrics(n, a, aht, answer)
    pw = _erlang_c_reference(n, a)
    assert sl == pytest.approx(1 - pw * math.exp(-(n - a) * answer / aht), rel=1e-9)
    assert asa == pytest.approx(pw * aht / (n - a), rel=1e-9)


def test_erlang_a_with_patience_that_never_runs_out_is_erlang_c():
    sl_a = staffing.erlang_a_metrics(24, 20.0, 300.0, 20, 10 ** 7)[0]
    sl_c = staffing.erlang_c_metrics(24, 20.0, 300.0, 20)[0]
    assert sl_a == pytest.approx(sl_c, abs=0.005)


def test_erlang_a_stays_correct_for_a_long_answer_threshold():
    # exp(-lt) underflows to zero for lt above about 745: the service level used to collapse to the share answered at once
    short = staffing.erlang_a_metrics(25, 20.0, 280.0, 20, 120)[0]
    long_ = staffing.erlang_a_metrics(25, 20.0, 280.0, 1800, 120)[0]
    longer = staffing.erlang_a_metrics(25, 20.0, 280.0, 3600, 120)[0]
    assert short < long_ <= longer <= 1.0
    # given long enough, everyone not abandoning is served: the service level tends to 1 - the share who abandon (which is what the rest of the model says that share is)
    ab = staffing.erlang_a_metrics(25, 20.0, 280.0, 20, 120)[2]
    assert longer == pytest.approx(1 - ab, abs=0.01), (longer, 1 - ab)


def test_erlang_a_follows_a_heavily_loaded_queue_further_than_the_old_fixed_cutoff():
    sl, asa, ab = staffing.erlang_a_metrics(1500, 1480.0, 300.0, 20, 600)
    assert 0 <= sl <= 1 and 0 <= ab <= 1 and math.isfinite(asa)


def _req(volume=220, aht=280, channel="voice", **p):
    r = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.28)
    r.params.add(channel=channel, service_level=0.8, answer_sec=20, occupancy_cap=0.85, method="erlang_c", **p)
    r.inputs.add(channel=channel, day="2026-12-07", slot=36, volume=volume, aht_sec=aht)
    return r


def test_an_interval_reports_what_was_asked_what_was_found_and_whether_the_target_was_met():
    validation.validate_staffing_request(_req())
    (o,) = staffing.staff_intervals(_req())
    assert o.offered_load_erlangs == pytest.approx(220 * 280 / 900, abs=0.01)
    assert o.base > o.offered_load_erlangs and o.required == math.ceil(o.base / (1 - 0.28))
    assert o.target_service_level == pytest.approx(0.8) and o.service_level >= 0.8 and o.target_met
    assert o.status == "OK" and o.occupancy_limit == pytest.approx(0.85) and o.occupancy <= 0.85 + 1e-9
    assert o.confidence in ("MEDIUM", "HIGH")


def test_a_target_the_agent_limit_cannot_reach_is_reported_not_passed_off_as_met(monkeypatch):
    monkeypatch.setattr(staffing, "MAX_AGENTS", 40)
    staffing._solve.cache_clear()
    try:
        (o,) = staffing.staff_intervals(_req(volume=9000))               # about 2,800 Erlangs
        assert o.base == 40 and not o.target_met and o.status == "TARGET_NOT_MET" and o.service_level < 0.8
    finally:
        staffing._solve.cache_clear()


def test_no_demand_is_said_to_be_no_demand():
    (o,) = staffing.staff_intervals(_req(volume=0))
    assert o.status == "NO_DEMAND" and o.base == 0 and o.target_met


def test_chat_efficiency_is_the_groups_own_when_it_sets_one():
    def agents(eff):
        r = _req(volume=300, aht=600, channel="chat", concurrency=3, **({"chat_efficiency": eff} if eff else {}))
        validation.validate_staffing_request(r)
        return staffing.staff_intervals(r)[0]
    default, full, poor = agents(0), agents(1.0), agents(0.6)
    assert default.offered_load_erlangs == pytest.approx(300 * 600 / (3 * 0.85) / 900, abs=0.01), "unset means the documented default of 0.85"
    assert full.offered_load_erlangs < default.offered_load_erlangs < poor.offered_load_erlangs
    assert full.base <= default.base <= poor.base


def test_email_and_back_office_report_their_load_and_a_met_target():
    r = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.3)
    r.params.add(channel="email", occupancy_cap=0.8, open_slot=32, close_slot=68)
    r.inputs.add(channel="email", day="2026-12-07", slot=40, volume=400, aht_sec=360)
    out = staffing.staff_intervals(r)
    assert out and all(o.target_met and o.status == "OK" and o.occupancy_limit == pytest.approx(0.8) for o in out)
    assert out[0].offered_load_erlangs == pytest.approx(400 * 360 / (36 * 900), abs=0.01)


@pytest.mark.parametrize("edit,message", [
    (lambda r: setattr(r.params[0], "occupancy_cap", 1.3), "occupancy limit"),
    (lambda r: setattr(r.params[0], "occupancy_cap", -0.5), "occupancy limit"),
    (lambda r: setattr(r.params[0], "service_level", 1.4), "service level"),
    (lambda r: setattr(r.params[0], "method", "erlang_x"), "method"),
    (lambda r: setattr(r, "shrinkage", 1.0), "shrinkage"),
    (lambda r: setattr(r, "shrinkage", -0.1), "shrinkage"),
    (lambda r: setattr(r, "interval_min", 7), "interval_min"),
    (lambda r: setattr(r.params[0], "chat_efficiency", 2.0), "chat efficiency"),
    (lambda r: setattr(r.params[0], "concurrency", 50), "concurrency"),
    (lambda r: setattr(r.inputs[0], "volume", float("nan")), "volume"),
    (lambda r: setattr(r.inputs[0], "slot", 200), "slot"),
    (lambda r: setattr(r.inputs[0], "aht_sec", -5), "handle time"),
    (lambda r: setattr(r.inputs[0], "channel", "chat"), "no parameters"),
    (lambda r: r.params.add(channel="voice"), "two parameter sets"),
])
def test_a_staffing_request_that_cannot_be_answered_as_sent_is_refused_and_says_why(edit, message):
    r = _req()
    edit(r)
    with pytest.raises(validation.InvalidRequest, match=message):
        validation.validate_staffing_request(r)


def test_unset_targets_are_the_documented_defaults_and_valid():
    r = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.2)
    r.params.add(channel="voice")
    r.inputs.add(channel="voice", day="2026-12-07", slot=10, volume=100, aht_sec=300)
    validation.validate_staffing_request(r)
    (o,) = staffing.staff_intervals(r)
    assert o.target_service_level == pytest.approx(0.8) and o.occupancy_limit == 1.0 and o.target_met


def test_the_legacy_hourly_function_checks_its_inputs_and_has_a_bound():
    assert staffing.required_agents(0, 300, 0.8, 20) == 0
    assert staffing.required_agents(600, 300, 0.8, 20) >= 51
    for bad in [(-1, 300, 0.8, 20), (100, 300, 0.0, 20), (100, 300, 1.5, 20), (100, 300, 0.8, -1), (float("nan"), 300, 0.8, 20), (100, 0, 0.8, 20)]:
        with pytest.raises(ValueError):
            staffing.required_agents(*bad)
    with pytest.raises(ValueError, match="cannot be reached"):
        staffing.required_agents(10 ** 7, 300, 0.99, 5)


def _a_request(method, volume=45, aht=200):
    r = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.28)
    r.params.add(channel="voice", service_level=0.8, answer_sec=20, occupancy_cap=0.95, method=method, patience_sec=120)
    r.inputs.add(channel="voice", day="2026-12-07", slot=36, volume=volume, aht_sec=aht)
    return r


def test_occupancy_is_the_work_agents_carry_so_callers_who_gave_up_do_not_count_under_erlang_a():
    (a,) = staffing.staff_intervals(_a_request("erlang_a"))
    (c,) = staffing.staff_intervals(_a_request("erlang_c"))
    load = 45 * 200 / 900                                                       # 10 Erlangs
    _, _, gave_up = staffing.erlang_a_metrics(a.base, load, 200.0, 20, 120)
    assert gave_up > 0.005
    assert a.occupancy == pytest.approx(load * (1 - gave_up) / a.base, abs=1e-3)
    assert a.occupancy < load / a.base, "less than offered load over agents: the callers who left never loaded anyone"
    assert c.occupancy == pytest.approx(load / c.base, abs=1e-3), "with no abandonment it is the textbook traffic over agents"
