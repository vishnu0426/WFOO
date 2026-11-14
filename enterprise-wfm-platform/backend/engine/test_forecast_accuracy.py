"""Forecast accuracy changes: repeating spikes are kept, the models can learn day-of-month, models are also scored four weeks out, and handle time is forecast per day."""
import numpy as np
import pandas as pd

import forecasting as fc


def _series(n=240, spike=None, one_off=None, start="2026-01-01"):
    ix = pd.date_range(start, periods=n)
    week = np.array([120, 130, 125, 128, 118, 60, 40], dtype=float)
    y = pd.Series([week[d.dayofweek] for d in ix], index=ix)
    rng = np.random.default_rng(3)
    y = y * (1 + rng.normal(0, 0.02, n))
    if spike:
        y[ix.day == spike] *= 1.7                 # e.g. pay day
    if one_off is not None:
        y.iloc[one_off] *= 2.2
    return y, pd.Series(False, index=ix)


def test_a_spike_that_repeats_every_month_is_kept():
    y, mask = _series(spike=1)
    clean, _, _ = fc.clean_series(y, mask)
    firsts = y.index.day == 1
    assert np.allclose(clean[firsts], y[firsts]), "the first-of-month spike must stay in the history"


def test_a_single_odd_day_is_still_cleaned_away():
    y, mask = _series(one_off=100)
    clean, n, _ = fc.clean_series(y, mask)
    assert n >= 1 and clean.iloc[100] < y.iloc[100] * 0.6


def test_a_spike_in_one_month_only_is_not_called_a_pattern():
    y, mask = _series(one_off=45)               # one 15 Feb spike
    clean, _, _ = fc.clean_series(y, mask)
    assert clean.iloc[45] < y.iloc[45] * 0.6


def test_a_gradient_boosted_model_learns_the_first_of_the_month():
    y, mask = _series(n=420, spike=1)
    clean, _, _ = fc.clean_series(y, mask)
    f = fc.m_gbm(clean.iloc[:-30], 30)
    fut = pd.date_range(clean.index[-31] + pd.Timedelta(days=1), periods=30)
    same_dow_other = [i for i, d in enumerate(fut) if d.day != 1]
    firsts = [i for i, d in enumerate(fut) if d.day == 1]
    assert firsts, "the window must contain a first of the month"
    actual = clean.iloc[-30:].values
    err_first = abs(f[firsts[0]] - actual[firsts[0]]) / actual[firsts[0]]
    assert err_first < 0.25, f"forecast for the first of the month is {err_first:.0%} off"
    assert np.mean(np.abs(f[same_dow_other] - actual[same_dow_other]) / actual[same_dow_other]) < 0.15


def test_models_are_also_scored_four_weeks_out():
    y, mask = _series(n=240)
    cache = {}
    long = fc.backtest_long(y, ["snaive", "wavg"], set(), cache, raw=y, event_mask=mask)
    assert set(long) == {"snaive", "wavg"} and all(v["mase_long"] > 0 for v in long.values())
    assert fc.backtest_long(y.iloc[:100], ["snaive"], set(), {}, raw=y.iloc[:100], event_mask=mask.iloc[:100]) == {}, "too little history for two four-week folds"


def test_selection_blends_the_two_horizons_only_when_every_model_has_both():
    both = {"snaive": {"mase": 1.0, "mase_long": 1.0}, "a": {"mase": 0.7, "mase_long": 1.4}, "b": {"mase": 0.9, "mase_long": 0.8}}
    assert fc.pick_model(both, "auto") == "b"        # a is best next week and worst a month out
    only_short = {"snaive": {"mase": 1.0}, "a": {"mase": 0.7, "mase_long": 1.4}, "b": {"mase": 0.9}}
    assert fc.pick_model(only_short, "auto") == "a"  # no long figure for all: ranked on the 1-week figure, as before


def test_a_model_must_still_beat_seasonal_naive():
    assert fc.pick_model({"snaive": {"mase": 1.0, "mase_long": 1.0}, "a": {"mase": 1.1, "mase_long": 0.95}}, "auto") == "snaive"


