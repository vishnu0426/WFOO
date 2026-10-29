# Schedule quality: what was added and how to use it

Migration `034_schedule_quality.sql`. Screens: Scheduling › **Schedule Quality**, Scheduling › Generate Schedule, Configuration › Scheduling Rules, Configuration › WFM Groups (queue skill), Workforce › Employees.

## 1. Generation report and status
Every generation run stores a report with the schedule (`settings.report`).

* Status: **Succeeded** or **Succeeded with warnings**. A run that cannot produce a schedule still fails with an error, as before.
* Who was scheduled and who was not. Each person left out has a reason: *no shift possible* (and what ruled every shift out: time off, no overnight, availability, a labour-law rule, their assigned start time) or *not needed*.
* Chosen people who are not eligible, days without a forecast, days projected from the long-term forecast, coverage below target, rule violations, a solver that ran out of time.
* `GET /scheduling/versions/:id/report` and `/report.csv`.

## 2. Same start and end time every day
* Company default: Configuration › Scheduling Rules (`Off`, `Preferred`, `Required`, with a start and an end tolerance in minutes).
* Per run: the same choice on Generate Schedule.
* Per person: `shiftConsistency` (`DEFAULT` follows the company setting) and an optional assigned start time (`fixedStartSlot`). A person's own setting always wins. An assigned start time applies unless they are set to `OFF`.
* **Required** never trades it off against coverage; **Preferred** costs a penalty per shift off a person's usual times but coverage always comes first. The usual start and end are chosen by the solver, once for the whole period.
* A schedule over several weeks with this rule is solved as one model (the usual weekly chunking is skipped), so it takes longer.

