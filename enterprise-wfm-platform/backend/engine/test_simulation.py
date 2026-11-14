"""The simulation must agree with queueing theory where theory applies, and behave sensibly where it does not."""
import simulation
import wfm_pb2
from staffing import erlang_a_metrics


def flat(agents, volume=60, aht=300, n=96, replications=30, seed=3, **kw):
    kw.setdefault('patience_sec', 120)
    req = wfm_pb2.SimRequest(answer_sec=20, replications=replications, volume_cv=0.0, seed=seed, slots_per_day=96, **kw)
    for _ in range(n):
        req.intervals.add(volume=volume, aht_sec=aht, agents=agents)
    return req


def middle(res, f):
    xs = [f(i) for i in res.intervals[8:88]]
    return sum(xs) / len(xs)


def test_matches_erlang_a_in_a_steady_state():
    for agents in (21, 24, 27):
        res = simulation.run(flat(agents))
        sl, _, ab = erlang_a_metrics(agents, 60 * 300 / 900, 300, 20, 120)
        assert abs(middle(res, lambda i: i.sl_mean) - sl) < 0.04, agents
        assert abs(middle(res, lambda i: i.abandon) - ab) < 0.02, agents


def test_more_people_never_make_service_worse():
    a, b = simulation.run(flat(22)), simulation.run(flat(26))
    assert b.sl_mean > a.sl_mean and b.abandon < a.abandon and b.occupancy < a.occupancy


def test_same_seed_same_answer():
    a, b = simulation.run(flat(23)), simulation.run(flat(23))
    assert a.sl_mean == b.sl_mean and list(a.sl_by_rep) == list(b.sl_by_rep)


def test_nobody_on_the_phones_means_everyone_gives_up():
    res = simulation.run(flat(0, n=8))
    assert res.sl_mean == 0.0 and res.abandon > 0.5


def test_no_calls_is_a_perfect_day_with_no_occupancy():
    res = simulation.run(flat(5, volume=0, n=8))
    assert res.sl_mean == 1.0 and res.occupancy == 0.0 and res.offered == 0


def test_forecast_error_makes_the_bad_days_worse_than_the_average_day():
    exact, wrong = simulation.run(flat(24)), simulation.run(flat(24, ))
    req = flat(24)
    req.volume_cv = 0.15
    noisy = simulation.run(req)
    assert min(noisy.sl_by_rep) < min(exact.sl_by_rep)
    assert noisy.days[0].sl_low < noisy.days[0].sl_mean


def test_people_who_leave_at_the_edge_finish_their_call_and_a_busier_interval_backs_up():
    req = wfm_pb2.SimRequest(answer_sec=20, patience_sec=120, replications=30, volume_cv=0.0, seed=5, slots_per_day=8)
    for k in range(8):
        req.intervals.add(volume=120 if k in (3, 4) else 40, aht_sec=300, agents=45 if k not in (3, 4) else 12)
    res = simulation.run(req)
    assert res.intervals[3].sl_mean < res.intervals[1].sl_mean
    assert res.intervals[4].asa_sec > res.intervals[1].asa_sec and res.intervals[4].abandon > res.intervals[1].abandon, 'callers in the short interval wait and give up'
    assert res.intervals[5].sl_mean > 0.9, 'once people are back the queue clears'


def test_reports_one_day_per_96_intervals():
    req = flat(25, n=96 * 3)
    req.replications = 5
    res = simulation.run(req)
    assert len(res.days) == 3 and len(res.sl_by_rep) == 5


# ---------------------------------------------------------------- richer behaviour: handling time, patience, after-call work, forecast error, priority, confidence

import math

import pytest

from staffing import erlang_c_metrics


def sl_of(**kw):
    agents = kw.pop("agents", 23)
    return simulation.run(flat(agents, **kw))


def test_with_patience_that_never_runs_out_the_simulation_matches_erlang_c():
    req = flat(24, replications=60)
    req.patience_sec = 86400
    res = simulation.run(req)
    sl, _asa, _ = erlang_c_metrics(24, 20.0, 300.0, 20)
    assert abs(middle(res, lambda i: i.sl_mean) - sl) < 0.03


def test_handling_times_that_vary_more_are_worse_for_the_same_average():
    # nobody gives up here, so the only thing that differs is how spread out the handling times are (Kingman: the wait grows with (1 + cv squared) / 2)
    steady = sl_of(agents=22, handle_dist="LOGNORMAL", handle_cv=0.3, patience_sec=86400)
    spread = sl_of(agents=22, handle_dist="LOGNORMAL", handle_cv=2.0, patience_sec=86400)
    assert steady.sl_mean > spread.sl_mean + 0.05
    exp, ln1 = sl_of(), sl_of(handle_dist="LOGNORMAL", handle_cv=1.0)
    assert abs(exp.sl_mean - ln1.sl_mean) < 0.04, "a lognormal as spread out as an exponential behaves like one"


