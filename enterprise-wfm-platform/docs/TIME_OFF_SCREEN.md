# Workforce > Time Off: decide leave with the cover in front of you

Before, the page was one table with Approve and Reject links. A manager approved leave without seeing whether the day was already short-staffed, which is the main risk in a leave decision. Now:

- **List or Calendar.** A List / Calendar switch at the top. The list keeps the status filter ("All requests", Waiting, Approved, Declined, Cancelled). The calendar is a month grid (Monday first): one chip per person per day, yellow for waiting and green for approved, waiting ones first, "+N more" when a day has more than three. Click a chip to open the request. It follows the same status filter (waiting and approved by default).
- **Approval drawer.** Click a name, a chip or *Review* and a drawer opens with the person, the dates, and:
  - **Headline** in plain words: *"Approving leaves Tue 03-05 10:00–12:00 at 82% coverage."* (the worst stretch on any day the person works; red when the day falls below the target, amber when it stays above it, green when the team stays covered).
  - **Checks:** their balance for that leave type (*"Vacation balance: 17 days left; this uses 5, leaving 12"*), the team's daily limit on people off (the self-service "most people off at once" percentage), blackout dates and daily limits from the leave rules.
  - **Cover on each day:** a table per day: are they working, cover now, cover if approved, and the weakest stretch ("11:00–17:00 at 67% (3 short)"). The target is the scheduling policy's target coverage (90% by default).
  - **Decide:** *Approve* when every check passes; otherwise *Approve anyway…* (a reason is required and is kept with the request), *Decline…* (reason required), and *Withdraw request…* / *Cancel leave…* for approved leave.
- **Inline actions.** *Approve* in a row approves at once if the request passes every check; if not, it opens the drawer to show what is in the way (it never approves a risky request on one click). *Decline* opens the drawer.
- **Bulk.** Tick waiting requests (only waiting rows have a tick box; the header box ticks all of them). A bar shows *"Approve N that pass the rules"* and *"Decline N…"*. Bulk approve approves only the requests that pass every check and leaves the rest waiting; the result says how many were approved and, for each one left, why. Bulk decline needs a reason. Up to 50 at a time.

## What "passes the rules" means

A waiting request passes only when all of these hold:

1. no blackout date or daily limit applies (strict rules block; softer ones need a manager's eye, so they do not pass);
2. the person has enough balance left for that leave type (types with no yearly allowance have no balance to run out of);
3. approving does not put more people off than the team limit allows on any day;
4. on every day the person is scheduled to work, cover after taking them off stays at or above the target;
5. a day they work that could not be judged (no forecast or weekly coverage template reaches it) does not pass: not knowing is not the same as being safe.

**People in more than one group.** A person has one shift a day across all groups, so each day is judged in the group whose published schedule holds that day's shift (days they do not work are shown against their primary group). When more than one group is involved the drawer names the group on each day. Blackout dates and daily limits of every group they are rostered in on those days, and of their primary group, all apply.

A day with no published schedule for the group is shown as "No schedule published yet" and not judged (it would read 0% for a reason that has nothing to do with the leave); if the person is not on it, approving takes nothing off anything.

## How cover is worked out

Coverage on a day = the sum over its 15-minute slots of min(staffed, needed) divided by the sum of needed. Needed comes from the group's published short-term forecast (long-term projection where the short forecast does not reach), else from the group's weekly coverage template. Staffed comes from the published schedule: everyone rostered in the group except those already on approved leave that day, and meals and split-shift gaps do not count (the same rule the timeline and the shortage report use). "Now" includes the person; "If approved" takes their shifts off the days of the leave. Overnight shifts from the day before still count towards the first hours. Slots nobody needs neither help nor hurt: an overstaffed slot cannot make up for a short one. The worst stretch is the longest run of slots where the person works and the others alone fall short, with the share of the need the others cover over that run.

API:

- `GET /workforce/time-off/:id/impact` (needs workforce:read or requests:approve; a supervisor limited to their teams only sees theirs): request, balance, rules, team limit, coverage per day with the headline and tone, `passes: { ok, why[] }`. Requests longer than 62 days are judged for their first 62.
- `POST /workforce/time-off/bulk-decide` `{ ids (1–50), status: APPROVED | REJECTED, reason?, onlyIfPasses (default true) }` returns `{ decided, skipped, requests, left: [{ id, employeeName, why[] }] }`. Each request is its own transaction, so one that cannot be decided does not undo the others. It goes through the same `decideTimeOff()` as `POST /workforce/time-off/:id/decide`, so double-booking checks, who may decide (supervisor vs manager), notifications, audit and the roster reconciliation are identical.

Tests: `test/timeOffMath.test.ts` (19, no stack: coverage percent, short stretches, day impact, headline wording, the pass rules), `test/timeOffImpactApi.test.ts` (8, including a person who works some days in their home group and the rest in another, judged per day and with the other group's blackout applied: cover for a worked day equals what the published shifts add up to, a day not worked changes nothing, a strict blackout is not passed and bulk leaves it waiting with the reason, bulk approves exactly those whose own checks pass and a second call decides nothing twice, bulk decline needs a reason, bad input, read vs decide permission), `qa/timeoff-check.mjs` (23 in Chrome: list and calendar, tick box first, drawer contents, bulk approval leaving the blackout one with its reason, calendar chip and drawer headline matching the API, approve anyway and decline need a reason, Escape closes the drawer, no serious accessibility violations on the drawer or the calendar, no console errors).

Found while testing:

- The app-wide Escape handler presses the last button whose label starts with "Cancel", so Escape in a drawer holding *Cancel leave…* opened that confirmation. The drawer's overlay is now the `role="dialog"` element, which that handler leaves alone.
- `rotationLeaveGaps` "counts a rotation and the schedule filling its gaps together" was failing for a reason that is not a bug: with 4 people needed and exactly 4 rostered, any meal leaves cover short (meals are not cover), so Monday, with nobody on leave, shows the same kind of gap. The test asserted "Tuesday has no gap at all"; it now asserts what it meant: the fill removes the whole-shift gap left by the person on leave and Tuesday is only short around meals, like a day with nobody on leave.
- Two older suites had date problems, not related to leave decisions: `timeOffRules` (the monthly-accrual test collided with a request another test makes about 60 days out; it now uses a year nobody else books) and `rotationLeaveGaps` (a hard-coded Monday that had passed; it is now two to three weeks ahead).

Not done / limits:

- The team limit on people off at once is still counted in the person's primary group only (the policy percentage is of a group's size); cover and rules are per rostered group (see above).
- The calendar starts weeks on Monday regardless of the configured pay week, and shows a month at a time (no week or team-filtered view).
- Overtime offers, swaps or VTO that could fill the gap are not suggested in the drawer.
- Not tested against a large tenant: the impact call loads the group's shifts for the leave days, which is fine for hundreds of people but was not timed for a 6,000-person group.
