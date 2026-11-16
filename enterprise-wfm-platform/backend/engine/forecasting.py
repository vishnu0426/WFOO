"""Contact-volume forecasting: daily model tournament x intraday arrival profile.

Pipeline per queue (mirrors the usual WFM process: clean -> estimate volume -> arrival pattern -> finalise):
  1. clean history (robust outlier / event days replaced by the same-weekday baseline, event uplift learned)
  2. fit candidate daily models, score them by rolling-origin backtest (WAPE, MASE, bias)
  3. pick the best by MASE; a candidate must beat seasonal naive or seasonal naive is used
  4. apply events, distribute days over intervals with the weekday arrival profile, add P10/P90 bands
  5. reconcile queue forecasts with the group forecast so they add up
"""
import json
import logging
import math
from typing import NamedTuple, Optional
import warnings
import os
import threading
import time
from collections import Counter
from contextlib import contextmanager
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import date, timedelta

import numpy as np
import pandas as pd

log = logging.getLogger("wfm.forecast")
_QUIET = (FutureWarning, DeprecationWarning, PendingDeprecationWarning)
_warned = Counter()


def _emit_counted(key, quiet, template, *args):
    """Log a message on its 1st, 10th, 100th ... occurrence (with the count), so repeated fits and backtest folds do not flood the log."""
    _warned[key] += 1
    n = _warned[key]
    if n in (1, 10, 100, 1000, 10000):
        (log.debug if quiet else log.warning)(template + ("" if n == 1 else f" (seen {n} times)"), *args)


@contextmanager
def model_warnings(name):
    """Keep what a model fit warns about instead of hiding it. Real fitting trouble (a fit that did not converge, bad values) is logged at WARNING with the model's name;
    library deprecation notices go to DEBUG. The same message is logged on its 1st, 10th, 100th ... occurrence with a count, so a backtest of many folds does not flood the log."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            yield
        finally:
            for w in caught:
                text = str(w.message).strip()
                key = (name, w.category.__name__, text.splitlines()[0][:160] if text else "")
                _emit_counted(key, issubclass(w.category, _QUIET), "forecast model %s: %s: %s", key[0], key[1], key[2])

Z80 = 1.2816  # P10/P90
MIN_HISTORY_DAYS = 28
BACKTEST_FOLDS = 4
BACKTEST_H = 7
PROFILE_WEEKS = 8


def _exit_with_parent():
    """A worker must not outlive the engine that started it: if the engine is killed, its workers (each holding statsmodels in memory) would otherwise stay behind."""
    import multiprocessing
    parent = multiprocessing.parent_process()
    if parent is None:
        return

    def watch():
        parent.join()                  # returns when the parent process is gone
        os._exit(0)
    threading.Thread(target=watch, daemon=True).start()


def warm_up():
    _exit_with_parent()
    from sklearn.ensemble import HistGradientBoostingRegressor  # noqa: F401
    from statsmodels.tsa.holtwinters import ExponentialSmoothing  # noqa: F401


def _d(s: str) -> date:
    return date.fromisoformat(s)


def to_series(points) -> pd.Series:
    """Daily points -> continuous daily series (gaps are NaN)."""
    if not points:
        return pd.Series(dtype=float)
    s = pd.Series({pd.Timestamp(_d(p.day)): p.volume for p in points}).sort_index()
    return s.reindex(pd.date_range(s.index[0], s.index[-1], freq="D"))


def in_event(ev, day: date, queue_id: int) -> bool:
    return _d(ev.start_day) <= day <= _d(ev.end_day) and ev.queue_id in (0, queue_id)


def event_ramp(ev, day: date, queue_id: int) -> float:
    """Fraction (0..1) of the event's uplift that applies on `day`: the full 1.0 within the event's own date range,
    ramping linearly from 0 over `lead_days` before it starts, and back to 0 over `lag_days` after it ends -- a
    campaign builds up and tails off around its core dates rather than switching on and off at a hard edge.
    lead_days/lag_days of 0 reduces exactly to the old in_event() on/off behaviour."""
    if ev.queue_id not in (0, queue_id):
        return 0.0
    start, end = _d(ev.start_day), _d(ev.end_day)
    if start <= day <= end:
        return 1.0
    lead, lag = max(0, ev.lead_days), max(0, ev.lag_days)
    if lead and start - timedelta(days=lead) <= day < start:
        return (day - (start - timedelta(days=lead))).days / lead
    if lag and end < day <= end + timedelta(days=lag):
        return 1 - (day - end).days / lag
    return 0.0


# --------------------------------------------------------------------------- cleaning

def same_dow_baseline(s: pd.Series, skip: pd.Series) -> pd.Series:
    """Median of the same weekday within +-4 weeks, ignoring the day itself and days flagged in `skip`."""
    vals = s.where(~skip)
    out = pd.Series(index=s.index, dtype=float)
    for i, ts in enumerate(s.index):
        idx = [i + 7 * k for k in range(-4, 5) if k != 0 and 0 <= i + 7 * k < len(s)]
        w = vals.iloc[idx].dropna()
        out.iloc[i] = w.median() if len(w) else np.nan
    return out


def _month_no(ts) -> int:
    return ts.year * 12 + ts.month


def recurring_spikes(flagged: pd.Series, dev: pd.Series) -> pd.Series:
    """Flagged days that repeat on the calendar are a pattern (pay day, the first of the month, a billing run, quarter end); one-off outages and incidents are not.

    A group of flagged days is kept only when ALL of these hold: the same day of the month (or the last two days of the month) and the same direction; at least 3 different months;
    a similar size each time (the spread of the sizes is under 35% of their mean); and it really recurs: it happened in at least 60% of the months the history covers for that day,
    or there are at least 4 months and they are evenly spaced (every 1, 2, 3, 4, 6 or 12 months). Random one-off outliers meet the first rules by chance now and then; they do not meet the last one."""
    keep = pd.Series(False, index=flagged.index)
    if not flagged.any():
        return keep
    idx = flagged.index
    months_total = {}
    for ts in idx:
        months_total.setdefault(ts.day, set()).add(_month_no(ts))
    n_months = len({_month_no(ts) for ts in idx}) or 1
    groups = {}
    for ts in flagged[flagged].index:
        direction = 1 if dev[ts] > 0 else -1
        groups.setdefault(("dom", ts.day, direction), []).append(ts)
        if ts.day >= ts.days_in_month - 1:                       # the last two days of a month count together
            groups.setdefault(("eom", 0, direction), []).append(ts)
    for (kind, day, _), members in groups.items():
        months = sorted({_month_no(m) for m in members})
        if len(months) < 3:
            continue
        sizes = np.array([abs(float(dev[m])) for m in members])
        if sizes.mean() <= 0 or sizes.std() / sizes.mean() >= 0.35:
            continue
        covered = len(months) / (len(months_total.get(day, months)) if kind == "dom" else n_months)
        gaps = {b - a for a, b in zip(months, months[1:])}
        if covered >= 0.6 or (len(months) >= 4 and len(gaps) == 1 and gaps.pop() in (1, 2, 3, 4, 6, 12)):
            keep[members] = True
    return keep


def event_mask_for(index, events, queue_id) -> pd.Series:
    """History days an event touches: its own dates AND the build-up before it and the tail-off after it (the lead and lag days), so a campaign's ramp does not pass for ordinary demand."""
    mask = pd.Series(False, index=index)
    for ev in events:
        for ts in index:
            if event_ramp(ev, ts.date(), queue_id) > 0:
                mask[ts] = True
    return mask


