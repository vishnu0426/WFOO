"""
Checks on a schedule request before the solver sees it. A request the gateway builds is always consistent, but the engine is a network service: a bad value that reaches the
model would end as an obscure crash in a solver library, or worse as a schedule that looks fine and is wrong. Every problem is named, with the first few listed.
"""
import os
import re

SPD = 96
MAX_DAYS = int(os.environ.get("ENGINE_MAX_DAYS", "400"))
MAX_EMPLOYEES = int(os.environ.get("ENGINE_MAX_EMPLOYEES", "20000"))
MAX_TIME_LIMIT = int(os.environ.get("ENGINE_MAX_TIME_LIMIT_SEC", "3600"))
MAX_SHIFT_SLOTS = 2 * SPD                       # a shift is never longer than 48 hours
MAX_SKILLS = int(os.environ.get("ENGINE_MAX_SKILLS", "64"))
BACKEND_NAME = re.compile(r"^[A-Za-z0-9_,\- ]{0,100}$")


class InvalidRequest(ValueError):
    """The request cannot be solved as sent; the message says why."""


STAFF_CHANNELS = ("voice", "chat", "email", "backoffice")
MAX_STAFF_INPUTS = int(os.environ.get("ENGINE_MAX_STAFF_INPUTS", "300000"))


MAX_QUEUES = int(os.environ.get("ENGINE_MAX_QUEUES", "256"))
MAX_HISTORY_DAYS = int(os.environ.get("ENGINE_MAX_HISTORY_DAYS", "1830"))        # five years of daily history per queue
MAX_HORIZON_DAYS = int(os.environ.get("ENGINE_MAX_HORIZON_DAYS", "800"))         # a two-year forecast and a little over
MAX_SIM_REPLICATIONS = int(os.environ.get("ENGINE_MAX_SIM_REPLICATIONS", "500"))
MODEL_NAMES = ("", "auto", "snaive", "wavg", "ets", "gbm", "combo", "croston", "sarima", "arima", "lstm")


def validate_validate_request(req):
    """Limits on a validation request: it is cheap per shift, but not free, and a request for millions of shifts is refused up front."""
    errs = []
    if not 1 <= req.days <= MAX_DAYS:
        errs.append(f"days must be between 1 and {MAX_DAYS} (got {req.days})")
    if not 0 <= req.first_dow <= 6:
        errs.append("first_dow must be 0 (Monday) to 6 (Sunday)")
    if len(req.employees) > MAX_EMPLOYEES:
        errs.append(f"{len(req.employees):,} people is more than one validation can take ({MAX_EMPLOYEES:,})")
    if len(req.shifts) > 3_000_000 or len(req.commitments) > 3_000_000:
        errs.append("more than 3,000,000 shifts or commitments in one validation")
    ids = [e.limits.id for e in req.employees]
    if len(set(ids)) != len(ids):
        errs.append("two people have the same id")
    if not 0 <= req.target_coverage <= 1:
        errs.append("target_coverage must be from 0 to 1")
    if errs:
        raise InvalidRequest("; ".join(errs))


def validate_series_request(req):
    """Limits on a forecast request: queues, history, horizon and events. A forecast of thousands of queues or decades of history is refused up front, not discovered by running out of memory."""
    import math
    errs = []
    bad = errs.append
    if len(req.queues) > MAX_QUEUES:
        bad(f"{len(req.queues)} queues is more than one forecast request can take ({MAX_QUEUES})")
    if not 1 <= len(req.dates) <= MAX_HORIZON_DAYS:
        bad(f"the forecast must cover from 1 to {MAX_HORIZON_DAYS} days (got {len(req.dates)})")
    if req.slots_per_day not in (0, 24, 48, 96):
        bad(f"slots_per_day must be 0 (daily only), 24, 48 or 96 (got {req.slots_per_day})")
    if req.model not in MODEL_NAMES:
        bad(f"unknown model '{req.model}'")
    if len(req.events) > 5000:
        bad(f"{len(req.events)} events is more than one forecast request can take (5,000)")
    total = 0
    for q in req.queues:
        if len(q.daily) > MAX_HISTORY_DAYS:
            bad(f"queue {q.queue_id}: {len(q.daily)} days of history is more than the {MAX_HISTORY_DAYS} the forecast uses")
        if len(q.slots) > MAX_HISTORY_DAYS * 96:
            bad(f"queue {q.queue_id}: {len(q.slots)} interval rows is more than a forecast can take")
        total += len(q.daily) + len(q.slots)
        if any(not math.isfinite(p.volume) or p.volume < 0 for p in q.daily):
            bad(f"queue {q.queue_id}: daily history has a negative or non-numeric volume")
        if len(errs) >= 10:
            break
    if total > 3_000_000:
        bad("more than 3,000,000 rows of history in one request")
    if errs:
        raise InvalidRequest("; ".join(errs[:6]))


