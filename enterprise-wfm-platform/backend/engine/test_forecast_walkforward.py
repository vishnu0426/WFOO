"""The backtest is walk-forward: a fold is fitted on what was known at its cut-off, and nothing a later day taught."""
import numpy as np
import pandas as pd

import forecasting


def _history(n=200, seed=3):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2026-01-01", periods=n, freq="D")
    weekly = np.array([1.0, 1.1, 1.05, 1.0, 0.95, 0.5, 0.4])
    return pd.Series(np.maximum(0, 300 * weekly[idx.dayofweek] * (1 + rng.normal(0, 0.05, n))), index=idx)


def _run(raw, names=("snaive", "wavg", "ets", "sarima", "combo")):
    mask = pd.Series(False, index=raw.index)
    y, _, _ = forecasting.clean_series(raw, mask)
    scores, per_model = forecasting.backtest(y, list(names), {}, {}, raw=raw, event_mask=mask)
    return y, scores, per_model


def test_what_happens_in_the_latest_week_cannot_change_how_earlier_folds_were_forecast():
    raw = _history()
    changed = raw.copy()
    changed.iloc[-7:] = changed.iloc[-7:] * 6 + 5000          # a regime change in the most recent holdout week
    _, _, base = _run(raw)
    _, _, other = _run(changed)
    cutoff = raw.index[-7]
    compared = 0
    for m in base:
        a = {ts: f for ts, _, f in base[m] if ts < cutoff}
        b = {ts: f for ts, _, f in other[m] if ts < cutoff}
        assert a.keys() == b.keys() and a, m
        for ts in a:
            assert a[ts] == b[ts], f"{m} on {ts.date()} was forecast differently once later days changed"
            compared += 1
    assert compared >= 5 * 21


def test_model_settings_are_chosen_from_each_folds_own_training_data(monkeypatch):
    seen = {"ets": [], "sarima": []}
    real_ets, real_sarima = forecasting.ets_mode, forecasting.sarima_order
    monkeypatch.setattr(forecasting, "ets_mode", lambda y: (seen["ets"].append(len(y)), real_ets(y))[1])
    monkeypatch.setattr(forecasting, "sarima_order", lambda y: (seen["sarima"].append(len(y)), real_sarima(y))[1])
    raw = _history()
    _run(raw, names=("ets", "sarima"))
    n = len(raw)
    folds = {n - forecasting.BACKTEST_H * (k + 1) for k in range(forecasting.BACKTEST_FOLDS)}
    for kind, lengths in seen.items():
        assert set(lengths) == folds, f"{kind} was decided on series of length {sorted(set(lengths))}, not on each fold's training data {sorted(folds)}"
        assert len(lengths) == len(folds), f"{kind} decided more than once per fold"


def test_each_fold_is_cleaned_from_its_own_history(monkeypatch):
    lengths = []
    real = forecasting.clean_series
    monkeypatch.setattr(forecasting, "clean_series", lambda s, m: (lengths.append(len(s)), real(s, m))[1])
    raw = _history()
    mask = pd.Series(False, index=raw.index)
    y, _, _ = real(raw, mask)
    forecasting.backtest(y, ["snaive"], {}, {}, raw=raw, event_mask=mask)
    n = len(raw)
    assert sorted(lengths) == sorted(n - forecasting.BACKTEST_H * (k + 1) for k in range(forecasting.BACKTEST_FOLDS))


def test_the_mase_scale_comes_from_training_data_only():
    raw = _history()
    changed = raw.copy()
    changed.iloc[-7:] = changed.iloc[-7:] * 6 + 5000
    _, s1, _ = _run(raw, names=("snaive",))
    _, s2, _ = _run(changed, names=("snaive",))
    # MASE = MAE / scale, so MAE / MASE is the scale: the latest week must not be able to move it (fold 0 trains on everything before that week)
    scale1 = s1["snaive"]["mae"] / s1["snaive"]["mase"]
    scale2 = s2["snaive"]["mae"] / s2["snaive"]["mase"]
    assert abs(scale1 - scale2) < 1e-9
