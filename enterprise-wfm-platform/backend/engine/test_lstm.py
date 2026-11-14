"""The LSTM: its gradients are right, it learns a weekly shape, it is deterministic, and it competes honestly in the forecast tournament."""
import numpy as np
import pandas as pd
import pytest

import forecasting as fc
import lstm
import wfm_pb2


def weekly(n=200, noise=0.03, seed=3, level=300.0, start="2025-01-06"):
    rng = np.random.default_rng(seed)
    shape = np.array([1.25, 1.15, 1.1, 1.05, 1.0, 0.45, 0.35])                     # Monday first
    idx = pd.date_range(start, periods=n, freq="D")
    v = level * shape[idx.dayofweek] * (1 + noise * rng.standard_normal(n))
    return pd.Series(v, index=idx)


def test_the_gradients_match_finite_differences():
    rng = np.random.default_rng(1)
    net = lstm.LSTM(n_in=5, n_cal=3, hidden=4, seed=2)
    X, C, T = rng.standard_normal((6, 5, 5)), rng.standard_normal((6, 3)), rng.standard_normal(6)

    def loss():
        return 0.5 * float(np.sum((net.forward(X, C)[0] - T) ** 2))

    pred, saved = net.forward(X, C)
    grads = net.backward(pred - T, saved)
    for name, arr in net.p.items():
        flat = arr.reshape(-1)
        for j in rng.choice(len(flat), size=min(6, len(flat)), replace=False):
            keep = flat[j]
            flat[j] = keep + 1e-6
            up = loss()
            flat[j] = keep - 1e-6
            down = loss()
            flat[j] = keep
            numeric = (up - down) / 2e-6
            assert grads[name].reshape(-1)[j] == pytest.approx(numeric, rel=1e-4, abs=1e-7), f"{name}[{j}]"


def test_it_learns_a_weekly_shape_far_better_than_a_flat_line():
    y = weekly(200)
    train, test = y.iloc[:-7], y.iloc[-7:]
    f = lstm.fit_predict(train, 7)
    flat = np.full(7, train.iloc[-28:].mean())
    err = lambda p: float(np.abs(p - test.values).sum() / test.values.sum())
    assert err(f) < 0.12 and err(f) < err(flat) / 2, (err(f), err(flat))


def test_training_is_deterministic():
    y = weekly(160)
    assert np.array_equal(lstm.fit_predict(y, 7), lstm.fit_predict(y, 7))


def test_too_little_history_or_no_volume_is_refused_not_guessed():
    with pytest.raises(ValueError, match="at least"):
        lstm.fit_predict(weekly(60), 7)
    with pytest.raises(ValueError, match="no volume"):
        lstm.fit_predict(pd.Series(np.zeros(150), index=pd.date_range("2025-01-06", periods=150)), 7)


def test_it_is_a_candidate_only_for_a_long_steady_history():
    assert "lstm" in fc.candidates(weekly(150))
    assert "lstm" not in fc.candidates(weekly(100))
    sparse = weekly(150)
    sparse.iloc[::2] = 0
    assert "lstm" not in fc.candidates(sparse)
    assert "112 days" in fc.unavailable_reason("lstm", weekly(100))


def test_the_backtest_scores_it_against_the_same_folds_as_the_others_and_against_real_actuals():
    y = weekly(170)
    cache = {}
    scores, per_model = fc.backtest(y, ["snaive", "lstm"], set(), cache, raw=y, event_mask=pd.Series(False, index=y.index))
    assert "lstm" in scores and scores["lstm"]["raw_scored"] and scores["lstm"]["wape"] < 0.15
    assert len(per_model["lstm"]) == len(per_model["snaive"])


def test_a_model_that_cannot_forecast_a_fold_is_left_out_not_scored_as_seasonal_naive(monkeypatch):
    y = weekly(170)
    monkeypatch.setitem(fc.MODELS, "lstm", lambda *a, **k: (_ for _ in ()).throw(ValueError("no")))
    scores, per_model = fc.backtest(y, ["snaive", "lstm"], set(), {})
    assert "lstm" not in scores and "lstm" not in per_model and "snaive" in scores


def test_raw_accuracy_is_measured_against_what_really_came_in_not_the_cleaned_history():
    y = weekly(170)
    raw = y.copy()
    raw.iloc[-3] *= 3.0                                                               # an event day that the cleaning replaces with the baseline
    mask = pd.Series(False, index=raw.index)
    mask.iloc[-3] = True
    cleaned = fc.clean_series(raw, mask)[0]
    scores, _ = fc.backtest(cleaned, ["snaive"], set(), {}, raw=raw, event_mask=mask)
    s = scores["snaive"]
    assert s["raw_scored"] and s["raw_wape"] > s["wape"] * 1.5, (s["raw_wape"], s["wape"])