def validate_intraday_request(req):
    errs = []
    if len(req.forecast) > 96 * 2 or len(req.actuals) > 96 * 2:
        errs.append("an intraday reforecast covers one day (at most 192 rows)")
    if not 0 <= req.current_slot <= 96:
        errs.append(f"current_slot must be from 0 to 96 (got {req.current_slot})")
    if errs:
        raise InvalidRequest("; ".join(errs))


def validate_sim_request(req):
    import math
    errs = []
    spd = req.slots_per_day or 96
    if not 1 <= len(req.intervals) <= 96 * 60:
        errs.append(f"a simulation covers from 1 interval to 60 days of 15 minutes (got {len(req.intervals)})")
    if not 1 <= spd <= 1440 or 86400 % spd:
        errs.append(f"slots_per_day must divide the day evenly (got {spd})")
    if req.interval_sec and not 60 <= req.interval_sec <= 3600:
        errs.append(f"interval_sec must be from 60 to 3600 (got {req.interval_sec})")
    if req.replications < 0 or req.replications > MAX_SIM_REPLICATIONS:
        errs.append(f"replications must be from 1 to {MAX_SIM_REPLICATIONS} (got {req.replications}); leave it out for the default")
    if not math.isfinite(req.volume_cv) or not 0 <= req.volume_cv <= 2:
        errs.append("volume_cv (the forecast error) must be from 0 to 2")
    if not 0 <= req.answer_sec <= 7200 or not -1 <= req.patience_sec <= 86400:
        errs.append("answer_sec must be from 0 to 7,200 and patience_sec from 0 to 86,400 (or -1: nobody gives up)")
    if any(not math.isfinite(i.volume) or i.volume < 0 or not math.isfinite(i.aht_sec) or i.aht_sec < 0 or not math.isfinite(i.agents) or i.agents < 0 for i in req.intervals):
        errs.append("volume, handle time and agents must be numbers that are not negative")
    if errs:
        raise InvalidRequest("; ".join(errs))


def validate_staffing_request(req):
    """Refuse a staffing request that cannot be answered as sent, saying why. Nothing is silently replaced by a default or a clamp: an occupancy of 130%, a shrinkage of 100% or a
    channel with no parameters is an error the caller can fix, not a number quietly changed. Unset (0) targets are the documented defaults (see staffing.targets)."""
    import math
    errs = []
    bad = errs.append
    finite = lambda v: isinstance(v, (int, float)) and math.isfinite(v)
    if req.interval_min not in (0, 5, 10, 15, 20, 30, 60):
        bad(f"interval_min must be 5, 10, 15, 20, 30 or 60 (got {req.interval_min})")
    slots = 1440 // (req.interval_min or 15)
    if not finite(req.shrinkage) or not 0 <= req.shrinkage <= 0.9:
        bad(f"shrinkage must be from 0 to 0.9 (got {req.shrinkage:g}): at 100% no number of agents is enough")
    if len(req.inputs) > MAX_STAFF_INPUTS:
        bad(f"{len(req.inputs):,} intervals is more than one request can take ({MAX_STAFF_INPUTS:,})")
    if len(req.params) > 8:
        bad("more than 8 channel parameter sets")
    channels = set()
    for p in req.params:
        if p.channel not in STAFF_CHANNELS:
            bad(f"unknown channel '{p.channel}'")
        elif p.channel in channels:
            bad(f"channel '{p.channel}' has two parameter sets")
        channels.add(p.channel)
        if not finite(p.service_level) or not 0 <= p.service_level <= 1:
            bad(f"{p.channel}: the service level target must be above 0 and at most 1 (got {p.service_level:g}); leave it out for the default of 80%")
        if p.answer_sec < 0 or p.answer_sec > 7200:
            bad(f"{p.channel}: the answer threshold must be from 0 to 7,200 seconds")
        if not finite(p.occupancy_cap) or p.occupancy_cap < 0 or p.occupancy_cap > 1 or 0 < p.occupancy_cap < 0.3:
            bad(f"{p.channel}: the occupancy limit must be from 30% to 100% (got {p.occupancy_cap:g}); leave it out for no limit (live work) or 85% (email and back office)")
        if p.method not in ("", "erlang_c", "erlang_a"):
            bad(f"{p.channel}: method must be erlang_c or erlang_a (got '{p.method}')")
        if p.patience_sec < 0 or p.patience_sec > 86400:
            bad(f"{p.channel}: patience must be from 0 to 86,400 seconds")
        if not finite(p.concurrency) or p.concurrency < 0 or p.concurrency > 20:
            bad(f"{p.channel}: concurrency must be from 1 to 20 conversations at once")
        if not finite(p.chat_efficiency) or p.chat_efficiency < 0 or (0 < p.chat_efficiency < 0.3) or p.chat_efficiency > 1:
            bad(f"{p.channel}: chat efficiency must be from 0.3 to 1 (got {p.chat_efficiency:g}); leave it out for the default of 0.85")
        if p.open_slot < 0 or p.open_slot > slots or p.close_slot < 0 or p.close_slot > slots or (p.close_slot and p.close_slot <= p.open_slot):
            bad(f"{p.channel}: opening hours must lie within the day ({slots} slots) and end after they start")
        if p.turnaround_hours < 0 or p.turnaround_hours > 720:
            bad(f"{p.channel}: turnaround must be from 0 to 720 hours")
    for n, i in enumerate(req.inputs):
        if i.channel not in STAFF_CHANNELS:
            bad(f"interval {n}: unknown channel '{i.channel}'")
        elif i.channel not in channels:
            bad(f"interval {n}: channel '{i.channel}' has no parameters, so it would be staffed to another channel's targets")
        if not i.day:
            bad(f"interval {n}: no day")
        if not 0 <= i.slot < slots:
            bad(f"interval {n}: slot {i.slot} is outside the day (0 to {slots - 1})")
        if not finite(i.volume) or i.volume < 0 or i.volume > 1e7:
            bad(f"interval {n}: volume must be from 0 to 10,000,000")
        if not finite(i.aht_sec) or i.aht_sec < 0 or i.aht_sec > 86400:
            bad(f"interval {n}: handle time must be from 0 to 86,400 seconds")
        if len(errs) >= 20:
            break
    if errs:
        more = f" (and {len(errs) - 6} more)" if len(errs) > 6 else ""
        raise InvalidRequest("; ".join(errs[:6]) + more)


