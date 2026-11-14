"""A small LSTM for daily contact volume, written with NumPy only.

Why not a deep-learning framework: the series are short (a few hundred days per queue) and the network is tiny, so a framework buys nothing but a very large dependency (its Linux
wheels pull in gigabytes of GPU libraries), a larger attack surface to scan, and a lock file that no longer pins a small, reviewable set. The mathematics is the standard LSTM
(input, forget, output gates and a cell candidate; backpropagation through time; Adam), written out so that it can be checked: test_lstm.py compares its gradients with finite
differences.

The model: the last WINDOW days, each described by its volume relative to the queue's recent level plus the weekday and a holiday flag, are run through an LSTM; the final state, with
the calendar of the day to predict, goes through one linear layer to give that day's volume relative to the level. Longer horizons are produced one day at a time, each prediction
becoming the next day's input. Training is deterministic (a fixed seed, no threads), stops early on a held-out tail of the history, and is bounded in time.
"""
import time

import numpy as np

WINDOW = 28
HIDDEN = 24
MIN_DAYS = 112                    # 16 weeks: below this a network has too little to learn a weekly shape from
MAX_EPOCHS = 160
BATCH = 64
LEARNING_RATE = 0.01
WEIGHT_DECAY = 1e-4
PATIENCE = 14
SEED = 7


def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -40.0, 40.0)))


class LSTM:
    """Sequence (N, L, D) + calendar of the target day (N, C) -> one number each."""

    def __init__(self, n_in, n_cal, hidden=HIDDEN, seed=SEED):
        rng = np.random.default_rng(seed)
        H = hidden
        self.H, self.D, self.C = H, n_in, n_cal
        s = 1.0 / np.sqrt(H)
        self.p = {"Wx": rng.uniform(-s, s, (n_in, 4 * H)), "Wh": rng.uniform(-s, s, (H, 4 * H)), "b": np.zeros(4 * H),
                  "Wo": rng.uniform(-s, s, (H + n_cal, 1)), "bo": np.zeros(1)}
        self.p["b"][H:2 * H] = 1.0                   # a forget gate that starts open: the usual way to let the memory last

    def forward(self, X, C):
        N, L, _ = X.shape
        H, p = self.H, self.p
        h, c, cache = np.zeros((N, H)), np.zeros((N, H)), []
        for t in range(L):
            z = X[:, t] @ p["Wx"] + h @ p["Wh"] + p["b"]
            i, f, g, o = _sigmoid(z[:, :H]), _sigmoid(z[:, H:2 * H]), np.tanh(z[:, 2 * H:3 * H]), _sigmoid(z[:, 3 * H:])
            c_new = f * c + i * g
            tc = np.tanh(c_new)
            cache.append((X[:, t], h, c, i, f, g, o, tc))
            h, c = o * tc, c_new
        feat = np.concatenate([h, C], axis=1)
        return (feat @ p["Wo"] + p["bo"])[:, 0], (cache, feat)

    def backward(self, dout, saved):
        """Gradients of a loss whose derivative with respect to each output is `dout`."""
        cache, feat = saved
        H, p = self.H, self.p
        g_ = {k: np.zeros_like(v) for k, v in p.items()}
        g_["Wo"] = feat.T @ dout[:, None]
        g_["bo"] = np.array([dout.sum()])
        dh = (dout[:, None] @ p["Wo"].T)[:, :H]
        dc = np.zeros_like(dh)
        for x, hp, cp, i, f, g, o, tc in reversed(cache):
            dc_t = dc + dh * o * (1.0 - tc * tc)
            dz = np.concatenate([(dc_t * g) * i * (1 - i), (dc_t * cp) * f * (1 - f), (dc_t * i) * (1 - g * g), (dh * tc) * o * (1 - o)], axis=1)
            g_["Wx"] += x.T @ dz
            g_["Wh"] += hp.T @ dz
            g_["b"] += dz.sum(axis=0)
            dh, dc = dz @ p["Wh"].T, dc_t * f
        return g_