class _P:
    def __init__(self, day, slot, volume, aht):
        self.day, self.slot, self.volume, self.aht_sec = day, slot, volume, aht


def _slots(days=84, drift=0.0, weekday_extra=None):
    out = []
    d0 = pd.Timestamp("2026-08-01")
    for i in range(days):
        d = d0 + pd.Timedelta(days=i)
        aht = 300 * (1 + drift * i / days) * (weekday_extra or {}).get(d.dayofweek, 1.0)
        out.append(_P(d.date().isoformat(), 10, 100.0, aht))
    return out, (d0 + pd.Timedelta(days=days)).date().isoformat()


def test_handle_time_follows_a_drift():
    slots, nxt = _slots(drift=0.30)                      # handle time rose 30% over twelve weeks
    f = fc.aht_forecast(slots, [nxt], 330.0)[nxt]
    assert 375 < f < 395, f"the last weeks ran at about 385 s, got {f:.0f}"         # the plain average would say about 345


def test_handle_time_has_a_weekday_shape():
    slots, _ = _slots(weekday_extra={0: 1.15})           # Mondays run 15% longer
    mon, tue = "2026-10-26", "2026-10-27"                # a Monday and the day after
    f = fc.aht_forecast(slots, [mon, tue], 300.0)
    assert f[mon] > f[tue] * 1.08


def test_handle_time_with_little_history_is_the_plain_average():
    slots, nxt = _slots(days=5)
    assert fc.aht_forecast(slots, [nxt], 321.0)[nxt] == 321.0


# ---------------------------------------------------------------- a stricter rule for repeating spikes

def _kept_of_one_offs(seed, n_out=30, days=730):
    rng = np.random.default_rng(seed)
    ix = pd.date_range("2024-01-01", periods=days)
    y = pd.Series(100.0, index=ix) * (1 + rng.normal(0, 0.02, days))
    hits = rng.choice(days, n_out, replace=False)
    y.iloc[hits] *= rng.uniform(1.8, 2.6, n_out)
    mask = pd.Series(False, index=ix)
    clean, n, _ = fc.clean_series(y, mask)
    flagged = (clean != y)
    return n_out - int(flagged.sum())


def test_random_one_off_outliers_are_not_taken_for_a_pattern():
    kept = [_kept_of_one_offs(seed) for seed in range(20)]
    assert sum(kept) <= 2, f"outliers kept in 20 trials of 30 random incidents: {kept}"
    assert _kept_of_one_offs(1, n_out=20) <= 1


def test_a_quarter_end_spike_every_three_months_is_still_a_pattern():
    ix = pd.date_range("2024-01-01", periods=730)
    y = pd.Series(100.0, index=ix) * (1 + np.random.default_rng(4).normal(0, 0.02, 730))
    quarter_ends = [d for d in ix if d.month in (3, 6, 9, 12) and d.day == d.days_in_month]
    for d in quarter_ends:
        y[d] *= 2.0
    clean, _, _ = fc.clean_series(y, pd.Series(False, index=ix))
    assert all(clean[d] == y[d] for d in quarter_ends), "evenly spaced, same size, same day: a pattern"


def test_the_same_date_in_three_months_but_different_sizes_is_not():
    ix = pd.date_range("2024-01-01", periods=300)
    y = pd.Series(100.0, index=ix)
    for d, k in ((pd.Timestamp("2024-02-14"), 1.6), (pd.Timestamp("2024-05-14"), 4.0), (pd.Timestamp("2024-07-14"), 2.2)):
        y[d] *= k
    clean, _, _ = fc.clean_series(y, pd.Series(False, index=ix))
    assert clean[pd.Timestamp("2024-05-14")] < 150


# ---------------------------------------------------------------- a model that crashes is left out