def clean_series(s: pd.Series, event_mask: pd.Series):
    """Returns (clean series, cleaned day count, ratio-to-baseline for event days)."""
    s = s.copy()
    missing = s.isna()
    base = same_dow_baseline(s, event_mask | missing)
    ratio = (s / base).replace([np.inf, -np.inf], np.nan)
    lr = np.log(ratio.where(ratio > 0))
    med = lr[~event_mask].median()
    mad = (lr[~event_mask] - med).abs().median()
    thr = max(0.30, 3.5 * 1.4826 * (0 if np.isnan(mad) else mad))
    outlier = ((lr - (0 if np.isnan(med) else med)).abs() > thr) & ~event_mask
    outlier &= ~recurring_spikes(outlier, lr - (0 if np.isnan(med) else med))
    fill = missing | outlier | event_mask
    clean = s.where(~fill, base)
    clean = clean.fillna(clean.median() if clean.notna().any() else 0.0).clip(lower=0)
    return clean, int((outlier | event_mask).sum()), ratio.where(event_mask)


# --------------------------------------------------------------------------- daily models (all return a numpy array of length h)

def _hist_dow(y: pd.Series, h: int):
    last = y.index[-1]
    return [(last + pd.Timedelta(days=k)).dayofweek for k in range(1, h + 1)]


def m_snaive(y, h, **_):
    v = y.values
    return np.array([v[len(v) - 7 + ((k - 1) % 7)] for k in range(1, h + 1)])


def m_wavg(y, h, weeks=8, **_):
    """Recency-weighted mean of the last `weeks` same weekdays (the original engine's method)."""
    by = {}
    for dow in range(7):
        sub = y[y.index.dayofweek == dow].iloc[-weeks:]
        by[dow] = float(np.average(sub.values, weights=np.arange(1, len(sub) + 1))) if len(sub) else float(y.mean())
    return np.array([by[d] for d in _hist_dow(y, h)])


def m_ets(y, h, mode=None, **_):
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    yy = y.iloc[-min(len(y), 280):]
    yy = yy.asfreq("D")
    if len(yy) < 21:
        return m_wavg(y, h)
    best = None
    for seasonal in ([mode] if mode else (["add", "mul"] if (yy > 0).all() else ["add"])):
        try:
            r = ExponentialSmoothing(yy, trend="add", damped_trend=True, seasonal=seasonal, seasonal_periods=7,
                                     initialization_method="estimated").fit(optimized=True)
            if best is None or r.aicc < best[0]:
                best = (r.aicc, seasonal, r)
        except Exception:
            continue
    if best is None:
        return m_wavg(y, h)
    return np.clip(np.asarray(best[2].forecast(h)), 0, None)


def m_gbm(y, h, holidays=None, **_):
    """Gradient boosting on calendar features, target = volume / trailing 28-day level (so it can extrapolate level)."""
    from sklearn.ensemble import HistGradientBoostingRegressor
    if len(y) < 120:
        return m_ets(y, h)
    holidays = holidays or set()
    level = y.rolling(28, min_periods=14).mean().shift(1)
    idx = y.index

    def feats(ix):
        doy = ix.dayofyear.values
        return np.column_stack([ix.dayofweek.values, np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25),
                                ix.month.values, [1 if d.date() in holidays else 0 for d in ix],
                                ix.day.values, ix.days_in_month.values - ix.day.values])      # day of month and days to month end: pay-day and month-end spikes

    ok = level.notna() & (level > 0)
    model = HistGradientBoostingRegressor(max_iter=120, learning_rate=0.06, max_depth=4, min_samples_leaf=10, random_state=7)
    model.fit(feats(idx[ok]), (y[ok] / level[ok]).values)
    fut = pd.date_range(idx[-1] + pd.Timedelta(days=1), periods=h, freq="D")
    return np.clip(model.predict(feats(fut)) * float(y.iloc[-28:].mean()), 0, None)


def m_croston(y, h, **_):
    """Croston-SBA for sparse queues (many zero days)."""
    v = y.values.astype(float)
    nz = np.flatnonzero(v > 0)
    if len(nz) < 2:
        return np.full(h, float(v.mean()))
    a, z, p, q = 0.1, v[nz[0]], float(nz[1] - nz[0]), 1
    for t in range(nz[0] + 1, len(v)):
        if v[t] > 0:
            z += a * (v[t] - z)
            p += a * (q - p)
            q = 1
        else:
            q += 1
    return np.full(h, (1 - a / 2) * z / p)


SARIMA_WEEKS = 28            # how much recent history the ARIMA family fits to: enough for the weekly pattern, quick to fit
SARIMA_ORDERS = [((1, 0, 1), (1, 1, 0, 7)), ((0, 1, 1), (0, 1, 1, 7)), ((1, 1, 1), (0, 1, 1, 7))]


def _arima_input(y):
    """The recent window as a daily series, on a log scale when every day is positive (volume swings are proportional, not additive)."""
    yy = y.iloc[-min(len(y), SARIMA_WEEKS * 7):].asfreq("D")
    yy = yy.interpolate(limit_direction="both")
    log = bool((yy > 0).all())
    return (np.log(yy) if log else yy), log


def _fit_sarimax(z, order, seasonal, exog=None, trend=None, stable=False):
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    return SARIMAX(z, exog=exog, order=order, seasonal_order=seasonal, trend=trend,
                   enforce_stationarity=stable, enforce_invertibility=stable).fit(disp=False, maxiter=60)


def _sane(f, y):
    """A fit that has run away (infinite, or far outside anything seen in the last eight weeks) is not a forecast: the caller falls back."""
    if not np.isfinite(f).all():
        return False
    recent = y.iloc[-56:]
    return bool(f.min() >= 0.4 * recent.min() and f.max() <= 1.6 * recent.max())


def sarima_order(y):
    """Which seasonal ARIMA shape suits this series, decided once on the full history (AIC) so every backtest fold fits one model, not three."""
    if len(y) < 84:
        return None
    z, _ = _arima_input(y)
    best = None
    for order, seasonal in SARIMA_ORDERS:
        try:
            r = _fit_sarimax(z, order, seasonal)
            if np.isfinite(r.aic) and (best is None or r.aic < best[0]):
                best = (r.aic, (order, seasonal))
        except Exception:
            continue
    return best[1] if best else None


def m_sarima(y, h, order=None, **_):
    """Seasonal ARIMA with a weekly cycle. Falls back to Holt-Winters when the series is too short or the fit fails."""
    if len(y) < 84 or (y.iloc[-SARIMA_WEEKS * 7:] == 0).mean() > 0.2:
        return m_ets(y, h)
    order = order or sarima_order(y)
    if order is None:
        return m_ets(y, h)
    try:
        z, log = _arima_input(y)
        f = np.asarray(_fit_sarimax(z, order[0], order[1]).forecast(h), dtype=float)
        f = np.exp(np.clip(f, -50, 50)) if log else f
        return np.clip(f, 0, None) if _sane(f, y) else m_ets(y, h)
    except Exception:
        return m_ets(y, h)


def m_arima(y, h, **_):
    """ARIMA errors plus a fixed effect for each weekday (regression with ARIMA errors): the non-seasonal member of the family,
    which keeps the weekly shape without differencing it away."""
    if len(y) < 84 or (y.iloc[-SARIMA_WEEKS * 7:] == 0).mean() > 0.2:
        return m_ets(y, h)
    try:
        z, log = _arima_input(y)
        dummies = lambda ix: np.column_stack([(ix.dayofweek.values == d).astype(float) for d in range(7)])   # one level per weekday, so no separate constant
        fut = pd.date_range(z.index[-1] + pd.Timedelta(days=1), periods=h, freq="D")
        r = _fit_sarimax(z, (1, 0, 1), (0, 0, 0, 0), exog=dummies(z.index), trend=None, stable=True)
        f = np.asarray(r.forecast(h, exog=dummies(fut)), dtype=float)
        f = np.exp(np.clip(f, -50, 50)) if log else f
        return np.clip(f, 0, None) if _sane(f, y) else m_ets(y, h)
    except Exception:
        return m_ets(y, h)


def m_lstm(y, h, holidays=None, **_):
    """A small LSTM trained on this queue's own history (lstm.py: NumPy, deterministic, bounded in time). It raises when it cannot give a usable forecast, and the backtest then
    leaves it out for this queue instead of quietly scoring a different model under its name."""
    import lstm
    return np.clip(lstm.fit_predict(y, h, holidays), 0, None)


