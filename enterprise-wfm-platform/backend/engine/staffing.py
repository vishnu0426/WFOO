"""Staffing maths: Erlang C, Erlang A (abandonment), chat concurrency and async (email/back-office) workload."""
import math
from collections import defaultdict
from functools import lru_cache

import numpy as np
from scipy.stats import poisson

CHAT_EFFICIENCY = 0.85  # the default: concurrent chats are slower than 1/c of a single chat. A group can set its own (ChannelParams.chat_efficiency)
MAX_AGENTS = 5000       # the search for the fewest agents stops here; an interval that still misses its target is reported as TARGET_NOT_MET, never passed off as met


def chat_efficiency(params) -> float:
    """The chat efficiency in force: the group's own if it set one, else the default."""
    v = getattr(params, "chat_efficiency", 0.0) or 0.0
    return v if v > 0 else CHAT_EFFICIENCY


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
    """Kept for the legacy hourly forecast. Inputs are checked (ValueError), and the search is bounded: a target that MAX_AGENTS cannot reach raises ValueError instead of searching for ever."""
    for name, v in (("calls_per_hour", calls_per_hour), ("aht_sec", aht_sec), ("target_sl", target_sl), ("answer_sec", answer_sec)):
        if v is None or not math.isfinite(v):
            raise ValueError(f"{name} must be a number")
    if calls_per_hour < 0 or aht_sec < 0 or answer_sec < 0:
        raise ValueError("calls_per_hour, aht_sec and answer_sec cannot be negative")
    if not 0 < target_sl <= 1:
        raise ValueError("target_sl must be above 0 and at most 1")
    if calls_per_hour == 0:
        return 0
    if aht_sec == 0:
        raise ValueError("aht_sec must be above 0 when there are calls")
    traffic = calls_per_hour * aht_sec / 3600.0
    n = max(1, math.ceil(traffic))
    while n <= MAX_AGENTS:
        if n > traffic and erlang_c_metrics(n, traffic, aht_sec, answer_sec)[0] >= target_sl:
            return n
        n += 1
    raise ValueError(f"{target_sl:.0%} within {answer_sec}s cannot be reached with {MAX_AGENTS} agents for {calls_per_hour:g} calls an hour")


ERLANG_A_MAX_QUEUE = 6000


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
    # the chain is cut off K people into the queue; K grows until what lies beyond is negligible (a cut-off that is too short drops real probability and flatters the answer)
    K = int(min(ERLANG_A_MAX_QUEUE, max(40, 3 * n)))
    while True:
        k = np.arange(1, n + K + 1)
        rates = np.where(k <= n, k * mu, n * mu + (k - n) * theta)
        logp = np.concatenate([[0.0], np.cumsum(np.log(lam) - np.log(rates))])
        p = np.exp(logp - logp.max())
        p /= p.sum()
        if p[-1] < 1e-9:
            break
        if K >= ERLANG_A_MAX_QUEUE:
            if p[-1] > 1e-6:
                raise ArithmeticError(f"Erlang A with {n} agents and {traffic:g} Erlangs is not numerically reliable (probability left beyond a queue of {K}: {p[-1]:.2g})")
            break
        K = min(ERLANG_A_MAX_QUEUE, K * 2)
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
    # Poisson(lt) weight of m steps, computed in log space: exp(-lt) underflows to zero from about lt = 745 (a long answer threshold), which used to drop every term and leave
    # only the share served at once
    weights = poisson.pmf(np.arange(m_max + 1), lt)
    for m in range(m_max):
        s_j += weights[m] * u
        prev = np.concatenate([[1.0], u[:-1]])
        u = stay * u + move * prev
    s_j += weights[m_max] * u
    sl = float((1 - p_wait) + (p[n:n + K + 1] * np.clip(s_j, 0, 1)).sum())
    return min(max(sl, 0.0), 1.0), asa, min(max(abandon, 0.0), 1.0)


def _metrics(method, n, traffic, aht, answer, patience):
    if method == "erlang_a":
        return erlang_a_metrics(n, round(traffic, 2), float(aht), int(answer), int(patience))
    return erlang_c_metrics(n, traffic, aht, answer)