def test_a_model_that_crashes_in_the_backtest_is_not_scored_under_its_own_name(monkeypatch):
    y, mask = _series(n=200)
    def boom(*a, **k):
        raise ValueError("did not fit")
    monkeypatch.setitem(fc.MODELS, "ets", boom)
    cache = {}
    scores, per_model = fc.backtest(y, ["snaive", "wavg", "ets"], set(), cache, raw=y, event_mask=mask)
    assert "ets" not in scores and "ets" not in per_model, "left out, not scored with seasonal-naive numbers"
    assert cache["failed_models"] == ["ets"] and {"snaive", "wavg"} <= set(scores)


# ---------------------------------------------------------------- no volume in the hours the queue is closed

def test_the_arrival_profile_puts_nothing_before_opening_or_after_closing():
    slots = [_P(d.date().isoformat(), s, 10.0 + (s % 5), 300.0) for d in pd.date_range("2026-09-01", periods=28) for s in range(32, 68)]     # open 08:00 to 17:00
    prof = fc.arrival_profile(slots, [], 96, set())
    for dow in range(7):
        p = prof[dow]
        assert p[31] == 0 and p[68] == 0 and p[:32].sum() == 0 and p[68:].sum() == 0, f"weekday {dow} leaks into closed hours"
        assert abs(p.sum() - 1.0) < 1e-9


# ---------------------------------------------------------------- event ramp-up and tail-off days

class _Ev:
    def __init__(self, start, end, lead=0, lag=0, queue=0):
        self.start_day, self.end_day, self.lead_days, self.lag_days, self.queue_id, self.uplift_pct, self.kind, self.name = start, end, lead, lag, queue, 0, "campaign", "c"


def test_event_ramp_days_are_masked_in_the_history():
    ix = pd.date_range("2026-03-01", periods=30)
    mask = fc.event_mask_for(ix, [_Ev("2026-03-10", "2026-03-12", lead=3, lag=2)], 1)
    masked = [d.day for d in ix[mask.values]]
    assert masked == [8, 9, 10, 11, 12, 13], masked            # the days the event has any effect: build-up (the first lead day is still at 0), the event itself, tail-off (the last lag day is back at 0)
    assert not fc.event_mask_for(ix, [_Ev("2026-03-10", "2026-03-12", lead=3, lag=2, queue=9)], 1).any(), "another queue's event does not touch this one"


# ---------------------------------------------------------------- bands beyond a week come from the 4-week backtest

def _rel_folds(rng, sd_near, sd_far, folds=2, mean=0.0):
    """Relative errors per fold for days 8 to 28: the spread grows from sd_near at day 8 to sd_far at day 28."""
    out = []
    for _ in range(folds):
        out.append([(h, float(rng.normal(mean, sd_near + (sd_far - sd_near) * (h - 8) / 20.0))) for h in range(8, 29)])
    return out


def test_the_far_band_follows_the_errors_measured_8_to_28_days_out():
    rng = np.random.default_rng(11)
    folds = _rel_folds(rng, 0.10, 0.30, folds=40)
    far = fc.calibrate_far(folds)
    assert far is not None and far.points == 40 * 21
    assert far.lo < -0.15 and far.hi > 0.15, (far.lo, far.hi)
    assert 0.05 < far.p10_coverage < 0.16 and 0.84 < far.p90_coverage < 0.95, "held-out coverage is near 10% and 90%"


def test_too_few_far_errors_means_no_far_calibration():
    assert fc.calibrate_far([[(8, 0.1), (9, -0.1)]]) is None


def test_band_at_uses_the_old_rule_up_to_a_week_then_the_measured_edges_then_widens():
    far = fc.FarBand(-0.30, 0.34, 0.2, 18.0, 400, 0.1, 0.9)
    lo, hi = -0.08, 0.09
    assert fc.band_at(5, lo, hi, far) == fc.band_at(5, lo, hi, None), "up to a week nothing changes"
    assert fc.band_at(20, lo, hi, far) == (-0.30, 0.34), "8 to 28 days: the measured edges"
    wide_lo, wide_hi = fc.band_at(56, lo, hi, far)
    assert wide_lo < -0.30 and wide_hi > 0.34, "beyond 28 days they widen from where they were measured"
    assert fc.band_at(56, lo, hi, far)[0] < fc.band_at(40, lo, hi, far)[0]


