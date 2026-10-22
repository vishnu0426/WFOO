"""Staffing maths: Erlang C, Erlang A (abandonment), chat concurrency and async (email/back-office) workload."""
import math
from collections import defaultdict
from functools import lru_cache

import numpy as np

CHAT_EFFICIENCY = 0.85  # concurrent chats are slower than 1/c of a single chat


def erlang_c_wait_prob(agents: int, traffic: float) -> float:
    if agents <= traffic:
        return 1.0
    b = 1.0  # iterative Erlang B, then convert to C (numerically stable)
    for k in range(1, agents + 1):
        b = traffic * b / (k + traffic * b)
    return b / (1 - (traffic / agents) * (1 - b))


def erlang_c_metrics(n: int, traffic: float, aht: float, answer: int):
    """(service level, ASA seconds, abandon) for n agents. Erlang C has no abandonment."""
    if n <= traffic:
        return 0.0, math.inf, 0.0
    pw = erlang_c_wait_prob(n, traffic)
    sl = 1 - pw * math.exp(-(n - traffic) * answer / aht)
    asa = pw * aht / (n - traffic)
    return sl, asa, 0.0


def required_agents(calls_per_hour: float, aht_sec: int, target_sl: float, answer_sec: int) -> int:
    """Kept for the legacy hourly forecast."""
    if calls_per_hour <= 0:
        return 0
    traffic = calls_per_hour * aht_sec / 3600.0
    n = max(1, math.ceil(traffic))
    while True:
        if n > traffic and erlang_c_metrics(n, traffic, aht_sec, answer_sec)[0] >= target_sl:
            return n
        n += 1


@lru_cache(maxsize=20000)
def erlang_a_metrics(n: int, traffic: float, aht: float, answer: int, patience: int):
    """M/M/n+M. Returns (service level, ASA, abandon share).

    Steady state comes from the birth-death chain; the service level of an arrival that finds j customers
    queued is the probability it is served within `answer` s before it or others ahead give up, computed by
    uniformisation of the "position in queue" chain.
    """
    if traffic <= 0:
        return 1.0, 0.0, 0.0
    mu, theta = 1.0 / aht, 1.0 / max(patience, 1)
    lam = traffic * mu
    K = int(min(400, max(40, 3 * n)))
    k = np.arange(1, n + K + 1)
    rates = np.where(k <= n, k * mu, n * mu + (k - n) * theta)
    logp = np.concatenate([[0.0], np.cumsum(np.log(lam) - np.log(rates))])
    p = np.exp(logp - logp.max())
    p /= p.sum()
    p_wait = float(p[n:].sum())
    queue = np.arange(K + 1)
    exp_q = float((queue * p[n:n + K + 1]).sum())
    abandon = theta * exp_q / lam if lam else 0.0
    asa = exp_q / lam if lam else 0.0  # Little's law on the queue (includes people who abandon)

    down = n * mu + queue * theta  # rate the position ahead improves
    big_l = float(down[-1] + theta) * 1.02
    stay = 1 - (down + theta) / big_l
    move = down / big_l
    lt = big_l * answer
    m_max = int(lt + 10 * math.sqrt(max(lt, 1)) + 20)
    u = np.zeros(K + 1)  # u[j] = P(served within m uniformised steps | j customers ahead); u_m(-1) = 1
    s_j = np.zeros(K + 1)
    w = math.exp(-lt) if lt < 700 else 0.0  # Poisson(lt) weight of m steps
    for m in range(m_max):
        s_j += w * u
        prev = np.concatenate([[1.0], u[:-1]])
        u = stay * u + move * prev
        w = w * lt / (m + 1)
    s_j += w * u
    sl = float((1 - p_wait) + (p[n:n + K + 1] * np.clip(s_j, 0, 1)).sum())
    return min(max(sl, 0.0), 1.0), asa, min(max(abandon, 0.0), 1.0)


def _metrics(method, n, traffic, aht, answer, patience):
    if method == "erlang_a":
        return erlang_a_metrics(n, round(traffic, 2), float(aht), int(answer), int(patience))
    return erlang_c_metrics(n, traffic, aht, answer)


def solve_agents(traffic: float, aht: float, params, method: str):
    """Smallest n meeting the service level and the occupancy cap. Returns (n, sl, asa, abandon)."""
    cap = params.occupancy_cap if 0 < params.occupancy_cap <= 1 else 1.0
    return _solve(round(traffic, 1), round(aht / 10) * 10, params.service_level or 0.8, params.answer_sec or 20, cap,
                  params.patience_sec or 120, method)


@lru_cache(maxsize=50000)
def _solve(traffic, aht, target, answer, cap, patience, method):
    n_min = max(1, math.ceil(traffic / cap - 1e-9))
    n = max(n_min, math.floor(traffic) + 1)
    # walk up from the load floor; Erlang A never needs more agents than Erlang C, and both are monotonic in n
    while True:
        sl, asa, ab = _metrics(method, n, traffic, aht, answer, patience)
        if sl >= target:
            break
        n += 1
        if n > 5000:
            break
    return n, sl, asa, ab


