# Workforce > Availability: the team-week grid

The page opens on a **team-week grid** instead of an empty page: people down the side, Monday to Sunday across, each cell showing what that person can do that day. It opens on the largest team; pick another team,
a WFM group, or search. (Setting up a new team of 30 is one drag and one save instead of 30 pick-and-edit rounds.)

- **Cells.** *Any time* (nothing entered: any time a shift template allows), *9–17* (only available in those hours), *Prefers 6–10*, *Off*, *Not 12–14:30* (part of the day blocked), *2 rules* (a day with a mix).
- **Paint.** Choose what to paint (Any time, Off all day, Only available + hours, Prefers + hours), then click a cell or drag across many: people and days together, in one gesture. With "Select cells" chosen you select first,
  then choose a paint and press "Paint N selected cells". The weekday headers select that day for everyone shown. Hours that end before they start are refused with a reason.
- **Apply to selected people.** Tick people, choose the days (Mon to Fri by default) and a paint, press "Apply to N selected people".
- **Copy week.** "Copy week" on a row, then "Paste to N selected" or "Paste to everyone shown".
- **Held until saved.** Everything above changes the screen only: edited people are marked, a bar says "N people have unsaved changes" with **Save** and **Discard**, and the team/group/search filters wait until you save or discard.
  One save writes everyone in one call, all or nothing.
- **Details.** "Details" on a row opens the one-person editor below the grid (it also edits windows that apply only between two dates).
- Windows that apply only between two dates are not part of the recurring week: the grid shows how many a person has ("2 dated rules") and never changes or removes them.
- Read-only for people without write access (they see the grid, no paint, tick or save).

API: `GET /workforce/availability/grid?teamId=&groupId=&q=&limit=&offset=` (people with their recurring windows and a count of dated ones; a supervisor with a team limit only sees their people), and
`PUT /workforce/availability/bulk` `{ people: [{ employeeId, windows }] }` (replaces each person's recurring week, refuses a window that ends before it starts or one with dates, 404 for anyone not there and then saves
nobody, audited per person, drops the scheduler's cached view). Rules of the grid (what a day shows, what painting does, copying, selecting a drag) are in `src/components/workforce/availabilityRules.ts`.

Tests: `test/availabilityGrid.test.ts` (12, no stack), `test/availabilityGridApi.test.ts` (5: the team list and paging, one call for many people, dated windows left alone, a bad window or missing person saves nobody, read-only
access), `qa/availability-check.mjs` (24 in Chrome with a team of 30: opens on the grid, one drag paints the weekend off for all 30, nothing is saved until Save, apply to the ten ticked, copy week, a one-cell preference,
refused hours, one save writes all 30, discard, details, no accessibility violations, no console errors).

Found while testing: the team list used for "pick a team" had no head-counts (`?fields=pick`), so the default team could be an empty one; the grid uses the full list.
Not done: overnight windows (a window must end after it starts on the same day); copying a week across days within one person; the saved week applies to every future schedule, not a date range (use Details for a dated rule).