MODELS = {"snaive": m_snaive, "wavg": m_wavg, "ets": m_ets, "gbm": m_gbm, "croston": m_croston, "sarima": m_sarima, "arima": m_arima, "lstm": m_lstm}


def ets_mode(y):
    """Additive vs multiplicative seasonality, decided once per series (AICc) so backtest folds don't refit both."""
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    if not (y > 0).all() or len(y) < 21:
        return "add"
    best = None
    for seasonal in ("add", "mul"):
        try:
            r = ExponentialSmoothing(y.iloc[-280:].asfreq("D"), trend="add", damped_trend=True, seasonal=seasonal, seasonal_periods=7,
                                     initialization_method="estimated").fit(optimized=True)
            if best is None or r.aicc < best[0]:
                best = (r.aicc, seasonal)
        except Exception:
            pass
    return best[1] if best else "add"


def run_model(name, y, h, holidays, cache):
    """Run one model; components of the ensemble are computed once and shared with the backtest."""
    key = (name, len(y), h)
    if key not in cache:
        with model_warnings(name):
            _run_model_uncached(name, key, y, h, holidays, cache)
    return cache[key]


def _run_model_uncached(name, key, y, h, holidays, cache):
    if name == "combo":
        parts = [run_model("ets", y, h, holidays, cache), run_model("wavg", y, h, holidays, cache)]
        if len(y) >= 120:
            parts.append(run_model("gbm", y, h, holidays, cache))
        cache[key] = np.mean(parts, axis=0)
    elif name == "ets":
        # the seasonality mode and the SARIMA shape are chosen from the history the model is given, and only that: a backtest fold decides them from its own training data,
        # so no fold is helped by what happened after its cut-off (the cache is keyed by the training length, which differs from fold to fold)
        cache[key] = MODELS["ets"](y, h, mode=cache.setdefault(("mode", len(y)), ets_mode(y)))
    elif name == "sarima":
        if ("sarima_order", len(y)) not in cache:
            cache[("sarima_order", len(y))] = sarima_order(y)
        cache[key] = MODELS["sarima"](y, h, order=cache[("sarima_order", len(y))])
    else:
        cache[key] = MODELS[name](y, h, holidays=holidays)


LABELS = {"snaive": "Seasonal naive", "wavg": "Weighted seasonal avg", "ets": "Holt-Winters (ETS)",
          "gbm": "Gradient boosting", "combo": "Ensemble", "croston": "Croston-SBA", "sarima": "Seasonal ARIMA (SARIMA)", "arima": "ARIMA with weekday effects",
          "lstm": "LSTM neural network"}


def unavailable_reason(name, y):
    """Why a model is not offered for this history, in plain words."""
    n, zeros, mean = len(y), float((y == 0).mean()), float(y.mean())
    if name == "gbm":
        return f"gradient boosting needs at least 120 days of history and this queue has {n}"
    if name in ("sarima", "arima"):
        if n < 84:
            return f"it needs at least 12 weeks (84 days) of history and this queue has {n} days"
        return f"it is built for steady volume, and this queue has {round(zeros * 100)}% empty days and averages {mean:.1f} a day"
    if name == "lstm":
        if n < 112:
            return f"it needs at least 16 weeks (112 days) of history to learn a weekly shape and this queue has {n} days"
        return f"it is built for steady volume, and this queue has {round(zeros * 100)}% empty days and averages {mean:.1f} a day"
    if name == "croston":
        return "it is made for intermittent volume (many empty days or very low counts), and this queue has contacts on most days"
    return "it cannot be fitted to this history"


def candidates(y: pd.Series):
    names = ["snaive", "wavg", "ets"]
    if len(y) >= 120:
        names.append("gbm")
    if len(y) >= 84 and (y == 0).mean() <= 0.2 and y.mean() >= 3:      # 12+ weeks of a queue that is not sparse
        names += ["sarima", "arima"]
    if len(y) >= 112 and (y == 0).mean() <= 0.2 and y.mean() >= 3:     # 16+ weeks of steady volume: enough for a small network to learn the weekly shape
        names.append("lstm")
    names.append("combo")
    if (y == 0).mean() > 0.2 or y.mean() < 3:
        names.append("croston")
    return names


# --------------------------------------------------------------------------- backtest & selection

def backtest(y: pd.Series, names, holidays, cache, raw=None, event_mask=None):
    """Rolling-origin: 4 origins, 7-day horizon. Returns scores dict and per-model list of (day, actual, forecast).

    Walk-forward, as it would have happened: each fold is fitted on what was known at its cut-off and nothing later. When the raw history and its event mask are given, the training
    data of every fold is cleaned (outliers, event days, gaps) from that fold's own history, and its model settings are chosen from it; `y` (cleaned over the whole history) is
    then only the yardstick the forecasts are compared with. The MASE scale is the naive error of the training data of each fold, not of the whole series."""
    n = len(y)
    if n < MIN_HISTORY_DAYS + BACKTEST_H * 2:
        return {}, {}
    per_model = {m: [] for m in names}
    per_raw = {m: [] for m in names}              # (what really happened, forecast): the raw actuals, outliers and event days included
    failed = set()                                # models that could not forecast a fold: left out, never scored as if they had
    why_failed = {}                               # the first error of each, logged once for the model, not once per fold
    naive_scales = []
    for k in range(BACKTEST_FOLDS):
        cut = n - BACKTEST_H * (k + 1)
        train, test = y.iloc[:cut], y.iloc[cut:cut + BACKTEST_H]
        raw_test = None
        if raw is not None:
            train = clean_series(raw.iloc[:cut], event_mask.iloc[:cut])[0]
            raw_test = raw.iloc[cut:cut + BACKTEST_H]
        tv = train.values
        naive_scales.append(float(np.mean(np.abs(tv[7:] - tv[:-7]))) if len(tv) > 7 else 0.0)
        for m in names:
            try:
                f = run_model(m, train, BACKTEST_H, holidays, cache)
            except Exception as e:
                if m != "snaive":
                    failed.add(m)                      # not comparable: it is left out of the ranking, never scored with another model's numbers under its own name
                    why_failed.setdefault(m, f"{type(e).__name__}: {str(e)[:120]}")
                f = m_snaive(train, BACKTEST_H)
            per_model[m] += [(ts, float(a), float(fc)) for ts, a, fc in zip(test.index, test.values, f)]
            if raw_test is not None:
                per_raw[m] += [(float(a), float(fc)) for a, fc in zip(raw_test.values, f)]
    naive_mae = float(np.mean(naive_scales)) or 1.0
    scores = {}
    cache["failed_models"] = sorted(failed)
    for m in sorted(failed):
        _emit_counted((m, "BacktestFit", why_failed.get(m, "")), False, "forecast model %s could not be fitted in the backtest (%s) and is left out", m, why_failed.get(m, ""))
    for m in failed:
        per_model.pop(m, None)
    for m, rows in per_model.items():
        a = np.array([r[1] for r in rows])
        f = np.array([r[2] for r in rows])
        tot = a.sum() or 1.0
        # error per backtest fold: a model whose error swings between folds is less trustworthy
        fold = [float(np.abs(a[i:i + BACKTEST_H] - f[i:i + BACKTEST_H]).sum() / (a[i:i + BACKTEST_H].sum() or 1.0))
                for i in range(0, len(a), BACKTEST_H)]
        cv = float(np.std(fold) / max(np.mean(fold), 1e-9)) if len(fold) > 1 else 0.0
        nz = a > 0
        scores[m] = {"wape": float(np.abs(a - f).sum() / tot), "mase": float(np.abs(a - f).mean() / naive_mae),
                     "bias": float((f - a).sum() / tot), "mae": float(np.abs(a - f).mean()),
                     "rmse": float(np.sqrt(np.mean((a - f) ** 2))),
                     "mape": float(np.mean(np.abs(a[nz] - f[nz]) / a[nz])) if nz.any() else 0.0,
                     "stability": "HIGH" if cv < 0.35 else "MEDIUM" if cv < 0.7 else "VARIABLE"}
        if per_raw[m]:
            # the accuracy that matters to the business: against what really came in. The figures above are against the cleaned history (event days and outliers replaced by a baseline),
            # which is what the models learn from and are compared on; a model can look better on cleaned demand than it is on the real thing, so both are kept and shown
            ra = np.array([r[0] for r in per_raw[m]])
            rf = np.array([r[1] for r in per_raw[m]])
            rtot = ra.sum() or 1.0
            scores[m].update({"raw_wape": float(np.abs(ra - rf).sum() / rtot), "raw_mase": float(np.abs(ra - rf).mean() / naive_mae), "raw_bias": float((rf - ra).sum() / rtot),
                              "raw_mae": float(np.abs(ra - rf).mean()), "raw_scored": True})
    return scores, per_model


