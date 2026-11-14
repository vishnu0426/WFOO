"""Stress-test a schedule: play random call arrivals against its staffing, interval by interval.

Erlang formulas (staffing.py) say what an *average* interval needs. This plays the actual day: calls arrive at random, take random time, wait in one
queue in the order they came, and give up after a random patience. People on the phones change at every interval edge. The answer is a distribution,
not a single number: how often an interval or a day would meet its service level, and how bad a poor day gets.

Calls arrive as a Poisson process whose rate is the interval's forecast volume, scaled for the whole stretch by one random factor (the forecast's own
error). Handling times and patience are exponential. When people leave at an interval edge, those already on a call finish it.
"""
import heapq
import math
import time

import numpy as np

import wfm_pb2

SLOT_SEC = 900
MAX_CALLS = 4_000_000        # across all replications; more than this and the replications are reduced


def _draw(rng, dist, mean, cv, size, samples=None):
    """`size` random durations with this mean. EXPONENTIAL has a spread equal to its mean; LOGNORMAL has the given cv; FIXED has none; EMPIRICAL resamples observed values."""
    mean = np.asarray(mean, dtype=float)
    if dist == "EMPIRICAL" and samples is not None and len(samples):
        return rng.choice(samples, size)
    if dist == "FIXED":
        return np.broadcast_to(mean, (size,)).astype(float) if mean.ndim == 0 else mean.astype(float)
    if dist == "LOGNORMAL":
        sigma = math.sqrt(math.log(1 + max(cv, 1e-6) ** 2))
        return np.exp(rng.normal(-0.5 * sigma * sigma, sigma, size)) * mean
    return rng.exponential(1.0, size) * mean


