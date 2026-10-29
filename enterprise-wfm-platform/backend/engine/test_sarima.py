"""SARIMA and ARIMA candidates for the daily volume tournament: fit sensibly, fall back safely, and never beat the rules (seasonal naive baseline)."""
import numpy as np
import pandas as pd

import forecasting as fc


def weekly_series(n=140, level=1000.0, trend=0.0, noise=0.03, seed=3, zeros=False):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2026-01-05", periods=n, freq="D")                  # starts on a Monday
    shape = np.array([1.15, 1.1, 1.05, 1.0, 0.95, 0.55, 0.45])               # Mon..Sun
    v = (level + trend * np.arange(n)) * shape[idx.dayofweek] * (1 + noise * rng.standard_normal(n))
    if zeros:
        v[rng.random(n) < 0.5] = 0
    return pd.Series(np.maximum(v, 0), index=idx)


def test_sarima_follows_the_weekly_shape_and_a_trend():
    y = weekly_series(trend=2.0)
    f = fc.m_sarima(y.iloc[:-7], 7, order=fc.sarima_order(y.iloc[:-7]))
    actual = y.iloc[-7:].values
    assert f.shape == (7,)
    assert (f >= 0).all()
    wape = np.abs(f - actual).sum() / actual.sum()
    assert wape < 0.08, f"SARIMA WAPE {wape:.3f} on a clean weekly series"
    assert f[:5].min() > f[5:].max(), "weekdays are busier than the weekend"


def test_arima_with_weekday_effects_handles_the_weekly_shape():
    y = weekly_series()
    f = fc.m_arima(y.iloc[:-7], 7)
    actual = y.iloc[-7:].values
    assert np.abs(f - actual).sum() / actual.sum() < 0.08


def test_short_or_broken_series_fall_back_instead_of_failing():
    short = weekly_series(n=30)
    assert len(fc.m_sarima(short, 7)) == 7 and len(fc.m_arima(short, 7)) == 7
    flat = pd.Series(np.zeros(120), index=pd.date_range("2026-01-05", periods=120, freq="D"))
    for fn in (fc.m_sarima, fc.m_arima):
        out = fn(flat, 7)
        assert len(out) == 7 and np.isfinite(out).all() and (out >= 0).all()


def test_the_candidates_include_them_only_where_they_make_sense():
    assert "sarima" in fc.candidates(weekly_series(n=140)) and "arima" in fc.candidates(weekly_series(n=140))
    assert "sarima" not in fc.candidates(weekly_series(n=60)), "under 12 weeks is too little to fit a weekly seasonal model"
    sparse = weekly_series(n=140, level=2.0, zeros=True)
    assert "sarima" not in fc.candidates(sparse), "mostly-zero queues use Croston"


def test_the_tournament_can_pick_them_and_still_beats_seasonal_naive_or_uses_it():
    y = weekly_series(n=168, trend=1.5, noise=0.05)
    cache = {}
    names = fc.candidates(y)
    scores, _ = fc.backtest(y, names, set(), cache)
    assert "sarima" in scores and "arima" in scores
    chosen = fc.pick_model(scores, "auto")
    assert chosen == "snaive" or scores[chosen]["mase"] < scores["snaive"]["mase"]
    assert fc.pick_model(scores, "sarima") == "sarima"                       # asking for it by name works


def test_fitting_is_quick_enough_for_a_large_estate():
    import time
    y = weekly_series(n=196)
    cache = {}
    t = time.time()
    fc.backtest(y, ["sarima", "arima"], set(), cache)
    assert time.time() - t < 25, "four folds of both models should fit in well under half a minute per queue"


def test_they_are_real_fits_not_a_quiet_fallback_to_holt_winters():
    y = weekly_series(trend=1.0).iloc[:-7]
    ets = fc.m_ets(y, 7)
    assert not np.allclose(fc.m_sarima(y, 7), ets), "SARIMA returned exactly the Holt-Winters numbers"
    assert not np.allclose(fc.m_arima(y, 7), ets), "ARIMA returned exactly the Holt-Winters numbers"