LONG_H = 28
LONG_FOLDS = 2
ANNUAL_LAG = 364                 # the same weekday, 52 weeks earlier
ANNUAL_ENABLED = True
ANNUAL_MIN_GAIN = 0.03           # the same-week-last-year adjustment must cut the 4-week error by at least this share in the backtest, or it is not used
ANNUAL_WEIGHTS = (0.25, 0.5, 0.75, 1.0)


def annual_ratio(y: pd.Series, days):
    """How much last year moved between where this history ends and each of `days`: A(d - 364) / A(end - 364), with A the centred 28-day mean (four whole weeks, so no weekday counts
    twice). Multiplying a forecast that is anchored to the recent level by this brings in the yearly cycle (summer lull, year-end rush) that the weekly models cannot see.
    Returns an array (1.0 for a day last year does not reach), or None when the history is too short to hold the same weeks a year earlier (about 13 months) or last year's level is zero."""
    n = len(y)
    if n < ANNUAL_LAG + 28:
        return None
    mean = y.rolling(28, center=True, min_periods=28).mean()
    ref = mean.get(y.index[-1] - pd.Timedelta(days=ANNUAL_LAG))
    if ref is None or not math.isfinite(ref) or ref <= 0:
        return None
    out = []
    for d in days:
        v = mean.get(pd.Timestamp(d) - pd.Timedelta(days=ANNUAL_LAG))
        out.append(min(2.0, max(0.5, float(v) / ref)) if v is not None and math.isfinite(v) else 1.0)
    return np.array(out)


ANNUAL_MAX_FOLDS = 8


def annual_backtest(y: pd.Series, model, holidays, cache, raw=None, event_mask=None, basis=None):
    """The chosen model's 4-week walk-forward forecasts from up to 8 origins, four weeks apart, back through the past year or so: [(actual, forecast, last year's movement)]. The two
    folds of the 4-week test sit in the last two months, which can miss the part of the year where the cycle turns; these cover it. Needs about 13 months of history before the earliest
    origin and at least 3 origins, otherwise []. Not run for the neural network (too slow). `basis` is the series last year's movement is read from (see `forecast_queue`); the model itself is trained on the cleaned history."""
    if not ANNUAL_ENABLED or model == "lstm":
        return []
    n = len(y)
    folds = []
    for k in range(1, ANNUAL_MAX_FOLDS + 1):
        cut = n - LONG_H * k
        if cut < ANNUAL_LAG + 28:
            break
        train, test = y.iloc[:cut], (basis if basis is not None else y).iloc[cut:cut + LONG_H]      # scored against what really came in (events aside), seasonal lulls and rushes included
        if raw is not None:
            train = clean_series(raw.iloc[:cut], event_mask.iloc[:cut])[0]
        ratio = annual_ratio((basis if basis is not None else train).iloc[:cut], test.index)
        if ratio is None:
            break
        try:
            f = run_model(model, train, LONG_H, holidays, cache)
        except Exception:
            return []
        folds.append((np.asarray(test.values, dtype=float), np.asarray(f, dtype=float), ratio))
    return folds if len(folds) >= 3 else []


def choose_annual_weight(folds):
    """How far to pull a forecast toward last year's movement: (weight 0 to 1, share of the 4-week error it removed). `folds` are (actual, forecast, ratio or None) from the 4-week
backtest (see `annual_backtest`). Needs at least 3 folds with the ratio; the weight with the lowest error wins and must beat no adjustment by ANNUAL_MIN_GAIN, otherwise 0: the yearly shape is not used."""
    if not ANNUAL_ENABLED or len(folds) < 3 or any(r is None for _, _, r in folds):
        return 0.0, 0.0
    def error(w):
        num = sum(float(np.abs(a - f * (1 + w * (r - 1))).sum()) for a, f, r in folds)
        return num / (sum(float(a.sum()) for a, _, _ in folds) or 1.0)
    base = error(0.0)
    best_w, best = 0.0, base
    for w in ANNUAL_WEIGHTS:
        e = error(w)
        if e < best:
            best_w, best = w, e
    gain = (base - best) / base if base > 0 else 0.0
    return (best_w, gain) if gain >= ANNUAL_MIN_GAIN else (0.0, 0.0)


def adjusted_rel_folds(folds, weight):
    """The 4-week backtest errors for days 8 to 28 as they would have been with the yearly adjustment, in the form `calibrate_far` takes."""
    out = []
    for a, f, r in folds:
        adj = f * (1 + weight * (r - 1)) if r is not None else f
        out.append([(h + 1, (float(av) - float(fv)) / float(fv)) for h, (av, fv) in enumerate(zip(a, adj)) if h >= BACKTEST_H and fv > 0 and math.isfinite(av)])
    return out


def backtest_long(y: pd.Series, names, holidays, cache, raw=None, event_mask=None):
    """The same walk-forward test at the horizon a schedule is built on (4 weeks out, not 1): {model: {wape_long, mase_long}}. A model that is good next week and poor a month out
    looks fine on the 7-day test alone. Needs enough history for two 4-week folds after a 12-week training start; otherwise returns {}. Models that cannot be run this far are left out."""
    n = len(y)
    if n < 84 + LONG_H * LONG_FOLDS:
        return {}
    rows = {m: [] for m in names}
    rel_folds = {m: [] for m in names}            # per fold, per model: (days ahead, (actual - forecast) / forecast) for days 8 to 28, to calibrate the band beyond a week
    scales = []
    skipped = {"lstm"}                                  # a network fit per fold is too slow to repeat at a second horizon
    for k in range(LONG_FOLDS):
        cut = n - LONG_H * (k + 1)
        train, test = y.iloc[:cut], y.iloc[cut:cut + LONG_H]
        if raw is not None:
            train = clean_series(raw.iloc[:cut], event_mask.iloc[:cut])[0]
        tv = train.values
        scales.append(float(np.mean(np.abs(tv[7:] - tv[:-7]))) if len(tv) > 7 else 0.0)
        for m in names:
            if m in skipped:
                continue
            try:
                f = run_model(m, train, LONG_H, holidays, cache)
            except Exception:
                skipped.add(m)
                rows.pop(m, None)
                continue
            if m in rows:
                rows[m] += list(zip(test.values, f))
                rel_folds[m].append([(h + 1, (float(a) - float(fv)) / float(fv)) for h, (a, fv) in enumerate(zip(test.values, f)) if h >= BACKTEST_H and fv > 0 and math.isfinite(a)])
    scale = float(np.mean(scales)) or 1.0
    out = {}
    for m, r in rows.items():
        if not r:
            continue
        a = np.array([x[0] for x in r], dtype=float)
        f = np.array([x[1] for x in r], dtype=float)
        out[m] = {"wape_long": float(np.abs(a - f).sum() / (a.sum() or 1.0)), "mase_long": float(np.abs(a - f).mean() / scale), "rel_folds": rel_folds.get(m, [])}
    return out


class Sigma(NamedTuple):
    """The forecast error spread a queue's interval bands are built from: `base` from the 1-week backtest, and, when there was history for a 4-week backtest, `far` from the
    errors 8 to 28 days out (measured at an average of `cal_days` ahead). Picklable, because it travels back from the worker processes."""
    base: float
    far: Optional[float] = None
    cal_days: float = 18.0


