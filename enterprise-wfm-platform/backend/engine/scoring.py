"""One way of judging a roster, whichever solver produced it.

Every backend (CP-SAT, HiGHS, SCIP, the greedy start, an external one) optimises its own model, and the figures each reports about its own answer are in its own terms. To compare
two rosters, or to say how good one is, they are all given to this evaluator, which prices a chosen set of shifts from first principles with the same terms and weights as the
models use:

  under         people short of the requirement (per skill when the queues need different skills), times w_under
  over          people on shift beyond the requirement, times w_over (and a rising extra price, `heavy`, for surplus beyond the need plus two: it spreads surplus in line with demand)
  past_end      time a shift spends past the end of a period that does not repeat, as surplus
  contract_hours   paid time short of the week's contract target, times w_hours
  overtime      paid time past the full contract in a week the period covers completely, times w_overtime
  consistency   shifts away from the person's one usual start and end (people who prefer them), times w_consist; the usual times are the best ones the person could have had
  preference    minus w_pref for every shift on a preferred time
  cost          what the shifts themselves cost (a holiday the organisation would rather not staff)
  fairness      the gap between the most and least loaded person in weekend and holiday hours, times the fairness weight

Because it shares no code with any model, a disagreement between a solver's own objective and this figure is a bug in one of them, and the parity tests look for exactly that.
Hard rules (rest, days in a row, weekly maximum, one shift a day) are not priced here: a roster that breaks one is not a worse roster, it is not a roster, and it is refused by the
independent checks.
"""
from collections import defaultdict

from coverage import away_from_anchor, cover_slots, generic_need, signatures, slot_groups, unmet, unsocial_hours

SPD = 96
TERMS = ("under", "over", "heavy", "past_end", "contract_hours", "overtime", "consistency", "preference", "cost", "fairness")


class Score:
    """The business objective of a roster (lower is better) and what it is made of."""
    def __init__(self, terms):
        self.terms = {k: float(terms.get(k, 0.0)) for k in TERMS}
        self.total = sum(self.terms.values())

    def __repr__(self):
        return f"Score({self.total:g}: " + ", ".join(f"{k}={v:g}" for k, v in self.terms.items() if v) + ")"