def test_after_call_work_costs_service_and_counts_as_occupancy():
    plain, acw = sl_of(agents=26), sl_of(agents=26, after_call_work_sec=90)
    assert acw.sl_mean < plain.sl_mean - 0.03 and acw.occupancy > plain.occupancy + 0.05


def test_callers_give_up_when_the_observed_abandonment_says_they_do():
    quick, patient = sl_of(agents=21), sl_of(agents=21)
    quick = simulation.run(flat(21, patience_dist="EMPIRICAL", patience_samples=[4.0] * 30))
    patient = simulation.run(flat(21, patience_dist="EMPIRICAL", patience_samples=[7200.0] * 30))
    assert quick.abandon > 0.3 and patient.abandon < 0.02 and quick.sl_mean < patient.sl_mean + 0.0001 or quick.abandon > patient.abandon


def test_the_forecast_own_past_errors_decide_how_wrong_a_day_can_be():
    exact = simulation.run(flat(24, replications=80, volume_scales=[1.0]))
    wrong = simulation.run(flat(24, replications=80, volume_scales=[0.7, 1.0, 1.35]))
    spread = lambda r: float(__import__("numpy").std(list(r.sl_by_rep)))
    assert spread(wrong) > spread(exact) + 0.01, "days that came in 30% over or under are worse and more varied than days that came in as forecast"
    assert wrong.offered == pytest.approx(exact.offered * (0.7 + 1.0 + 1.35) / 3, rel=0.12)


def test_high_priority_calls_are_served_first():
    mixed = simulation.run(flat(21, volume=64, priority_share=0.3))
    assert mixed.priority_sl_mean > mixed.normal_sl_mean + 0.1, (mixed.priority_sl_mean, mixed.normal_sl_mean)
    assert mixed.priority_sl_mean > 0.9 * 0.0 + 0.5
    none = simulation.run(flat(21, volume=64))
    assert none.priority_sl_mean == 0 and none.normal_sl_mean == 0


def test_the_confidence_interval_holds_the_mean_and_narrows_with_more_replications():
    few = simulation.run(flat(23, replications=40))
    many = simulation.run(flat(23, replications=400, n=96, seed=11))
    for res in (few, many):
        assert res.sl_ci_low <= res.sl_mean <= res.sl_ci_high and res.abandon_ci_low <= res.abandon <= res.abandon_ci_high
    assert (many.sl_ci_high - many.sl_ci_low) < (few.sl_ci_high - few.sl_ci_low) * 0.6
    assert all(i.sl_ci_low <= i.sl_mean <= i.sl_ci_high for i in few.intervals)


def test_the_interval_really_covers_the_true_mean_about_as_often_as_it_says():
    # the true mean is itself estimated, from three long runs, so its own error (about a fifth of one interval's half-width) is small next to the intervals being judged
    truth = sum(simulation.run(flat(23, replications=500, n=24, seed=s)).sl_mean for s in (901, 902, 903)) / 3
    inside = 0
    runs = 20
    for seed in range(1, runs + 1):
        r = simulation.run(flat(23, replications=40, n=24, seed=seed))
        inside += r.sl_ci_low <= truth <= r.sl_ci_high
    assert inside >= 0.80 * runs, f"a 95% interval held the true mean in {inside} of {runs} runs"


def test_a_stretch_too_big_for_the_work_limit_says_how_many_replications_it_could_run():
    req = flat(900, volume=2000, n=96, replications=100)
    res = simulation.run(req)
    assert res.replications_requested == 100 and 1 <= res.replications < 100


def test_a_negative_patience_means_nobody_gives_up_and_matches_erlang_c():
    from staffing import erlang_c_metrics
    req = flat(24, replications=60)
    req.patience_sec = -1
    res = simulation.run(req)
    sl, _asa, _ = erlang_c_metrics(24, 20.0, 300.0, 20)
    assert abs(middle(res, lambda i: i.sl_mean) - sl) < 0.03
    assert max(i.abandon for i in res.intervals) == 0.0, "with no abandonment nobody is lost"


def test_unset_or_zero_patience_is_still_120_seconds():
    a = simulation.run(flat(21, replications=40, patience_sec=0))
    b = simulation.run(flat(21, replications=40, patience_sec=120))
    assert middle(a, lambda i: i.abandon) == middle(b, lambda i: i.abandon) > 0
