"""Smoke tests for the forecasting/staffing engine. Run: .venv\\Scripts\\python test_engine.py"""
import math
import time
from datetime import date, timedelta

import numpy as np

import forecasting
import staffing
import wfm_pb2

CURVE = [4, 3, 3, 3, 5, 12, 30, 62, 95, 118, 126, 120, 104, 110, 122, 118, 104, 86, 62, 42, 28, 18, 10, 6]
DOW = [1.15, 1.05, 1.0, 0.98, 1.08, 0.45, 0.4]


def make_queue(days=400, seed=1, scale=1.0, trend=0.0004, holiday=None, outlier=None):
    rng = np.random.default_rng(seed)
    end = date.today() - timedelta(days=1)
    q = wfm_pb2.QueueSeries(queue_id=1, name="Support", channel="voice")
    for n in range(days):
        d = end - timedelta(days=days - 1 - n)
        f = DOW[d.weekday()] * (1 + trend * n) * (1 + 0.1 * math.sin(2 * math.pi * d.timetuple().tm_yday / 365))
        if holiday and d in holiday:
            f *= 1.6
        if outlier and d == outlier:
            f *= 0.2
        total = 0
        for h in range(24):
            for s in range(4):
                v = rng.poisson(CURVE[h] * f * scale / 4 * 4) / 4
                total += v
                if n >= days - 56:
                    q.slots.add(day=d.isoformat(), slot=h * 4 + s, volume=v, aht_sec=280 + rng.normal(0, 8))
        q.daily.add(day=d.isoformat(), slot=-1, volume=total, aht_sec=280)
    return q, end


def test_forecast():
    hol = {date.today() - timedelta(days=60), date.today() - timedelta(days=200)}
    q, end = make_queue(holiday=hol, outlier=date.today() - timedelta(days=30))
    req = wfm_pb2.SeriesRequest(slots_per_day=96, model="auto", reconcile=False)
    req.queues.append(q)
    for d in sorted(hol):
        req.events.add(name="Holiday", kind="holiday", start_day=d.isoformat(), end_day=d.isoformat())
    future = date.today() + timedelta(days=7)
    req.events.add(name="Holiday", kind="holiday", start_day=future.isoformat(), end_day=future.isoformat())
    req.dates.extend((date.today() + timedelta(days=i)).isoformat() for i in range(14))
    t = time.time()
    resp = forecasting.run(req)
    print(f"forecast took {time.time() - t:.1f}s")
    fc = resp.series[0]
    print("model:", fc.model, "cleaned:", fc.cleaned_days, "sigma:", fc.sigma_rel)
    for s in fc.scores:
        print(f"  {s.model:8s} wape={s.wape:.3f} mase={s.mase:.3f} bias={s.bias:+.3f}{' <-' if s.selected else ''}")
    assert len(fc.slots) == 14 * 96
    assert fc.cleaned_days >= 3, "outlier + two events should be cleaned"
    daily = {p.day: p.volume for p in fc.daily}
    normal = np.mean([v for d, v in daily.items() if d != future.isoformat() and date.fromisoformat(d).weekday() == future.weekday()])
    assert daily[future.isoformat()] > normal * 1.2, "learned holiday uplift should lift the event day"
    assert all(s.p10 <= s.volume <= s.p90 + 1e-6 for s in fc.slots)
    day0 = [s.volume for s in fc.slots if s.day == fc.daily[0].day]
    assert abs(sum(day0) - fc.daily[0].volume) < 1.0, "interval volumes must add up to the daily forecast"
    best = min(s.mase for s in fc.scores)
    sel = next(s for s in fc.scores if s.selected)
    naive = next(s for s in fc.scores if s.model == "snaive")
    assert sel.model == "snaive" or sel.mase < naive.mase, "selected model must beat seasonal naive"
    assert sel.wape < 0.2, f"WAPE too high: {sel.wape}"


def test_event_ramp():
    ev = wfm_pb2.EventInfo(name="Sale", kind="campaign", start_day="2026-06-10", end_day="2026-06-12", uplift_pct=50, queue_id=1, lead_days=3, lag_days=2)
    assert forecasting.event_ramp(ev, date(2026, 6, 11), 1) == 1.0, "inside the event's own window is full strength"
    assert forecasting.event_ramp(ev, date(2026, 6, 6), 1) == 0.0, "before the ramp starts: no effect yet"
    assert forecasting.event_ramp(ev, date(2026, 6, 7), 1) == 0.0, "first lead day: ramp starts from 0"
    assert abs(forecasting.event_ramp(ev, date(2026, 6, 9), 1) - 2 / 3) < 1e-9, "last lead day: short of full strength"
    assert abs(forecasting.event_ramp(ev, date(2026, 6, 13), 1) - 0.5) < 1e-9, "first lag day: ramping back down"
    assert forecasting.event_ramp(ev, date(2026, 6, 14), 1) == 0.0, "last lag day: back to 0"
    assert forecasting.event_ramp(ev, date(2026, 6, 15), 1) == 0.0, "past the lag window: no effect"
    assert forecasting.event_ramp(ev, date(2026, 6, 11), 2) == 0.0, "a different queue than the event targets: no effect"
    flat = wfm_pb2.EventInfo(name="Holiday", kind="holiday", start_day="2026-06-10", end_day="2026-06-10", uplift_pct=20, queue_id=0)
    assert forecasting.event_ramp(flat, date(2026, 6, 9), 1) == 0.0 and forecasting.event_ramp(flat, date(2026, 6, 10), 1) == 1.0, \
        "lead_days=lag_days=0 (the default) is the old hard on/off behaviour"


