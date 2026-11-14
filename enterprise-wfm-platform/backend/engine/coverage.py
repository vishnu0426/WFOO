"""
What a shift covers, and how people with different skills are matched to what each skill needs. Shared by every solver, so the CP-SAT model, the backup solvers and the
starting roster all judge coverage the same way.
"""
from collections import defaultdict

SPD = 96     # fifteen-minute slots in a day


def is_weekend(req, weekday):
    """True when `weekday` (Monday = 0) is a weekend day. The request names them in `weekend_mask`; Saturday and Sunday when it is empty."""
    mask = req.weekend_mask or 0b1100000
    return bool((mask >> (weekday % 7)) & 1)


def unsocial_hours(req, o):
    """Whole hours of this shift that count as unsocial for fairness: its paid time when the day is a weekend day or a public holiday, otherwise nothing. Counting hours
    (not shifts) means a person given a long night on a holiday has carried more than one given a short morning."""
    if not (o.unsocial or is_weekend(req, req.first_dow + o.day)):
        return 0
    return max(1, round((o.paid_slots or o.length_slots) / 4))


def consistency_mode(default, own):
    """Same start and end every day, for one person: 0 off, 1 prefer, 2 require. The person's own setting (SchedEmployee.consist_mode: 1 off, 2 prefer, 3 require) wins over the default."""
    return {1: 0, 2: 1, 3: 2}.get(own, default)


def rest_needed(req, emp, day):
    """Slots of rest the person needs before a shift on `day` (counted from the end of the previous day's shift on the wall clock). Where the clocks change overnight the
    wall clock and the elapsed time differ by an hour, so the allowance moves with them and the rest is always real elapsed time."""
    adj = req.dst_rest_adjust[day] if 0 <= day < len(req.dst_rest_adjust) else 0
    return max(0, emp.rest_slots + adj)


def away_from_anchor(req, emp, o):
    """True when this shift is outside the tolerance of the usual start and end the person was given in the weeks solved before (see SchedEmployee.has_anchor)."""
    return bool(emp.has_anchor) and (abs(o.start_slot - emp.anchor_start) > req.start_tol_slots or abs(o.start_slot + o.length_slots - emp.anchor_end) > req.end_tol_slots)


def cover_slots(o, total, wrap):
    """Slots, counted from the start of the period, that this shift covers: the whole shift except its gap (an unpaid meal, or the break between the two halves of a split
    shift, during which the person is on shift but answers nothing). When the period repeats (`wrap`) what runs past the end is folded back onto the first slots."""
    base = o.day * SPD
    a, b = base + o.start_slot, base + o.start_slot + o.length_slots
    ga, gb = (base + o.gap_start_slot, base + o.gap_start_slot + o.gap_slots) if o.gap_slots > 0 else (0, 0)
    out = []
    for g in range(a, min(b, 2 * total if wrap else total)):
        if ga <= g < gb:
            continue
        out.append(g - total if g >= total else g)
    return out


def gap_overlap(lo, hi, o):
    """Slots of the absolute range [lo, hi) that fall inside this option's gap."""
    if o.gap_slots <= 0:
        return 0
    base = o.day * SPD
    ga, gb = base + o.gap_start_slot, base + o.gap_start_slot + o.gap_slots
    return max(0, min(hi, gb) - max(lo, ga))


def signatures(emps, skill_req):
    """Employee id -> the set of the skills asked for that this person holds."""
    return {e: frozenset(k for k in emp.skill_ids if k in skill_req) for e, emp in emps.items()}


def slot_groups(g, skill_req, sig, covering):
    """For one slot when coverage is judged per skill: what each skill still needs, and the people on shift grouped by which skills they hold.
    Returns (need_by_skill, people_by_signature) where `covering` is a list of (employee, variable) and people who hold none of the skills asked for count for nothing."""
    need = {k: skill_req[k][g] for k in skill_req if skill_req[k][g] > 0}
    by_sig = defaultdict(list)
    for e, v in covering:
        if sig[e]:
            by_sig[sig[e]].append(v)
    return need, by_sig


def generic_need(total, need):
    """DEMAND SEMANTICS, in one place (every solver, the shared evaluator and the validator use this):
      * `required` (the total) is the number of people who must be serving contacts in the slot, whatever their skills.
      * a skill requirement is the number of those people who must be serving THAT skill; a person serves one skill at a time and counts toward the skills they hold.
      * so the skills' needs are shares of the total: what is left of the total after them (`total` less their sum, never below zero) is needed from anybody on shift, skilled or not.
      * the slot's whole demand is therefore max(total, sum of the skill needs); people short = that demand less the most that a matching of people to it can meet.
    With no skill requirements the demand is just the total. Returns the people needed from anybody."""
    return max(0, total - sum(need.values()))


def unmet(need, supply, extra=0, unskilled=0):
    """The fewest people short, in total, when each person on shift serves one skill at a time. `need` is {skill: people needed}, `supply` is {frozenset(skills held): people on shift
    holding exactly those}. A maximum matching between people and skills (a small flow problem: the number of nodes is the number of skills plus the number of skill combinations).
    `extra` is the number needed from anybody (generic_need) and `unskilled` the people on shift who hold none of the skills asked for: they can only serve that part."""
    skills = [k for k, n in need.items() if n > 0]
    if not skills and extra <= 0:
        return 0
    groups = [(s, n) for s, n in supply.items() if n > 0 and (extra > 0 or any(k in s for k in skills))]
    if unskilled > 0 and extra > 0:
        groups.append((frozenset(), unskilled))
    if not groups:
        return sum(need[k] for k in skills) + max(0, extra)
    S, T = 0, 1
    gid = {i: 2 + i for i in range(len(groups))}
    kid = {k: 2 + len(groups) + j for j, k in enumerate(skills)}
    anyone = 2 + len(groups) + len(skills)
    size = anyone + 1
    cap = [defaultdict(int) for _ in range(size)]
    for i, (s, n) in enumerate(groups):
        cap[S][gid[i]] += n
        for k in skills:
            if k in s:
                cap[gid[i]][kid[k]] += n
        if extra > 0:
            cap[gid[i]][anyone] += n
    for k in skills:
        cap[kid[k]][T] += need[k]
    if extra > 0:
        cap[anyone][T] += extra
    flow = 0
    while True:                                   # shortest augmenting paths until none is left
        parent = {S: None}
        queue = [S]
        for u in queue:
            for v, c in cap[u].items():
                if c > 0 and v not in parent:
                    parent[v] = u
                    queue.append(v)
        if T not in parent:
            break
        push, v = float("inf"), T
        while parent[v] is not None:
            push = min(push, cap[parent[v]][v])
            v = parent[v]
        v = T
        while parent[v] is not None:
            u = parent[v]
            cap[u][v] -= push
            cap[v][u] += push
            v = u
        flow += push
    return sum(need[k] for k in skills) + max(0, extra) - flow