def sigma_at(sigma, days_ahead) -> float:
    """The relative error spread `days_ahead` days after the history ends. A plain number is the old rule (the 1-week figure widened by the square root of 1 + days/28). With a
    4-week calibration: the 1-week rule up to a week, the measured spread from 8 to 28 days, and beyond that the measured spread widened the same way from where it was measured."""
    d = max(days_ahead, 0)
    if not isinstance(sigma, Sigma):
        return float(sigma) * math.sqrt(1 + d / 28.0)
    near = sigma.base * math.sqrt(1 + d / 28.0)
    if sigma.far is None or d <= BACKTEST_H:
        return near
    far = sigma.far if d <= LONG_H else sigma.far * math.sqrt((1 + d / 28.0) / (1 + sigma.cal_days / 28.0))
    return max(near, far)                       # a band is never narrower than the 1-week rule would give


class FarBand(NamedTuple):
    lo: float
    hi: float
    sigma: float
    cal_days: float
    points: int
    p10_coverage: float          # on folds it was not fitted to; -1 when it could not be tested
    p90_coverage: float


def calibrate_far(rel_folds) -> Optional["FarBand"]:
    """The band edges for 8 to 28 days ahead, from the 4-week backtest's errors for those days. None when there are too few (a short history). Coverage is tested leave-one-fold-out,
    like the 1-week band: the edges from the other folds, checked on the held fold."""
    folds = [[r for _, r in f if math.isfinite(r)] for f in rel_folds]
    allrel = [r for f in folds for r in f]
    if len(allrel) < BAND_MIN_POINTS:
        return None
    sigma = max(0.04, float(np.std(allrel)))
    lo, hi = _band_edges(allrel, sigma)
    cal_days = float(np.mean([h for f in rel_folds for h, r in f if math.isfinite(r)]))
    below10 = below90 = tested = 0
    if len([f for f in folds if f]) >= 2:
        for j, held in enumerate(folds):
            rest = [r for i, f in enumerate(folds) if i != j for r in f]
            if len(rest) < BAND_MIN_POINTS:
                continue
            lj, hj = _band_edges(rest, sigma)
            below10 += sum(1 for r in held if r <= lj)
            below90 += sum(1 for r in held if r <= hj)
            tested += len(held)
    return FarBand(lo, hi, sigma, cal_days, len(allrel), below10 / tested if tested else -1.0, below90 / tested if tested else -1.0)


def band_at(ahead, lo, hi, far: Optional["FarBand"]):
    """(low, high) relative band edges `ahead` days after the history ends. Up to a week: the 1-week edges widened by sqrt(1 + days/28), as before. 8 to 28 days: the edges measured on
    the 4-week backtest. Beyond: those edges widened from where they were measured. Never narrower than the 1-week rule gives, so a noisy 4-week test cannot make a band tighter."""
    d = max(ahead, 0)
    grow = math.sqrt(1 + d / 28.0)
    if far is None or d <= BACKTEST_H:
        return lo * grow, hi * grow
    g = 1.0 if d <= LONG_H else math.sqrt((1 + d / 28.0) / (1 + far.cal_days / 28.0))
    return min(far.lo * g, lo * grow), max(far.hi * g, hi * grow)


def selection_score(scores, m):
    """What a model is ranked on: the 1-week MASE, blended equally with the 4-week MASE when every model has one (so the comparison stays fair)."""
    s = scores[m]
    if all("mase_long" in v for v in scores.values()):
        return 0.5 * s["mase"] + 0.5 * s["mase_long"]
    return s["mase"]


def pick_model(scores, requested):
    if not scores:
        return "wavg"
    if requested and requested != "auto" and requested in scores:
        return requested
    best = min(scores, key=lambda m: selection_score(scores, m))
    if best != "snaive" and "snaive" in scores and selection_score(scores, best) >= selection_score(scores, "snaive"):
        return "snaive"  # the cardinal rule: beat seasonal naive or use it
    return best


# --------------------------------------------------------------------------- intraday profile & AHT

