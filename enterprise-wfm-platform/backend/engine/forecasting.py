"""Contact-volume forecasting: daily model tournament x intraday arrival profile.

Pipeline per queue (mirrors the usual WFM process: clean -> estimate volume -> arrival pattern -> finalise):
  1. clean history (robust outlier / event days replaced by the same-weekday baseline, event uplift learned)
  2. fit candidate daily models, score them by rolling-origin backtest (WAPE, MASE, bias)
  3. pick the best by MASE; a candidate must beat seasonal naive or seasonal naive is used
  4. apply events, distribute days over intervals with the weekday arrival profile, add P10/P90 bands
  5. reconcile queue forecasts with the group forecast so they add up
"""
import math
import warnings
import os
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import date, timedelta

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

Z80 = 1.2816  # P10/P90
MIN_HISTORY_DAYS = 28
BACKTEST_FOLDS = 4
BACKTEST_H = 7
PROFILE_WEEKS = 8


def warm_up():
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
    m_ets.last_mode = best[1]
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
                                ix.month.values, [1 if d.date() in holidays else 0 for d in ix]])

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


MODELS = {"snaive": m_snaive, "wavg": m_wavg, "ets": m_ets, "gbm": m_gbm, "croston": m_croston}


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
        if name == "combo":
            parts = [run_model("ets", y, h, holidays, cache), run_model("wavg", y, h, holidays, cache)]
            if len(y) >= 120:
                parts.append(run_model("gbm", y, h, holidays, cache))
            cache[key] = np.mean(parts, axis=0)
        elif name == "ets":
            cache[key] = MODELS["ets"](y, h, mode=cache.setdefault("mode", ets_mode(y)))
        else:
            cache[key] = MODELS[name](y, h, holidays=holidays)
    return cache[key]
LABELS = {"snaive": "Seasonal naive", "wavg": "Weighted seasonal avg", "ets": "Holt-Winters (ETS)",
          "gbm": "Gradient boosting", "combo": "Ensemble", "croston": "Croston-SBA"}


def candidates(y: pd.Series):
    names = ["snaive", "wavg", "ets"]
    if len(y) >= 120:
        names.append("gbm")
    names.append("combo")
    if (y == 0).mean() > 0.2 or y.mean() < 3:
        names.append("croston")
    return names


# --------------------------------------------------------------------------- backtest & selection

def backtest(y: pd.Series, names, holidays, cache):
    """Rolling-origin: 4 origins, 7-day horizon. Returns scores dict and per-model list of (day, actual, forecast)."""
    n = len(y)
    if n < MIN_HISTORY_DAYS + BACKTEST_H * 2:
        return {}, {}
    scale_series = y.values
    naive_mae = np.mean(np.abs(scale_series[7:] - scale_series[:-7])) or 1.0
    per_model = {m: [] for m in names}
    for k in range(BACKTEST_FOLDS):
        cut = n - BACKTEST_H * (k + 1)
        train, test = y.iloc[:cut], y.iloc[cut:cut + BACKTEST_H]
        for m in names:
            try:
                f = run_model(m, train, BACKTEST_H, holidays, cache)
            except Exception:
                f = m_snaive(train, BACKTEST_H)
            per_model[m] += [(ts, float(a), float(fc)) for ts, a, fc in zip(test.index, test.values, f)]
    scores = {}
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
    return scores, per_model


