# Long plans: 13, 26 and 52 weeks

A schedule can now cover up to 52 weeks. Nobody solves a year of named shifts in one go, so a long plan is built in layers.

## How a long plan is built

1. **Range.** On Generate Schedule choose 4, 13 (quarter), 26 (6 months) or 52 (12 months) weeks, or any number from 1 to 52. Up to 4 weeks is built straight away, as before. Longer is built in the background.
2. **Windows.** The solver works four weeks at a time. Each window starts from where the one before it ended: rest between shifts, days worked in a row, the week's hours already worked and the number of weekend shifts each person has had all carry over. So window 3 knows what window 2 did.
3. **Solved weeks, then repeated weeks.** The first N weeks (default 13, your choice) are solved shift by shift against the forecast. After that the last solved cycle is repeated, each repeated week copying the solved week whose daily demand looks most like its own (kept in rotation order unless another week fits clearly better; a week that resembles none is reported by date as one to solve properly). Time off, availability, rest, days in a row and the weekly maximum are applied to every repeated shift first, and a shift that would break one is left out (the build says how many). These repeated shifts are marked `PATTERN` and are the "rotation lines" the Year Plan screen describes. They are not a forecast-matched roster; they give a year its shape until each window is close enough to solve properly.
4. **Forecast.** Each week uses the published short-term forecast where it reaches and the published long-term forecast (projected onto intervals by the queue's usual daily shape) after that. A week no forecast reaches is shown as "no forecast", and a plan whose later windows have none repeats the last cycle instead of failing.
5. **Confidence.** Weeks within 6 weeks of today are High, up to 18 weeks Medium, further out or based on the long-term projection Lower. This is a rule of thumb for how far a forecast can be trusted, not a statistical interval, and it is labelled that way on screen.

## The job

The build is a row in `schedule_jobs`. Any gateway can pick it up (`FOR UPDATE SKIP LOCKED`), reports progress after every window, and keeps running when the page is closed. The Generate screen shows "N of M weeks built, about X min left" with Cancel; the Year Plan screen shows a build in progress too. Cancelling stops the solve inside the engine and deletes the half-built schedule. A worker that stops heartbeating for 30 seconds has its job put back in the queue once, then it is marked failed. One build per WFM group at a time.

The time estimate is `search time x windows + 0.02 s x people x weeks preparing each window`. It was fitted to `SOLVER_BENCHMARK.md` and is a guide, not a promise.

## Publishing a window

On Year Plan, "Publish through the end of week N" makes those weeks live: staff see them, adherence and offers use them, and they are locked from re-solving. Later weeks stay planned and are not shown to staff. The date is stored as `schedule_versions.publish_through`; every screen that reads a published schedule respects it. Publishing an older, overlapping schedule archives it, so publish the first window of a plan when you are ready for it to replace the current one.

## Re-solving as weeks come closer

"Re-solve the next N weeks" rebuilds the planned weeks after the locked ones on today's forecast and repeats the new cycle after them. It never touches locked weeks, weeks that are over, or shifts someone edited by hand (those stay, their cover counts, and the person is not offered another shift that day). A schedule published in full cannot be re-solved; publish it through a date first.

## What this does not do

- It does not solve 52 weeks of named shifts as one problem, and does not claim an optimal year. Each window reports its own status and coverage.
- Repeated weeks are only as good as the cycle they repeat. They can differ from the demand of that week (public holidays, a campaign) until they are re-solved.
- Rotation lines are derived from the plan. They are not the same thing as Rotation Patterns (the fixed 4-on-4-off style rosters), which are a separate feature.

## Tests

`backend/gateway/test/longPlan.test.ts` builds 13 weeks in the background, checks progress, the repeat, the year view, the lines, windowed publish, re-solving with locked weeks untouched, the refusal on a fully published schedule, cancellation, the readiness view for 26 weeks, and the stress test.