def test_a_far_band_is_never_narrower_than_the_one_week_rule():
    far = fc.FarBand(-0.02, 0.02, 0.01, 18.0, 400, 0.1, 0.9)        # a lucky, quiet 4-week test
    lo, hi = -0.08, 0.09
    narrow = fc.band_at(20, lo, hi, far)
    old = fc.band_at(20, lo, hi, None)
    assert narrow[0] <= old[0] and narrow[1] >= old[1]


def test_sigma_follows_the_same_curve_and_a_plain_number_keeps_the_old_rule():
    import math
    assert fc.sigma_at(0.1, 28) == 0.1 * math.sqrt(2)
    s = fc.Sigma(0.08, 0.25, 18.0)
    assert fc.sigma_at(s, 5) == 0.08 * math.sqrt(1 + 5 / 28)
    assert fc.sigma_at(s, 20) == 0.25
    assert fc.sigma_at(s, 56) > 0.25
    assert fc.sigma_at(fc.Sigma(0.08, None), 56) == 0.08 * math.sqrt(1 + 56 / 28)


def test_a_failed_model_is_logged_once_not_once_per_fold(monkeypatch, caplog):
    import logging
    y, mask = _series(n=200)
    def boom(*a, **k):
        raise ValueError("did not fit")
    monkeypatch.setitem(fc.MODELS, "ets", boom)
    fc._warned.clear()
    with caplog.at_level(logging.WARNING, logger="wfm.forecast"):
        fc.backtest(y, ["snaive", "wavg", "ets"], set(), {}, raw=y, event_mask=mask)
    lines = [r for r in caplog.records if "could not be fitted in the backtest" in r.getMessage()]
    assert len(lines) == 1, [r.getMessage() for r in lines]


# ---------------------------------------------------------------- the yearly pattern: pulled toward how the same weeks moved last year

WEEK = np.array([1.0, 1.05, 1.0, 0.98, 0.95, 0.45, 0.35])


def _annual(days=1000, amp=0.35, start="2023-01-01", noise=0.02, seed=2):
    ix = pd.date_range(start, periods=days)
    doy = ix.dayofyear.values
    season = 1 + amp * np.sin(2 * np.pi * (doy - 80) / 365.25)
    truth = pd.Series(200.0 * WEEK[ix.dayofweek.values] * season, index=ix)
    return truth * (1 + np.random.default_rng(seed).normal(0, noise, days)), truth


def _queue_of(y, qid=1):
    import wfm_pb2
    q = wfm_pb2.QueueSeries(queue_id=qid, name=f"Q{qid}", channel="voice")
    for d, v in y.items():
        q.daily.add(day=d.date().isoformat(), slot=-1, volume=round(float(v), 1), aht_sec=300)
    return q


def test_last_years_movement_is_read_from_the_same_weeks_a_year_earlier():
    y, truth = _annual()
    train = y.iloc[:900]
    days = pd.date_range(train.index[-1] + pd.Timedelta(days=1), periods=28)
    r = fc.annual_ratio(train, days)
    want = (truth.rolling(28, center=True, min_periods=28).mean()).reindex(days).values / truth.rolling(28, center=True, min_periods=28).mean().iloc[899]
    assert r is not None and np.allclose(r, want, rtol=0.06), (r[:3], want[:3])


def test_with_under_about_13_months_of_history_there_is_no_yearly_shape():
    y, _ = _annual(days=360)
    assert fc.annual_ratio(y, pd.date_range(y.index[-1] + pd.Timedelta(days=1), periods=7)) is None


