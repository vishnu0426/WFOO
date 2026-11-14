# Workforce > Time & Attendance: a week you can scan

Before, the page listed every scheduled person-day in one table (351 rows, about 16,700 px tall). Every row said "Missed punch" in red, there were no counts or filters, and the add-a-punch form sat at the very end. Now:

- **One row per person**, with the seven days of the pay week across, then Scheduled, Worked, Variance and Overtime. A page of people at a time (25, 50, 100 or 200; Previous / Next; "Showing 26–50 of 80 people"), the people with the most problems first.
- **Day cells say what happened in words, not only colour:** *OK 8.0*, *Late 12m*, *Early 1h*, *Missed*, *Clocked in* (no clock-out yet), *Extra 9.0* (punches on a day they were not scheduled), *Not due* (the shift has not finished), *–* (nothing scheduled or punched).
- **Chips along the top count person-days and are the filters:** All days, Missed punch, Late, Early leave, Still clocked in, Not scheduled, Not due yet, OK. Click one to show only the people who have such a day (the matching days are underlined in the row); click it again to clear. The counts always cover the whole week (for the people matching the search), whatever is filtered or paged. A day that is both late and an early leave counts under both, so the chips can add up to more than "All days".
- **Search** by name or employee number.
- **Click a person** and a side panel shows each day: the scheduled shift, what was said about it ("Late by 30m"), every punch (marked "by hand" when added manually) with a remove button, and an **Add a punch** link for that day.
- **Add a punch** is a header button that opens a side panel (person, day, clock in, clock out, note). A clock-out earlier than the clock-in is read as the next morning, as in the file import. Removing a punch asks first.
- **Import punches, CSV template and Payroll export** are unchanged.

## What the words mean

All judged against the published shift for the day, with the **grace** from the scheduling policy's adherence grace (5 minutes by default; at least 1 minute):

