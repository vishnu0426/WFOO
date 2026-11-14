"""Forecast bands are calibrated on errors the model did not see, and a group's forecast is the sum of its queues in every interval."""
import datetime

import numpy as np
import pytest

import forecasting
import wfm_pb2


# ---------------------------------------------------------------- calibration

def _coverage(rel_by_fold, fallback=0.1):
    lo, hi, method, c10, c90, n = forecasting.calibrate_bands(rel_by_fold, fallback)
    return lo, hi, method, c10, c90, n


def test_bands_that_follow_the_errors_cover_what_they_say_they_cover():
    rng = np.random.default_rng(1)
    folds = [list(rng.normal(0, 0.08, 400)) for _ in range(8)]
    lo, hi, method, c10, c90, n = _coverage(folds)
    assert method == "EMPIRICAL" and n == 3200
    assert c10 == pytest.approx(0.10, abs=0.025) and c90 == pytest.approx(0.90, abs=0.025)
    assert lo == pytest.approx(-1.2816 * 0.08, abs=0.01) and hi == pytest.approx(1.2816 * 0.08, abs=0.01)


def test_errors_that_are_skewed_get_a_skewed_band_where_a_normal_band_would_miss():
    rng = np.random.default_rng(2)
    skewed = lambda: list(np.exp(rng.normal(0, 0.35, 400)) - 1.0)         # under-forecasting is far more common and more costly than over-forecasting
    folds = [skewed() for _ in range(8)]
    lo, hi, _, c10, c90, _ = _coverage(folds)
    assert abs(hi) > abs(lo) * 1.3, "the upper edge is further from the forecast than the lower one"
    assert c10 == pytest.approx(0.10, abs=0.03) and c90 == pytest.approx(0.90, abs=0.03)
    # a normal band of the same spread is wrong in exactly the way a planner would care about: too tight above, too loose below
    allrel = np.array([r for f in folds for r in f])
    sd = float(np.std(allrel))
    normal_c90 = float(np.mean(allrel <= 1.2816 * sd))
    assert abs(normal_c90 - 0.90) > abs(c90 - 0.90)


def test_too_little_history_falls_back_to_a_normal_band_and_says_so():
    folds = [[0.05, -0.04, 0.02, -0.06, 0.07, -0.01, 0.03] for _ in range(2)]
    lo, hi, method, _c10, _c90, n = _coverage(folds, fallback=0.08)
    assert method == "NORMAL" and n == 14
    assert lo == pytest.approx(-1.2816 * 0.08) and hi == pytest.approx(1.2816 * 0.08)


def test_the_band_always_contains_the_point_forecast():
    lo, hi, *_ = _coverage([[0.1 + 0.001 * i for i in range(30)] for _ in range(4)])         # a model that is always too low
    assert lo <= 0.0 <= hi


# ---------------------------------------------------------------- one queue, end to end

def _history(days=140, seed=4, level=400.0):
    rng = np.random.default_rng(seed)
    start = datetime.date(2026, 6, 1)
    weekly = np.array([1.0, 1.05, 1.0, 0.98, 0.95, 0.45, 0.35])
    return [(start + datetime.timedelta(days=d), float(max(0, level * weekly[(start + datetime.timedelta(days=d)).weekday()] * (1 + rng.normal(0, 0.06))))) for d in range(days)]


def _queue(qid, level, days=140, spd=96, slot_weeks=3):
    q = wfm_pb2.QueueSeries(queue_id=qid, name=f"Q{qid}", channel="voice")
    hist = _history(days, seed=qid, level=level)
    for d, v in hist:
        q.daily.add(day=d.isoformat(), slot=-1, volume=round(v, 1), aht_sec=300 + 20 * qid)
    shape = np.exp(-0.5 * ((np.arange(spd) - 40 - 3 * qid) / 12.0) ** 2)
    shape /= shape.sum()
    for d, v in hist[-7 * slot_weeks:]:
        for s in range(spd):
            q.slots.add(day=d.isoformat(), slot=s, volume=round(v * shape[s], 3), aht_sec=300 + 20 * qid)
    return q, hist[-1][0]


def test_a_queue_forecast_reports_how_its_band_was_made_and_how_it_held_up():
    q, last = _queue(1, 400.0)
    fc, _ = forecasting.forecast_queue(q, [(last + datetime.timedelta(days=k)).isoformat() for k in range(1, 15)], 0, [], "auto", set())
    assert fc.band_method == "EMPIRICAL" and fc.band_points >= 20
    assert 0 <= fc.p10_coverage <= 1 and 0 <= fc.p90_coverage <= 1
    assert all(p.p10 <= p.volume <= p.p90 for p in fc.daily)
    widths = [(p.p90 - p.p10) / max(p.volume, 1e-9) for p in fc.daily]
    assert widths[-1] > widths[0], "the further ahead, the wider the band"


# ---------------------------------------------------------------- group = sum of queues, in every interval

def _request(reconcile):
    req = wfm_pb2.SeriesRequest(slots_per_day=96, model="snaive", reconcile=reconcile)
    qs = [_queue(1, 300.0), _queue(2, 500.0), _queue(3, 150.0)]
    for q, _ in qs:
        req.queues.append(q)
    last = qs[0][1]
    for k in range(1, 8):
        req.dates.append((last + datetime.timedelta(days=k)).isoformat())
    return req


