"""The simulation must agree with queueing theory where theory applies, and behave sensibly where it does not."""
import simulation
import wfm_pb2
from staffing import erlang_a_metrics


def flat(agents, volume=60, aht=300, n=96, **kw):
    req = wfm_pb2.SimRequest(answer_sec=20, patience_sec=120, replications=30, volume_cv=0.0, seed=3, slots_per_day=96, **kw)
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
