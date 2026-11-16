"""Independent check of several groups' published 4-week forecasts (one per channel), using wfm_math.py.

  python check_forecast_multi.py <export.txt> <runDir> <outDir>

Expected staffing per channel (the method the application documents for each channel, recomputed here from first principles):
  VOICE       net = smallest N with Erlang C SL >= 80 % in 20 s and A/N <= 85 %, A = volume * AHT / 900
  CHAT        the same on an effective handle time AHT / (concurrency 2 * efficiency 0.85)
  EMAIL       24 h reply target: net per open slot = ceil(day workload / (open slots * 900 s * 85 %)), flat over the slots it is worked
  BACKOFFICE  48 h target: as email, on the average workload of the last round(48 h / open hours per day) days in the forecast
  every       gross = ceil(net / (1 - 30 %)) — reported with and without the float-error rule of MATH-01
"""
import csv
import datetime as dt
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wfm_math as M  # noqa: E402

SRC, RUN, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
raw = json.loads(SRC.read_text())
if isinstance(raw, list):
    raw = json.JSONDecoder().raw_decode(raw[0]["text"].strip())[0]
if isinstance(raw, str):
    raw = json.JSONDecoder().raw_decode(raw.strip())[0]
SL, T, OCC, SHR, IV, CONC, EFF = 0.80, 20, 0.85, 0.30, 900, 2, 0.85
rows, summary, acc = [], {}, {}


def rec(group, check, key, expected, actual, tol=0):
    ok = expected is not None and actual is not None and abs(expected - actual) <= tol
    rows.append({"group": group, "check": check, "key": key, "expected": expected, "actual": actual, "result": "PASS" if ok else "FAIL"})
    s = summary.setdefault(group, {}).setdefault(check, [0, 0])
    s[0 if ok else 1] += 1


for gname, g in raw.items():
    ch = g["channel"]
    if ch in ("VOICE", "CHAT"):
        for day, slot, vol, aht, base, req, sl, occ in g["i"]:
            if not vol or vol <= 0:
                continue
            eff = aht / (CONC * EFF) if ch == "CHAT" else aht
            a = round(vol * eff / IV, 2)
            if a == 0:
                continue                      # OBS-02: the app staffs 1 for any volume
            exp = M.required_agents(a * IV / round(eff), round(eff), IV, SL, T, max_occupancy=OCC)
            rec(gname, f"{ch} net agents (Erlang C{' on AHT/(2*0.85)' if ch == 'CHAT' else ''})", f"{day} {slot}", exp, base)
            rec(gname, "gross = ceil(net/0.7) exact", f"{day} {slot}", math.ceil(base / (1 - SHR) - 1e-9), req)
            rec(gname, f"{ch} service level at net", f"{day} {slot}", round(M.service_level(base, a, round(eff), T), 2), sl, 0.011)
    else:
        work = defaultdict(float)
        staffed = defaultdict(dict)
        for day, slot, vol, aht, base, req, sl, occ in g["i"]:
            work[day] += (vol or 0) * (aht or 0)
            staffed[day][slot] = (base, req)
        days = sorted({d[0] for d in g["d"]})
        open_slots = 48                       # 08:00-20:00: a 24 h queue in a group with no live channel is worked in daytime hours
        cap = open_slots * IV * OCC
        window = max(1, round(48 / (open_slots * IV / 3600))) if ch == "BACKOFFICE" else 1
        for i, day in enumerate(days):
            lo = max(0, i - window + 1)
            avg = sum(work[days[j]] for j in range(lo, i + 1)) / (i - lo + 1)
            exp = math.ceil(avg / cap) if avg > 0 else 0
            got = {b for b, r in staffed[day].values()} or {0}
            slots_used = sorted(s for s, (b, r) in staffed[day].items() if b > 0)
            rec(gname, f"{ch} net per slot = ceil(workload/capacity){' (4-day rolling avg)' if window > 1 else ''}", day, exp, max(got))
            if exp:
                rec(gname, f"{ch} worked 08:00-20:00 (slots 32-79)", day, 1, int(slots_used[:1] == [32] and slots_used[-1:] == [79] and len(slots_used) == 48))
                rec(gname, "gross = ceil(net/0.7) exact", day, math.ceil(exp / (1 - SHR) - 1e-9), max(r for b, r in staffed[day].values()))
    # roll-ups
    by_day = defaultdict(float)
    for day, slot, vol, *_ in g["i"]:
        by_day[day] += vol or 0
    for day, vol, *_ in g["d"]:
        rec(gname, "day = sum of 15-min", day, round(by_day[day], 2), vol, 0.05 + 1e-6 * vol)
    dmap = {d[0]: d[1] for d in g["d"]}
    for wk, vol in g["w"]:
        st = dt.date.fromisoformat(wk)
        rec(gname, "week = sum of days", wk, round(sum(dmap.get((st + dt.timedelta(i)).strftime("%m-%d"), 0) for i in range(7)), 2), vol, 0.05)
    # accuracy vs held-back days and truth
    q = gname + "-Q"
    hold, truth = defaultdict(float), defaultdict(float)
    for r in csv.DictReader(open(RUN / f"holdout_{q}.csv")):
        hold[r["date"][5:]] += int(r["offered"])
    for r in csv.DictReader(open(RUN / f"truth_{q}.csv")):
        if r["split"] == "holdout":
            truth[r["date"][5:]] += float(r["expected_offered"])
    common = [d for d in dmap if d in hold]
    acc[gname] = {"channel": ch, "model": g.get("model"), "days": len(common)}
    for label, ref in (("vsActual", hold), ("vsTruth", truth)):
        A_ = [ref[d] for d in common]
        F_ = [dmap[d] for d in common]
        if sum(A_) == 0:
            continue
        acc[gname][label] = {"WAPE%": round(M.wape(A_, F_), 2), "MAPE%": round(M.mape(A_, F_)[0], 2) if M.mape(A_, F_)[0] is not None else None,
                             "MAE": round(M.mae(A_, F_), 1), "RMSE": round(M.rmse(A_, F_), 1), "bias%": round(M.bias(A_, F_), 2)}

OUT.mkdir(parents=True, exist_ok=True)
with open(OUT / "forecast_checks_multi.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
json.dump({"summary": summary, "accuracy": acc}, open(OUT / "forecast_multi_summary.json", "w"), indent=1)
for gname, s in summary.items():
    print(gname, {k: f"{v[0]} pass / {v[1]} fail" for k, v in s.items()})
print(json.dumps(acc, indent=1))
fails = [r for r in rows if r["result"] == "FAIL" and "gross" not in r["check"]][:10]
for r in fails:
    print("FAIL", r)
