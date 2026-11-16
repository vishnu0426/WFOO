"""Independent check of a generated schedule: hard rules per person, and coverage per interval against the forecast.

  python check_schedule_stage.py <schedule-export.json> <forecast-export.json> <runDir> <out.json>

schedule export: {"name", "from", "weeks", "stats": <app stats>, "emp": {employeeId: [number, type, weekly, maxWeekly, daysPerWeek, minRestH, maxConsec]},
                  "sh": [[employeeId, day, startSlot, lengthSlots, paidHours, [[type, startSlot, slots], ...]], ...]}
Rules checked (hard): overlap, rest between shifts >= minRest, consecutive days <= maxConsec, paid hours per pay week (Mon) <= maxWeekly,
days per pay week <= daysPerWeek, shift length within the template (4-9 h), start inside the template window (07:00-13:00, 30-min steps),
breaks/meal inside the shift, every scheduled person belongs to the group's import, no-one scheduled twice on a day.
Coverage (first 4 weeks, where the short forecast exists): on-phone people per 15-min slot (shift minus BREAK/MEAL) / net required ("base").
"""
import datetime as dt
import json
import sys
from collections import defaultdict

SCH, FC, RUN, OUT = sys.argv[1:5]


def load(p):
    raw = json.load(open(p))
    if isinstance(raw, list):
        raw = json.JSONDecoder().raw_decode(raw[0]["text"].strip())[0]
        if isinstance(raw, str):
            raw = json.loads(raw)
    return raw


s = load(SCH)
fc = load(FC)
FROM = dt.date.fromisoformat(s["from"])
dnum = lambda d: (dt.date.fromisoformat(d) - FROM).days
emp = s["emp"]
v = defaultdict(list)
by = defaultdict(list)
for row in s["sh"]:
    by[row[0]].append(row)

WIN = {"VOICE": (28, 52), "CHAT": (32, 56), "EMAIL": (24, 52), "BACKOFFICE": (32, 36)}
CHN = s.get("channel", "VOICE")
TPL_EARLY, TPL_LATE = WIN[CHN]
MIN_LEN, MAX_LEN = 16, 36
hours_week = defaultdict(float)
for eid, lst in by.items():
    if eid not in emp:
        v["person not in this group's import"].append(eid)
        continue
    num, typ, weekly, maxw, dpw, rest_h, maxc = emp[eid][:7]
    if len(emp[eid]) > 7 and emp[eid][7] in ("SUSPENDED", "TERMINATED", "LEAVE"):
        v["scheduled while " + emp[eid][7]].append(num)
    lst.sort(key=lambda r: (r[1], r[2]))
    run = 1
    weeks = defaultdict(lambda: [0.0, set()])
    for i, (e, day, st, ln, paid, acts) in enumerate(lst):
        if CHN == "BACKOFFICE" and dt.date.fromisoformat(day).weekday() >= 5:
            v["back-office shift on a weekend (template Mon-Fri)"].append(f"{num} {day}")
        if not MIN_LEN <= ln <= MAX_LEN:
            v["shift length outside template 4-9 h"].append(f"{num} {day} {ln / 4}h")
        if not (TPL_EARLY <= st <= TPL_LATE and st % 2 == 0):
            v["start outside template window/step"].append(f"{num} {day} slot {st}")
        for typ_a, ast, asl in acts or []:
            if ast < st or ast + asl > st + ln:
                v["break/meal outside shift"].append(f"{num} {day} {typ_a}")
        if i:
            p = lst[i - 1]
            if p[1] == day:
                v["two shifts on one day"].append(f"{num} {day}")
            gap = (dnum(day) * 96 + st) - (dnum(p[1]) * 96 + p[2] + p[3])
            if gap < 0:
                v["overlap"].append(f"{num} {p[1]}/{day}")
            elif gap < rest_h * 4:
                v[f"rest < minimum"].append(f"{num} {p[1]}->{day} {gap / 4}h")
            dd = dnum(day) - dnum(p[1])
            run = run + 1 if dd == 1 else (run if dd == 0 else 1)
            if run > maxc:
                v["consecutive days > max"].append(f"{num} {day} run {run}")
        w = dnum(day) // 7
        weeks[w][0] += paid if paid is not None else ln / 4 - 0.5
        weeks[w][1].add(day)
    for w, (h, ds) in weeks.items():
        if h > maxw + 0.01:
            v["weekly paid hours > max weekly"].append(f"{num} wk{w} {h}h > {maxw}")
        if len(ds) > dpw:
            v["days in pay week > days per week"].append(f"{num} wk{w} {len(ds)} > {dpw}")
        hours_week[(eid, w)] = h

