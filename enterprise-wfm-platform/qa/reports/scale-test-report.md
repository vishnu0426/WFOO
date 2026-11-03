# WFM 50k Scale Test

50,000 employees in 13 WFM groups · schedule week from 2026-11-02 · 1 November 2026

Machine: 1 laptop: Intel i5-10310U 4 cores / 8 threads, 15.7 GB RAM (about 3 GB free), one engine, Vite dev servers

## Verdict: NOT READY

The platform holds 50,000 people, forecasts every group in seconds and, when a group is solved one at a time and whole, produces schedules with zero rule breaks. It is not ready for an organisation this size: the engine crashed 15 times, every group large enough to need splitting failed, all 12 builds failed when started together, and the gateway stopped answering everyone for 40+ minutes while large schedules were prepared. Four employee features silently stop at 2,000 people.

| Measure | Result |
| --- | --- |
| Employees | 50,000 in 13 groups, one organisation |
| Schedules built | 9 of 13 (through the real gateway → engine pipeline) |
| Shifts generated and re-checked | 250,495 |
| Rule breaks found by the independent checker | 0 |
| Engine crashes (under a restart supervisor) | 15 |
| New defects | 14 |

## Scenario groups

Each group is a different real-world case. All were loaded through the API and scheduled for one week (S10: 13 weeks) by background jobs, one group at a time.

| Group | People | Situation | Schedule | Attempts (one at a time) | Build time | Covered | Shifts | No shift | Rule breaks |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| S01 · Voice office hours | 6,000 | Mon–Fri 08:00–20:00 demand, full-time 40 h, weekday-only templates | DONE (FEASIBLE, cpsat) | in parts: failed; whole: built | 3.0 min | 98.4% | 24,288 | 0 | 0 |
| S02 · Voice 24x7 with nights | 6,000 | Round-the-clock demand, overnight shifts for people with night consent, SARIMA forecast | FAILED | in parts: failed; in parts: engine crashed | — | — | — | — | — |
| S03 · Chat part-time mix | 5,000 | 50% part-timers (20 h, 4 days), variable-length 4–8.5 h shifts, chat concurrency, ETS forecast | FAILED | in parts: failed; in parts: engine crashed | — | — | — | — | — |
| S04 · Email back office | 3,000 | Low, intermittent email volume (Croston), Mon–Fri | DONE (FEASIBLE, cpsat) | in parts: built | 1.8 min | 43.5% | 12,278 | 0 | 0 |
| S05 · Multi-skill EN/ES | 5,000 | Two queues needing different skills (60% EN, 20% ES, 20% both), weighted-average forecast | FAILED | in parts: failed; in parts: engine crashed | — | — | — | — | — |
| S06 · Time off and availability | 4,000 | 10% on approved leave in the week, 10% with unavailable windows, gradient-boosting forecast | DONE (FEASIBLE, cpsat) | in parts: failed; whole: built | 2.9 min | 95.8% | 19,600 | 0 | 0 |
| S07 · Rotation 4-on-4-off | 2,000 | Two-crew 4-on-4-off 12 h rotation materialized into shifts, seasonal-naive forecast | DONE (FEASIBLE, cpsat) | in parts: built | 1.7 min | 67.4% | 6,479 | 0 | 0 |
| S08 · Weekend retail peaks | 4,000 | Weekend demand 1.6× weekdays, 30% may not work weekends, 5 missing days in history, combo forecast | DONE (FEASIBLE, cpsat) | in parts: failed; whole: built | 3.1 min | 83.9% | 20,000 | 0 | 0 |
| S09 · London site (Europe/London) | 4,000 | Another site and time zone (UK, week after the clocks changed), outlier days in history, ARIMA | FAILED | in parts: engine crashed; whole: failed; whole: engine crashed | — | — | — | — | — |
| S10 · Long plan 13 weeks | 2,000 | 13-week background plan (4 solved weeks, rest repeated) on short + long-term (365-day) forecasts | DONE (FEASIBLE, cpsat) | in parts: built | 11.0 min | 95.8% | 129,730 | 0 | 0 |
| S11 · Overstaffed (VTO) | 3,000 | Demand far below the crew: surplus, voluntary-time-off suggestions | DONE (FEASIBLE, cpsat) | in parts: engine crashed; whole: built | 2.6 min | 96.5% | 8,120 | 0 | 0 |
| S12 · Understaffed (overtime) | 3,000 | Demand above the crew, +20% forecast adjustment and a special event: gaps, overtime suggestions | DONE (FEASIBLE, cpsat) | in parts: failed; whole: built | 2.7 min | 51.2% | 15,000 | 0 | 0 |
| S13 · Candidate-limit boundary | 3,000 | First a template with every 15-minute start and length (millions of options) to check the refusal, then normal templates | DONE (FEASIBLE, cpsat) | in parts: failed; whole: built | 2.7 min | 96.1% | 15,000 | 0 | 0 |

