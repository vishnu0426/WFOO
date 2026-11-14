# Enterprise scheduling policies

What the scheduler does about time zones, clock changes, overtime, holidays, split shifts, weekend fairness, approval and change impact. Settings are in
Configuration › Scheduling Policy (organisation-wide) and in the shift template form (split shifts).

## Time zones and clock changes

- A person shared between groups in different zones: the other groups' shifts are converted to the group being built **before** any clash or rest check
  (`convertShift` in `clockChange.ts`, applied in `loadCtx` and to other groups' drafts). The length becomes the real elapsed time.
- Rest is real elapsed time. For each day of a schedule `restAdjust` gives +4 slots where the clocks go forward in the night before and −4 where they go back
  (0 on every other day). The engine adds it to the rest a shift needs (`dst_rest_adjust`, `rest_needed` in `engine/coverage.py`), in the CP-SAT model,
  the backup solvers, the greedy start and the long-plan windows.
- Limit: the adjustment is applied to the day on which the change happens, whatever time of night the shift before ended. It is exact for the usual case
  (a shift ending before the change, the next starting after it).
- Not changed: the independent rule check (`checkPerson`) still measures rest on the wall clock.

## Overtime (Scheduling Policy › Overtime)

| Setting | Effect |
| --- | --- |
| Allowed freely | As before: up to the person's weekly maximum, no price. |
| Only to fill a shortage | Paid time beyond the full contract in a week costs `w_overtime` (half a short slot) per slot, so overtime is used only where cover is worth it. Weeks the schedule covers only partly are not priced. |
| Never planned | The contract is the ceiling (`capHoursOf`). |

## Public holidays (Scheduling Policy › Public holidays)

Holidays are the calendar's special events of kind "holiday" (organisation, site or group). Modes: staffed like any day; **only where needed** (each holiday shift
costs 24 short slots in the objective); **not staffed** (blocked like time off). Holiday shifts also count as unsocial time for fairness.

## Weekend and holiday fairness

Fairness is now in **hours**, not shifts: paid hours on weekend days (the policy's weekend days) and public holidays, per person, spread between the most and least loaded.
The load carries from one window of a long plan to the next in hours (`weekendCounts`), and respects the configured weekend days (it used to assume Saturday and Sunday).
The weight is `w_fair / 8` per hour, which keeps a shift of eight hours priced as before.

## Split shifts (shift template › More options › Split shift)

Two parts of the day with an unpaid gap of 1–6 hours between them. The gap is stored as the template's unpaid meal (up to 24 slots), is fixed (not moved with
breaks, not shifted by the break optimiser), covers nothing in coverage, and each part must be at least 2 hours. The length is fixed; meal rules by length do not apply.
Not built: a pay premium for split shifts (payroll rules are separate).

## Approval

Optional (Scheduling Policy › "A schedule must be approved before it is published"). Draft → **Submit for approval** → **Approve** or **Send back** (reason required) →
**Publish**. The state sits beside the status (`approval_state`, migration 079) and each step is tied to the schedule's revision: an edit after submitting or approving
means that review no longer counts. The four-eyes organisation setting also applies: the submitter cannot approve. Approvers are the roles holding `schedule:approve`.
Republishing a published schedule after edits is not gated.

## What publishing changes

`GET /scheduling/versions/:id/impact` compares a draft with the schedule(s) live for the same group and dates, from today on (days already over are locked):
added, removed and moved shifts per person, hour changes, and changes with less notice than the policy's minimum (default 48 h, judged on the group's clock).
Short-notice changes are an open check when publishing (a reason is asked for when "ask for a reason before publishing with open checks" is on).
On publish, only the people whose shifts changed are notified, with what changed; if nothing was live, everyone gets "your schedule is ready".

## Verification

Engine: `test_scheduling.py` (priced holiday, planned overtime, rest across a clock change, unsocial hours, holiday as unsocial time), whole engine suite.
Gateway: `test/phase3.test.ts` (no stack), `test/enterprisePolicies.test.ts` (needs a stack: split shift, overtime, holiday, approval, impact, two time zones).

## Fixes before enterprise rollout (2026-11-06)

1. **One skill is a skill.** Per-skill coverage now applies from one skill requirement up (it used to need two). People without the skill cover nothing of it, and
   being on shift without any of the skills asked for counts as surplus, so they are not scheduled for free.
2. **Usual start and end across weeks.** In a plan solved a week at a time, a person who *must* have their usual times is only offered shifts near them; a person who
   *prefers* them is offered everything and charged `w_consist` for leaving them (previously both were limited). The usual times are kept as first chosen (for a person who
   must keep them) or are the pair worked most in the week, instead of whichever shift came last.