def validate_schedule_request(req, max_options):
    errs = []

    def bad(msg):
        errs.append(msg)

    import scoring
    swing, price, ok = scoring.dominance(req)
    if not ok:
        bad(f"the weights let consistency, preferences or fairness outweigh cover: one shift can gain up to {swing} from them but a slot of uncovered demand costs only {price}. "
            f"Raise the cost of understaffing to at least {swing}, or lower those weights")

    if not 1 <= req.days <= MAX_DAYS:
        bad(f"days must be between 1 and {MAX_DAYS} (got {req.days})")
    if not 0 <= req.first_dow <= 6:
        bad(f"first_dow must be 0 (Monday) to 6 (Sunday) (got {req.first_dow})")
    if not 0 <= req.week_start <= 6:
        bad(f"week_start must be 0 to 6 (got {req.week_start})")
    if not 0 <= req.weekend_mask <= 127:
        bad(f"weekend_mask must be between 0 and 127 (got {req.weekend_mask})")
    if not 0 <= req.time_limit_sec <= MAX_TIME_LIMIT:
        bad(f"time_limit_sec must be between 0 and {MAX_TIME_LIMIT} (got {req.time_limit_sec})")
    if not 0 <= req.workers <= 64:
        bad(f"workers must be between 0 and 64 (got {req.workers})")
    for name in ("w_under", "w_over", "w_hours", "w_fair", "w_consist"):
        if getattr(req, name) < 0:
            bad(f"{name} cannot be negative (got {getattr(req, name)})")
    if not 0 <= req.start_tol_slots <= SPD or not 0 <= req.end_tol_slots <= SPD:
        bad("start_tol_slots and end_tol_slots must be between 0 and 96")
    if req.wrap and req.days > 7:
        bad("wrap (the period repeats) is only possible for a period of one week or less: a longer period is solved a week at a time, and a week cannot be told to repeat when the next one is different")
    if not BACKEND_NAME.match(req.backend or ""):
        bad("backend contains characters a solver name cannot have")
    slots = max(req.days, 0) * SPD
    if len(req.required) > slots:
        bad(f"required has {len(req.required)} values but {req.days} days have {slots} slots")
    if any(v < 0 for v in req.required):
        bad("required cannot contain a negative number of people")

    if not 1 <= len(req.employees) <= MAX_EMPLOYEES:
        bad(f"a request needs between 1 and {MAX_EMPLOYEES:,} employees (got {len(req.employees):,})")
    for mo in req.weekend_months:
        if any(not 0 <= d < req.days for w in mo.weekends for d in w.days):
            bad("a weekend in weekend_months has a day outside the period")
    ids = set()
    for e in req.employees:
        if e.id <= 0:
            bad(f"employee id must be positive (got {e.id})")
        elif e.id in ids:
            bad(f"employee id {e.id} appears twice")
        ids.add(e.id)
        for name in ("max_week_slots", "min_week_slots", "max_consecutive", "rest_slots", "max_days_week", "prior_run", "prior_week_slots", "prior_week_days", "prior_lead_days", "prior_weekend", "min_days_off_together"):
            if getattr(e, name) < 0:
                bad(f"employee {e.id}: {name} cannot be negative")
        if e.min_days_off_together > 7:
            bad(f"employee {e.id}: min_days_off_together cannot be above 7")
        if len(e.weekend_need) > len(req.weekend_months):
            bad(f"employee {e.id}: weekend_need has more entries than the request has months")
        if any(n < 0 or n > 5 for n in e.weekend_need):
            bad(f"employee {e.id}: weekend_need must be between 0 and 5")
        if e.max_week_slots and e.min_week_slots > e.max_week_slots:
            bad(f"employee {e.id}: the contract minimum ({e.min_week_slots} slots) is above the weekly maximum ({e.max_week_slots})")
        if e.max_days_week > 7:
            bad(f"employee {e.id}: max_days_week cannot be above 7")
        if e.rest_slots > 3 * SPD:
            bad(f"employee {e.id}: rest of more than 72 hours is not a rest period")
        if len(e.ext_paid) > max(req.days, 0):
            bad(f"employee {e.id}: ext_paid has more days than the request")
        if any(k <= 0 for k in e.skill_ids):
            bad(f"employee {e.id}: skill ids must be positive")
        if len(errs) >= 20:
            break

    skill_ids = set()
    for sk in req.skill_requirements:
        if sk.id <= 0 or sk.id in skill_ids:
            bad(f"skill requirement id {sk.id} is not a unique positive number")
        skill_ids.add(sk.id)
        if len(sk.required) > slots or any(v < 0 for v in sk.required):
            bad(f"skill {sk.id}: its requirement has more values than the period has slots, or a negative one")
    if len(skill_ids) > MAX_SKILLS:
        bad(f"more than {MAX_SKILLS} skills with a requirement")
    if req.skill_requirements and len(req.required):
        # the people needed per skill are shares of the total: at no slot may the skills together ask for more than the total (a person per skill of rounding aside)
        allow = len(req.skill_requirements)
        for g in range(min(slots, max(len(sk.required) for sk in req.skill_requirements))):
            want = sum(sk.required[g] for sk in req.skill_requirements if g < len(sk.required))
            have = req.required[g] if g < len(req.required) else 0
            if want > have + allow:
                bad(f"slot {g}: the skills together ask for {want} people but the total requirement is {have}")
                break

    if len(req.options) > max_options:
        bad(f"{len(req.options):,} candidate shifts is more than the solver can take ({max_options:,})")
    elif not errs or len(errs) < 20:
        for n, o in enumerate(req.options):
            if o.employee not in ids:
                bad(f"option {n}: employee {o.employee} is not in the request")
            elif not 0 <= o.day < max(req.days, 1):
                bad(f"option {n}: day {o.day} is outside the period of {req.days} days")
            elif not 0 <= o.start_slot < SPD:
                bad(f"option {n}: start_slot {o.start_slot} is not a slot of the day (0 to 95)")
            elif not 1 <= o.length_slots <= MAX_SHIFT_SLOTS:
                bad(f"option {n}: a shift of {o.length_slots} slots is empty or longer than 48 hours")
            elif not 0 <= o.paid_slots <= o.length_slots:
                bad(f"option {n}: paid_slots {o.paid_slots} is more than the shift's {o.length_slots} slots")
            elif not -1 <= o.preference <= 1:
                bad(f"option {n}: preference must be -1, 0 or 1")
            elif o.template < 0:
                bad(f"option {n}: template cannot be negative")
            elif o.gap_slots < 0 or o.gap_start_slot < 0:
                bad(f"option {n}: the gap cannot be negative")
            elif o.gap_slots > 0 and not (o.start_slot <= o.gap_start_slot and o.gap_start_slot + o.gap_slots <= o.start_slot + o.length_slots):
                bad(f"option {n}: the gap ({o.gap_slots} slots from slot {o.gap_start_slot}) is not inside the shift")
            if len(errs) >= 20:
                break

    if errs:
        more = "" if len(errs) < 20 else " (and possibly more)"
        raise InvalidRequest("; ".join(errs[:6]) + more)
