# Stage 50 — 50 employees, test org AUDITTR0042 on 192.168.9.186

Date 2026-11-14 · TEST_RUN_ID `TR0042S50` · Driven from the signed-in admin page (browser), every step guarded by `/auth/me` tenant = `a27e73cf…` (AUDIT TR0042). Nothing touched the real org.

## What ran, and how it went

| Step | Result | Time |
|---|---|---|
| Setup: 1 site, 9 skills, 1 group (SL 80/20, shrinkage 30 %, occupancy 85 %), 1 voice queue, 1 shift template (07:00–13:00 starts, 4–9 h, 30-min meal, 2×15-min breaks), 4 teams | 17 records, values read back match | 0.9 s |
| Employee import, dry run → commit | 50 new, 0 errors; **450/450 field checks match** (team, group, type, weekly/max hours, days/week, hire date, status, skills+levels) | 113 ms / 183 ms |
| History import, 90 days × 15 min (5,400 rows) | **612 rows rejected for AHT 0** (AUD-05); re-sent with AHT blank → all 5,400 in | 0.7 s + 0.4 s |
| Forecast 4 weeks (15-min) and 53 weeks (daily), submit → approve → publish | Both published; model chosen: ETS (Holt-Winters); app's own backtest WAPE 3.0 % | 6.4 s / 4.3 s |
| Schedules 1, 4, 13, 26, 52 weeks (+26 and 52 fully optimised) | see table below | 36 s – see below |
| API probe every 5 s during all solves | **0 failures**, p95 505 ms, max 11.3 s (PERF-01) | ~30 min |

## Maths (independent, `06-mathematical-validation/check_forecast_stage.py`)

| Check | Pass | Fail | Note |
|---|---:|---:|---|
| Net agents = Erlang C, SL 80 %/20 s, occupancy cap 85 % | 1,668 | 8 | the 8 are 0.01-call intervals: app staffs 1 for any volume (OBS-02), my check rounds A to 0 — not a defect |
| Gross = ceil(net / (1 − 30 %)) | 1,632 | **44** | **MATH-01**: float error, net 21 → 31 instead of 30 |
| Service level at net | 1,676 | 0 | |
| Occupancy = A / N | 1,676 | 0 | |
| Day = Σ 15-min · Week = Σ days · 30/60-min = Σ 15-min | 104 | 0 | |
| Schedule coverage (app definition reproduced) | 7 of 7 plans | 0 | equal to the app's figure to ±0.4 pt; exact on 1 week (8,699 / 1,074 / 175 / 276) |

## Forecast accuracy (4-week forecast vs data the app never saw)

| Against | Days / intervals | WAPE | Accuracy (100−WAPE) | MAPE | MAE | RMSE | Bias |
|---|---:|---:|---:|---:|---:|---:|---:|
| Held-back actuals, daily | 26 days | 13.6 % | 86.4 % | 11.5 % | 315 | 530 | −13.6 % |
| Noise-free truth, daily | 26 days | 8.5 % | 91.5 % | 8.6 % | 187 | 200 | −8.5 % |
| Held-back actuals, 15-min | 1,557 | 18.2 % | — | 22.9 % (160 zero intervals skipped) | 7.1 | 12.4 | −13.6 % |

Reading: the forecast is **under** by 8.5 % against the truth. Most of that is by design of the test data: it has a 91-day seasonal cycle that rises through the forecast window, which no model can learn from 90 days of history, plus random spike days in the held-back period. This is a property of this dataset, not proof of a model fault. A longer history (≥ 1 year) is needed to judge accuracy fairly.

## Schedules (independent rule check, `06-mathematical-validation/check_schedule_stage.py`)

Rules checked per person: overlap, two shifts a day, rest ≥ 11 h, ≤ 6 days in a row, paid hours per pay week ≤ max weekly, days per pay week ≤ contract days, shift length and start inside the template, breaks/meal inside the shift, person belongs to the group.

| Plan | Solved weeks | Wall time | Shifts | Hard-rule breaks (mine / app) | Coverage app / mine (app definition, first 4 weeks) | Solver |
|---|---:|---:|---:|---|---|---|
| 1 week | 1 | 36 s | 232 | 0 / 0 | 87.7 / 87.65 | CP-SAT, feasible |
| 4 weeks | 4 | 60 s | 928 | 0 / 0 | 87.0 / 87.02 | CP-SAT, feasible |
| Quarter (13) | 13 | 241 s | 3,016 | 0 / 0 | 87.4 / 87.02 | CP-SAT, feasible |
| Half year (26), default | 13 + 13 repeated | 215 s | 6,032 | 0 / 0 | 87.1 / 87.02 | CP-SAT, feasible |
| Half year (26), all solved | 26 | 395 s | 6,033 | 0 / 0 | 87.3 / 87.04 | CP-SAT, feasible |
| Full year (52), default | 13 + 39 repeated | 212 s | 12,064 | 0 / 0 | 86.9 / 87.02 | CP-SAT, feasible |
| Full year (52), all solved | 52 | 770 s | 12,066 | 0 / 0 | 87.1 / 87.04 | CP-SAT, feasible |

**API probe during all 7 solves (≈ 30 min, 385 samples of GET /config/groups):** 0 failures, p50 65 ms, p95 505 ms, p99 1.4 s, **max 11.3 s**, 3 samples over 2 s (PERF-01, cause not proven; my own 1–2 MB schedule exports were running at times in the same browser).

Notes
* Every plan is **understaffed by design of the demand** (forecast needs ≈ 2,175 paid hours a week, 50 people give ≈ 1,950). The solver therefore schedules everyone close to the maximum: 82 % of person-weeks are paid above contract (42.5 h vs 40 h), never above the 48 h maximum. Reported as overtime by the app (128.5 h/week).
* Repeated weeks (default plans) are exact copies of the last solved 4-week cycle and do not react to later forecast changes (holidays, seasonality). Use "all solved" when the forecast changes within the horizon.
* "Gap" 0.8–1.0 means CP-SAT found a valid roster but did not prove it best within 60 s per window; the app says so in its advice text.

## Read latency while solving (12 calls each, p50 / max)

employees page 73/191 ms · search 74/482 · groups 61/807 · forecast day 138/387 · forecast 15-min 146/397 · schedule version 58/354 · 4-week shifts 96/1,140 · time off 59/307 · audit 60/423 ms.

## Not covered at this stage (and why)

* Employee portal sign-in and access rules: I cannot type passwords on this server; needs you to sign in as 2 test employees, or the local stack.
* Shift bidding, VTO/overtime offers, swaps, time off approval, adherence: next functional pass (they need published schedules — now available).
* Multi-skill, multi-site, chat/email/back-office: start at the 500 stage (the generator creates them from ~2,000 people up; I will force a mix earlier).
* Server CPU/RAM/DB: only `/metrics` from outside; no shell access.
