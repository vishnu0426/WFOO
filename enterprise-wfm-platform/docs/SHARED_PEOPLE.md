# People in more than one WFM group

A person can belong to several WFM groups (a main group, plus groups they are allowed to work in). They still have one body: the schedules of all their groups are checked together.

## What counts across groups

Only **published** schedules of other groups count when a schedule is built or checked.

| Rule | What happens |
|---|---|
| One shift a day | A day worked for another group is closed for this group, whatever the time. |
| Rest | The minimum rest between shifts also applies between a shift here and one for another group, the day before or after. |
| The week's hours | Hours worked for other groups count toward the person's weekly maximum and toward the contract target (a person already at 40 h elsewhere is not pushed to work 40 h more here). |
| Days in the week, days in a row | Days for other groups count toward both. |

The solver gets this as the new `ext_paid` field per person (paid slots per day worked for another group, `backend/proto/wfm.proto`). Every solver path uses it: CP-SAT, HiGHS, SCIP and the greedy starting roster.

## While building

- **Generate Schedule › Ready to generate?** lists other drafts that plan the same people for the same dates (red) and other groups that already have published shifts for them (info).
- The build report (Schedule Quality) says the same: `OVERLAPPING_DRAFT` (warning, names the person and the other schedule) and `SHARED_PEOPLE` (info).
- Drafts never block each other. Whichever is published first takes the shared people; the other is refused at publishing with the reason (rule violations name the other group).

## At publishing and on edits

The rule check counts the same things, so a hand-added or moved shift that breaks a limit counted with another group shows up as a violation (`REST`, `CONSECUTIVE`, `WEEKLY_MAX`, `DAYS_PER_WEEK`, `DOUBLE_BOOKED`). The message says how much of it is for which group.

## Home group

A person's **main WFM group** (set on their profile) is their home group; the other groups they are allowed in treat them as **guests**.

- While building a guest group, a guest gets only the time the home group leaves free: his home group's shifts count (published, or its newest draft) and the days its schedules do not cover yet are held back. The week's limits above are shared as usual.
- If the home group has no schedule for the dates, the guest is held back for all of them. The build report says so (`GUESTS`, warning), and a build where nobody else is left explains why.
- **Generate Schedule › Who to schedule › People from other home groups**: "Only the time their home group leaves free" (default) or "Use them even if their home group is not scheduled" (the old behaviour, API: `guests: 'ALWAYS'`).
- Groups whose pool is set by required skills are not affected: they draw from everyone with the skills.
- Regenerating repeats the choice.

## Known limits

- Other groups' shifts **after** the last day of a schedule, in the same pay week, are not counted while building (a schedule that ends mid-week). They are counted when the schedule is checked at publishing.
- Only published schedules count while building. Draft against draft is a warning, not a block.
- Shifts split across two groups in one day are not supported (one shift a day).

The home group's published schedule always wins over a guest group's, because it is checked first. If a guest group publishes before the home group has built, the home group is the one that is then blocked: that is why the default holds guests back until the home group is scheduled.

Tests: `backend/engine/test_scheduling.py` (days, hours and runs worked elsewhere, all solvers), `backend/gateway/test/crossGroup.test.ts` (rest and checks), `backend/gateway/test/crossGroupApi.test.ts` (a real build with one person in two groups).