def _one_run(rng, volume, aht, agents, answer, patience, cv, slot_sec=SLOT_SEC, opts=None):
    opts = opts or {}
    n = len(volume)
    if opts.get("volume_scales"):
        scale = float(rng.choice(opts["volume_scales"]))                          # one of the forecast's own past errors
    else:
        scale = float(np.exp(rng.normal(-0.5 * cv * cv, cv))) if cv > 0 else 1.0     # mean 1: the forecast is right on average, wrong on the day
    counts = rng.poisson(np.maximum(volume, 0) * scale)
    total = int(counts.sum())
    offered = counts.astype(float)
    answered_in = np.zeros(n)        # answered within the threshold, by the interval the call arrived in
    answered = np.zeros(n)
    abandoned = np.zeros(n)
    wait_sum = np.zeros(n)
    busy_sec = np.zeros(n)           # handling time, credited to the interval the call started in
    if total == 0:
        return offered, answered_in, answered, abandoned, wait_sum, busy_sec, np.zeros(2), np.zeros(2)
    interval_of = np.repeat(np.arange(n), counts)
    arr = (interval_of + rng.random(total)) * slot_sec
    arr.sort()
    interval_of = np.minimum((arr // slot_sec).astype(int), n - 1)
    svc = _draw(rng, opts.get("handle_dist", "EXPONENTIAL"), aht[interval_of], opts.get("handle_cv", 1.0), total)
    acw = float(opts.get("acw", 0))
    if opts.get("patience_dist") == "EMPIRICAL" and opts.get("patience_samples"):
        pat = _draw(rng, "EMPIRICAL", patience, 1.0, total, opts["patience_samples"])
    elif patience > 0:
        pat = _draw(rng, opts.get("patience_dist", "EXPONENTIAL"), patience, opts.get("patience_cv", 1.0), total)
    else:
        pat = np.full(total, np.inf)
    share = float(opts.get("priority_share", 0.0))
    high = rng.random(total) < share if share > 0 else np.zeros(total, dtype=bool)       # high-priority calls are served ahead of the rest
    cap = np.floor(agents + 0.5).astype(int)

    done = []                         # heap of the times busy agents become free
    queues = ([], [])                 # calls waiting, in arrival order (indexes): [0] high priority, [1] the rest
    heads = [0, 0]                    # the first in each not yet served or given up
    qi = 0                            # next call to arrive
    boundary = 1
    hi_in = np.zeros(2)               # answered within the threshold, by class (high, normal)
    hi_off = np.zeros(2)

    def start(i, now):
        w = now - arr[i]
        k = interval_of[i]
        answered[k] += 1
        wait_sum[k] += w
        if w <= answer:
            answered_in[k] += 1
            hi_in[0 if high[i] else 1] += 1
        busy_sec[k] += svc[i] + acw
        heapq.heappush(done, now + svc[i] + acw)       # the agent is not free until the after-call work is done

    def waiting_count():
        return (len(queues[0]) - heads[0]) + (len(queues[1]) - heads[1])

    def fill(now, c):
        while len(done) < c:
            cls = 0 if heads[0] < len(queues[0]) else 1 if heads[1] < len(queues[1]) else None
            if cls is None:
                return
            i = queues[cls][heads[cls]]
            heads[cls] += 1
            if now - arr[i] > pat[i]:                 # gave up before an agent got to them
                abandoned[interval_of[i]] += 1
                continue
            start(i, now)

    while qi < total or waiting_count() > 0 or boundary < n:
        next_arr = arr[qi] if qi < total else np.inf
        next_done = done[0] if done else np.inf
        next_edge = boundary * slot_sec if boundary < n else np.inf
        t = min(next_arr, next_done, next_edge)
        if t == np.inf:
            break
        c = cap[min(int(t // slot_sec), n - 1)]
        if next_done <= next_arr and next_done <= next_edge:
            heapq.heappop(done)
            fill(t, c)
        elif next_edge <= next_arr:
            boundary += 1
            fill(t, cap[min(int(t // slot_sec), n - 1)])
        else:
            i = qi
            qi += 1
            if len(done) < c and waiting_count() == 0:
                start(i, t)
            else:
                queues[0 if high[i] else 1].append(i)
        for cls in (0, 1):
            if heads[cls] > 1024 and heads[cls] * 2 > len(queues[cls]):   # keep the lists from growing without bound
                del queues[cls][:heads[cls]]
                heads[cls] = 0
    # whoever is still waiting when the stretch ends and would have given up by then
    for cls in (0, 1):
        for i in queues[cls][heads[cls]:]:
            if (n * slot_sec - arr[i]) > pat[i]:
                abandoned[interval_of[i]] += 1
    hi_off[0], hi_off[1] = float(high.sum()), float(total - high.sum())
    return offered, answered_in, answered, abandoned, wait_sum, busy_sec, hi_in, hi_off


def _ci(x):
    """95% confidence interval for the mean of the replications' figures: the mean plus or minus 1.96 standard errors (it narrows as replications are added), kept within 0 to 1."""
    x = np.asarray(x, dtype=float)
    m = float(x.mean())
    se = float(x.std(ddof=1) / math.sqrt(len(x))) if len(x) > 1 else 0.0
    return max(0.0, m - 1.96 * se), min(1.0, m + 1.96 * se)


def run(req):
    t0 = time.time()
    n = len(req.intervals)
    if n == 0:
        return wfm_pb2.SimResponse()
    volume = np.array([i.volume for i in req.intervals], dtype=float)
    aht = np.array([max(1.0, i.aht_sec) if i.volume > 0 else 1.0 for i in req.intervals], dtype=float)
    agents = np.array([i.agents for i in req.intervals], dtype=float)
    answer = max(1, req.answer_sec or 20)
    # patience: unset or 0 = the 120 seconds earlier callers assumed (a proto3 number cannot say "unset"); a negative number = callers never give up, the case Erlang C assumes
    patience = 0 if req.patience_sec < 0 else (req.patience_sec or 120)
    spd = req.slots_per_day or 96
    slot_sec = float(req.interval_sec or SLOT_SEC)               # the length of an interval is what the request says; unset means the 900 seconds (15 minutes) every earlier caller assumed
    reps = max(1, min(int(req.replications or 30), 500))
    reps = max(1, min(reps, int(MAX_CALLS / max(1.0, float(volume.sum())))))
    rng = np.random.default_rng(req.seed or 12345)

    opts = {"handle_dist": (req.handle_dist or "EXPONENTIAL").upper(), "handle_cv": req.handle_cv or 1.0, "patience_dist": (req.patience_dist or "EXPONENTIAL").upper(),
            "patience_cv": req.patience_cv or 1.0, "patience_samples": [x for x in req.patience_samples if x >= 0], "acw": max(0, req.after_call_work_sec),
            "volume_scales": [x for x in req.volume_scales if x > 0], "priority_share": min(max(req.priority_share, 0.0), 1.0)}
    off = np.zeros((reps, n)); ain = np.zeros((reps, n)); ans = np.zeros((reps, n)); ab = np.zeros((reps, n)); wt = np.zeros((reps, n)); bs = np.zeros((reps, n))
    cls_in, cls_off = np.zeros(2), np.zeros(2)
    for r in range(reps):
        off[r], ain[r], ans[r], ab[r], wt[r], bs[r], ci_, co_ = _one_run(rng, volume, aht, agents, answer, patience, max(0.0, req.volume_cv), slot_sec, opts)
        cls_in += ci_
        cls_off += co_

    # service level counts every caller who arrived: those who gave up were not answered in time
    sl_i = np.divide(ain, off, out=np.ones_like(off), where=off > 0)
    out = wfm_pb2.SimResponse(replications=reps, replications_requested=max(1, min(int(req.replications or 30), 500)))
    for k in range(n):
        cap_sec = max(agents[k], 0) * slot_sec
        out.intervals.add(
            sl_mean=float(sl_i[:, k].mean()), sl_low=float(np.percentile(sl_i[:, k], 10)),
            asa_sec=float(wt[:, k].sum() / max(1.0, ans[:, k].sum())), abandon=float(ab[:, k].sum() / max(1.0, off[:, k].sum())),
            occupancy=float(min(1.0, bs[:, k].mean() / cap_sec)) if cap_sec > 0 else 0.0, offered=float(off[:, k].mean()), sl_ci_low=_ci(sl_i[:, k])[0], sl_ci_high=_ci(sl_i[:, k])[1])
    for d in range(max(1, n // spd)):
        a, b = d * spd, min(n, (d + 1) * spd)
        o, ai = off[:, a:b].sum(axis=1), ain[:, a:b].sum(axis=1)
        sl = np.divide(ai, o, out=np.ones_like(o), where=o > 0)
        out.days.add(sl_mean=float(sl.mean()), sl_low=float(np.percentile(sl, 10)), abandon=float(ab[:, a:b].sum() / max(1.0, o.sum())),
                     occupancy=float(min(1.0, bs[:, a:b].sum(axis=1).mean() / max(agents[a:b].sum() * slot_sec, 1.0))), offered=float(o.mean()), sl_ci_low=_ci(sl)[0], sl_ci_high=_ci(sl)[1])
    tot_o, tot_a = off.sum(axis=1), ain.sum(axis=1)
    sl_rep = np.divide(tot_a, tot_o, out=np.ones_like(tot_o), where=tot_o > 0)
    out.sl_by_rep.extend(float(x) for x in sl_rep)
    out.sl_mean = float(sl_rep.mean())
    out.sl_ci_low, out.sl_ci_high = _ci(sl_rep)
    ab_rep = np.divide(ab.sum(axis=1), off.sum(axis=1), out=np.zeros(reps), where=off.sum(axis=1) > 0)
    out.abandon_ci_low, out.abandon_ci_high = _ci(ab_rep)
    if opts["priority_share"] > 0 and cls_off.min() > 0:
        out.priority_sl_mean, out.normal_sl_mean = float(cls_in[0] / cls_off[0]), float(cls_in[1] / cls_off[1])
    out.abandon = float(ab.sum() / max(1.0, off.sum()))
    out.occupancy = float(min(1.0, bs.sum(axis=1).mean() / max(1.0, agents.sum() * slot_sec)))
    out.offered = float(tot_o.mean())
    out.wall_sec = round(time.time() - t0, 2)
    return out