DEFAULT_SERVICE_LEVEL, DEFAULT_ANSWER_SEC, DEFAULT_PATIENCE_SEC, DEFAULT_ASYNC_OCCUPANCY = 0.8, 20, 120, 0.85


def targets(params):
    """The targets in force for a channel, each with the documented default where the request left it unset (0). Values that are not usable are refused by validation, never replaced."""
    return {"service_level": params.service_level or DEFAULT_SERVICE_LEVEL, "answer_sec": params.answer_sec or DEFAULT_ANSWER_SEC,
            "occupancy_cap": params.occupancy_cap if params.occupancy_cap > 0 else 1.0, "patience_sec": params.patience_sec or DEFAULT_PATIENCE_SEC}


def solve_agents(traffic: float, aht: float, params, method: str):
    """Smallest n meeting the service level and the occupancy cap. Returns (n, sl, asa, abandon, reached, note): `reached` is whether the target was met (False: the search stopped
    at MAX_AGENTS), `note` is "" or "erlang_c_fallback" when Erlang A could not be trusted and Erlang C was used."""
    t = targets(params)
    return _solve(round(traffic, 2), round(aht), t["service_level"], t["answer_sec"], t["occupancy_cap"], t["patience_sec"], method)


@lru_cache(maxsize=50000)
def _solve(traffic, aht, target, answer, cap, patience, method):
    n_min = max(1, math.ceil(traffic / cap - 1e-9))
    n = min(MAX_AGENTS, max(n_min, math.floor(traffic) + 1))
    note = ""
    # walk up from the load floor; Erlang A never needs more agents than Erlang C, and both are monotonic in n
    while True:
        try:
            sl, asa, ab = _metrics(method, n, traffic, aht, answer, patience)
        except ArithmeticError:
            method, note = "erlang_c", "erlang_c_fallback"          # Erlang A is not reliable for this load: Erlang C needs at least as many agents, so the answer is on the safe side
            continue
        if sl >= target - 1e-9:
            return n, sl, asa, ab, True, note
        if n >= MAX_AGENTS:
            return n, sl, asa, ab, False, note
        n += 1


def deadline_staffing(arrivals, interval_min, open_s, close_s, hours, cap):
    """Staff an email or back-office queue so that every message is answered within `hours` OPEN hours of arriving (a response-time target shorter than a day).

    arrivals: {(day, slot): seconds of work that arrive in that interval}. Time that counts is the opening hours: work that arrives while closed waits for the next opening. Each
    interval's work is spread evenly over the `hours` of opening time that start when it arrives, so it is finished by its deadline: the capacity needed in an interval is the sum
    of the shares of everything still due. Returns {(day, slot): (agents, seconds of work in the interval)}. Work still due after the last day given is carried by the days after it,
    which are outside this forecast, so its share past the end is not counted."""
    interval_sec = interval_min * 60
    days = sorted({d for d, _ in arrivals})
    positions = [(d, s) for d in days for s in range(open_s, close_s)]
    if not positions:
        return {}
    at = {p: i for i, p in enumerate(positions)}
    window = max(1, round(hours * 60 / interval_min))
    load = [0.0] * len(positions)
    expanded = defaultdict(float)
    for (d, s), work in arrivals.items():
        if s < 0 and close_s > open_s:                          # a daily total with no time of day: assumed to arrive evenly over the opening hours
            for k in range(open_s, close_s):
                expanded[(d, k)] += work / (close_s - open_s)
        else:
            expanded[(d, s)] += work
    for (d, s), work in expanded.items():
        if work <= 0:
            continue
        if s < open_s:
            i = at[(d, open_s)]
        elif s >= close_s:
            nxt = days.index(d) + 1
            i = at[(days[nxt], open_s)] if nxt < len(days) else len(positions) - 1       # closed for the night: it waits for the next opening
        else:
            i = at[(d, s)]
        for j in range(i, min(i + window, len(positions))):         # the part of the window past the last day given belongs to the days after it
            load[j] += work / window
    return {p: (math.ceil(load[i] / (interval_sec * cap) - 1e-9) if load[i] > 0 else 0, load[i]) for p, i in at.items()}