"Covered" is the share of required staff-hours the schedule meets (from the schedule's own statistics). "Rule breaks" are counted by an independent checker.

## First attempt: all groups at once

All 12 jobs queued together (S13 not queued: the orchestrator lost its connection to the frozen gateway). Up to 10 ran at once although the limit is 2. Every build failed; the gateway answered nobody for most of the 42 minutes. Started 2026-10-31 13:52 UTC.

| Group | Result | Ran for | Why |
| --- | --- | ---: | --- |
| S01 | FAILED | 42 min | engine not reachable (crash) while solving |
| S02 | FAILED | 42 min | engine not reachable while preparing |
| S03 | FAILED | 31 min | engine crash while solving |
| S04 | FAILED | 11 min | engine crash while solving |
| S05 | FAILED | 25 min | engine crash while preparing |
| S06 | FAILED | 25 min | engine crash while solving |
| S07 | FAILED | 9 min | engine crash while solving |
| S08 | FAILED | 25 min | engine crash while solving |
| S09 | FAILED | 25 min | engine crash while preparing |
| S10 | FAILED | 17 min | engine crash in week 1 of 4 |
| S11 | FAILED | 22 min | engine crash while solving |
| S12 | FAILED | 22 min | engine crash while solving |

## Schedule rules, person by person

| Group | Double-booked | Rest < 11 h | Over max hours | Too many days | Days in a row | On approved leave | In unavailable hours | Weekend (not allowed) | Night without consent | Odd shift length | Not in group | Avg week-1 hours FT / PT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S01 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 32.4 / — |
| S04 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 32.7 / — |
| S06 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 39.2 / — |
| S07 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 37.3 / — |
| S08 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 40 / — |
| S10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 40 / — |
| S11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 21.7 / — |
| S12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 40 / — |
| S13 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 40 / — |

Context: S06 has 400 people on approved leave and 400 with unavailable mornings; S08 has 1,200 people who may not work weekends. Not validated: groups with no schedule (S02, S03, S05, S09).

## Forecasting

History: 12 weeks of 15-minute intervals per queue (gaps in S08, outlier days in S09, intermittent volume in S04). Each forecast was created, then submitted, approved and published. Data is synthetic, so backtest errors are unrealistically low except where the model was a poor fit.

| Group | Model asked | Model used | Backtest WAPE | Create | Dashboard | Leaderboard | Scenarios | Accuracy | History quality | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| S01 | auto | wavg | 0.10% | 3.2 s | 7 ms | 6 ms | 7 ms | 2.1 s | 21 ms | 2 outlier/event day(s) replaced by the same-weekday baseline before fitting. |
| S02 | sarima | sarima | 0.09% | 4.5 s | 7 ms | 5 ms | 4 ms | 2.1 s | 20 ms |  |
| S03 | ets | ets | 0.13% | 3.3 s | 4 ms | 5 ms | 4 ms | 1.9 s | 20 ms |  |
| S04 | croston | ets | 7.83% | 3.4 s | 4 ms | 4 ms | 4 ms | 1.6 s | 18 ms | Requested model 'croston' unavailable for this history; used 'ets'. |
| S05 | wavg | wavg | 0.19% | 5.5 s | 6 ms | 5 ms | 4 ms | 2.4 s | 33 ms | Queue forecasts reconciled with the group forecast (average of bottom-up and top-down totals). |
| S06 | gbm | combo | 0.14% | 3.8 s | 4 ms | 4 ms | 4 ms | 1.7 s | 25 ms | Requested model 'gbm' unavailable for this history; used 'combo'. · stability MEDIUM, MASE 0.7581 |
| S07 | snaive | snaive | 0.19% | 3.7 s | 4 ms | 4 ms | 4 ms | 1.7 s | 24 ms |  |
| S08 | combo | combo | 0.13% | 3.7 s | 5 ms | 5 ms | 3 ms | 1.9 s | 20 ms |  |
| S09 | arima | arima | 7.69% | 3.2 s | 8 ms | 4 ms | 7 ms | 2.0 s | 24 ms | 4 outlier/event day(s) replaced by the same-weekday baseline before fitting. · stability VARIABLE, MASE 2.6198 |
| S10 | auto | ets | 0.14% | 4.8 s | 5 ms | 4 ms | 4 ms | 1.9 s | 23 ms | 365-day long-term: created (3.6 s) |
| S11 | auto | wavg | 0.25% | 4.2 s | 6 ms | 4 ms | 4 ms | 2.1 s | 19 ms |  |
| S12 | auto | wavg | 0.10% | 3.3 s | 5 ms | 4 ms | 3 ms | 1.5 s | 22 ms | +20% adjustment: applied |
| S13 | auto | ets | 0.15% | 3.4 s | 5 ms | 3 ms | 3 ms | 1.4 s | 20 ms |  |

## Limits, rotation and load

| Check | Result |
| --- | --- |
| Candidate-limit boundary (S13: every 15-minute start and every length 4–12 h for 3,000 people) | No answer: the connection dropped after 8.5 min (fetch failed); engine afterwards: true, Redis: false |
| Rotation 4-on-4-off (S07: 2 crews, 12 h days, 4 weeks) | 2000 members in 3.9 s; materialised in 11.8 s: {"versionId":"04dbf559-9c82-4122-93e0-e0eb4e60567d","shiftsPlaced":28000,"days":28,"holidaysSkipped":0,"leaveShiftsSkipped":0,"from":"2026-11-02","through":"202 |
| Engine (restart loop for this test) | 17 starts, 15 crashes |

## Screens, API and portal with 50,000 people

### API reads

| Read | Status | Time | Size | Rows |
| --- | ---: | ---: | ---: | ---: |
| employees (unfiltered) | 200 | 968 ms | 1,620 kB | 2,000 |
| employees of a 6,000 group | 200 | 987 ms | 1,630 kB | 2,000 |
| time off (all) | 200 | 28 ms | 148 kB | 422 |
| availability (all) | 200 | 41 ms | 414 kB | 2,008 |
| schedule versions | 200 | 38 ms | 508 kB | 56 |
| shifts of a 6,000 group (1 wk) | 200 | 1.1 s | 14,798 kB | 24,288 |
| schedule plan view | 200 | 18.4 s | 1 kB | — |
| live coverage (6,000 group) | 200 | 125 ms | 0 kB | — |
| adherence (6,000 group) | 200 | 431 ms | 5 kB | — |
| rollup by site | 200 | 2.6 s | 24 kB | — |
| forecast versions | 200 | 12 ms | 27 kB | 43 |
| audit log | 200 | 26 ms | 57 kB | 100 |
| attendance summary | 200 | 738 ms | 25 kB | — |
| users | 200 | 11 ms | 10 kB | 40 |
| self-service logins | 200 | 5 ms | 3 kB | 16 |

### Admin screens in Chrome (6,000-person group selected where it applies)

| Screen | Ready | JS heap | Result |
| --- | ---: | ---: | --- |
| Employees list | 5.1 s | 48 MB | OK |
| Overview | 1.1 s | 38 MB | OK |
| Schedule timeline | 43.8 s | 236 MB | OK |
| All schedules | 2.6 s | 253 MB | OK |
| Live coverage | 30.3 s | 40 MB | OK |
| Adherence | 30.2 s | 62 MB | OK |
| Time off | 3.1 s | 55 MB | OK |
| Year plan | 8.0 s | 42 MB | OK |
| Schedule quality | 2.0 min | 40 MB | not idle after 120 s |

### Live agent states and the portal

- **Live agent states:** 6,000 people in 5.3 s — 2,000/2,000 accepted in 337 ms, 2,000/2,000 accepted in 322 ms, 2,000/2,000 accepted in 351 ms. A batch of 2,001 → 400 "Invalid input: events Array must contain at most 2000 element(s)". Adherence afterwards: 4.2 s.
- **Employee portal (S01-00001, one of 6,000 in their group):** sign-in to Home 1.6 s; home 86 ms, schedule 22 ms, time-off 20 ms, swaps 25 ms, offers 26 ms, notifications 11 ms. Shifts were visible only after the schedule was published (publish of 24,288 shifts: 9.5 s); the employee then saw 4 shifts for the week (32 h on a 40 h contract) and no notification.

## Defects (14)

Numbered after the release-gate list (DEF-01 to DEF-28). Also in `qa/reports/scale/scale-defects.csv`.

### DEF-29 · Critical · Engine crashes on large solves and takes every running build down with it

**Area:** Scheduling · Engine

- **Steps:** Schedule groups of 3,000–6,000 people (one week, 90 s limit). Runs: 12 groups together; then one at a time; then one at a time without splitting.
- **Expected:** A solve that runs out of time or memory fails alone; the engine keeps serving
- **Actual:** 15 engine crashes in the scale run (engine-supervisor.log; 17 counting the 2 earlier in the day). All 12 builds started together failed. One at a time: every group that the gateway splits into parts (S02, S03, S05 and the split runs of S09, S11) crashed the engine; S10 survived one crash. Logs: 'Fatal Python error: Aborted' (14; 2 of them show SCIP 'Insufficient memory for allocation' followed by an OR-Tools 'Check failed' abort), and one 'Windows fatal exception: access violation' in backends.py respond() while building the reply. The parts of one group are solved side by side in one engine process, each CP-SAT model plus the HiGHS/SCIP backups in memory at once.
- **Evidence:** scale/engine-run-*.log, engine-supervisor.log; S11 whole: DONE 157 s, no crash; S11 in parts: crash
- **Fix:** Solve each part/solve in its own child process with a memory cap so a native abort kills one solve, not the server; skip the MIP backups (HiGHS/SCIP) above a candidate size they cannot handle; run parts one after another when memory is short; supervise the engine and retry the job after a restart.

### DEF-30 · Critical · Preparing a large schedule freezes the gateway for every user

**Area:** Gateway · Availability

- **Steps:** Start schedule builds for groups of 5,000–6,000 people; call GET /health and the admin app meanwhile
- **Expected:** The API stays responsive while schedules are built in the background
- **Actual:** Gateway pinned at 100% of one CPU core (Node main thread, 430→604 MB); /health timed out at 15–30 s continuously for 40+ minutes; DB sessions sat 'idle in transaction' waiting for the gateway; S03 spent 16 minutes preparing. Opening Schedule Quality for a 6,000-person group did the same for 2+ minutes.
- **Evidence:** health-samples.jsonl; scheduleRoutes.ts ~598–640: candidates are built on the main thread, rebuilt up to 8 times at coarser settings, yielding only every 25 people
- **Fix:** Build candidates in a worker thread or in the engine; compute the candidate count arithmetically and pick the thinning level once instead of rebuilding the list; cap per-request CPU for report screens and cache their results.

### DEF-31 · High · An over-limit schedule request is not refused — it runs 8½ minutes and then drops

**Area:** Scheduling · Limits

- **Steps:** S13: one template with every 15-minute start and every length 4–12 h, 3,000 people, POST /scheduling/versions
- **Expected:** Immediate 400: 'too many possible shifts' (the 900,000 limit exists in the code)
- **Actual:** 510 s, then the connection failed; /health afterwards showed Redis down; the gateway answered nobody meanwhile
- **Evidence:** results.jsonl phase boundary
- **Fix:** Estimate people × days × starts × lengths before building and refuse at once.

### DEF-32 · High · Employee list stops at 2,000 people without saying so

**Area:** Workforce · API and screens

- **Steps:** GET /workforce/employees (or ?groupId= for a 6,000-person group); open Workforce › Employees
- **Expected:** Paging, or a total and a 'showing 2,000 of 50,000' notice
- **Actual:** Exactly 2,000 rows, no total, no next page (loadEmployees … LIMIT 2000). The other 48,000 people cannot be found by scrolling.
- **Evidence:** probe-api; workforceRoutes.ts:70
- **Fix:** Server-side paging with a total count; AG Grid server-side row model.

### DEF-33 · High · Bulk edit silently skips anyone outside the first 2,000

**Area:** Workforce · Bulk edit

- **Steps:** POST /workforce/employees/bulk with one person inside and one outside the first 2,000 (by last name)
- **Expected:** Both updated
- **Actual:** 200 OK, updated 1, skipped 1: 'Employee not found'
- **Evidence:** cap-check.mjs; workforceRoutes.ts:178 uses the capped loader
- **Fix:** Load the selected ids directly (WHERE id = ANY($1)) instead of the capped list.

### DEF-34 · High · Re-importing existing employees fails once the organisation has more than 2,000 people

**Area:** Workforce · Import

- **Steps:** Import a CSV row for an existing employee outside the first 2,000
- **Expected:** Dry run says UPDATE; commit updates them
- **Actual:** Dry run says NEW; commit fails with 409 'That already exists' and rejects the whole file. A nightly HR sync of 50,000 people cannot run.
- **Evidence:** cap-check.mjs; workforceRoutes.ts:274
- **Fix:** Match existing employees by number with a direct query for the numbers in the file.

### DEF-35 · High · The 'two builds at a time' limit is not enforced

**Area:** Scheduling · Background jobs

- **Steps:** Queue 12 schedule jobs while the gateway is busy
- **Expected:** At most SCHEDULE_JOB_CONCURRENCY (default 2) running
- **Actual:** 10 jobs RUNNING at once on one gateway, multiplying the load that caused DEF-29 and DEF-30
- **Evidence:** schedule_jobs rows at 14:35; scheduleJobs.ts tick(): the running-count check and the claim are separated by an await, and tick() runs from both a timer and every enqueue
- **Fix:** Make tick() single-flight (a flag or mutex) and claim only CONCURRENCY - running.size jobs in one UPDATE.

### DEF-36 · Medium · Jobs fail at once while the engine restarts, and timeouts are reported as 'engine not reachable'

**Area:** Scheduling · Background jobs

- **Steps:** Queue jobs during the ~60 s an engine takes to start; or solve a group whose call exceeds the gateway's gRPC deadline
- **Expected:** Wait/retry with back-off; a timeout says it timed out
- **Actual:** 8 jobs failed within 5 s each; S09 (no crash) failed after 172 s with 'The forecasting engine is not reachable'
- **Evidence:** seq.log
- **Fix:** Retry engine-unavailable failures with back-off for a few minutes; distinguish DEADLINE_EXCEEDED from UNAVAILABLE in the message.

### DEF-37 · High · At 3,000+ people the optimiser adds nothing: schedules are the greedy starting roster

**Area:** Scheduling · Optimiser

- **Steps:** Schedule any group with ≥ 210,000 candidate shifts (S01, S06, S08, S11, S12, S13) with a 90 s limit
- **Expected:** CP-SAT improves on the starting roster; or the screen says the result is unoptimised
- **Actual:** Every one: 'cpsat: feasible (starting roster only), highs: unknown, scip: unknown, greedy: feasible', gap 1 (100%). Valid schedules, often 95–98% covered, but contract hours, preferences and fairness are not optimised. Only S04/S07 (≤ 75,000 candidates) were optimised.
- **Evidence:** results.jsonl schedule-seq statsRaw
- **Fix:** Split earlier (smaller parts, solved safely — see DEF-29), give large groups a longer default limit, and show 'starting roster only' prominently on the schedule.

### DEF-38 · Medium · Email (24 h turnaround) demand is spread across the night

**Area:** Forecasting · Staffing

- **Steps:** S04: email queue, weekday office-hours history (no night volume), Mon–Fri 08:00–18:30 templates
- **Expected:** Back-office work can wait within its 24 h turnaround, so it is staffed in office hours
- **Actual:** Requirement of about 140 people 00:00–08:00 every day; coverage 43.5% while 388,976 surplus quarter-hours sit in the day; shortage report: 'no shift template covers this time'
- **Evidence:** GET /scheduling/versions/:id/shortage for S04
- **Fix:** For deferrable channels, place the requirement within the queue's opening hours (backlog model) instead of flat over 24 h.

### DEF-39 · Medium · Full-timers scheduled well below contract hours with no warning

**Area:** Scheduling · Contracts

- **Steps:** Validate hours per person in S11 (overstaffed) and S01
- **Expected:** Contract hours met, or the shortfall listed as a warning for payroll
- **Actual:** Full-time 40 h people averaged 21.7 h (S11) and 32.4 h (S01); schedule statistics show warnings: 0
- **Evidence:** validate rows
- **Fix:** Report contract-hour shortfall per person; offer VTO instead of silently cutting hours where the policy pays contract hours.

### DEF-40 · Medium · Screens and reads for a 6,000-person group are slow and heavy

**Area:** Performance · Large groups

- **Steps:** Open screens with the 6,000-person group selected; call the shift and plan APIs
- **Expected:** < 5 s
- **Actual:** Schedule Timeline 44 s, 236 MB browser heap; Live Coverage and Adherence 30 s; Schedule Quality > 120 s; plan view API 18 s; shifts API returns everything at once (15 MB for one week; 79 MB for 2,000 people × 13 weeks — about 1 GB for 6,000 × 52 weeks)
- **Evidence:** probe-ui, probe-api, validate (shiftsKb)
- **Fix:** Page and window the shift APIs (by day/team), virtualise the timeline, precompute report screens.

### DEF-41 · Low · Model choice is not explained: unsuitable models run, unavailable ones fall back quietly

**Area:** Forecasting

- **Steps:** Request ARIMA for S09, Croston for S04, GBM for S06
- **Expected:** The screen says what each model needs and warns when the chosen one is worse than a naive forecast
- **Actual:** ARIMA used though worse than seasonal naive (MASE 2.6, WAPE 7.7% vs ~0.1–0.2% elsewhere, stability VARIABLE). GBM needs 120 days of history and Croston a sparse daily series; both fell back with a note only in the summary.
- **Evidence:** forecast versions summaries
- **Fix:** Show eligibility next to each model and warn when the selected model loses to the baseline.

### DEF-42 · Low · Publishing a schedule does not notify the people on it

**Area:** Self-service

- **Steps:** Publish S01 (6,000 people) → sign in as S01-00001
- **Expected:** 'Your schedule for 2–8 Nov is published'
- **Actual:** 0 notifications (shifts are visible)
- **Evidence:** probe-portal after publish
- **Fix:** Confirm intended behaviour; if not, notify on publish (batched).

## What held up

- 50,000 employees loaded through the real API: 6,000-row CSV imports in about 3.5 s, 12 weeks of 15-minute history per queue in about 2 s, 400 leave requests and 400 availability rules without an error.
- Every forecast model the engine offers was exercised across 13 groups; each forecast was created in 3–6 s, published through submit/approve/publish, plus a 365-day long-term forecast and a +20% adjustment. Missing days were tolerated and outlier days detected and replaced.
- Independent re-check of every shift in 9 built schedules (250,495 shifts, incl. a 13-week plan): 0 double-bookings, 0 rest or weekly-hour breaks, 0 shifts on approved leave, 0 in unavailable hours, 0 weekend shifts for the 1,200 people who may not work weekends, and everyone got shifts.
- Solved whole and one at a time, groups of 3,000–6,000 people built in about 3 minutes each (S01: 6,000 people, 98.4% covered).
- Rotation 4-on-4-off: 2,000 members assigned in 4 s and 28,000 shifts materialised in 12 s.
- Live agent states for 6,000 people accepted in 3 batches of 2,000 (about 330 ms each); the 2,000-per-call limit is enforced with a clear message.
- Publishing a 6,000-person schedule (24,288 shifts) took 9.5 s; the employee then saw their week in the portal in under 100 ms.
- The shortage report explains gaps in plain words with causes and suggested actions (overtime, a missing template, temporary staff).

## Method and limits

```powershell
$env:QA_ADMIN_PASSWORD='…'                     # test stack only: adds 50,000 people
node qa/scale/scale-test.mjs setup             # groups, queues, 12 weeks of history, people, leave, availability
node qa/scale/scale-test.mjs forecast          # one model per group, publish, long-term + adjustment
node qa/scale/schedule-sequential.mjs S01,S02 90 [900000]   # one group at a time; 900000 = solve whole
node qa/scale/validate.mjs                     # independent rule check
node qa/scale/probe-50k.mjs                    # API, live states, admin screens, portal
node qa/scale/build-scale-report.mjs
node qa/tools/build-markdown.mjs
```

- One laptop ran everything (database, gateway, one engine, both web apps, Chrome), so times are a floor, not a server benchmark.
- One week is solved per group (S10: 4 weeks solved and 9 repeated). Demand and people are synthetic; real availability patterns make the model harder.
- Coverage is what the solver reached within its 90-second limit (feasible, not proven optimal).
- The test data (groups `SCALE S01`–`S13`, employees `S01-00001`…) is still in the local database.
