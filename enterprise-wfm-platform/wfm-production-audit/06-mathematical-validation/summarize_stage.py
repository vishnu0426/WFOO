"""summarize_stage.py <schedDir> : one markdown row per checked plan."""
import json, sys, glob, os
rows = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*_check.json"))):
    c = json.load(open(f)); a = c.get("appStats") or {}; sv = a.get("solver", {})
    rows.append((c["name"][11:], c["weeks"], c["shifts"], c["people"], c.get("activeWithoutShifts"), c["totalHardViolations"], a.get("violations"),
                 a.get("coverage", {}).get("percent"), c["coverageAppDefinition4w"]["coverage%"], sv.get("status"), sv.get("gap")))
def key(r):
    g, w = r[0].split(" ")[0], r[1]; return (g, w, r[0])
print("| Plan | Weeks | Shifts | People | Active w/o shifts | Breaks mine/app | Coverage app (horizon) | Coverage mine (first 4 wk) | Solver | Gap |")
print("|---|---:|---:|---:|---:|---|---:|---:|---|---:|")
for r in sorted(rows, key=key):
    print(f"| {r[0]} | {r[1]} | {r[2]:,} | {r[3]} | {r[4]} | {r[5]} / {r[6]} | {r[7]} | {r[8]} | {r[9]} | {r[10]} |")
print(f"\n{len(rows)} plans, total hard-rule breaks (mine): {sum(r[5] for r in rows)}, (app): {sum((r[6] or 0) for r in rows)}")