def arrival_profile(slots, dates, spd, event_days):
    """{dow: share array (spd,)} from the last PROFILE_WEEKS same weekdays, recency-weighted, lightly smoothed."""
    by_day = {}
    for p in slots:
        by_day.setdefault(p.day, np.zeros(spd))
        if 0 <= p.slot < spd:
            by_day[p.day][p.slot] += p.volume
    per_dow = {d: [] for d in range(7)}
    for day in sorted(by_day):
        v = by_day[day]
        if v.sum() > 0 and _d(day) not in event_days:
            per_dow[_d(day).weekday()].append(v / v.sum())
    overall = np.mean([x for l in per_dow.values() for x in l], axis=0) if any(per_dow.values()) else np.full(spd, 1 / spd)
    total = np.zeros(spd)
    for v in by_day.values():
        total += v
    seen = (total > 0).astype(float) if total.sum() > 0 else np.ones(spd)       # intervals that ever had contacts in the history shown
    out = {}
    for dow in range(7):
        rows = per_dow[dow][-PROFILE_WEEKS:]
        prof = np.average(rows, axis=0, weights=np.arange(1, len(rows) + 1)) if rows else overall
        sm = np.convolve(np.pad(prof, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
        sm = sm * seen                                      # smoothing must not carry volume into an interval that never had any (before opening, after closing)
        out[dow] = sm / sm.sum() if sm.sum() > 0 else prof / (prof.sum() or 1.0)
    return out


AHT_HALF_LIFE_DAYS = 14.0


def aht_by_day(slots):
    """{day: volume-weighted AHT of that day} from the interval history."""
    vol, work = {}, {}
    for p in slots:
        if p.volume > 0 and p.aht_sec > 0:
            vol[p.day] = vol.get(p.day, 0.0) + p.volume
            work[p.day] = work.get(p.day, 0.0) + p.volume * p.aht_sec
    return {d: work[d] / vol[d] for d in vol if vol[d] > 0}


def aht_forecast(slots, days, fallback):
    """A handle-time forecast per day, not one average for every day: the recent level (recency-weighted, half-life 2 weeks, so a drift in handle time is followed) times a weekday
    factor (some weekdays run longer calls; shrunk toward 1 where there are few observations and held within 0.8 to 1.25). {day: seconds}. With under 14 days of history it is the plain average."""
    hist = aht_by_day(slots)
    if len(hist) < 14:
        return {d: float(fallback) for d in days}
    ds = sorted(hist)
    vals = np.array([hist[d] for d in ds])
    age = np.array([(_d(ds[-1]) - _d(d)).days for d in ds], dtype=float)
    level = float(np.average(vals, weights=0.5 ** (age / AHT_HALF_LIFE_DAYS)))
    base = pd.Series(vals, index=[pd.Timestamp(_d(d)) for d in ds])
    ratio = (base / base.rolling(28, min_periods=7).mean()).dropna()
    factor = {}
    for dow in range(7):
        r = ratio[ratio.index.dayofweek == dow]
        k = 4.0                                              # four observations' worth of pull toward 1
        factor[dow] = min(1.25, max(0.8, float((r.sum() + k) / (len(r) + k))))
    return {d: level * factor[_d(d).weekday()] for d in days}


def aht_profile(slots, spd, fallback):
    """Volume-weighted AHT per interval, shrunk toward the queue mean where volume is thin."""
    vol, work = np.zeros(spd), np.zeros(spd)
    for p in slots:
        if 0 <= p.slot < spd:
            vol[p.slot] += p.volume
            work[p.slot] += p.volume * p.aht_sec
    overall = work.sum() / vol.sum() if vol.sum() > 0 else fallback
    k = 20.0
    return (work + k * overall) / (vol + k), overall


# --------------------------------------------------------------------------- one queue

ENGINE_VERSION = "wfm-engine 2"


def library_versions():
    """Versions of the libraries a forecast is computed on: a different version can give a different forecast."""
    from importlib import metadata
    out = {}
    for name in ("numpy", "pandas", "scipy", "statsmodels", "scikit-learn"):
        try:
            out[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            out[name] = "unknown"
    return out


def _sha(text):
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()


def forecast_queue(q, dates, spd, events, model, holidays):
    import wfm_pb2
    notes = []
    raw = to_series(q.daily)
    out = wfm_pb2.SeriesForecast(queue_id=q.queue_id, model="wavg")
    if len(raw) < 14:
        notes.append(f"Only {len(raw)} days of history; using a plain weekday average. Import more history for a better model.")
    hist_events = [e for e in events if e.queue_id in (0, q.queue_id)]
    mask = event_mask_for(raw.index, hist_events, q.queue_id) if len(raw) else pd.Series(dtype=bool)
    if not len(raw):
        raw = pd.Series([0.0] * 7, index=pd.date_range(date.today() - timedelta(days=7), periods=7))
        mask = pd.Series(False, index=raw.index)
    y, cleaned, ev_ratio = clean_series(raw, mask)
    out.cleaned_days = cleaned
    if cleaned:
        notes.append(f"{cleaned} outlier/event day(s) replaced by the same-weekday baseline before fitting.")

    names = candidates(y)
    cache = {}
    scores, per_model = backtest(y, names, holidays, cache, raw=raw, event_mask=mask)
    long_scores = backtest_long(y, [m for m in names if m in scores], holidays, cache, raw=raw, event_mask=mask) if scores else {}
    for m, v in long_scores.items():
        scores[m].update(v)
    chosen = pick_model(scores, model)
    for m in cache.get("failed_models", []):
        notes.append(f"{LABELS.get(m, m)} could not be fitted on this history, so it was left out of the comparison.")
    if model and model != "auto" and chosen != model:
        notes.append(f"You asked for '{model}' but it was not used: {unavailable_reason(model, y)}. '{chosen}' was used instead.")
    elif model and model != "auto" and model in scores:
        best = min(scores, key=lambda m: selection_score(scores, m))
        if best != model and selection_score(scores, best) > 0 and selection_score(scores, model) > selection_score(scores, best) * 1.15:
            gap = round((selection_score(scores, model) / selection_score(scores, best) - 1) * 100)
            notes.append(f"'{model}' ran as you asked, but in the backtest '{best}' was about {gap}% more accurate on this queue. Choose Auto to let the engine pick the best one.")
    if scores and chosen == "snaive" and model in (None, "", "auto"):
        notes.append("No model beat seasonal naive in the backtest, so seasonal naive is used.")
    out.model = chosen
    for m in names:
        if m in scores:
            out.scores.add(model=m, wape=round(scores[m]["wape"], 4), mase=round(scores[m]["mase"], 4),
                           bias=round(scores[m]["bias"], 4), selected=(m == chosen), mae=round(scores[m]["mae"], 1),
                           rmse=round(scores[m]["rmse"], 1), mape=round(scores[m]["mape"], 4), stability=scores[m]["stability"],
                           raw_scored=bool(scores[m].get("raw_scored")), raw_wape=round(scores[m].get("raw_wape", 0.0), 4), raw_mase=round(scores[m].get("raw_mase", 0.0), 4),
                           raw_bias=round(scores[m].get("raw_bias", 0.0), 4), raw_mae=round(scores[m].get("raw_mae", 0.0), 1))

    # relative error of the chosen model -> band width
    rel, rel_by_fold = [], []
    if chosen in per_model:
        rows = per_model[chosen]
        for ts, a, f in rows:
            out.backtest.add(day=ts.date().isoformat(), slot=-1, volume=round(a, 1), aht_sec=round(f, 1))
            if f > 0:
                rel.append((a - f) / f)
        rel_by_fold = [[(a - f) / f for _, a, f in rows[i:i + BACKTEST_H] if f > 0] for i in range(0, len(rows), BACKTEST_H)]
    sigma = max(0.04, float(np.std(rel))) if len(rel) > 3 else 0.12
    out.sigma_rel = round(sigma, 4)
    band_lo, band_hi, out.band_method, out.p10_coverage, out.p90_coverage, out.band_points = calibrate_bands(rel_by_fold, sigma)
    # Last year's movement is read from the history as it happened, not from the cleaned one: cleaning replaces days that stand out from their weekday's baseline, and a multi-week lull
    # or rush (August, the year end) stands out, so the cleaned history has lost the very shape being looked for. Known events are replaced; a one-off last year is damped by the
    # 4-week averaging, the weight that must prove itself in the backtest, and the limit on the ratio.
    basis = raw.where(~mask, y).fillna(y) if len(raw) == len(y) else y
    annual_folds = annual_backtest(y, chosen, holidays, cache, raw=raw, event_mask=mask, basis=basis) if scores else []
    annual_w, annual_gain = choose_annual_weight(annual_folds)
    if annual_folds:                      # more folds, spread over the year, than the two of the 4-week test: the better source for the band too (of the adjusted forecast when it is used)
        far_src = adjusted_rel_folds(annual_folds, annual_w)
    else:
        far_src = long_scores[chosen]["rel_folds"] if chosen in long_scores else None
    far = calibrate_far(far_src) if far_src is not None else None       # the band for days 8 to 28
    # the registry record: what the model learned from, how it was set up, and what it ran on
    out.training_start, out.training_end, out.training_rows = (raw.index[0].date().isoformat(), raw.index[-1].date().isoformat(), int(len(raw))) if len(raw) else ("", "", 0)
    out.data_hash = _sha("".join(f"{d.date().isoformat()}:{v:.4f};" for d, v in raw.items()))
    libs = library_versions()
    cfg = {"model": chosen, "requested": model or "auto", "history_days": int(len(y)), "outlier_days_replaced": int(cleaned), "ets_mode": cache.get(("mode", len(y))),
           "sarima_order": cache.get(("sarima_order", len(y))), "backtest": {"folds": BACKTEST_FOLDS, "horizon_days": BACKTEST_H, "walk_forward": True,
                                                                                                                                  "long_folds": LONG_FOLDS if long_scores else 0, "long_horizon_days": LONG_H if long_scores else 0,
                                                                                                                                  "annual": {"weight": annual_w, "backtest_gain": round(annual_gain, 3)},
                                                                                                                                  "far_band": ({"points": far.points, "low": round(far.lo, 4), "high": round(far.hi, 4), "p10_coverage": round(far.p10_coverage, 3), "p90_coverage": round(far.p90_coverage, 3)} if far else None)}, "band_min_points": BAND_MIN_POINTS}
    out.model_config = json.dumps(cfg, sort_keys=True, default=str)
    out.library_versions = json.dumps(libs, sort_keys=True)
    out.model_version = f"{chosen}-{_sha(ENGINE_VERSION + out.model_config + out.library_versions)[:12]}"
    out.events_hash = _sha(json.dumps(sorted((e.name, e.kind, e.start_day, e.end_day, e.uplift_pct, e.queue_id, e.lead_days, e.lag_days) for e in hist_events), default=str))
    out.p10_coverage, out.p90_coverage = round(out.p10_coverage, 3), round(out.p90_coverage, 3)
    if out.p10_coverage >= 0 and (out.p10_coverage > 0.25 or out.p90_coverage < 0.75):
        notes.append(f"The P10-P90 band is calibrated on {out.band_points} backtest errors, and on days it was not fitted to it held {out.p10_coverage:.0%} of actuals at or under P10 "
                     f"(0% to 20% is good) and {out.p90_coverage:.0%} at or under P90 (80% to 100% is good): treat the band as optimistic.")

    h = (_d(dates[-1]) - y.index[-1].date()).days
    h = max(h, 1)
    try:
        base = np.clip(run_model(chosen, y, h, holidays, cache), 0, None)
    except Exception as e:
        if chosen != "lstm":
            raise
        notes.append(f"The LSTM won the backtest but could not be refitted on the full history ({str(e)[:100]}), so Holt-Winters is used for the forecast.")
        chosen = out.model = "ets"
        base = np.clip(run_model("ets", y, h, holidays, cache), 0, None)
    fut_index = [y.index[-1].date() + timedelta(days=k) for k in range(1, h + 1)]
    if annual_w > 0:
        ratio = annual_ratio(basis, fut_index)
        if ratio is not None:
            base = base * (1 + annual_w * (ratio - 1))
            notes.append(f"The forecast is pulled {annual_w:.0%} of the way toward how the same weeks moved last year: in the 4-week backtest that cut the error by {annual_gain:.0%}.")
        else:
            annual_w = 0.0
    daily = {d: float(v) for d, v in zip(fut_index, base)}

    # learned uplift per event kind from history
    learned = {}
    if ev_ratio is not None and ev_ratio.notna().any():
        for ts, r in ev_ratio.dropna().items():
            for ev in hist_events:
                if in_event(ev, ts.date(), q.queue_id):
                    learned.setdefault(ev.kind, []).append(float(r) - 1)
    noted = set()
    for day in dates:
        d = _d(day)
        mult = 1.0
        for ev in events:
            frac = event_ramp(ev, d, q.queue_id)
            if frac > 0:
                up = ev.uplift_pct / 100.0
                if up == 0 and learned.get(ev.kind):
                    up = float(np.mean(learned[ev.kind]))
                    if ev.name not in noted:
                        noted.add(ev.name)
                        notes.append(f"'{ev.name}': uplift {up * 100:+.0f}% learned from {len(learned[ev.kind])} past event day(s).")
                mult *= 1 + up * frac
        daily[d] = daily.get(d, float(np.mean(base))) * mult

    aht_fallback = float(np.average([p.aht_sec for p in q.daily], weights=[max(p.volume, 1) for p in q.daily])) if q.daily else 300.0
    for day in dates:
        d = _d(day)
        v = daily[d]
        lo_rel, hi_rel = band_at((d - y.index[-1].date()).days, band_lo, band_hi, far)       # the further ahead, the wider; beyond a week from the 4-week backtest
        out.daily.add(day=day, slot=-1, volume=round(v, 2), aht_sec=round(aht_fallback, 1),
                      p10=round(max(0.0, v * (1 + lo_rel)), 2), p90=round(v * (1 + hi_rel), 2))
    if far is not None and far.p10_coverage >= 0 and (far.p10_coverage > 0.25 or far.p90_coverage < 0.75):
        notes.append(f"The band for 8 to 28 days ahead is calibrated on {far.points} errors from a 4-week backtest, and on folds it was not fitted to it held {far.p10_coverage:.0%} of actuals "
                     f"at or under P10 (0% to 20% is good) and {far.p90_coverage:.0%} at or under P90 (80% to 100% is good): treat the band far ahead as optimistic.")
    elif far is None and dates and (_d(dates[-1]) - y.index[-1].date()).days > BACKTEST_H:
        notes.append("The band more than a week ahead is widened by a fixed rule, not calibrated: this queue has too little history (about 140 days are needed) for a 4-week backtest.")
    out.notes.extend(notes)
    return out, Sigma(sigma, far.sigma if far else None, far.cal_days if far else 18.0)


BAND_MIN_POINTS = 20          # fewer out-of-sample errors than this and an empirical quantile is not worth more than a normal band


def _band_edges(rel, fallback_sigma):
    """(low, high): the 10th and 90th percentile of the relative error (actual - forecast) / forecast. Empirical from the errors when there are enough, else a normal band; the band
    always contains the point forecast (a model that is always high or always low shows that in its bias figure, not as a forecast outside its own band)."""
    if len(rel) >= BAND_MIN_POINTS:
        lo, hi = float(np.quantile(rel, 0.10)), float(np.quantile(rel, 0.90))
    else:
        lo, hi = -Z80 * fallback_sigma, Z80 * fallback_sigma
    return min(lo, 0.0), max(hi, 0.0)


def calibrate_bands(rel_by_fold, fallback_sigma):
    """The relative band edges to use, how they were found, and how well that procedure does on errors it has not seen.

    Coverage is measured leave-one-fold-out: the edges for each backtest fold are found from the other folds' errors and tested on that fold's, so every figure comes from an
    observation that played no part in setting the band. A well-calibrated band has an actual at or under P10 about 10% of the time and at or under P90 about 90% of the time.
    Returns (low, high, method, p10_coverage, p90_coverage, points); coverage is -1 when there were too few folds to test it."""
    folds = [[r for r in f if math.isfinite(r)] for f in rel_by_fold]
    allrel = [r for f in folds for r in f]
    method = "EMPIRICAL" if len(allrel) >= BAND_MIN_POINTS else "NORMAL"
    lo, hi = _band_edges(allrel, fallback_sigma)
    below10 = below90 = tested = 0
    if len([f for f in folds if f]) >= 3:
        for j, held in enumerate(folds):
            rest = [r for i, f in enumerate(folds) if i != j for r in f]
            lj, hj = _band_edges(rest, fallback_sigma)
            below10 += sum(1 for r in held if r <= lj)
            below90 += sum(1 for r in held if r <= hj)
            tested += len(held)
    return lo, hi, method, (below10 / tested if tested else -1.0), (below90 / tested if tested else -1.0), len(allrel)


def distribute(fc, q, dates, spd, events, sigma):
    """Fill fc.slots from fc.daily using the weekday arrival profile."""
    if not spd:
        return
    event_days = set()
    for ev in events:
        if ev.queue_id in (0, q.queue_id):
            d = _d(ev.start_day)
            while d <= _d(ev.end_day):
                event_days.add(d)
                d += timedelta(days=1)
    prof = arrival_profile(q.slots, dates, spd, event_days)
    aht, overall = aht_profile(q.slots, spd, fc.daily[0].aht_sec if fc.daily else 300.0)
    aht_day = aht_forecast(q.slots, [p.day for p in fc.daily], overall)
    last_day = to_series(q.daily).index[-1].date() if q.daily else None      # the history is rebuilt once, not once per forecast day
    for p in fc.daily:
        share = prof[_d(p.day).weekday()]
        last = last_day or _d(p.day)
        sig = sigma_at(sigma, (_d(p.day) - last).days)
        for s in range(spd):
            v = p.volume * share[s]
            sd = math.sqrt((sig * v) ** 2 + v)  # forecast error plus Poisson arrival noise
            fc.slots.add(day=p.day, slot=s, volume=round(v, 3), aht_sec=round(float(aht[s]) * aht_day[p.day] / overall, 1) if overall else round(float(aht[s]), 1),
                         p10=round(max(0.0, v - Z80 * sd), 3), p90=round(v + Z80 * sd, 3))
        p.aht_sec = round(aht_day[p.day], 1)


# --------------------------------------------------------------------------- public entry point

_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    """Persistent warm worker processes: the fits are GIL-bound Python, so threads would not help."""
    global _pool
    with _pool_lock:
        if _pool is None:
            # Not the Linux default (fork): the engine is a multi-threaded gRPC server, and forking it while other threads are inside gRPC can crash the whole process with a
            # segmentation fault (seen in production, in threading._after_fork). A forkserver is a clean separate process that the workers are forked from instead.
            # ENGINE_POOL_START=fork brings the old behaviour back; spawn is the other safe choice.
            import multiprocessing
            want = os.environ.get("ENGINE_POOL_START") or "forkserver"
            ctx = multiprocessing.get_context(want if want in multiprocessing.get_all_start_methods() else "spawn")     # Windows has no forkserver
            _pool = ProcessPoolExecutor(max_workers=max(2, min(4, __import__("resources").effective_cpus())), mp_context=ctx, initializer=warm_up)
        return _pool


def _noop(_):
    return 0


def start_pool():
    """Spawn the worker processes now (each imports statsmodels/sklearn) so the first request is not a cold start."""
    p = _get_pool()
    list(p.map(_noop, range(p._max_workers * 2)))


def _job(payload):
    import wfm_pb2
    qb, dates, spd, eb, model, hol = payload
    fc, sigma = forecast_queue(wfm_pb2.QueueSeries.FromString(qb), dates, spd, [wfm_pb2.EventInfo.FromString(b) for b in eb],
                               model, {date.fromordinal(o) for o in hol})
    return fc.SerializeToString(), sigma


class DeadlineExceeded(RuntimeError):
    """The forecast could not be finished inside the time allowed."""


def fit_all(jobs, dates, spd, events, model, holidays, deadline=None):
    """[(SeriesForecast, sigma)] for each queue series, fitted in parallel worker processes (serial if that fails). `deadline` (a time.monotonic() value) bounds the wait: past it the
    pool is dropped (its workers finish what they hold and exit; nothing new is queued behind them) and DeadlineExceeded is raised."""
    import wfm_pb2
    global _pool
    if len(jobs) > 1:
        eb = [e.SerializeToString() for e in events]
        hol = [d.toordinal() for d in holidays]
        try:
            left = None if deadline is None else max(0.0, deadline - time.monotonic())
            out = list(_get_pool().map(_job, [(q.SerializeToString(), dates, spd, eb, model, hol) for q in jobs], timeout=left))
            return [(wfm_pb2.SeriesForecast.FromString(b), sg) for b, sg in out]
        except TimeoutError:
            old, _pool = _pool, None
            if old is not None:
                old.shutdown(wait=False, cancel_futures=True)
            raise DeadlineExceeded("the forecast did not finish inside the time allowed")
        except (BrokenProcessPool, OSError):
            _pool = None  # fall through to the serial path
    return [forecast_queue(q, dates, spd, events, model, holidays) for q in jobs]


def run(req, deadline_sec=None):
    import wfm_pb2
    deadline = None if deadline_sec is None else time.monotonic() + deadline_sec
    dates = list(req.dates)
    spd = req.slots_per_day
    holidays = set()
    for ev in req.events:
        if ev.kind == "holiday":
            d = _d(ev.start_day)
            while d <= _d(ev.end_day):
                holidays.add(d)
                d += timedelta(days=1)
    events = list(req.events)

    reconcile = req.reconcile and len(req.queues) > 1
    jobs = list(req.queues)
    if reconcile:
        # group total forecast from the summed history; queues are then made to add up to the blend of both views
        by_day = {}
        for q in req.queues:
            for p in q.daily:
                by_day[p.day] = by_day.get(p.day, 0.0) + p.volume
        gq = wfm_pb2.QueueSeries(queue_id=0, name="Group", channel="all")
        for day in sorted(by_day):
            gq.daily.add(day=day, slot=-1, volume=by_day[day], aht_sec=0)
        jobs.append(gq)
    done = fit_all(jobs, dates, spd, events, req.model, holidays, deadline)
    results = [(fc, q, sigma) for (fc, sigma), q in zip(done[:len(req.queues)], req.queues)]

    resp = wfm_pb2.SeriesResponse()
    if reconcile:
        gfc, _sig = done[-1]
        for i, gp in enumerate(gfc.daily):
            total_bu = sum(fc.daily[i].volume for fc, _, _ in results)
            target = 0.5 * (total_bu + gp.volume) if total_bu > 0 else gp.volume
            k = target / total_bu if total_bu > 0 else 1.0
            for fc, _, _ in results:
                p = fc.daily[i]
                p.volume, p.p10, p.p90 = round(p.volume * k, 2), round(p.p10 * k, 2), round(p.p90 * k, 2)
            gp.volume, gp.p10, gp.p90 = round(target, 2), round(gp.p10 * k, 2), round(gp.p90 * k, 2)
        gfc.notes.append("Queue forecasts reconciled with the group forecast per day (average of bottom-up and top-down totals), then the group's days and intervals rebuilt as the sum of its queues.")
        resp.series.append(gfc)

    for fc, q, sigma in results:
        distribute(fc, q, dates, spd, events, sigma)
        resp.series.append(fc)
    if reconcile:
        _reconcile_intervals(resp.series[0], [fc for fc, _, _ in results], done[-1][1], spd)      # the group is the first series: appending copied it, so rebuild the copy in the response
    return resp


def _reconcile_intervals(gfc, queue_fcs, group_sigma, spd):
    """Make the group forecast the sum of its queues at every level, not only per day. In every interval F_group = sum of F_queue, and each day's group figure is the sum of its queues'
    days, so the figures a planner reads at the group, the queue, the day and the 15 minutes all agree and none is negative. The queues were scaled by one common factor per day
    (see run), so their proportions to each other are what the model gave them. The group's handle time is the volume-weighted mean of its queues'; its band is built the way a
    queue's is (forecast error plus arrival noise) from the group's own error spread, not by adding queue bands, which would treat the queues' errors as independent."""
    by_day = {}
    for fc in queue_fcs:
        for p in fc.daily:
            cell = by_day.setdefault(p.day, [0.0, 0.0])
            cell[0] += p.volume
            cell[1] += p.volume * p.aht_sec
    for p in gfc.daily:
        total, work = by_day.get(p.day, [p.volume, 0.0])
        ratio = (p.p10 / p.volume, p.p90 / p.volume) if p.volume > 0 else (1.0, 1.0)
        p.volume, p.p10, p.p90 = round(total, 2), round(total * ratio[0], 2), round(total * ratio[1], 2)
        if total > 0:
            p.aht_sec = round(work / total, 1)
    if not spd:
        return
    cells = {}
    for fc in queue_fcs:
        for s in fc.slots:
            cell = cells.setdefault((s.day, s.slot), [0.0, 0.0])
            cell[0] += s.volume
            cell[1] += s.volume * s.aht_sec
    del gfc.slots[:]
    horizon = {p.day: p for p in gfc.daily}
    first = min(horizon) if horizon else None
    for (day, slot) in sorted(cells):
        v, work = cells[(day, slot)]
        grp = horizon.get(day)
        ahead = (_d(day) - _d(first)).days + 1 if horizon else 0       # history ends the day before the first forecast day
        sig = sigma_at(group_sigma, ahead)
        sd = math.sqrt((sig * v) ** 2 + v)
        gfc.slots.add(day=day, slot=slot, volume=round(v, 3), aht_sec=round(work / v, 1) if v > 0 else (grp.aht_sec if grp else 0.0),
                      p10=round(max(0.0, v - Z80 * sd), 3), p90=round(v + Z80 * sd, 3))
    gfc.notes.append("The group's 15-minute forecast is the sum of its queues' in every interval.")


# --------------------------------------------------------------------------- intraday reforecast

def intraday(req):
    """Re-scale the rest of today by how the last hours ran versus forecast; the correction fades over ~4 hours."""
    import wfm_pb2
    fc = {p.slot: p for p in req.forecast}
    act = {p.slot: p for p in req.actuals}
    cur = req.current_slot
    recent = [s for s in range(cur) if s in act and s in fc][-8:]
    a = sum(act[s].volume for s in recent)
    f = sum(fc[s].volume for s in recent)
    ratio_raw = a / f if f > 0 else 1.0
    cred = a / (a + 40.0)  # thin actuals are not trusted much
    ratio = min(max(1 + cred * (ratio_raw - 1), 0.5), 2.0)
    aht_a = sum(act[s].volume * act[s].aht_sec for s in recent)
    aht_f = sum(act[s].volume * fc[s].aht_sec for s in recent)
    aht_ratio = 1 + cred * ((aht_a / aht_f) - 1) if aht_f > 0 else 1.0
    resp = wfm_pb2.IntradayResponse(ratio=round(ratio, 4), credibility=round(cred, 3))
    for s in sorted(fc):
        if s < cur:
            continue
        decay = 0.5 ** ((s - cur) / 16.0)
        r = 1 + (ratio - 1) * decay
        v = fc[s].volume * r
        band = Z80 * math.sqrt((0.10 * v) ** 2 + v)
        resp.adjusted.add(day=fc[s].day, slot=s, volume=round(v, 3), aht_sec=round(fc[s].aht_sec * (1 + (aht_ratio - 1) * decay), 1),
                          p10=round(max(0.0, v - band), 3), p90=round(v + band, 3))
    return resp
