"""Deterministic synthetic WFM data for one TEST_RUN_ID.

Writes (to --out/<TEST_RUN_ID>/):
  setup.json            sites, teams, skills, WFM groups/queues the run needs (created through the API before import)
  employees.csv         the app's employee import format (employee_number, first_name, last_name, team, wfm_group, ...)
  employees_ext.csv     attributes the import has no column for (email, site, tz, languages, preferences, ...) - kept for checks
  history_<queue>.csv   interval history in the app's ingestion format (date, interval, offered, handled, abandoned, aht, talk, hold, acw)
  truth_<queue>.csv     the noise-free expected volume per interval (ground truth for forecast accuracy)
  holdout_<queue>.csv   "future actuals" for the days after the history (forecast is scored against these)
  manifest.json         TEST_RUN_ID, seed, every file + row counts + sha256, for cleanup and reproducibility
  quality.json          data-quality checks (duplicates, references, contract hours, offered >= handled, AHT identity, ...)

Same --seed and arguments => byte-identical output.
Example:  python generate.py --employees 5000 --seed 42 --days 90 --holdout 28 --interval 15
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import random
from pathlib import Path

import numpy as np

FIRST = "Asha Ben Chen Dara Eli Fay Gus Hana Ivo Jun Kai Lea Max Nia Omar Pia Quin Ravi Sara Tom Uma Vik Wen Xia Yan Zoe".split()
LAST = "Adams Bose Cruz Diaz Eng Fox Gill Hart Iyer Jain Khan Lund Moss Nair Ortiz Park Quinn Rao Shah Tan Usha Vega Wong Xu Young Zhou".split()

# channel: (AHT mean s, talk/hold/acw split, intraday shape, weekend factor, patience/abandon base, open hours)
CHANNELS = {
    "VOICE": dict(aht=300, split=(0.72, 0.10, 0.18), peaks=[(10.0, 1.6, 1.0), (14.5, 2.0, 0.8)], weekend=0.55, abandon=0.06, open=(7, 22)),
    "CHAT": dict(aht=540, split=(0.85, 0.0, 0.15), peaks=[(12.0, 3.0, 1.0), (19.5, 1.5, 0.7)], weekend=0.8, abandon=0.03, open=(8, 23)),
    "EMAIL": dict(aht=420, split=(0.80, 0.0, 0.20), peaks=[(9.5, 2.5, 1.0)], weekend=0.35, abandon=0.0, open=(0, 24)),
    "BACKOFFICE": dict(aht=900, split=(0.90, 0.0, 0.10), peaks=[(11.0, 4.0, 1.0)], weekend=0.0, abandon=0.0, open=(8, 18)),
}
WEEKDAY = [1.15, 1.05, 1.0, 0.98, 0.95, 1.0, 1.0]   # Mon..Sun (weekend handled by channel factor)
SITES = [("BLR", "Asia/Kolkata"), ("MNL", "Asia/Manila"), ("LON", "Europe/London"), ("NYC", "America/New_York"), ("MEX", "America/Mexico_City")]
LANGS = ["English", "Spanish", "Hindi", "Tagalog", "French"]


def plan_groups(n_emp: int):
    """Group count grows with headcount: ~1 group per 2,000 people, at least 1, each with a channel mix."""
    g = max(1, round(n_emp / 2000))
    mix = ["VOICE", "VOICE", "CHAT", "EMAIL", "BACKOFFICE"]
    sizes = np.full(g, n_emp // g)
    sizes[: n_emp - sizes.sum()] += 1
    return [dict(code=f"G{i + 1:03d}", channel=mix[i % len(mix)], site=SITES[i % len(SITES)], people=int(sizes[i])) for i in range(g)]


def shape(ch: dict, slots: int, interval: int):
    h = (np.arange(slots) + 0.5) * interval / 60.0
    y = np.zeros(slots)
    for mu, sd, w in ch["peaks"]:
        y += w * np.exp(-0.5 * ((h - mu) / sd) ** 2)
    o, c = ch["open"]
    y[(h < o) | (h >= c)] = 0.0
    return y / y.sum() if y.sum() else y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--employees", type=int, required=True)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--holdout", type=int, default=28)
    ap.add_argument("--interval", type=int, default=15, choices=[15, 30, 60])
    ap.add_argument("--start", default="2026-07-06", help="first history day (a Monday)")
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "out"))
    a = ap.parse_args()

    run_id = a.run_id or f"TR{a.seed:04d}E{a.employees}"
    rng = np.random.default_rng(a.seed)
    prnd = random.Random(a.seed)
    out = Path(a.out) / run_id
    out.mkdir(parents=True, exist_ok=True)
    created = dt.datetime(2026, 1, 1).isoformat() + "Z"   # fixed, so files are reproducible; the real time goes in the manifest
    tag = dict(TEST_RUN_ID=run_id, TEST_DATA_FLAG="TRUE", CREATED_BY_TEST_RUN=run_id, CREATED_AT=created)

    groups = plan_groups(a.employees)
    slots = 24 * 60 // a.interval
    start = dt.date.fromisoformat(a.start)
    files, quality = {}, {"checks": []}

    # ---- setup: teams of ~15, a supervisor per team, skills per group ----
    skills = [f"{run_id}-{c}" for c in CHANNELS] + [f"{run_id}-LANG-{l}" for l in LANGS]
    setup = {"tag": tag, "sites": [{"code": f"{run_id}-{s}", "tz": tz} for s, tz in SITES], "skills": skills, "groups": [], "teams": []}

    emp_rows, ext_rows = [], []
    seq = 0
    for g in groups:
        gname = f"{run_id}-{g['code']}"
        site_code, tz = g["site"]
        setup["groups"].append({"name": gname, "channel": g["channel"], "site": f"{run_id}-{site_code}", "tz": tz, "interval": a.interval,
                                "queue": f"{gname}-Q", "people": g["people"]})
        n_teams = max(1, math.ceil(g["people"] / 15))
        for t in range(n_teams):
            setup["teams"].append({"name": f"{gname}-T{t + 1:03d}", "group": gname})
        for i in range(g["people"]):
            seq += 1
            num = f"{run_id}-{seq:06d}"
            team = f"{gname}-T{i // 15 + 1:03d}"
            pt = prnd.random() < 0.22
            weekly = prnd.choice([20, 24, 30]) if pt else prnd.choice([37.5, 40, 40, 40])
            max_weekly = weekly if pt else min(48, weekly + 8)
            dpw = 5 if not pt else max(math.ceil(weekly / 8), prnd.choice([3, 4, 5]))   # part-timers work at most 8 h a day
            hire = start - dt.timedelta(days=int(rng.integers(30, 3650)))
            lang = LANGS[0] if prnd.random() < 0.7 else prnd.choice(LANGS[1:])
            other = prnd.choice([c for c in CHANNELS if c != g["channel"]]) if prnd.random() < 0.25 else None
            sk = [f"{run_id}-{g['channel']}:{prnd.randint(2, 5)}", f"{run_id}-LANG-{lang}:{prnd.randint(3, 5)}"]
            if other:
                sk.append(f"{run_id}-{other}:{prnd.randint(1, 3)}")
            status = "ACTIVE" if prnd.random() > 0.01 else "SUSPENDED"
            emp_rows.append({"employee_number": num, "first_name": prnd.choice(FIRST), "last_name": f"{prnd.choice(LAST)}-{run_id[-4:]}",
                             "team": team, "wfm_group": gname, "employment_type": "PART_TIME" if pt else "FULL_TIME",
                             "weekly_hours": weekly, "max_weekly_hours": max_weekly, "days_per_week": dpw, "status": status,
                             "hire_date": hire.isoformat(), "skills": "; ".join(sk)})
            ext_rows.append({"employee_number": num, "email": f"{num.lower()}@wfm-test.example", "site": f"{run_id}-{site_code}", "tz": tz,
                             "is_supervisor": i % 15 == 0, "max_daily_hours": 10 if not pt else 8, "min_rest_hours": 11,
                             "preferred_start": prnd.choice(["EARLY", "MID", "LATE", "ANY"]), "language": lang,
                             "leave_balance_days": round(float(rng.uniform(0, 25)), 1), "portal_account": prnd.random() < 0.02, **tag})

    def write(name, rows):
        p = out / name
        with open(p, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        files[name] = {"rows": len(rows), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}

    write("employees.csv", emp_rows)
    write("employees_ext.csv", ext_rows)

    # ---- history: sized so the workload roughly needs the group's headcount ----
    for g in setup["groups"]:
        ch = CHANNELS[g["channel"]]
        prof = shape(ch, slots, a.interval)
        active = g["people"] * 0.99
        # productive hours a week ~ people * 36 h * (1 - 30% shrinkage) at ~80% occupancy
        weekly_work_h = active * 36 * 0.70 * 0.80
        daily_base = weekly_work_h * 3600 / ch["aht"] / (5 + 2 * ch["weekend"])   # contacts on an average weekday
        gname = g["name"]
        total = a.days + a.holdout
        hist, truth, hold = [], [], []
        spike_days = set(rng.choice(total, size=max(1, total // 30), replace=False).tolist())
        for d in range(total):
            day = start + dt.timedelta(days=d)
            wd = day.weekday()
            f = WEEKDAY[wd] * (ch["weekend"] if wd >= 5 else 1.0)
            f *= 1 + 0.0015 * d                                    # gentle trend
            f *= 1 + 0.08 * math.sin(2 * math.pi * d / 91)         # quarterly seasonality
            if (day.month, day.day) in {(8, 15), (10, 2), (11, 1), (12, 25)}:
                f *= 0.4                                           # holidays
            spike = 1.6 if d in spike_days else 1.0
            for s in range(slots):
                lam = daily_base * f * prof[s]
                if lam <= 0:
                    continue
                offered = int(rng.poisson(lam * spike))
                ab = int(rng.binomial(offered, ch["abandon"] * (1.5 if spike > 1 else 1))) if offered else 0
                handled = offered - ab
                aht = max(30.0, float(rng.normal(ch["aht"], ch["aht"] * 0.08))) if handled else 0.0
                tt, ht, at = (round(handled * aht * x) for x in ch["split"])
                aht_r = round((tt + ht + at) / handled, 2) if handled else 0
                hh, mm = divmod(s * a.interval, 60)
                row = {"queue": g["queue"], "date": day.isoformat(), "interval": f"{hh:02d}:{mm:02d}", "offered": offered, "handled": handled,
                       "abandoned": ab, "aht": aht_r, "talk_sec": tt, "hold_sec": ht, "acw_sec": at}
                (hist if d < a.days else hold).append(row)
                truth.append({"queue": g["queue"], "date": day.isoformat(), "interval": f"{hh:02d}:{mm:02d}", "expected_offered": round(lam, 4),
                              "spike": spike > 1, "split": "history" if d < a.days else "holdout"})
        write(f"history_{g['queue']}.csv", hist)
        write(f"holdout_{g['queue']}.csv", hold)
        write(f"truth_{g['queue']}.csv", truth)

        # quality on the fly
        bad_off = sum(1 for r in hist + hold if r["offered"] != r["handled"] + r["abandoned"])
        bad_aht = sum(1 for r in hist + hold if r["handled"] and abs(r["aht"] - (r["talk_sec"] + r["hold_sec"] + r["acw_sec"]) / r["handled"]) > 0.01)
        quality["checks"].append({"check": f"{g['queue']}: offered = handled + abandoned", "violations": bad_off})
        quality["checks"].append({"check": f"{g['queue']}: AHT = (talk+hold+acw)/handled", "violations": bad_aht})

    nums = [r["employee_number"] for r in emp_rows]
    team_names = {t["name"] for t in setup["teams"]}
    group_names = {g["name"] for g in setup["groups"]}
    quality["checks"] += [
        {"check": "duplicate employee numbers", "violations": len(nums) - len(set(nums))},
        {"check": "employee team exists in setup", "violations": sum(r["team"] not in team_names for r in emp_rows)},
        {"check": "employee group exists in setup", "violations": sum(r["wfm_group"] not in group_names for r in emp_rows)},
        {"check": "weekly_hours <= max_weekly_hours", "violations": sum(float(r["weekly_hours"]) > float(r["max_weekly_hours"]) for r in emp_rows)},
        {"check": "weekly_hours <= days_per_week * max_daily_hours", "violations": sum(float(e["weekly_hours"]) > int(e["days_per_week"]) * x["max_daily_hours"] for e, x in zip(emp_rows, ext_rows))},
        {"check": "every employee number carries TEST_RUN_ID prefix", "violations": sum(not n.startswith(run_id + "-") for n in nums)},
        {"check": "skills reference run skills", "violations": sum(any(s.split(":")[0].strip() not in skills for s in r["skills"].split(";")) for r in emp_rows)},
    ]
    quality["passed"] = all(c["violations"] == 0 for c in quality["checks"])
    (out / "setup.json").write_text(json.dumps(setup, indent=1))
    (out / "quality.json").write_text(json.dumps(quality, indent=1))
    manifest = {**tag, "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "seed": a.seed, "args": vars(a), "employees": a.employees,
                "groups": len(groups), "teams": len(setup["teams"]), "files": files,
                "cleanup_keys": {"employee_number_prefix": run_id + "-", "name_prefix": run_id + "-"}}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(json.dumps({"run_id": run_id, "out": str(out), "employees": a.employees, "groups": len(groups), "teams": len(setup["teams"]),
                      "history_rows": sum(v["rows"] for k, v in files.items() if k.startswith("history_")), "quality_passed": quality["passed"]}))


if __name__ == "__main__":
    main()