| Word | When |
|---|---|
| Late | the first clock-in is later than the shift start by more than the grace |
| Early leave | everyone is clocked out and the last clock-out is earlier than the shift end by more than the grace |
| Missed punch | a scheduled day with no punch at all, **once the shift is over** (plus the grace). Before that it is *Not due yet* (so today's later shifts and the rest of the week are not "missed") |
| Still clocked in | a punch with no clock-out |
| Not scheduled | punches on a day with no published shift |
| OK | none of the above |

A split shift is judged from its first start to its last end and its hours add up (before, only the last shift's hours were used). Times: punches are wall-clock times (the time-clock file's own clock, stored as if UTC, the same as the import and the manual form), compared with the schedule's wall-clock slots; the group's time zone is used only to decide whether a shift is over yet.

## Excusing a problem

A manager can excuse a missed punch, a late arrival, an early leave or a punch left open, so the day stops counting as a problem and shows who dealt with it and why.

- **One day:** open a person, then **Excuse…** on the day. Choose which of the day's problems to excuse, a reason (*Approved absence not entered*, *Clock or badge fault*, *System outage*, *Worked at another site*, *Manager decision*, *Other*, which needs a note), an optional note, and, for a missed punch, whether to **pay the scheduled hours**. The day then reads "Excused: Missed punch", with the reason, note and who excused it, and an **Undo**.
- **Many at once:** with a problem chip selected (Missed punch, Late, Early leave or Still clocked in) an **Excuse all N …** button excuses every such day under the current filter and search, on every page (a clock outage that hit the whole floor). The server finds them itself, up to 2,000 at a time.
- An excused day counts under its own **Excused** chip and drops out of the Missed / Late / Early chips. A day that is both late and an early leave and has only the late excused stays an early leave. An excuse for something the day does not have is ignored.
- **Who may:** the same rule as leave: a manager (or scheduler) for anyone, a supervisor for people in a team they supervise or cover, never for themselves. Excusing needs workforce write or the request-approval permission; everyone with read access sees the result.
- **Closed periods:** a day inside a payroll run that is approved or exported cannot be excused or un-excused (409 PAY_PERIOD_LOCKED, "reopen that payroll run first"). A day that has not happened yet cannot be excused.
- **Pay:** an excused missed day is exported as `EXCUSED` in the payroll export on this screen, with the scheduled hours as regular hours when it was excused as paid and none otherwise. The main Payroll run (Workforce > Payroll) does not read excuses yet.
- Every excuse and undo is written to the audit log.

API: `POST /attendance/exceptions` `{ items: [{ employeeId, day, kind }] (1–500), reasonCode, note, paid }`; `POST /attendance/exceptions/by-filter` `{ groupId, from, to, issue, q, reasonCode, note, paid }`; `GET /attendance/exceptions?from=&to=&employeeId=`; `DELETE /attendance/exceptions/:id`. The week and summary days carry `excused: [{ id, kind, reasonCode, note, paid, level, by, at }]`, `paidExcuse`, and the summary status `EXCUSED` for an excused missed day.

## The daily note

Once a group's local morning has come (07:00 by default), the people who look after each team get one note about **yesterday's problems nobody has excused**: *"Attendance to review for 2026-11-11: 3. North: 2 missed, 1 late. Open Time & Attendance to excuse or follow up."* One note per person per group per day, not one per event. Supervisors get their own team's people when the organisation works supervisor-first and the team has a supervisor; otherwise (and for people with no team) the managers do. If nearly every scheduled day has no punch, managers get *"Time-clock punches look missing for 2026-11-11"* instead of a list. What has been sent is remembered (`attendance_digest_log`), so a restart does not resend it. `ATTENDANCE_DIGEST=off` turns it off, `ATTENDANCE_DIGEST_HOUR` changes the hour, `ATTENDANCE_DIGEST_TICK_SECONDS` how often it checks (default 900). `POST /attendance/digest { groupId, day?, force? }` (workforce write) sends one now. The note arrives in the person's inbox, by push and by their email or SMS settings, like other notifications; it is not a new notification type, so it cannot yet be switched off separately in a person's notification settings.

## When the time-clock file has not been loaded

If at least 10 scheduled days are over and at least 90% of them have no punch at all, the page says once, in an information banner, *"Almost no punches for this week. 351 of 351 scheduled days that are over have no punch, which usually means the time-clock file has not been imported yet"* and shows those cells in grey as "No punch" instead of red "Missed". The Missed chip keeps its true count. (It is almost never 351 people not turning up.)

Variance (worked minus scheduled) only counts days that are over, so a shift later in the week is not "8 hours short".

## API

`GET /attendance/week?from=&to=&groupId=&issue=&q=&limit=&offset=` returns `{ counts, feedMissing, total, people: [{ employeeNumber, name, scheduledHours, actualHours, varianceHours, overtimeHours, problems, days: [{ day, shift, status, issues, lateMinutes, earlyLeaveMinutes, due, punches: [{ id, clockIn, clockOut, source }] }] }], graceMinutes, payStart }`. `issue` is one of missed, late, early, open, unscheduled, upcoming, ok (400 otherwise). A supervisor limited to their own teams only sees their people (also on `/attendance/summary` and the payroll export, which were not scoped before).

`GET /attendance/summary` (used by the Attendance report and the payroll export) keeps its shape and adds `lateMinutes`, `earlyLeaveMinutes`, `due`, `issues`, `shift` and punch ids. Its `status` gains one value, **UPCOMING**, for a scheduled day that has not happened yet (it used to say MISSED); Late and Early leave are flags, not statuses, so a late day is still MATCHED for payroll. The payroll export's columns are unchanged and a not-yet-due day is now exported as UPCOMING instead of MISSED.

## Tests

`test/attendanceMath.test.ts` (23, including excuses and the daily note's grouping: no stack: the rules above, overnight and split shifts, the missing-feed rule, counts, the week view, filtering, search, paging, variance over finished days), `test/attendanceExceptionsApi.test.ts` (9: excusing and its effect on the week, changing the reason, excusing one of two problems, refusals (Other without a note, a future day, an unknown person, a role that may not), undo, excusing everything under a filter, paid versus unpaid in the export, a closed payroll period, the daily note once a day and its permissions), `qa/attendance-exceptions-check.mjs` (17 in Chrome: the dialog, "Other" needs a note, Escape, excusing and its chips, Undo, "Excuse all N" across pages, accessibility), `test/attendanceWeekApi.test.ts` (6: a published schedule with shifts 00:00–02:00 today and real punches giving on time, late, early leave, still clocked in and missed; filter, paging and search with counts that do not change; tomorrow is "not due yet"; the missing-file rule; the older summary and payroll export; read versus add permission), `qa/attendance-check.mjs` (24 in Chrome: one row per person, the day columns, chip counts equal the server's, filtering and clearing, search, a person's panel, adding and removing a punch, "Add a punch" in the header, the missing-file note and grey cells, paging 25 / next, page height, no serious accessibility violations with the panel open and closed, no console errors).

## Found while testing

- `clock_in::text` depends on the database session's time zone (on a server set to IST a 00:02 punch came back as 05:32+05:30). The attendance screen now reads punches explicitly as UTC wall-clock text.
- Payroll (`payroll.ts`) reads the same punches as real instants and converts them into the employee's zone, while the screen, the file import and the manual form treat them as wall-clock times. For an employee outside UTC the two disagree by their offset. Not changed here (it is a payroll-wide decision); worth settling before payroll goes live.
- Shifts are rostered with the shift templates' times, so a group with employees in several time zones is compared by wall-clock only.

## Not done

- Servers still compute the whole week for the group and page it, so one request at 50,000 people is not small (the response is, the work is not). It was not timed at that size.
- The punch list and delete endpoints are not team-scoped for limited supervisors.
- An employee cannot explain or dispute a missed punch themselves; only a manager or supervisor excuses it. The daily note cannot be switched off per person.
- The Payroll run does not read excuses (only the simple export on this screen does).
- Excusing is a manager's decision only; there is no approval step on top of it and no limit on how many a person can have excused.
- Only the pay week containing the chosen date is shown; there is no month view.