def staff_intervals(req):
    """Requirement per (channel, day, slot). Traffic of one channel is pooled across the queues that feed it."""
    interval_min = req.interval_min or 15
    interval_sec = interval_min * 60
    shrink = req.shrinkage            # validated to be from 0 to 0.9: never silently clamped
    params = {p.channel: p for p in req.params}
    default = next(iter(params.values()), None)

    pooled = defaultdict(lambda: [0.0, 0.0])  # (channel, day, slot) -> [volume, volume*aht]
    for i in req.inputs:
        cell = pooled[(i.channel, i.day, i.slot)]
        cell[0] += i.volume
        cell[1] += i.volume * i.aht_sec

    out = []
    async_days = defaultdict(float)  # (channel, day) -> workload seconds
    async_slots = defaultdict(lambda: defaultdict(float))  # channel -> (day, slot) -> workload seconds, for a response-time target shorter than a day
    live_slots = {i.slot for i in req.inputs if i.channel in ("voice", "chat") and i.volume > 0}   # when the live queues have contacts: people are in the building then
    blend = defaultdict(lambda: [0.0, 0.0])  # (day, slot) -> [traffic in erlangs, contacts] for cross-skilled voice + chat
    blend_params = params.get("voice") or params.get("chat")
    for (ch, day, slot), (vol, work) in pooled.items():
        p = params.get(ch, default)
        if p is None:
            continue
        if ch in ("email", "backoffice"):
            async_days[(ch, day)] += work
            async_slots[ch][(day, slot)] += work
            continue
        if req.blend and ch in ("voice", "chat") and blend_params is not None:
            aht = work / vol if vol > 0 else 0.0
            conc = p.concurrency if ch == "chat" and p.concurrency > 1 else 1.0
            eff = aht / (conc * chat_efficiency(p)) if conc > 1 else aht
            cell = blend[(day, slot)]
            cell[0] += vol * eff / interval_sec
            cell[1] += vol
            continue
        aht = work / vol if vol > 0 else 0.0
        if vol <= 0 or aht <= 0:
            out.append(wfo_out(ch, day, slot, 0, 0, 0, 1.0, 0, 0, False, status="NO_DEMAND", target=targets(p)["service_level"], met=True, limit=targets(p)["occupancy_cap"], confidence="HIGH"))
            continue
        conc = p.concurrency if ch == "chat" and p.concurrency > 1 else 1.0
        eff_aht = aht / (conc * chat_efficiency(p)) if conc > 1 else aht
        traffic = vol * eff_aht / interval_sec
        method = p.method if p.method in ("erlang_c", "erlang_a") else "erlang_c"
        n, sl, asa, ab, reached, note = solve_agents(traffic, eff_aht, p, method)
        out.append(_live_row(ch, day, slot, n, traffic, sl, asa, ab, reached, note, p, shrink))

    for (day, slot), (traffic, vol) in blend.items():  # one pool for voice and chat: Erlang on the combined traffic
        p = blend_params
        method = p.method if p.method in ("erlang_c", "erlang_a") else "erlang_c"
        eff = traffic * interval_sec / vol if vol > 0 else 0.0
        if traffic <= 0 or eff <= 0:
            out.append(wfo_out("voice+chat", day, slot, 0, 0, 0, 1.0, 0, 0, False))
            continue
        n, sl, asa, ab, reached, note = solve_agents(traffic, eff, p, method)
        out.append(_live_row("voice+chat", day, slot, n, traffic, sl, asa, ab, reached, note, p, shrink))

    by_channel = defaultdict(dict)  # channel -> {day: workload seconds}
    for (ch, day), work in async_days.items():
        by_channel[ch][day] = work
    for ch, days in by_channel.items():  # email / back office: spread each day's workload over opening hours
        p = params.get(ch, default)
        open_s, close_s = p.open_slot, p.close_slot or (24 * 60 // interval_min)
        per_hour = 60 // interval_min
        if (close_s - open_s) > 16 * per_hour:
            # an email or back-office queue that is "open" round the clock is not worked round the clock: its backlog is cleared while people are working, i.e. when the live
            # queues of the group have contacts, or in ordinary daytime hours when there are none. (A queue given shorter opening hours keeps them exactly.)
            lo, hi = (min(live_slots), max(live_slots) + 1) if live_slots else (8 * per_hour, 20 * per_hour)
            open_s, close_s = max(open_s, lo), min(close_s, hi)
            if close_s <= open_s:
                open_s, close_s = p.open_slot, p.close_slot or (24 * 60 // interval_min)
        cap = p.occupancy_cap if p.occupancy_cap > 0 else DEFAULT_ASYNC_OCCUPANCY
        slots = max(close_s - open_s, 1)
        day_capacity_sec = slots * interval_sec * cap
        if 0 < p.turnaround_hours < 24:
            # a reply-within target shorter than a day: staff each interval for the work that falls due in it, not one flat number for the whole day
            for (day, slot), (n, work) in sorted(deadline_staffing(async_slots[ch], interval_min, open_s, close_s, p.turnaround_hours, cap).items()):
                out.append(wfo_out(ch, day, slot, n, math.ceil(n / (1 - shrink)) if n else 0, cap if n else 0, 1.0, 0, 0, False, load=work / interval_sec, status="OK" if n else "NO_DEMAND", met=True, limit=cap, confidence="MEDIUM"))
            continue
        emit = lambda day, n, work=0.0: [out.append(wfo_out(ch, day, s, n, math.ceil(n / (1 - shrink)) if n else 0, cap if n else 0, 1.0, 0, 0, False, load=work / (slots * interval_sec), status="OK" if n else "NO_DEMAND", met=True, limit=cap, confidence="MEDIUM")) for s in range(open_s, open_s + slots)]
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
                emit(day, math.ceil(avg_work / day_capacity_sec) if avg_work > 0 else 0, avg_work)
        else:
            for day, work in days.items():
                emit(day, math.ceil(work / day_capacity_sec) if work > 0 else 0, work)
    out.sort(key=lambda o: (o.day, o.slot, o.channel))
    return out


def _live_row(channel, day, slot, n, traffic, sl, asa, ab, reached, note, p, shrink):
    """One voice, chat or blended interval: the agents found, and whether they really reach the target."""
    t = targets(p)
    # occupancy is the work the agents actually carry over their time: callers who gave up before an agent answered never loaded anyone. With no abandonment (Erlang C) that is
    # traffic / agents; with Erlang A it is traffic x (1 - the share who gave up) / agents
    occ = traffic * (1.0 - min(max(ab, 0.0), 1.0)) / n if n else 0.0
    warn = (n < 10 and traffic >= 3) or occ > 0.93          # Erlang assumptions get shaky for small pools under real load
    confidence = "LOW" if warn or n < 5 else "MEDIUM" if n < 30 or occ > 0.88 else "HIGH"
    status = "TARGET_NOT_MET" if not reached else "METHOD_FALLBACK" if note else "OK"
    return wfo_out(channel, day, slot, n, math.ceil(n / (1 - shrink)), occ, sl, asa, ab, warn, load=traffic, status=status, target=t["service_level"], met=reached, limit=t["occupancy_cap"], confidence=confidence)


def wfo_out(channel, day, slot, base, required, occupancy, sl, asa, ab, warn, load=0.0, status="OK", target=0.0, met=True, limit=1.0, confidence="MEDIUM"):
    import wfm_pb2
    finite = lambda v: 0.0 if v is None or math.isinf(v) or math.isnan(v) else float(v)
    return wfm_pb2.StaffOutput(channel=channel, day=day, slot=slot, base=base, required=required,
                               occupancy=round(finite(occupancy), 4), service_level=round(finite(sl), 4),
                               asa_sec=round(finite(asa), 1), abandon=round(finite(ab), 4), warn=warn,
                               offered_load_erlangs=round(finite(load), 3), target_service_level=round(finite(target), 4), target_met=bool(met), status=status,
                               occupancy_limit=round(finite(limit), 4), confidence=confidence)