def test_campaign_ramp_lifts_the_days_around_it():
    """A campaign with lead days should visibly lift volume on the ramp days, not just its own date. Compares a
    forecast with the event against an identical one without it, so the fixed weekday pattern cancels out and
    only the uplift ramp shows up in the ratio."""
    q, _ = make_queue()
    start = date.today() + timedelta(days=10)
    dates = [(date.today() + timedelta(days=i)).isoformat() for i in range(15)]

    req_plain = wfm_pb2.SeriesRequest(slots_per_day=0, model="auto", reconcile=False)
    req_plain.queues.append(q)
    req_plain.dates.extend(dates)
    plain = {p.day: p.volume for p in forecasting.run(req_plain).series[0].daily}

    req_ev = wfm_pb2.SeriesRequest(slots_per_day=0, model="auto", reconcile=False)
    req_ev.queues.append(q)
    req_ev.dates.extend(dates)
    req_ev.events.add(name="Big sale", kind="campaign", start_day=start.isoformat(), end_day=start.isoformat(), uplift_pct=80, lead_days=4, lag_days=0)
    lifted = {p.day: p.volume for p in forecasting.run(req_ev).series[0].daily}

    before, ramp1, ramp3 = ((start - timedelta(days=n)).isoformat() for n in (5, 3, 1))
    assert abs(lifted[before] / plain[before] - 1.0) < 1e-6, "before the ramp starts: forecast is unchanged"
    r1, r3 = lifted[ramp1] / plain[ramp1], lifted[ramp3] / plain[ramp3]
    assert 1.15 < r1 < 1.25, f"1 of 4 lead days in: expected ~+20% uplift, got {r1:.3f}"
    assert 1.55 < r3 < 1.65, f"3 of 4 lead days in: expected ~+60% uplift, got {r3:.3f}"
    assert lifted[start.isoformat()] / plain[start.isoformat()] > r3, "the event's own day is the peak, stronger than any ramp day"


def test_reconcile():
    q1, _ = make_queue(seed=1)
    q2, _ = make_queue(seed=2, scale=0.5)
    q2.queue_id, q2.name, q2.channel = 2, "Sales", "chat"
    req = wfm_pb2.SeriesRequest(slots_per_day=96, model="auto", reconcile=True)
    req.queues.extend([q1, q2])
    req.dates.extend((date.today() + timedelta(days=i)).isoformat() for i in range(7))
    resp = forecasting.run(req)
    grp = next(s for s in resp.series if s.queue_id == 0)
    parts = [s for s in resp.series if s.queue_id != 0]
    for i, gp in enumerate(grp.daily):
        assert abs(sum(p.daily[i].volume for p in parts) - gp.volume) < 0.05 * len(parts), "queues must add up to the group"


def test_erlang():
    n_c, sl_c, _, _ = staffing.solve_agents(20 * 300 / 900, 300, wfm_pb2.ChannelParams(service_level=0.8, answer_sec=20, occupancy_cap=1.0), "erlang_c")
    print("erlang c agents for 6.67 erlangs:", n_c, round(sl_c, 3))
    assert sl_c >= 0.8 and n_c >= 8
    p = wfm_pb2.ChannelParams(service_level=0.8, answer_sec=20, occupancy_cap=1.0, patience_sec=120)
    n_a, sl_a, _, ab = staffing.solve_agents(40, 300, p, "erlang_a")
    n_c, *_ = staffing.solve_agents(40, 300, p, "erlang_c")
    print("40 erlangs: erlang_c", n_c, "erlang_a", n_a, "abandon", round(ab, 3))
    assert n_a <= n_c, "Erlang A never needs more agents than Erlang C"
    # theta -> 0 must converge to Erlang C
    sl_a_inf = staffing.erlang_a_metrics(46, 40.0, 300.0, 20, 10**7)[0]
    sl_c_ref = staffing.erlang_c_metrics(46, 40.0, 300.0, 20)[0]
    assert abs(sl_a_inf - sl_c_ref) < 0.01, (sl_a_inf, sl_c_ref)