def dominance(req):
    """Whether the price of leaving cover short is above the most the soft goals could pay one shift for it: (the largest swing in cents of a shift's soft terms, the price of a short
    slot, ok). The soft goals are the ones ranked below cover: shift consistency (a shift can be away from both its usual start and its usual end), preferences, and weekend and
    holiday fairness (a shift of up to 24 hours). They must never be worth more than one slot of uncovered demand, or the solver could rationally leave a queue short to please
    someone. Contract hours, overtime and holiday cost are priced trade-offs by design (a shift of contract hours is worth more than a slot of surplus) and are not part of this."""
    consistent = req.consistency_mode == 1 or any(e.consist_mode == 2 for e in req.employees)
    swing = max(0, req.w_pref) + (2 * req.w_consist if consistent else 0) + max(1, req.w_fair // 8) * 24 * (1 if req.w_fair > 0 else 0)
    return swing, req.w_under, (req.w_under <= 0 or req.w_under >= swing)


def chosen_indices(opts, assignments):
    """Indexes into `opts` of the shifts a response assigns."""
    by_key = {(o.employee, o.day, o.template, o.start_slot, o.length_slots): i for i, o in enumerate(opts)}
    out = set()
    for a in assignments:
        i = by_key.get((a.employee, a.day, a.template, a.start_slot, a.length_slots))
        if i is not None:
            out.add(i)
    return out


def evaluate(req, prep, chosen) -> Score:
    """Price the roster `chosen` (a set of indexes into the candidate shifts) for the request. `prep` is what every backend is given: (people, candidate shifts, per-slot need,
    carried runs, fairness already carried, slots in the period, helpers)."""
    emps, opts, required, carry, weekend_prior, total, helpers = prep
    week_offset, paid, week_target, effective_mode = helpers["week_offset"], helpers["paid"], helpers["week_target"], helpers["effective_mode"]
    from backends import ext_week
    days = req.days
    t = defaultdict(float)
    picked = [opts[i] for i in chosen]
    by_e = defaultdict(list)                                   # every candidate shift of a person (the targets are set by what they could work)
    for i, o in enumerate(opts):
        by_e[o.employee].append(i)
    mine = defaultdict(list)                                   # the chosen ones
    for o in picked:
        mine[o.employee].append(o)

    # ---- coverage
    skill_req = {s.id: list(s.required) + [0] * max(0, total - len(s.required)) for s in req.skill_requirements}
    heavy_price = max(1, req.w_over // 3)
    under = over = heavy = 0
    if skill_req:
        sig = signatures(emps, skill_req)
        on = defaultdict(lambda: defaultdict(int))             # slot -> {skills held: people on shift}
        heads = defaultdict(int)
        for o in picked:
            for g in cover_slots(o, total, req.wrap):
                heads[g] += 1
                if sig[o.employee]:
                    on[g][sig[o.employee]] += 1
        for g in range(total):
            need, _ = slot_groups(g, skill_req, sig, [])
            extra = generic_need(required[g] if g < len(required) else 0, need)
            need_tot = sum(need.values()) + extra
            if not heads.get(g) and need_tot == 0:
                continue
            skilled = sum(on[g].values()) if g in on else 0
            under += unmet(need, on[g] if g in on else {}, extra, max(0, heads.get(g, 0) - skilled))
            o_g = max(0, heads.get(g, 0) - need_tot)
            over += o_g
            heavy += max(0, o_g - need_tot - 2)
    else:
        cnt = defaultdict(int)
        for o in picked:
            for g in cover_slots(o, total, req.wrap):
                cnt[g] += 1
        for g in range(total):
            need, cv = required[g], cnt.get(g, 0)
            under += max(0, need - cv)
            o_g = max(0, cv - need)
            over += o_g
            heavy += max(0, o_g - need - 2)
    t["under"] = req.w_under * under
    t["over"] = req.w_over * over
    t["heavy"] = heavy_price * heavy
    if not req.wrap:
        t["past_end"] = sum(req.w_over * max(0, o.day * SPD + o.start_slot + o.length_slots - total) for o in picked)

    # ---- contract hours and planned overtime, week by week
    for e, emp in emps.items():
        weeks = defaultdict(list)
        for i in by_e.get(e, []):
            weeks[(week_offset(req) + opts[i].day) // 7].append(i)
        have = defaultdict(int)
        for o in mine.get(e, []):
            have[(week_offset(req) + o.day) // 7] += paid(o)
        for w, idx in weeks.items():
            done_slots, _done_days, lead = (emp.prior_week_slots, emp.prior_week_days, emp.prior_lead_days) if w == 0 else (0, 0, 0)
            xs, xd = ext_week(emp, week_offset(req)).get(w, (0, 0))
            done_slots += xs
            first = w * 7 - week_offset(req)
            n_days = min(first + 6, days - 1) - max(first, 0) + 1
            target = max(0, week_target(emp.min_week_slots, n_days + lead, [paid(opts[i]) for i in idx], emp.max_days_week, emp.max_week_slots) - done_slots)
            if target > 0 and req.w_hours > 0:
                t["contract_hours"] += req.w_hours * max(0, target - have[w])
            if req.w_overtime > 0 and emp.min_week_slots > 0 and n_days + lead >= 7 and idx:
                t["overtime"] += req.w_overtime * max(0, have[w] + done_slots - emp.min_week_slots)

    # ---- consistency: people who prefer one usual start and end; the usual times are whatever suits their chosen shifts best
    for e, emp in emps.items():
        mode = effective_mode(req, emp)
        shifts = mine.get(e, [])
        if mode != 1 or not shifts:
            continue
        for key, tol in (("start", req.start_tol_slots), ("end", req.end_tol_slots)):
            val = (lambda o: o.start_slot) if key == "start" else (lambda o: o.start_slot + o.length_slots)
            anchors = {val(opts[i]) for i in by_e.get(e, [])}
            off = len(shifts)                                  # no usual time at all: every shift is away from it
            for a in anchors:
                off = min(off, sum(1 for o in shifts if abs(val(o) - a) > tol))
            t["consistency"] += req.w_consist * off
        t["consistency"] += req.w_consist * sum(1 for o in shifts if away_from_anchor(req, emp, o))

    # ---- preferences and what the shifts cost
    if req.w_pref:
        t["preference"] = -req.w_pref * sum(o.preference for o in picked if o.preference)
    t["cost"] = sum(o.cost for o in picked if o.cost)

    # ---- fairness in weekend and holiday hours
    if req.w_fair > 0:
        loads = {}
        for e in emps:
            if any(unsocial_hours(req, opts[i]) for i in by_e.get(e, [])):
                loads[e] = weekend_prior.get(e, 0) + sum(unsocial_hours(req, o) for o in mine.get(e, []))
        if len(loads) > 1:
            t["fairness"] = max(1, req.w_fair // 8) * (max(loads.values()) - min(loads.values()))
    return Score(t)


def attach(req, prep, response):
    """Record the business objective of a response's roster on the response itself, whichever backend made it."""
    if response.status not in ("OPTIMAL", "FEASIBLE"):
        return None
    s = evaluate(req, prep, chosen_indices(prep[1], response.assignments))
    response.score, response.scored = s.total, True
    del response.score_terms[:]
    for k, v in s.terms.items():
        if v:
            response.score_terms.add(name=k, value=round(v, 4))
    return s