3. **Memory.** If the memory a solver needs is still not free after `ENGINE_MEMORY_WAIT_SEC` (default 300), the engine refuses with RESOURCE_EXHAUSTED ("ENGINE_BUSY"),
   which the gateway reports as busy and the caller can retry; before, it launched the solver anyway.
4. **Long plans.** A plan solved in more than one window reports `FEASIBLE` and `windowed`, and the screen says it was built one week at a time and is not proven best for
   the whole plan (before, it said "Best possible" when every week was optimal).
5. **One coverage count.** Every gateway place that counted heads uses `addShiftCoverage`, including the night shift from the day before (`dayIdx = -1`) and the
   pinned shifts of a long-plan window (which now carry their meals).

## Scenario table (2026-11-06)

`engine/test_scenarios.py` has one test per row of the review's scenario table (older tests cover one skill, part-week contracts and meal gaps in more depth).
Three behaviours were added by it:

- **A solve cancelled while it waits for solver capacity** leaves the queue within a quarter of a second (and stops waiting for memory), instead of keeping its place.
- **A person who must keep their usual times but has no shift near them in a week** is reported ("N people who must keep their usual start and end times have no shift near
  them this week, so they were given new usual times") in the solver's attempts, instead of silently getting new times.
- **Deterministic mode** (`deterministic: true` on a schedule build): one search thread and a limit counted in solver work rather than seconds, so the same input gives the same
  schedule on any machine, however busy. The default searches in parallel against the clock, is faster, and can return a different, equally valid schedule on a rerun.
  Not yet offered for background long plans (they use their own request).

## Skill demand across windows (2026-11-06)

A plan solved a week at a time now cuts each skill's demand to the window's days, as it always did the total (before, every window was solved for the first window's skill demand,
so a week whose skill demand differed could get no shifts and report no shortage). The engine also refuses a request whose skills together ask for more than the total at any slot,
counts skill-only demand when judging an empty answer, and reports no gap figure for a plan solved in windows (`gap` 1.0, `windowed`). Regression tests:
`engine/test_scenarios.py` (`test_skill_demand_of_each_week_...`, `..._only_in_a_later_week_is_not_lost`).

## Forecast backtest, staffing and the engine as a service (2026-11-06)

**Backtest is walk-forward.** Each fold is cleaned from its own history and chooses its model settings (ETS seasonality, SARIMA shape) from its own training data, and the MASE scale
comes from each fold's training data. Before, the settings were chosen on the full series (including the weeks being predicted) and reused by older folds. Tests:
`engine/test_forecast_walkforward.py` (changing the latest week cannot change how earlier folds were forecast).

**Staffing says what it found.** Each interval now carries the offered load (Erlangs), the target, whether it was met (`target_met`), a status (`OK`, `NO_DEMAND`, `TARGET_NOT_MET`,
`METHOD_FALLBACK`), the occupancy ceiling applied and a confidence (HIGH/MEDIUM/LOW: how far the Erlang assumptions hold at that size, not the forecast's confidence). The 5,000-agent
search limit is reported as `TARGET_NOT_MET`. Requests are validated and refused with a reason (occupancy outside 30–100%, shrinkage outside 0–0.9, unknown method, a channel with no
parameters, ...): nothing is silently clamped or defaulted; an unset (0) target is the documented default. Chat efficiency is the group's own (Group form, 0.3–1, default 0.85).
Erlang A: the queue cut-off grows until the probability beyond it is negligible, and the Poisson weights are computed in log space (they underflowed to zero for answer thresholds above
about 12 minutes, which collapsed the service level). Checked against the textbook Erlang C formula in `engine/test_staffing.py`. Simulation takes an explicit `interval_sec`.

**The engine as a service** (`engine/engine_config.py`, `server.py`): settings are loaded and validated before any module reads its environment (an unusable value stops the engine at start
with every problem listed); message limits are finite (`ENGINE_MAX_MESSAGE_MB`, 256); TLS and mutual TLS (`ENGINE_TLS_*`, and the gateway's `ENGINE_TLS_CA` ...); an address other machines
can reach without TLS is refused unless `ENGINE_ALLOW_INSECURE=1`; the plain `Schedule` call is cancellable and has a deadline (`ENGINE_SCHEDULE_DEADLINE_SEC`, or the caller's own, whichever is
sooner), as does the streaming call, and a call cancelled or timed out while waiting for solver capacity or memory leaves the queue at once; forecasts have a deadline and drop their worker pool
on expiry; forecast, intraday and simulation requests have input limits. Tests: `engine/test_server.py` (a real gRPC server, TLS and mTLS with generated certificates).

Not done in this round: per-interval reconciliation and empirical P10/P90 calibration of forecasts, a shared scoring function for the backup solvers, a lexicographic objective,
simulation realism (empirical distributions, skill routing), a standalone schedule-validator service, a model registry, dependency lockfile/SBOM tooling, resource-manager admission control.

## One evaluator for every solver; calibrated bands; the group forecast as the sum of its queues (2026-11-06)

**Shared evaluator** (`engine/scoring.py`). Every roster a backend returns is priced by the same function, which shares no code with any model: under, over (plus the rising `heavy`
price of surplus beyond need + 2), time past the end of a period, contract hours, planned overtime, consistency (the person's best possible usual times), preferences, shift cost,
and fairness in weekend and holiday hours, with the models' own weights. The chain compares backends on that score (it used to compare only under- and over-cover, so a roster with the
same cover but a dearer shift, a missed preference or more overtime tied with a better one and the first answer kept). The response carries `score` and `score_terms`; the Generate screen
shows the score and its largest terms; a split group's score is the sum of its parts'. `engine/test_backend_parity.py`: CP-SAT, HiGHS and SCIP report the same objective as each other
and as the evaluator on inputs they solve to the end (pooled and two-skill); CP-SAT equals the evaluator exactly with every term in play; a backend that has not finished may report a
larger figure of its own than its roster is worth (slack in a MIP solver's bookkeeping), never a smaller one; every backend's roster passes the independent rule check.
A finding of the parity run: on the all-terms scenario in 10 s CP-SAT scored about 15,000 while HiGHS and SCIP scored 48,000 to 64,000: the backups are a safety net, not an equal alternative.

**Forecast bands** are quantiles of the model's own backtest errors (`EMPIRICAL`; a normal band only with fewer than 20 errors, and the response says which). Calibration is measured
leave-one-fold-out, so every figure is on an observation that took no part in setting the band: `p10_coverage` should be near 0.10 and `p90_coverage` near 0.90, and the version's note
and the model comparison screen say when they are not. The band always contains the point forecast, and widens with the horizon as before.

**Group = sum of queues in every interval** (`forecasting._reconcile_intervals`). With reconciliation on, the group forecast's 15-minute figures are the sum of its queues' in every interval,
its days the sum of its queues' days, none negative; the queues keep their shares of each other (one common factor per day); its handle time is the volume-weighted mean. Before, the
group had daily figures only. Tests: `engine/test_forecast_bands.py`.

Limits: per-interval bands are normal (forecast error plus arrival noise), not calibrated; only the daily band is. Calibration rests on four weekly folds (28 errors), so the measured
coverage is itself noisy: read it as a flag, not a certificate.

## The remaining review items (2026-11-07)

**Priority of goals** (`scoring.dominance`, validation, gateway). Instead of seven strict stages, the weights are checked against a bound: the price of a slot of uncovered demand must be at
least what one shift can gain from the soft goals ranked below cover (usual times: up to twice `w_consist`; preferences: `w_pref`; weekend and holiday fairness: the fairness price for a
shift of up to 24 hours). The engine refuses weights that break it, saying what to raise; the gateway raises the cost of understaffing to the bound itself and says so on the build
(`weightsNote`). Contract hours, overtime and holiday cost stay priced trade-offs on purpose (a shift of contract hours is worth more than a slot of surplus; a strict order would
leave people under their contract to avoid surplus). `test_priorities.py` shows the inversion the bound prevents and that every soft goal at its maximum never costs cover.

**Resource manager** (`engine/resources.py`). A solve reserves the memory it expects to need before it starts, for as long as it runs, against a budget (`ENGINE_MEMORY_BUDGET_PCT`, 85% of the
machine or container, less a share kept for staffing, forecasts and simulation: `ENGINE_LIGHT_RESERVE_MB`, 8% or 512 MB). Two solves can no longer both be told there is room for the
same memory; a solve that has just started is counted against the live free-memory reading until it has taken its memory (`ENGINE_RESERVATION_RAMP_SEC`); a request bigger than the whole
budget runs alone; waiting ends within a quarter of a second when the caller cancels, and ends in a retryable "engine busy" after `ENGINE_MEMORY_WAIT_SEC`. Cores come from the container's CPU
quota. Metrics: reserved and budget MB, admissions waited, refused and cancelled, CPUs. Small calls do not go through it and are answered while solves hold the whole budget (tested through gRPC).

**Schedule validator service** (`engine/validator.py`, RPC `Validate`, `POST /scheduling/versions/:id/validate`, "Check rules" on the Timeline). Independent of the solvers. Hard: overlapping shifts,
two shifts a day, clashes with anything else the person is committed to (another group's shift, leave, training, unavailable), rest (across midnight, across groups, in real elapsed time over
a clock change, against the schedule before), days in a row (counting other groups and the run before), weekly hours and days (counting other groups by paid time and what was worked earlier in
the week), daily hours, overnight and weekend work for people not allowed it, activities outside their shift or overlapping each other or unknown. Soft: contract shortfall and overtime, uncovered
demand per day and per skill, people on shift with none of the skills asked for, a meal at the edge of a shift, an unfair weekend and holiday load. Shift length, paid time and productive
time are three different things (an unpaid meal is neither paid nor coverage; training is paid but not coverage; a break is paid and counts as covered because shrinkage allows for it). Validity
(`status`) and staffing (`coverage_status`) are reported apart: a roster that obeys every rule and leaves a queue short is VALIDATED_WITH_WARNINGS and UNDERSTAFFED, never "perfect".
Publishing, windowed publishing and republishing all require it to pass. If the check cannot run (the engine is down) publishing waits: 503 `VALIDATION_UNAVAILABLE` (an operator who accepts the risk can set `VALIDATION_FAIL_OPEN=true`; logged either way).
Every solver's roster is checked by it in `test_validator.py`. Not in it: availability windows (checked by the gateway's own rule check), compliance-pack rules beyond the person's limits, and
per-person skill assignment (cover is judged by matching, which is what the solvers do too).

**Simulation.** Handling time can be exponential, lognormal (with its spread) or fixed; patience exponential, lognormal or resampled from observed abandonment times; after-call work keeps an agent busy;
the forecast's own past errors (ratios of actual to forecast) can replace the normal error; a share of calls can be high priority and is served first. Every result carries a 95% confidence interval for the
mean service level (per interval, per day and overall) and for abandonment, and the response says how many replications ran against how many were asked for. Checked against Erlang C (patience that never
runs out), and the interval is checked to hold the true mean about as often as it says. Not built: skill-based routing across queues, transfers, callbacks, and agents changing mid-call at shift ends.

**Model registry** (migration 081, `forecast_model_runs`, `GET /forecast/versions/:id/registry`, `GET /forecast/registry`). Every forecast version records, for each queue and for the group total: model and a
version fingerprint (configuration + the libraries it ran on), the training window and a SHA-256 of the history rows, the settings chosen from that data, every candidate's walk-forward scores, how the band was
made and how it held up, the forecast's P10/P50/P90 totals, and the special events in force with a hash. The same inputs give the same record and the same forecast (tested).

**Supply chain** (`docs/DEPENDENCIES.md`). Hash-locked requirements, CycloneDX SBOMs for the engine, gateway and admin app, `pip-audit` and `npm audit` results, and the Docker image installs only the locked set.
The previous pins could not be installed by pip at all (OR-Tools 9.15 needs protobuf below 6.34; grpcio-tools 1.83 needs protobuf 7): fixed.

## Round 4: enforcement, one definition of demand, honest backends

**The Schedule call validates its own answer** (`engine/verdict.py`). Every roster the engine returns carries `ScheduleResponse.verdict` (checked, valid, status, coverage status, counts, first hard findings), made by the
same validator the gateway uses; a caller is never handed a roster without one. Inside the solver chain a backend whose roster breaks a hard rule is **rejected** (the attempt says why) and the next one is tried, so a solver
that ignores a rule cannot win. If nothing valid exists, the nearest roster is returned marked INVALID. A long plan is also checked as a whole after its windows are joined. The build records the verdict
(`stats.solver.verdict`), parts of a split group are merged (valid only if every part was checked and valid), and the gateway still refuses to publish anything its own independent check fails. `ENGINE_VERIFY=0` turns the
engine's check off (the response then says "not checked"); above `ENGINE_VERIFY_MAX_SHIFTS` (400,000) it is skipped and said to be.

**Required shift consistency is a hard rule across a whole plan.** A person who must keep one usual start and end: inside a window the solvers already forced it (CP-SAT, HiGHS/SCIP rows, greedy). Across windows the
usual times are now fixed as the middle of the first window's starts and ends (so every shift of that window is within tolerance of them), later windows offer only shifts near them, and a window with no such shift gives the
person **no shift that week** (the attempt says so, the shortfall shows in coverage) instead of quietly giving them new usual times, which is what used to happen. The validator checks it (`CONSISTENCY`): with no usual times
given, the starts (and the ends) must lie within twice the tolerance of each other; with usual times given, each shift must be within tolerance of them. The gateway passes the company rule and each person's own setting to it.
Prefer mode stays a priced preference, not a rule.

**Demand: one definition** (`coverage.generic_need`, `coverage.unmet`). `required` is the number of people who must be serving contacts in the slot, whatever their skills. A skill requirement is how many of those must be
serving that skill; a person serves one skill at a time and counts toward the skills they hold. So the skills' needs are shares of the total, what is left of the total after them is needed from anybody on shift
(including people who hold none of the skills asked for), and the slot's whole demand is `max(total, sum of the skills)`. People short = that demand less the most a matching can meet. Before this, once any skill
requirement existed the total was ignored by every solver (a total of 10 with 6 for one skill asked for 6). The CP-SAT model, the HiGHS/SCIP rows, the shared evaluator, the read-back, the greedy start and the validator now all use it;
`test_enforcement.py` checks each solver against it, and that the evaluator and validator agree on the shortfall.

**Memory is never promised that is not there.** A request that cannot fit in what solves may hold, even with one search thread, is refused (`RESOURCE_EXHAUSTED`, `REQUEST_TOO_LARGE`, not retryable), at the door for the
busiest week of the plan and again before each solve; before, such a request was clamped to the whole budget and run alone. The search threads are reduced to what fits before the request is refused. The in-process path
(`ENGINE_ISOLATE_SOLVES=0`) gets the same admission and a reservation for as long as it runs, and so do the HiGHS and SCIP backups, which run inside the engine (a backup that cannot fit is skipped and the attempt says so).
The memory figures are estimates (about 3 MB per thousand candidate shifts per search thread for CP-SAT; 4 KB per candidate shift for the backups, which was not measured as carefully).

**Forecast accuracy is measured two ways.** The backtest scores each model against the cleaned history it learns from (as before) **and** against the raw actuals, outliers and event days included (`raw_wape`,
`raw_mase`, `raw_bias`); the leaderboard returns both (`wapePercent`, `rawWapePercent`) and the registry keeps them. A model can look better on cleaned demand than it is on what really came in.
The scheduling baseline (`baseline_coverage`, what a solver has to beat) now judges the starting roster exactly as an answer is judged (meals and gaps cover nothing, a repeating period folds, skill demand by matching);
before it counted whole shifts and ignored skills.

**Backends are not equivalent until they pass.** `capabilities.py` lists the rules a request uses (skills, required or preferred consistency, a repeating period, overtime pricing, weekend fairness, hours worked
elsewhere, clock changes, gaps, history, per-shift costs). CP-SAT, HiGHS, SCIP and greedy declare all of them (the parity tests hold them to each other). A solver that does not declare a rule the request uses is not used:
the attempt says so and `capability_notes` carries it. Timefold declares its own at `GET /capabilities`.

**Timefold is built** (`backend/timefold-service`, Java 21, Timefold Solver 1.35.0 Community Edition, Apache 2.0, no Enterprise feature; `docs/SOLVER_BACKENDS.md`). It implements one shift a day, rest, days in a row, weekly
hours and days (all counting hours elsewhere and history), required consistency, cover per slot (meals and gaps, repeating period), surplus and large surplus, per-shift costs and preferences, contract hours, overtime and weekend
fairness. It does **not** implement skill-based demand or preferred consistency, says so, and the engine never sends it such a request. Its answers are judged by the validator and the shared scorer like everyone else's.

**Python version and dependencies.** The lock fixes Python 3.12 (`tools/lock.py --python 3.12`), protobuf 6.33.6, grpcio 1.80.1, OR-Tools 9.15.6755. Configuration is read and validated before any module that depends on it is
imported (`engine_config` is the first import of `server.py`, and a test fails if that order changes). No new Python dependency was added for the LSTM (see below).

**LSTM** (`engine/lstm.py`, model name `lstm`). A small LSTM per queue, trained on that queue's own history: the last 28 days (volume relative to the recent level, weekday, holiday flag) go through an LSTM of 24 units and a
linear layer with the next day's calendar. Written in NumPy (backpropagation through time and Adam; its gradients are checked against finite differences in `test_lstm.py`), deterministic, bounded in time, stops early on a held-out
tail. It competes in the same walk-forward backtest as the other models, is offered only for 16 or more weeks of steady volume, is left out for a queue where it cannot forecast a fold (never scored as a different model), and is
chosen only if it wins on MASE and beats seasonal naive. It was written without a deep-learning framework because the series are short and the framework's Linux wheels pull in gigabytes of GPU libraries, a much larger thing to lock and scan.