def calendar(index, holidays):
    """Weekday (one-hot) and a holiday flag for each day of a DatetimeIndex."""
    dow = np.eye(7)[np.asarray(index.dayofweek)]
    hol = np.array([[1.0 if d.date() in holidays else 0.0] for d in index])
    return np.concatenate([dow, hol], axis=1)


def _windows(z, cal, window):
    """Training pairs: the `window` days before day t (their volume and calendar) -> day t's volume, with day t's calendar."""
    n = len(z)
    X = np.stack([np.concatenate([z[t - window:t, None], cal[t - window:t]], axis=1) for t in range(window, n)])
    return X, cal[window:n], z[window:n]


def fit_predict(y, h, holidays=None, deadline_sec=20.0, seed=SEED):
    """Forecast `h` days after the series `y` (a pandas Series with a daily DatetimeIndex). Raises ValueError when there is too little history or the result is not usable; the caller
    falls back to a simple model then."""
    import pandas as pd
    holidays = holidays or set()
    if len(y) < MIN_DAYS:
        raise ValueError(f"an LSTM needs at least {MIN_DAYS} days of history and this has {len(y)}")
    t0 = time.monotonic()
    level = float(y.iloc[-56:].mean())
    if not np.isfinite(level) or level <= 0:
        raise ValueError("the series has no volume to learn from")
    z = y.values.astype(float) / level
    fut = pd.date_range(y.index[-1] + pd.Timedelta(days=1), periods=h, freq="D")
    cal = calendar(y.index.append(fut), holidays)
    X, C, T = _windows(z, cal[:len(z)], WINDOW)
    hold = max(14, len(T) // 8)                                       # the most recent days stand out as the check for when to stop
    Xtr, Ctr, Ttr, Xva, Cva, Tva = X[:-hold], C[:-hold], T[:-hold], X[-hold:], C[-hold:], T[-hold:]
    net = LSTM(X.shape[2], C.shape[1], seed=seed)
    rng = np.random.default_rng(seed)
    m = {k: np.zeros_like(v) for k, v in net.p.items()}
    v = {k: np.zeros_like(x) for k, x in net.p.items()}
    best, best_p, bad, step = np.inf, None, 0, 0
    for epoch in range(MAX_EPOCHS):
        order = rng.permutation(len(Ttr))
        for a in range(0, len(order), BATCH):
            idx = order[a:a + BATCH]
            pred, saved = net.forward(Xtr[idx], Ctr[idx])
            err = pred - Ttr[idx]
            dout = np.where(np.abs(err) <= 1.0, err, np.sign(err)) / len(idx)           # Huber: a freak day does not drag the weights
            grads = net.backward(dout, saved)
            step += 1
            for k in net.p:                                                         # Adam
                gk = grads[k] + (WEIGHT_DECAY * net.p[k] if k.startswith("W") else 0.0)
                m[k] = 0.9 * m[k] + 0.1 * gk
                v[k] = 0.999 * v[k] + 0.001 * gk * gk
                net.p[k] -= LEARNING_RATE * (m[k] / (1 - 0.9 ** step)) / (np.sqrt(v[k] / (1 - 0.999 ** step)) + 1e-8)
        val = float(np.mean(np.abs(net.forward(Xva, Cva)[0] - Tva)))
        if val < best - 1e-5:
            best, best_p, bad = val, {k: x.copy() for k, x in net.p.items()}, 0
        else:
            bad += 1
            if bad >= PATIENCE:
                break
        if time.monotonic() - t0 > deadline_sec:
            break
    if best_p is None:
        raise ValueError("the network did not train")
    net.p = best_p
    hist = list(z[-WINDOW:])
    out = []
    ceiling = 3.0 * float(np.max(z)) + 1.0
    for k in range(h):
        ctx = cal[len(z) + k - WINDOW:len(z) + k]
        x = np.concatenate([np.array(hist[-WINDOW:])[:, None], ctx], axis=1)[None]
        nxt = float(net.forward(x, cal[len(z) + k][None])[0][0])
        if not np.isfinite(nxt) or nxt > ceiling:
            raise ValueError("the network gave an unusable forecast")
        nxt = max(0.0, nxt)
        out.append(nxt)
        hist.append(nxt)
    return np.array(out) * level