def pick_model(scores, requested):
    if not scores:
        return "wavg"
    if requested and requested != "auto" and requested in scores:
        return requested
    best = min(scores, key=lambda m: scores[m]["mase"])
    if best != "snaive" and scores[best]["mase"] >= scores["snaive"]["mase"]:
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
    out = {}
    for dow in range(7):
        rows = per_dow[dow][-PROFILE_WEEKS:]
        prof = np.average(rows, axis=0, weights=np.arange(1, len(rows) + 1)) if rows else overall
        sm = np.convolve(np.pad(prof, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
        out[dow] = sm / sm.sum()
    return out


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

def forecast_queue(q, dates, spd, events, model, holidays):
    import wfm_pb2
    notes = []
    raw = to_series(q.daily)
    out = wfm_pb2.SeriesForecast(queue_id=q.queue_id, model="wavg")
    if len(raw) < 14:
        notes.append(f"Only {len(raw)} days of history; using a plain weekday average. Import more history for a better model.")
    hist_events = [e for e in events if e.queue_id in (0, q.queue_id)]
    mask = pd.Series(False, index=raw.index) if len(raw) else pd.Series(dtype=bool)
    for ev in hist_events:
        for ts in raw.index:
            if in_event(ev, ts.date(), q.queue_id):
                mask[ts] = True
    if not len(raw):
        raw = pd.Series([0.0] * 7, index=pd.date_range(date.today() - timedelta(days=7), periods=7))
        mask = pd.Series(False, index=raw.index)
    y, cleaned, ev_ratio = clean_series(raw, mask)
    out.cleaned_days = cleaned
    if cleaned:
        notes.append(f"{cleaned} outlier/event day(s) replaced by the same-weekday baseline before fitting.")

    names = candidates(y)
    cache = {}
    scores, per_model = backtest(y, names, holidays, cache)
    chosen = pick_model(scores, model)
    if model and model != "auto" and chosen != model:
        notes.append(f"Requested model '{model}' unavailable for this history; used '{chosen}'.")
    if scores and chosen == "snaive" and model in (None, "", "auto"):
        notes.append("No model beat seasonal naive in the backtest, so seasonal naive is used.")
    out.model = chosen
    for m in names:
        if m in scores:
            out.scores.add(model=m, wape=round(scores[m]["wape"], 4), mase=round(scores[m]["mase"], 4),
                           bias=round(scores[m]["bias"], 4), selected=(m == chosen), mae=round(scores[m]["mae"], 1),
                           rmse=round(scores[m]["rmse"], 1), mape=round(scores[m]["mape"], 4), stability=scores[m]["stability"])

    # relative error of the chosen model -> band width
    rel = []
    if chosen in per_model:
        for ts, a, f in per_model[chosen]:
            out.backtest.add(day=ts.date().isoformat(), slot=-1, volume=round(a, 1), aht_sec=round(f, 1))
            if f > 0:
                rel.append((a - f) / f)
    sigma = max(0.04, float(np.std(rel))) if len(rel) > 3 else 0.12
    out.sigma_rel = round(sigma, 4)

    h = (_d(dates[-1]) - y.index[-1].date()).days
    h = max(h, 1)
    base = np.clip(run_model(chosen, y, h, holidays, cache), 0, None)
    fut_index = [y.index[-1].date() + timedelta(days=k) for k in range(1, h + 1)]
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
        sig = sigma * math.sqrt(1 + max((d - y.index[-1].date()).days, 0) / 28.0)
        out.daily.add(day=day, slot=-1, volume=round(v, 2), aht_sec=round(aht_fallback, 1),
                      p10=round(max(0.0, v * (1 - Z80 * sig)), 2), p90=round(v * (1 + Z80 * sig), 2))
    out.notes.extend(notes)
    return out, sigma


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
    for p in fc.daily:
        share = prof[_d(p.day).weekday()]
        last = to_series(q.daily).index[-1].date() if q.daily else _d(p.day)
        sig = sigma * math.sqrt(1 + max((_d(p.day) - last).days, 0) / 28.0)
        for s in range(spd):
            v = p.volume * share[s]
            sd = math.sqrt((sig * v) ** 2 + v)  # forecast error plus Poisson arrival noise
            fc.slots.add(day=p.day, slot=s, volume=round(v, 3), aht_sec=round(float(aht[s]), 1),
                         p10=round(max(0.0, v - Z80 * sd), 3), p90=round(v + Z80 * sd, 3))
        p.aht_sec = round(overall, 1)


# --------------------------------------------------------------------------- public entry point

_pool = None
_pool_lock = threading.Lock()


def _get_pool():
    """Persistent warm worker processes: the fits are GIL-bound Python, so threads would not help."""
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(max_workers=max(2, min(4, os.cpu_count() or 2)), initializer=warm_up)
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


def fit_all(jobs, dates, spd, events, model, holidays):
    """[(SeriesForecast, sigma)] for each queue series, fitted in parallel worker processes (serial if that fails)."""
    import wfm_pb2
    global _pool
    if len(jobs) > 1:
        eb = [e.SerializeToString() for e in events]
        hol = [d.toordinal() for d in holidays]
        try:
            out = list(_get_pool().map(_job, [(q.SerializeToString(), dates, spd, eb, model, hol) for q in jobs]))
            return [(wfm_pb2.SeriesForecast.FromString(b), sg) for b, sg in out]
        except (BrokenProcessPool, OSError):
            _pool = None  # fall through to the serial path
    return [forecast_queue(q, dates, spd, events, model, holidays) for q in jobs]


def run(req):
    import wfm_pb2
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
    done = fit_all(jobs, dates, spd, events, req.model, holidays)
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
        gfc.notes.append("Queue forecasts reconciled with the group forecast (average of bottom-up and top-down totals).")
        resp.series.append(gfc)

    for fc, q, sigma in results:
        distribute(fc, q, dates, spd, events, sigma)
        resp.series.append(fc)
    return resp


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