## 3. Per-skill coverage
A queue can name the skill its contacts need (Configuration › WFM Groups › Queues). When two to five skills carry work in a group, the pooled requirement is split between skills by workload (volume x handle time) and the solver judges each interval skill by skill: each person on shift serves one skill at a time, so the requirement is met exactly when, for every group of skills, enough people hold at least one of them (Hall's condition). The split always adds up to the pooled requirement.
Not done: skill proficiency levels beyond "has the skill", and several skills per queue.

## 4. Evaluation and score
`GET /scheduling/versions/:id/evaluation` estimates service level for every interval with Erlang C on the interval's whole workload. People on the phones are those on shift minus those at a meal or break, with the rest of the shrinkage taken off as a share. It also gives a **busy-day** and a **quiet-day** figure from the forecast's P90 and P10 bands. It is an estimate: channels with concurrency or abandonment are judged as one pool.
The score (0-100) is made of requirement covered (35), service level reached (30), rules respected (15), little wasted time (10) and little overtime (10).

## 5. Shortage analysis
`GET /scheduling/versions/:id/shortage` lists the gaps against the requirement, worst first. For each it counts every active person by why they were not covering it (on time off, not allowed overnight or weekends, a labour-law rule, at their weekly or days limit, not enough rest, no template covers the time, or *could work it but the schedule chose otherwise*) and suggests actions. The coverage target is Configuration › Scheduling Rules (default 90%).

## 6. Meals and breaks
Placed after the solver chooses shifts, then moved within their slack (template flex, or the company window if larger) to keep the phones covered where the forecast needs people. Shifts, order and lengths never change. `POST /scheduling/versions/:id/optimize-breaks` repeats it on a draft. This is a separate pass after the solver, not part of the solver's own model.

## 7. Stale schedules and publish checks
A schedule records the forecast revision it was built from. It is marked **stale** when that forecast is edited or withdrawn, or a newer one is published. With *Ask for a reason before publishing with open checks* on, publishing a schedule below the coverage target or stale needs a reason, which is stored with the schedule (`acknowledged`). Off by default.

## 8. Contract hours in a part week
A week is a calendar week, Monday to Sunday. When a schedule starts or ends inside one, that week used to be skipped for the contract-hours goal, so a schedule starting on a Sunday never pushed anyone toward their contract. Now a part week asks for the same share of the contract, rounded down to whole shifts of the person's usual length (a six-day week of a 40-hour contract asks for four 8-hour shifts, a single Sunday asks for nothing), and never more than the person's days-per-week or weekly-hours limits allow. A whole week is unchanged. The goal is still soft: the weight is the same "Meet contract hours" slider. Solver: `week_target()` in `backend/engine/scheduling.py`.

## 9. Bulk edit of employees
Tick people in Workforce › Employees, then *Edit selected*. Tick *Change* beside each field to set it on everyone; add or remove groups and skills without touching what each person already has. A reason is required and is written to the audit trail for each person. People who cannot take a change (for example contract hours above the maximum) are skipped and listed. `POST /workforce/employees/bulk`.

## 10. What people worked before the schedule starts
Generating a schedule now looks at the **published** schedule(s) for the 7 days before the first day, for the people being scheduled (switch off with `useHistory: false` on `POST /scheduling/versions`). Drafts and archived schedules never count.

* **Rest.** A first-day shift that starts too soon after an earlier shift is not offered. This matters for night shifts that end after midnight.
* **Days in a row.** The run of days worked just before the start continues into the new schedule.
* **The week's hours and days.** When the schedule starts mid-week, hours and shifts already worked earlier that Monday-to-Sunday week count toward the weekly maximum, the days-per-week limit and the contract target (the contract is for the whole week, less what was already worked).
* **Shifts that run past midnight.** An earlier night shift still on the clock after midnight counts toward the first hours of the new schedule, so the start is not shown empty. The requirement shown for those hours is net of these people and the report says how many; it is stored with the schedule (`settings.carryOver`) so later views stay consistent.
* The generation report carries a *Carried over from the previous schedule* note when anything was used.

Limits: only days inside the 7-day look-back count, and only shifts stored in a published schedule; time-off or manual changes outside schedules are not part of it. If the published schedule has no night shifts, nothing carries into the first hours: the benefit is rest, days in a row and the week's hours. Code: `backend/gateway/src/modules/boundaryHistory.ts`; solver fields `prior_*` in `backend/proto/wfm.proto`, used in `backend/engine/scheduling.py`.

## 11. Shift templates: variable length, rules by length, limits
Migration `036_shift_template_flex.sql`. Screen: Scheduling › Shift Templates, under *More options*. A template with none of these set behaves as before.

* **Variable length.** Give a shortest shift; the scheduler may then pick any length from there up to the template's length, in steps of 30, 60 or 120 minutes. A template that spans many lengths is thinned to five evenly spread ones for the solver (always the shortest and the longest), because every length is a separate candidate shift for every person and day.
* **Meal and breaks by length.** Rules such as "no meal under 5 hours, one break from 4 hours, a 30-minute meal and two breaks from 7 hours". The rule with the largest *from* not above the shift's length applies; shorter shifts get neither. With no rules, a fixed-length template keeps its own meal and breaks, and a variable-length one scales them (a meal from 5 hours, a break for every 4 hours up to its count). A meal never takes more than the shift leaves room for. The meal can be marked paid.
* **A start window per weekday.** A day can have its own earliest and latest start; other days use the general window. A window does not switch a day on: the day must also be ticked under *Days it can be used*.
* **Who it is offered to.** Limit it to WFM groups, contract types or skills (any one of the skills is enough), or leave it open to everyone. People it is not for are counted in the generation report under the reason.
* **Dates.** *From* and *Until* keep a template out of schedules outside them.
* **Copy.** The Copy link on a template opens a new one with the same settings.
* **Everything that counts paid time follows the shift's own length:** the roster Paid column, schedule statistics, weekly-hours checks, attendance, the employee app, compliance meal checks and the shortage analysis. A manual shift can be added at any length the template offers (`lengthHours` on `POST /scheduling/versions/:id/shifts`).
* Code: `backend/gateway/src/modules/templateRules.ts` (pure rules), `scheduleRoutes.ts` (routes, generation), solver unchanged except that each option carries its own length.

Not done: split shifts (two work blocks with an unpaid gap), pay premiums and cost per shift, and activities placed by the template beyond meal and breaks. Training and coaching can already be added to a shift by hand on the timeline.

## 12. A starting roster that spreads the week
The solver starts from a roster built before it searches. The old one filled Monday to Friday first, so weekends were left to whoever had days left and a large crew often could not improve on it. The new one gives each person, in rounds, the single shift (any day, any length) that most improves the objective, until they have their contract shifts. It counts shortage and surplus, honours the weekly and consecutive-day limits and the rest between shifts, and nudges toward the quieter day when two shifts cost about the same. On a synthetic 385-person crew with a 24x7 forecast, requirement short went from 5.4% to 3.0% and weekends are covered. It takes under a second at 1,000 people.

A bug found on the way: the spread-of-weekend-shifts variable never received a starting value, so for large crews the hint was incomplete and the solver often could not use it. It is now complete.

## 13. A repeating week, and a warning about crew size
* **Assume the week repeats** (Generate Schedule, one-week schedules). For a first schedule with nothing published before it: shifts on the last day that run past midnight also cover the first hours of the first day. The requirement shown for those hours is net of them, stored with the schedule (`settings.carryOver`), and the report notes the assumption. Check it against the real week before when you publish.
* **Crew size note.** The report says when the contracts of the people chosen add up to far more hours than the forecast needs on shift (a note from 25% more, a warning from 50%), with the surplus and roughly how many people the forecast needs. In that case no schedule can both honour every contract and avoid surplus: schedule fewer people, lower *Meet contract hours*, or offer shorter shifts.

## Tests
* `test/scheduleQuality.test.ts`, `test/erlang.test.ts`, `test/boundaryHistory.test.ts`, `test/templateRules.test.ts`: pure logic, no database.
* `test/qualityApi.test.ts`: end to end against a running gateway (29 tests, including the previous-schedule history and the new template options).
* `backend/engine/test_scheduling.py`: solver tests including per-person consistency and per-skill coverage.
* `backend/engine/bench_scheduling.py`: scale benchmark; results in `docs/SOLVER_BENCHMARK.md`.

## Pay week

Weekly hours, days per week and overtime are counted per pay week, which begins on a chosen weekday (Monday by default).

* **Company default:** Configuration › Scheduling Rules › Pay week starts on (`scheduling_policy.defaults.payWeekStart`).
* **Group override:** Configuration › WFM Groups › Pay week starts on (`wfm_groups.pay_week_start`, migration 037). Empty means the company setting.
* **Generate Schedule** uses the group's pay week, else the company's. Picking another day on that page applies to that run only, with a link to save it for the group.
* **A schedule keeps the pay week it was built with** (`settings.weekStart`). Changing the setting later does not re-count old schedules; schedules made before this setting existed count from Monday.
* **Used by:** the solver, schedule validation and stats, labour-law checks and overtime premium, schedule quality and shortage analysis, shift offers (VTO and overtime), and attendance overtime and the payroll export (these use the group's current pay week).
* Not yet: the employee self-service views and the mobile app still show weeks from Monday.

## Coverage view (Schedule Timeline)

"Coverage against the forecast" is read three ways and shows short and over by pattern (hatched, dotted) as well as colour.

* **Summary strip:** period coverage, hours short (with the worst interval), hours over (with the biggest surplus and its share of the need), the selected day, and the expected service level.
* **Day:** 15, 30 or 60 minute intervals; needed against scheduled; a bar chart of how far each interval is from the need; optional lines for the expected service level (Erlang C from the forecast volume, as on Schedule Quality) and for another version of the same group; a switch to show people on the phones, after shrinkage.
* **Whole period:** a heatmap of days against hours; each cell is people scheduled minus people needed in that hour. Click a cell to open that day.
* **Click any interval:** who is working it, and for everyone who is not, why not (time off, availability, weekly limit, rest, labour law, or free to work it). It uses the same reasoning as the shortage analysis.
* **API:** `GET /scheduling/versions/:id/coverage` (adds `grain=30`, `summary`, `heat`, `shrinkage`, `compare=<versionId>`) and `GET /scheduling/versions/:id/interval?day=&slot=`.
