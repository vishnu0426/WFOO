"""Stress-test a schedule: play random call arrivals against its staffing, interval by interval.

Erlang formulas (staffing.py) say what an *average* interval needs. This plays the actual day: calls arrive at random, take random time, wait in one
queue in the order they came, and give up after a random patience. People on the phones change at every interval edge. The answer is a distribution,
not a single number: how often an interval or a day would meet its service level, and how bad a poor day gets.

Calls arrive as a Poisson process whose rate is the interval's forecast volume, scaled for the whole stretch by one random factor (the forecast's own
error). Handling times and patience are exponential. When people leave at an interval edge, those already on a call finish it.
"""
import heapq
import time

import numpy as np

import wfm_pb2

SLOT_SEC = 900
MAX_CALLS = 4_000_000        # across all replications; more than this and the replications are reduced


def _one_run(rng, volume, aht, agents, answer, patience, cv):
    n = len(volume)
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
        return offered, answered_in, answered, abandoned, wait_sum, busy_sec
    interval_of = np.repeat(np.arange(n), counts)
    arr = (interval_of + rng.random(total)) * SLOT_SEC
    arr.sort()
    interval_of = np.minimum((arr // SLOT_SEC).astype(int), n - 1)
    svc = rng.exponential(1.0, total) * aht[interval_of]
    pat = rng.exponential(patience, total) if patience > 0 else np.full(total, np.inf)
    cap = np.floor(agents + 0.5).astype(int)

    done = []                         # heap of the times busy agents become free
    waiting = []                      # calls waiting, in arrival order (indexes); `head` is the first not yet served or given up
    head = 0
    qi = 0                            # next call to arrive
    boundary = 1

    def start(i, now):
        w = now - arr[i]
        k = interval_of[i]
        answered[k] += 1
        wait_sum[k] += w
        if w <= answer:
            answered_in[k] += 1
        busy_sec[k] += svc[i]
        heapq.heappush(done, now + svc[i])

    def fill(now, c):
        nonlocal head
        while head < len(waiting) and len(done) < c:
            i = waiting[head]
            head += 1
            if now - arr[i] > pat[i]:                 # gave up before an agent got to them
                abandoned[interval_of[i]] += 1
                continue
            start(i, now)

    while qi < total or head < len(waiting) or boundary < n:
        next_arr = arr[qi] if qi < total else np.inf
        next_done = done[0] if done else np.inf
        next_edge = boundary * SLOT_SEC if boundary < n else np.inf
        t = min(next_arr, next_done, next_edge)
        if t == np.inf:
            break
        c = cap[min(int(t // SLOT_SEC), n - 1)]
        if next_done <= next_arr and next_done <= next_edge:
            heapq.heappop(done)
            fill(t, c)
        elif next_edge <= next_arr:
            boundary += 1
            fill(t, cap[min(int(t // SLOT_SEC), n - 1)])
        else:
            i = qi
            qi += 1
            if len(done) < c and head >= len(waiting):
                start(i, t)
            else:
                waiting.append(i)
        if head > 1024 and head * 2 > len(waiting):   # keep the list from growing without bound
            del waiting[:head]
            head = 0
    # whoever is still waiting when the stretch ends and would have given up by then
    for i in waiting[head:]:
        if (n * SLOT_SEC - arr[i]) > pat[i]:
            abandoned[interval_of[i]] += 1
    return offered, answered_in, answered, abandoned, wait_sum, busy_sec


def run(req):
    t0 = time.time()
    n = len(req.intervals)
    if n == 0:
        return wfm_pb2.SimResponse()
    volume = np.array([i.volume for i in req.intervals], dtype=float)
    aht = np.array([max(1.0, i.aht_sec) if i.volume > 0 else 1.0 for i in req.intervals], dtype=float)
    agents = np.array([i.agents for i in req.intervals], dtype=float)
    answer, patience = max(1, req.answer_sec or 20), max(0, req.patience_sec or 120)
    spd = req.slots_per_day or 96
    reps = max(1, min(int(req.replications or 30), 500))
    reps = max(1, min(reps, int(MAX_CALLS / max(1.0, float(volume.sum())))))
    rng = np.random.default_rng(req.seed or 12345)

    off = np.zeros((reps, n)); ain = np.zeros((reps, n)); ans = np.zeros((reps, n)); ab = np.zeros((reps, n)); wt = np.zeros((reps, n)); bs = np.zeros((reps, n))
    for r in range(reps):
        off[r], ain[r], ans[r], ab[r], wt[r], bs[r] = _one_run(rng, volume, aht, agents, answer, patience, max(0.0, req.volume_cv))

    # service level counts every caller who arrived: those who gave up were not answered in time
    sl_i = np.divide(ain, off, out=np.ones_like(off), where=off > 0)
    out = wfm_pb2.SimResponse(replications=reps)
    for k in range(n):
        cap_sec = max(agents[k], 0) * SLOT_SEC
        out.intervals.add(
            sl_mean=float(sl_i[:, k].mean()), sl_low=float(np.percentile(sl_i[:, k], 10)),
            asa_sec=float(wt[:, k].sum() / max(1.0, ans[:, k].sum())), abandon=float(ab[:, k].sum() / max(1.0, off[:, k].sum())),
            occupancy=float(min(1.0, bs[:, k].mean() / cap_sec)) if cap_sec > 0 else 0.0, offered=float(off[:, k].mean()))
    for d in range(max(1, n // spd)):
        a, b = d * spd, min(n, (d + 1) * spd)
        o, ai = off[:, a:b].sum(axis=1), ain[:, a:b].sum(axis=1)
        sl = np.divide(ai, o, out=np.ones_like(o), where=o > 0)
        out.days.add(sl_mean=float(sl.mean()), sl_low=float(np.percentile(sl, 10)), abandon=float(ab[:, a:b].sum() / max(1.0, o.sum())),
                     occupancy=float(min(1.0, bs[:, a:b].sum(axis=1).mean() / max(agents[a:b].sum() * SLOT_SEC, 1.0))), offered=float(o.mean()))
    tot_o, tot_a = off.sum(axis=1), ain.sum(axis=1)
    sl_rep = np.divide(tot_a, tot_o, out=np.ones_like(tot_o), where=tot_o > 0)
    out.sl_by_rep.extend(float(x) for x in sl_rep)
    out.sl_mean = float(sl_rep.mean())
    out.abandon = float(ab.sum() / max(1.0, off.sum()))
    out.occupancy = float(min(1.0, bs.sum(axis=1).mean() / max(1.0, agents.sum() * SLOT_SEC)))
    out.offered = float(tot_o.mean())
    out.wall_sec = round(time.time() - t0, 2)
    return out