def test_the_group_forecast_is_the_sum_of_its_queues_in_every_interval_and_every_day():
    resp = forecasting.run(_request(True))
    group = next(s for s in resp.series if s.queue_id == 0)
    queues = [s for s in resp.series if s.queue_id != 0]
    assert len(queues) == 3 and group.slots, "the group has a 15-minute forecast of its own"
    per_slot = {}
    for s in queues:
        for p in s.slots:
            per_slot[(p.day, p.slot)] = per_slot.get((p.day, p.slot), 0.0) + p.volume
    assert {(p.day, p.slot) for p in group.slots} == set(per_slot)
    for p in group.slots:
        assert p.volume == pytest.approx(per_slot[(p.day, p.slot)], abs=2e-3), f"{p.day} slot {p.slot}"
        assert p.volume >= 0 and p.p10 >= 0 and p.p10 <= p.volume <= p.p90
    per_day = {}
    for s in queues:
        for p in s.daily:
            per_day[p.day] = per_day.get(p.day, 0.0) + p.volume
    for p in group.daily:
        assert p.volume == pytest.approx(per_day[p.day], abs=1e-6)
        assert p.volume == pytest.approx(sum(x.volume for x in group.slots if x.day == p.day), rel=2e-3, abs=0.2), "the group's days are the sum of its intervals too"


def test_reconciling_keeps_the_queues_in_proportion_to_each_other():
    plain = {s.queue_id: s for s in forecasting.run(_request(False)).series}
    rec = {s.queue_id: s for s in forecasting.run(_request(True)).series if s.queue_id != 0}
    for d in range(7):
        a1, b1 = plain[1].daily[d].volume, plain[2].daily[d].volume
        a2, b2 = rec[1].daily[d].volume, rec[2].daily[d].volume
        assert a2 / b2 == pytest.approx(a1 / b1, rel=0.01), "one common factor per day: the queues keep their shares"
    assert not [s for s in forecasting.run(_request(False)).series if s.queue_id == 0], "no group series without reconciliation"


# ---------------------------------------------------------------- the model registry record

def _dates(last, n=7):
    return [(last + datetime.timedelta(days=k)).isoformat() for k in range(1, n + 1)]


def test_a_forecast_records_what_it_learned_from_and_how_it_was_set_up():
    q, last = _queue(1, 400.0)
    fc, _ = forecasting.forecast_queue(q, _dates(last), 0, [], "auto", set())
    assert fc.training_start == q.daily[0].day and fc.training_end == q.daily[-1].day and fc.training_rows == len(q.daily)
    assert len(fc.data_hash) == 64 and len(fc.events_hash) == 64
    cfg = __import__("json").loads(fc.model_config)
    assert cfg["model"] == fc.model and cfg["backtest"]["walk_forward"] is True and cfg["history_days"] >= len(q.daily) - 1
    libs = __import__("json").loads(fc.library_versions)
    assert {"numpy", "pandas", "scipy", "statsmodels", "scikit-learn"} <= set(libs) and all(v != "unknown" for v in libs.values())
    assert fc.model_version.startswith(fc.model + "-") and len(fc.model_version.split("-")[-1]) == 12


def test_the_same_inputs_give_the_same_record_and_changed_inputs_a_different_one():
    q, last = _queue(1, 400.0)
    a, _ = forecasting.forecast_queue(q, _dates(last), 0, [], "snaive", set())
    b, _ = forecasting.forecast_queue(q, _dates(last), 0, [], "snaive", set())
    assert (a.model_version, a.data_hash, a.model_config, a.events_hash) == (b.model_version, b.data_hash, b.model_config, b.events_hash)
    assert [p.volume for p in a.daily] == [p.volume for p in b.daily], "the forecast itself is reproducible from the record"
    changed = wfm_pb2.QueueSeries()
    changed.CopyFrom(q)
    changed.daily[10].volume += 1
    c, _ = forecasting.forecast_queue(changed, _dates(last), 0, [], "snaive", set())
    assert c.data_hash != a.data_hash, "one changed day of history is a different training set"
    ev = wfm_pb2.EventInfo(name="Launch", kind="campaign", start_day=last.isoformat(), end_day=last.isoformat(), uplift_pct=20)
    d, _ = forecasting.forecast_queue(q, _dates(last), 0, [ev], "snaive", set())
    assert d.events_hash != a.events_hash, "a special event in force changes the record"


def test_the_band_beyond_a_week_is_calibrated_on_the_four_week_backtest(monkeypatch):
    monkeypatch.setattr(forecasting, "candidates", lambda y: ["snaive", "wavg", "ets"])         # keep the test light: no network or boosted model
    q, last = _queue(1, 400.0, days=220)
    fc, sigma = forecasting.forecast_queue(q, [(last + datetime.timedelta(days=k)).isoformat() for k in range(1, 61)], 0, [], "auto", set())
    assert isinstance(sigma, forecasting.Sigma) and sigma.far is not None, "a 220-day history is enough for a 4-week backtest"
    cfg = __import__("json").loads(fc.model_config)
    assert cfg["backtest"]["long_folds"] == 2 and cfg["backtest"]["far_band"] and cfg["backtest"]["far_band"]["points"] >= 20
    width = lambda i: (fc.daily[i].p90 - fc.daily[i].p10) / max(fc.daily[i].volume, 1e-9)
    assert all(p.p10 <= p.volume <= p.p90 for p in fc.daily)
    assert width(9) >= width(2), "never narrower beyond a week than inside it"
    assert width(50) > width(9), "and wider again past the 4 weeks it was measured on"


def test_a_short_history_says_the_far_band_is_not_calibrated():
    q, last = _queue(1, 400.0, days=100)
    fc, sigma = forecasting.forecast_queue(q, [(last + datetime.timedelta(days=k)).isoformat() for k in range(1, 30)], 0, [], "snaive", set())
    assert sigma.far is None
    assert any("not calibrated" in n and "140 days" in n for n in fc.notes), list(fc.notes)
