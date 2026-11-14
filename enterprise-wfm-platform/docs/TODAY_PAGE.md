# The Today page (Overview)

`GET /api/v1/overview/today?groupId=` (gateway `overviewToday.ts`, arithmetic in `overviewMath.ts`) returns everything the page shows, worked out in one place from the functions the detailed
screens use (`coverageFor` for live coverage, the adherence judgement, `accuracyTrendFor`, the schedule's own stale and violation checks), so the page and the screens cannot disagree.

## What it says, and what it never says

- **The verdict.** `ATTENTION` when anything urgent or "check" exists. `PARTIAL` ("not everything could be checked") when nothing is wrong in what was checked but a signal could not be
  (for example no published forecast covers today, so live coverage cannot be judged). `OK` ("on track") **only** when every signal was checked and none is a problem. The old page said
  "Nothing needs action right now" whenever its short list happened to be empty.
- **Signals** (each can be checked or not): the published schedule, the forecast, today's live coverage, agent activity (RTA), the volume feed. A role that is not meant to see a signal
  (no permission) does not have it counted as unchecked.
- **The attention rail.** Each item has a severity (urgent, check, to do), a plain-language reason and the action that fixes it (a button to the screen), or a note that the person's role cannot
  do it (an analyst is not offered a button that would be refused). Items, with when they appear:

| Item | When |
|---|---|
| No published schedule / does not cover today | none published; published period (or published-through date) does not include today |
| Published schedule breaks N rules | `stats.violations > 0` on the published version (drafts with violations are a to-do, not urgent) |
| Out of date | the schedule's own stale reasons (edited, or its forecast replaced or withdrawn) |
| Covers X% of the demand | below the company's coverage target (urgent when more than 10 points below) |
| No published forecast / none covers today / ends in fewer than 3 days | forecast versions of the group |
| Forecast waiting for approval / approved, not published | to-dos |
| N upcoming intervals understaffed | live coverage, gap below -0.5 people |
| N agents out of adherence | agent activity exists |
| No agent activity arriving | people are scheduled right now but no status has arrived today |
| N agents in a state the system cannot read | unknown agents or unmapped states (shown even when adherence has no data) |
| Volume feed N days behind | latest interval history more than 2 days old |

- **Order for the role.** Most serious first; within a severity, what that role acts on first (a forecast planner sees forecast items first, a scheduler schedule items, a supervisor live coverage and
  RTA). `WFM_ADMIN`, `WFM_MANAGER`, `FORECAST_PLANNER`, `SCHEDULER`, `SUPERVISOR_RTA`, `ANALYST` are ordered; `AGENT` has no page.

## The figures, and how each is calculated

| Figure | Calculation |
|---|---|
| Coverage today | `sum(min(scheduled, needed)) / sum(needed)` over the day's quarter hours (people-time), against the company's coverage target; trend vs yesterday computed the same way |
| People scheduled in a quarter hour | on shift, **less meals and split-shift gaps** (they cover nothing), **including the late hours of yesterday's night shifts**; breaks stay in (shrinkage allows for them) |
| Short / surplus hours | `sum(max(0, needed - scheduled))` and `sum(max(0, scheduled - needed))`, counted apart so a short interval is not cancelled by a long one |
| Adherence today | all adherent minutes / all scheduled minutes over everyone (not an average of each person's percentage); target 88%; trend vs yesterday |
| Forecast accuracy | 100 less the last full week's average daily miss of the published forecasts against actuals; target 92% (an 8% miss is "good" in the accuracy trend); trend vs the week before |
| Service level (forecast) | weighted by the contacts in each interval |
| Active people | active employees in the group; trend vs 4 weeks ago from hire and termination dates (approximate, and says so, when people have no hire date) |
| Trend | change in the figure's own units (percentage points); inside a 0.5-point band it is "steady"; "better" says whether the change is good news; no earlier figure means "no trend yet" |

Found and fixed while building it (they were wrong before, on the live coverage screen's numbers): people scheduled ignored meals and overnight tails; "coverage" was the share of intervals fully met,
not the share of people-time; the day's service level and occupancy were plain averages of intervals; the adherence summary was an average of percentages.

## Recent changes

The latest eight audit entries with **sign-ins left out** (`LOGIN`, `LOGIN_FAILED`); a "Show sign-ins" box brings them back. Needs audit access.

## Tests

- `test/overviewMath.test.ts` (13, no stack): every formula against figures worked out by hand, the verdict rules, the review's exact scenario (published schedule with 9 violations, out of date, 60.9%
  coverage, no forecast for today, 98 agents in an unreadable state), role ordering, actions refused by role.
- `test/overviewToday.test.ts` (4) and `test/overviewLive.test.ts` (3): the API; a real forecast and published schedule with meals, with people scheduled and coverage recomputed independently and compared.
- `qa/today-check.mjs` (20): the page in Chrome compared with the API, the fix buttons, the sign-in toggle, no second group selector, no serious accessibility violations.

Not done: the page does not yet pick a "my teams" view for a supervisor, trends use one earlier period (no sparkline), and a group's own adherence target is not a setting (88 is fixed).