def test_the_weight_is_full_when_last_years_movement_explains_the_error_and_zero_when_it_does_not():
    rng = np.random.default_rng(5)
    base = np.full(28, 100.0)
    real = [np.linspace(1.0, 1.4, 28), np.linspace(1.0, 0.7, 28), np.linspace(1.0, 1.2, 28)]
    folds = [(base * r, base.copy(), r) for r in real]                      # the forecast stayed flat, the year moved exactly as the ratio says
    w, gain = fc.choose_annual_weight(folds)
    assert w == 1.0 and gain > 0.8
    noise = [(base * (1 + rng.normal(0, 0.05, 28)), base.copy(), 1 + rng.normal(0, 0.15, 28)) for _ in range(3)]   # the ratio has nothing to do with what happened
    assert fc.choose_annual_weight(noise) == (0.0, 0.0)
    assert fc.choose_annual_weight([(base, base, None)] * 3) == (0.0, 0.0)
    assert fc.choose_annual_weight(folds[:2]) == (0.0, 0.0), "two folds are not enough to decide"


def _holiday_shaped(days=1000, start="2023-01-01", seed=2):
    """Volume with a yearly shape no weekly model can see coming: a six-week summer lull and a rush from early December, the same every year. Each swing is under 30%, so
    the history cleaner leaves it alone, as it would a real seasonal change."""
    ix = pd.date_range(start, periods=days)
    doy = ix.dayofyear.values
    season = np.where((doy >= 200) & (doy <= 245), 0.75, np.where(doy >= 340, 1.28, 1.0))
    truth = pd.Series(200.0 * WEEK[ix.dayofweek.values] * season, index=ix)
    return truth * (1 + np.random.default_rng(seed).normal(0, 0.02, days)), truth


def test_a_queue_with_a_yearly_cycle_is_forecast_better_with_it(monkeypatch):
    monkeypatch.setattr(fc, "candidates", lambda y: ["snaive", "wavg", "ets"])
    y, truth = _holiday_shaped()
    cut = 920                                                                  # 2025-07-09: the summer lull starts inside the next 28 days
    q = _queue_of(y.iloc[:cut])
    dates = [d.date().isoformat() for d in truth.index[cut:cut + 28]]
    actual = truth.iloc[cut:cut + 28].values
    results = {}
    for enabled in (False, True):
        monkeypatch.setattr(fc, "ANNUAL_ENABLED", enabled)
        out, _ = fc.forecast_queue(q, dates, 0, [], "auto", set())
        f = np.array([p.volume for p in out.daily])
        results[enabled] = (float(np.abs(f - actual).sum() / actual.sum()), out)
    off, on = results[False][0], results[True][0]
    cfg = __import__("json").loads(results[True][1].model_config)
    assert cfg["backtest"]["annual"]["weight"] > 0 and cfg["backtest"]["annual"]["backtest_gain"] >= 0.03, cfg["backtest"]["annual"]
    assert any("toward how the same weeks moved last year" in n for n in results[True][1].notes)
    assert on < off * 0.75, f"error with the yearly shape {on:.1%} against {off:.1%} without"
    assert cfg["backtest"]["far_band"], "the far band is calibrated on the adjusted errors"


def test_a_smooth_cycle_that_the_model_already_follows_is_left_alone(monkeypatch):
    monkeypatch.setattr(fc, "candidates", lambda y: ["snaive", "wavg", "ets"])
    y, truth = _annual(days=1000)
    q = _queue_of(y.iloc[:960])
    dates = [d.date().isoformat() for d in truth.index[960:988]]
    out, _ = fc.forecast_queue(q, dates, 0, [], "auto", set())
    cfg = __import__("json").loads(out.model_config)
    assert cfg["backtest"]["annual"]["weight"] == 0.0, "Holt-Winters tracked this gentle cycle: the backtest says the yearly shape would not help, so it is not used"


def test_a_queue_with_no_yearly_cycle_is_left_alone(monkeypatch):
    monkeypatch.setattr(fc, "candidates", lambda y: ["snaive", "wavg", "ets"])
    y, truth = _annual(days=1000, amp=0.0)
    q = _queue_of(y.iloc[:960])
    dates = [d.date().isoformat() for d in truth.index[960:988]]
    out, _ = fc.forecast_queue(q, dates, 0, [], "auto", set())
    cfg = __import__("json").loads(out.model_config)
    assert cfg["backtest"]["annual"]["weight"] == 0.0
    assert not any("toward how the same weeks moved" in n for n in out.notes)
