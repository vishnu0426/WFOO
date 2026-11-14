"""Email and back-office queues with a reply-within target shorter than a day: staffed so every message is answered inside it."""
import math
import random
from datetime import date, timedelta

import staffing
import wfm_pb2

IV = 60                      # minutes per interval
OPEN, CLOSE = 8, 16          # open 08:00 to 16:00


def _req(arrivals, hours, channel="email", cap=1.0):
    req = wfm_pb2.StaffingRequest(interval_min=IV, shrinkage=0.0)
    kw = dict(channel=channel, occupancy_cap=cap, open_slot=OPEN, close_slot=CLOSE)
    if hours is not None:
        kw["turnaround_hours"] = hours
    req.params.add(**kw)
    for (day, slot), work in arrivals.items():
        req.inputs.add(channel=channel, day=day, slot=slot, volume=work, aht_sec=1)       # aht 1 s: volume is seconds of work
    return req


def _agents(req):
    return {(o.day, o.slot): o.base for o in staffing.staff_intervals(req)}


def _everyone_answered_in_time(arrivals, agents, hours, cap=1.0):
    """Serve in arrival order with the capacity the staffing gives; every message must be finished within `hours` open hours of arriving. Work whose deadline falls after the last day
    given is only held to the part that falls inside (the days after it carry the rest)."""
    days = sorted({d for d, _ in agents})
    positions = [(d, s) for d in days for s in range(OPEN, CLOSE)]
    index = {p: i for i, p in enumerate(positions)}
    cap_left = [agents.get(p, 0) * IV * 60 * cap for p in positions]
    window = round(hours * 60 / IV)

    def start(d, s):
        if s >= CLOSE:
            nxt = days.index(d) + 1
            return index[(days[nxt], OPEN)] if nxt < len(days) else len(positions) - 1
        return index[(d, max(s, OPEN))]
    for (d, s), work in sorted(arrivals.items(), key=lambda kv: start(*kv[0])):
        i = start(d, s)
        inside = min(window, len(positions) - i)
        work = work * inside / window
        for j in range(i, i + inside):
            take = min(work, cap_left[j])
            cap_left[j] -= take
            work -= take
            if work <= 1e-6:
                break
        if work > 1e-6:
            return False
    return True


def test_a_burst_is_staffed_in_the_hours_it_falls_due_not_all_day():
    d = date.today().isoformat()
    arrivals = {(d, 10): 4 * 3600.0}                          # four agent-hours of mail arrive at 10:00
    a = _agents(_req(arrivals, 2))
    assert a[(d, 10)] == 2 and a[(d, 11)] == 2, a            # 4 hours of work due within 2 hours: two agents for two intervals
    assert all(a[(d, s)] == 0 for s in range(OPEN, 10)) and all(a[(d, s)] == 0 for s in range(12, CLOSE))
    same_day = _agents(_req(arrivals, None))
    assert set(same_day.values()) == {1}, same_day              # without a target the same four hours are one flat agent all day


def test_every_message_is_answered_inside_the_target():
    rnd = random.Random(5)
    days = [(date.today() + timedelta(days=i)).isoformat() for i in range(3)]
    arrivals = {(d, s): rnd.uniform(0, 5000) for d in days for s in range(OPEN - 2, CLOSE + 2)}     # includes mail arriving before opening and after closing
    for hours in (1, 2, 4, 8):
        agents = _agents(_req(arrivals, hours))
        assert _everyone_answered_in_time(arrivals, agents, hours), f"a {hours}-hour target was missed"


def test_a_tighter_target_needs_at_least_as_many_people():
    rnd = random.Random(9)
    d = date.today().isoformat()
    arrivals = {(d, s): rnd.uniform(500, 6000) for s in range(OPEN, CLOSE)}
    totals = [sum(_agents(_req(arrivals, h)).values()) for h in (1, 2, 4, 8)]
    assert totals == sorted(totals, reverse=True), totals


def test_mail_that_arrives_overnight_waits_for_the_next_opening():
    d0 = date.today()
    d1 = d0 + timedelta(days=1)
    arrivals = {(d0.isoformat(), 20): 3600.0, (d1.isoformat(), 12): 1.0}      # one agent-hour at 20:00, after closing; a little mail the next day so that day is in the forecast
    a = _agents(_req(arrivals, 1))
    assert a[(d1.isoformat(), 8)] == 1 and a[(d0.isoformat(), 15)] == 0, a


def test_a_daily_total_is_assumed_to_arrive_evenly_over_the_open_hours():
    d = date.today().isoformat()
    a = _agents(_req({(d, -1): 8 * 3600.0}, 2))               # eight agent-hours over an eight-hour day, no time of day known
    assert set(a.values()) == {1}, a


def test_a_day_target_or_none_is_exactly_the_old_behaviour():
    d = date.today().isoformat()
    arrivals = {(d, 10): 4 * 3600.0}
    assert _agents(_req(arrivals, None)) == _agents(_req(arrivals, 24))
    assert set(_agents(_req(arrivals, 24)).values()) == {1}   # four hours of work over an eight-hour day: one agent all day


def test_back_office_under_a_day_uses_the_same_rule():
    d = date.today().isoformat()
    a = _agents(_req({(d, 10): 4 * 3600.0}, 2, channel="backoffice"))
    assert a[(d, 10)] == 2 and a[(d, 11)] == 2


def test_occupancy_cap_is_respected():
    d = date.today().isoformat()
    a = _agents(_req({(d, 10): 4 * 3600.0}, 2, cap=0.8))      # at 80% occupancy 4 hours of work needs 2.5 agent-hours per hour: three agents
    assert a[(d, 10)] == 3
