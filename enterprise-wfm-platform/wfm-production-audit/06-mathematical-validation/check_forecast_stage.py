"""Independent check of one stage's published forecast, using wfm_math.py only.

  python check_forecast_stage.py <forecast-export.json> <runDir> <outDir>

forecast export (pulled from GET /forecast/versions/:id/data): {"i": [[MM-DD, slot, volume, aht, base, required, sl, occ], ...],
  "d": [[MM-DD, volume, peakRequired, agentHours, aht]], "w": [[weekStart, volume]], "h60": [[slot, volume, required]], "h30": [...]}
Group settings used by the app (read back from the API): SL 80% in 20 s, occupancy cap 85%, shrinkage 30%, Erlang C, 15-minute intervals.
Writes <outDir>/forecast_checks.csv and prints a summary.
"""
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wfm_math as M  # noqa: E402

SRC, RUN, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
SL, T, OCC, SHR, IV, YEAR = 0.80, 20, 0.85, 0.30, 900, "2026"
raw = json.loads(SRC.read_text())
if isinstance(raw, list):                      # the browser tool's wrapper: [{type, text}]
    raw = json.JSONDecoder().raw_decode(raw[0]["text"].strip())[0]   # the tool appends a note after the value
    if isinstance(raw, str):
        raw = json.loads(raw)
rows = []


def rec(check, key, expected, actual, tol, note=""):
    diff = None if expected is None or actual is None else abs(expected - actual)
    ok = diff is not None and diff <= tol
    rows.append({"check": check, "key": key, "expected": expected, "actual": actual, "diff": diff, "tolerance": tol, "result": "PASS" if ok else "FAIL", "note": note})
    return ok


# ---- 1. staffing per interval: net (base) = Erlang C with occupancy cap; gross = net / (1 - shrinkage); SL and occupancy at that net
for day, slot, vol, aht, base, req, sl, occ in raw["i"]:
    key = f"{day} slot {slot}"
    if not vol or vol <= 0:
        continue
    a = round(vol * aht / IV, 2)
    exp_base = M.required_agents(a * IV / aht, aht, IV, SL, T, max_occupancy=OCC)
    rec("net agents (Erlang C, SL 80/20, occ cap 85%)", key, exp_base, base, 0)
    rec("gross = ceil(net / (1 - 30%))", key, math.ceil(base / (1 - SHR) - 1e-9), req, 0)
    rec("service level at net", key, round(M.service_level(base, a, aht, T), 2), sl, 0.011)
    rec("occupancy at net = A / N", key, round(M.occupancy(a, base), 2), occ, 0.011)

# ---- 2. roll-ups: 15-min -> day -> week; 15 -> 30 -> 60 on the first day
by_day = defaultdict(float)
for day, slot, vol, *_ in raw["i"]:
    by_day[day] += vol or 0
for day, vol, *_ in raw["d"]:
    rec("day volume = sum of its 15-min intervals", day, round(by_day[day], 2), vol, 0.05 + 1e-6 * vol)
days = {d[0]: d[1] for d in raw["d"]}
for wk, vol in raw["w"]:
    import datetime as dt
    start = dt.date.fromisoformat(wk)
    s = sum(days.get((start + dt.timedelta(i)).strftime("%m-%d"), 0) for i in range(7))
    rec("week volume = sum of its days", wk, round(s, 2), vol, 0.05)
first = raw["d"][0][0]
f15 = {slot: vol for day, slot, vol, *_ in raw["i"] if day == first}
for grain, step in (("h30", 2), ("h60", 4)):
    for slot, vol, _req in raw[grain]:
        s = sum(f15.get(slot + k, 0) or 0 for k in range(step))
        rec(f"{grain[1:]}-min volume = sum of 15-min", f"{first} slot {slot}", round(s, 2), vol, 0.05)

# ---- 3. accuracy against the held-back days (noisy actuals) and the noise-free truth
hold = defaultdict(float)
truth = defaultdict(float)
ihold, ifc = {}, {}
qname = json.loads((RUN / "setup.json").read_text())["groups"][0]["queue"]
for r in csv.DictReader(open(RUN / f"holdout_{qname}.csv")):
    hold[r["date"][5:]] += int(r["offered"])
    h, m = map(int, r["interval"].split(":"))
    ihold[(r["date"][5:], (h * 60 + m) // 15)] = int(r["offered"])
for r in csv.DictReader(open(RUN / f"truth_{qname}.csv")):
    if r["split"] == "holdout":
        truth[r["date"][5:]] += float(r["expected_offered"])
for day, slot, vol, *_ in raw["i"]:
    ifc[(day, slot)] = vol or 0
common = [d for d in days if d in hold]
acc = {}
for label, ref in (("vs held-back actuals", hold), ("vs noise-free truth", truth)):
    A_ = [ref[d] for d in common]
    F_ = [days[d] for d in common]
    acc[label] = {"days": len(common), "WAPE%": round(M.wape(A_, F_), 2), "accuracy%": round(M.accuracy_from_wape(A_, F_), 2), "MAPE%": round(M.mape(A_, F_)[0], 2),
                  "MAE": round(M.mae(A_, F_), 1), "RMSE": round(M.rmse(A_, F_), 1), "bias%": round(M.bias(A_, F_), 2)}
keys = [k for k in ifc if k in ihold]
A_ = [ihold[k] for k in keys]
F_ = [ifc[k] for k in keys]
mp, zero = M.mape(A_, F_)
acc["15-min intervals vs held-back actuals"] = {"intervals": len(keys), "WAPE%": round(M.wape(A_, F_), 2), "MAPE% (non-zero actuals)": round(mp, 2), "zero-actual intervals skipped": zero,
                                                "MAE": round(M.mae(A_, F_), 2), "RMSE": round(M.rmse(A_, F_), 2), "bias%": round(M.bias(A_, F_), 2)}

OUT.mkdir(parents=True, exist_ok=True)
with open(OUT / "forecast_checks.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
(OUT / "forecast_accuracy.json").write_text(json.dumps(acc, indent=1))
summary = defaultdict(lambda: [0, 0])
for r in rows:
    summary[r["check"]][0 if r["result"] == "PASS" else 1] += 1
print(json.dumps({"checks": {k: {"pass": v[0], "fail": v[1]} for k, v in summary.items()}, "accuracy": acc}, indent=1))
fails = [r for r in rows if r["result"] == "FAIL"][:12]
if fails:
    print("FIRST FAILURES:")
    for r in fails:
        print(r)