def test_staffing_channels():
    req = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.3)
    req.params.add(channel="voice", service_level=0.8, answer_sec=20, occupancy_cap=0.9, method="erlang_c")
    req.params.add(channel="chat", service_level=0.8, answer_sec=30, occupancy_cap=0.85, method="erlang_c", concurrency=3)
    req.params.add(channel="email", occupancy_cap=0.85, open_slot=32, close_slot=68)
    day = date.today().isoformat()
    req.inputs.add(channel="voice", day=day, slot=40, volume=30, aht_sec=300)
    req.inputs.add(channel="chat", day=day, slot=40, volume=30, aht_sec=600)
    req.inputs.add(channel="email", day=day, slot=-1, volume=200, aht_sec=420)
    out = staffing.staff_intervals(req)
    by = {(o.channel, o.slot): o for o in out}
    assert by[("voice", 40)].required >= by[("voice", 40)].base / 0.7 - 1
    assert by[("chat", 40)].base < 10 * 3, "chat concurrency reduces agents"
    assert by[("email", 40)].base > 0 and by[("email", 40)].required >= by[("email", 40)].base
    assert ("email", 31) not in by


def test_backoffice_turnaround_smoothing():
    """Back office with a same-day (or unset) turnaround target staffs each day for its own volume, exactly like
    email always has. A turnaround target longer than a day spreads a volume spike's required capacity across the
    operating days within that window instead of demanding peak-day staffing on the spike day alone."""
    days = [(date.today() + timedelta(days=i)).isoformat() for i in range(6)]
    volumes = [1000, 1000, 1000, 144000, 1000, 1000]  # day 3 is a big spike; AHT 1s makes volume == workload seconds

    def run(turnaround_hours):
        req = wfm_pb2.StaffingRequest(interval_min=60, shrinkage=0.0)
        kwargs = dict(channel="backoffice", occupancy_cap=1.0, open_slot=0, close_slot=8)
        if turnaround_hours is not None:
            kwargs["turnaround_hours"] = turnaround_hours
        req.params.add(**kwargs)
        for day, vol in zip(days, volumes):
            req.inputs.add(channel="backoffice", day=day, slot=-1, volume=vol, aht_sec=1)
        out = staffing.staff_intervals(req)
        by_day = {}
        for o in out:
            by_day[o.day] = o.base  # every slot in the day carries the same base for this channel
        return [by_day[d] for d in days]

    same_day = run(None)
    assert same_day == [1, 1, 1, 5, 1, 1], f"unsmoothed: each day staffed for its own volume alone, got {same_day}"

    same_day_24h = run(24)
    assert same_day_24h == same_day, "a 24h (same-day) turnaround target must behave exactly like the old email-only path"

    smoothed = run(25)  # window = round(25 / 8 operating hours) = 3 operating days
    assert smoothed[2] == 1, "the day before the spike is unaffected: the backlog has not arrived yet"
    assert smoothed[3] < same_day[3], f"the spike day itself needs less same-day capacity once smoothed, got {smoothed[3]}"
    assert smoothed[4] > same_day[4] and smoothed[5] > same_day[5], f"the days after the spike absorb some of its backlog, got {smoothed}"
    assert smoothed[3] == smoothed[4] == smoothed[5] == 2, f"the 3-operating-day window averages the spike over itself and the two days after it, got {smoothed}"


def test_blend():
    def req(blend):
        r = wfm_pb2.StaffingRequest(interval_min=15, shrinkage=0.0, blend=blend)
        r.params.add(channel="voice", service_level=0.8, answer_sec=20, occupancy_cap=0.9)
        r.params.add(channel="chat", service_level=0.8, answer_sec=20, occupancy_cap=0.9, concurrency=2)
        r.inputs.add(channel="voice", day="2026-01-05", slot=2, volume=2, aht_sec=300)
        r.inputs.add(channel="chat", day="2026-01-05", slot=2, volume=2, aht_sec=400)
        return sum(o.required for o in staffing.staff_intervals(r))
    assert req(True) < req(False), "a blended pool needs fewer agents than two separate pools at low volume"


def test_intraday():
    fc = [wfm_pb2.Point(day="2026-01-01", slot=s, volume=20, aht_sec=300) for s in range(96)]
    act = [wfm_pb2.Point(day="2026-01-01", slot=s, volume=30, aht_sec=300) for s in range(40)]
    r = forecasting.intraday(wfm_pb2.IntradayRequest(forecast=fc, actuals=act, current_slot=40))
    assert r.ratio > 1.2 and r.adjusted[0].slot == 40 and r.adjusted[0].volume > r.adjusted[-1].volume
    print("intraday ratio", r.ratio, "credibility", r.credibility)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            t = time.time()
            fn()
            print(f"PASS {name} ({time.time() - t:.1f}s)")