# contract fit (not a hard rule: report it)
contract = {"under": 0, "exact": 0, "over": 0}
gap_hours = []
for (eid, w), h in hours_week.items():
    weekly = emp[eid][2]
    d = h - weekly
    gap_hours.append(d)
    contract["under" if d < -0.01 else "over" if d > 0.01 else "exact"] += 1

# coverage vs forecast net requirement, first 4 weeks
need = {}
for day, slot, vol, aht, base, req, sl, occ in fc["i"]:
    need[(day, slot)] = base or 0
on = defaultdict(int)
for e, day, st, ln, paid, acts in s["sh"]:
    off = set()
    for typ_a, ast, asl in acts or []:
        if typ_a in ("BREAK", "MEAL", "LUNCH"):
            off.update(range(ast, ast + asl))
    for g in range(st, st + ln):
        if g in off:
            continue
        d2 = dt.date.fromisoformat(day) + dt.timedelta(days=g // 96)
        on[(d2.strftime("%m-%d"), g % 96)] += 1
cov_req = cov_met = short = over = 0
under_slots = 0
LAST = FROM + dt.timedelta(days=7 * s["weeks"] - 1)
in_plan = lambda md: FROM <= dt.date(FROM.year + (1 if md < FROM.strftime("%m-%d") else 0), int(md[:2]), int(md[3:])) <= LAST
for k, n in need.items():
    if n <= 0 or not in_plan(k[0]):
        continue
    have = on.get(k, 0)
    cov_req += n
    cov_met += min(have, n)
    short += max(0, n - have)
    over += max(0, have - n)
    under_slots += have < n
# the app's own definition, reproduced: people on shift minus those on MEAL (short breaks count as present) vs GROSS required
gross = {(day, slot): req or 0 for day, slot, vol, aht, base, req, sl, occ in fc["i"]}
heads = defaultdict(int)
for e, day, st, ln, paid, acts in s["sh"]:
    meal = {g for t, a, n in acts or [] if t == "MEAL" for g in range(a, a + n)}
    for g in range(st, st + ln):
        if g not in meal:
            d2 = dt.date.fromisoformat(day) + dt.timedelta(days=g // 96)
            heads[(d2.strftime("%m-%d"), g % 96)] += 1
appdef = {"required": 0, "met": 0, "under": 0, "over": 0, "underIntervals": 0}
for k, n in gross.items():
    if n <= 0 or not in_plan(k[0]):
        continue
    h = heads.get(k, 0)
    appdef["required"] += n; appdef["met"] += min(h, n); appdef["under"] += max(0, n - h); appdef["over"] += max(0, h - n); appdef["underIntervals"] += h < n
appdef["coverage%"] = round(100 * appdef["met"] / appdef["required"], 2) if appdef["required"] else None
people = len(emp)
scheduled = len([e for e in by if e in emp])
active = [e for e in emp if len(emp[e]) < 8 or emp[e][7] == "ACTIVE"]
res = {"name": s["name"], "weeks": s["weeks"], "shifts": len(s["sh"]), "people": people, "peopleWithShifts": scheduled, "peopleWithoutShifts": people - scheduled, "activeWithoutShifts": len([e for e in active if e not in by]),
       "hardRuleViolations": {k: len(x) for k, x in v.items()}, "totalHardViolations": sum(len(x) for x in v.values()), "examples": {k: x[:3] for k, x in v.items()},
       "contractWeeks": contract, "avgPaidMinusContractH": round(sum(gap_hours) / len(gap_hours), 2) if gap_hours else None,
       "coverage4w": {"requiredAgentSlots": cov_req, "metAgentSlots": cov_met, "coverage%": round(100 * cov_met / cov_req, 2) if cov_req else None,
                      "shortAgentSlots": short, "overAgentSlots": over, "intervalsUnderstaffed": under_slots, "intervalsWithDemand": sum(1 for k, x in need.items() if x > 0 and in_plan(k[0]))},
       "coverageAppDefinition4w": appdef,
       "lastDay": max(r[1] for r in s["sh"]) if s["sh"] else None, "appStats": s.get("stats")}
json.dump(res, open(OUT, "w"), indent=1)
print(json.dumps({k: res[k] for k in res if k not in ("appStats", "examples")}, indent=1))
print("examples:", json.dumps(res["examples"])[:800])