def staff_intervals(req):
    """Requirement per (channel, day, slot). Traffic of one channel is pooled across the queues that feed it."""
    interval_min = req.interval_min or 15
    interval_sec = interval_min * 60
    shrink = min(max(req.shrinkage, 0.0), 0.9)
    params = {p.channel: p for p in req.params}
    default = next(iter(params.values()), None)

    pooled = defaultdict(lambda: [0.0, 0.0])  # (channel, day, slot) -> [volume, volume*aht]
    for i in req.inputs:
        cell = pooled[(i.channel, i.day, i.slot)]
        cell[0] += i.volume
        cell[1] += i.volume * i.aht_sec

    out = []
    async_days = defaultdict(float)  # (channel, day) -> workload seconds
    blend = defaultdict(lambda: [0.0, 0.0])  # (day, slot) -> [traffic in erlangs, contacts] for cross-skilled voice + chat
    blend_params = params.get("voice") or params.get("chat")
    for (ch, day, slot), (vol, work) in pooled.items():
        p = params.get(ch, default)
        if p is None:
            continue
        if ch in ("email", "backoffice"):
            async_days[(ch, day)] += work
            continue
        if req.blend and ch in ("voice", "chat") and blend_params is not None:
            aht = work / vol if vol > 0 else 0.0
            conc = p.concurrency if ch == "chat" and p.concurrency > 1 else 1.0
            eff = aht / (conc * CHAT_EFFICIENCY) if conc > 1 else aht
            cell = blend[(day, slot)]
            cell[0] += vol * eff / interval_sec
            cell[1] += vol
            continue
        aht = work / vol if vol > 0 else 0.0
        if vol <= 0 or aht <= 0:
            out.append(wfo_out(ch, day, slot, 0, 0, 0, 1.0, 0, 0, False))
            continue
        conc = p.concurrency if ch == "chat" and p.concurrency > 1 else 1.0
        eff_aht = aht / (conc * CHAT_EFFICIENCY) if conc > 1 else aht
        traffic = vol * eff_aht / interval_sec
        method = p.method if p.method in ("erlang_c", "erlang_a") else "erlang_c"
        n, sl, asa, ab = solve_agents(traffic, eff_aht, p, method)
        occ = traffic / n if n else 0.0
        warn = (n < 10 and traffic >= 3) or occ > 0.93  # Erlang assumptions get shaky for small pools under real load
        out.append(wfo_out(ch, day, slot, n, math.ceil(n / (1 - shrink)), occ, sl, asa, ab, warn))

    for (day, slot), (traffic, vol) in blend.items():  # one pool for voice and chat: Erlang on the combined traffic
        p = blend_params
        method = p.method if p.method in ("erlang_c", "erlang_a") else "erlang_c"
        eff = traffic * interval_sec / vol if vol > 0 else 0.0
        if traffic <= 0 or eff <= 0:
            out.append(wfo_out("voice+chat", day, slot, 0, 0, 0, 1.0, 0, 0, False))
            continue
        n, sl, asa, ab = solve_agents(traffic, eff, p, method)
        occ = traffic / n if n else 0.0
        out.append(wfo_out("voice+chat", day, slot, n, math.ceil(n / (1 - shrink)), occ, sl, asa, ab, (n < 10 and traffic >= 3) or occ > 0.93))

    by_channel = defaultdict(dict)  # channel -> {day: workload seconds}
    for (ch, day), work in async_days.items():
        by_channel[ch][day] = work
    for ch, days in by_channel.items():  # email / back office: spread each day's workload over opening hours
        p = params.get(ch, default)
        open_s, close_s = p.open_slot, p.close_slot or (24 * 60 // interval_min)
        cap = p.occupancy_cap if 0 < p.occupancy_cap <= 1 else 0.85
        slots = max(close_s - open_s, 1)
        day_capacity_sec = slots * interval_sec * cap
        emit = lambda day, n: [out.append(wfo_out(ch, day, s, n, math.ceil(n / (1 - shrink)) if n else 0, cap if n else 0, 1.0, 0, 0, False)) for s in range(open_s, open_s + slots)]
        if ch == "backoffice" and p.turnaround_hours > 24:
            # back office with a turnaround SLA longer than same-day: spread workload over the operating days the
            # window spans (a rolling trailing average) instead of requiring every day's own volume to be cleared
            # same-day, so a spike can be absorbed across the window rather than forcing peak-day staffing daily.
            ordered = sorted(days)
            hours_per_operating_day = slots * interval_min / 60
            window = max(1, round(p.turnaround_hours / hours_per_operating_day))
            for i, day in enumerate(ordered):
                lo = max(0, i - window + 1)
                avg_work = sum(days[ordered[j]] for j in range(lo, i + 1)) / (i - lo + 1)
                emit(day, math.ceil(avg_work / day_capacity_sec) if avg_work > 0 else 0)
        else:
            for day, work in days.items():
                emit(day, math.ceil(work / day_capacity_sec) if work > 0 else 0)
    out.sort(key=lambda o: (o.day, o.slot, o.channel))
    return out


def wfo_out(channel, day, slot, base, required, occupancy, sl, asa, ab, warn):
    import wfm_pb2
    finite = lambda v: 0.0 if v is None or math.isinf(v) or math.isnan(v) else float(v)
    return wfm_pb2.StaffOutput(channel=channel, day=day, slot=slot, base=base, required=required,
                               occupancy=round(finite(occupancy), 4), service_level=round(finite(sl), 4),
                               asa_sec=round(finite(asa), 1), abandon=round(finite(ab), 4), warn=warn)
