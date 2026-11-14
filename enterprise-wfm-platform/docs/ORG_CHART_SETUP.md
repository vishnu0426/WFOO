# Workforce > Org chart: setting reporting lines up

When people have no reporting line the chart is empty, so the screen treats that as a task rather than a footnote.

- **Banner.** At the top: "Assign managers to 382 people" with why it matters (the chart cannot show who is under whom; approvals and alerts that follow reporting lines have nowhere to go). Amber when 20% or more
  of people have no line, blue below that. People who lead nobody and report to nobody are the ones counted. Three ways to fix it:
  1. **Set from teams.** Every team lead becomes the manager of the people in their team, all teams at once. The dialog says first what will happen (people set, in how many teams), warns about teams that have no
     lead yet (their people cannot be set until the team has one) and about people in no team, offers "also change people who already report to someone else", needs a reason, and lists each team. A lead is never
     put under themselves, and a line that would make a loop (A under B under A) is skipped and counted. Doing it twice changes nothing.
  2. **Import from a file.** Two columns: `employee_number` and `reports_to_number`. The file the chart exports works as it is (fill in `reports_to_number`, load it back; a row with no manager is left alone, never
     read as "remove the line"). The file is checked first: how many lines will be set, how many are already as in the file, which rows cannot be used and why (unknown number, someone who has left, themselves, a loop).
     Nothing changes until it is applied with a reason; rows with a problem are skipped, the rest are applied.
  3. **Choose one by one.** The existing list with a picker on each person.
- The "N people, M with no line, Show them" text became "N people, M with a line"; the empty state points at these actions.

API (all need `workforce:write` except the preview): `GET /workforce/org-chart/setup?groupId=` (what Set from teams would do), `POST /workforce/org-chart/apply-teams` `{ overwrite, groupId?, reason }`,
`POST /workforce/org-chart/import` `{ csv, dryRun, reason }`. Both writes are audited with the counts. Loop and self checks are in `reportingLines.ts` (pure, tested).

Tests: `test/reportingLines.test.ts` (8, no stack: the loop rules and the file parsing), `test/orgSetupApi.test.ts` (6: preview counts, reason required, existing lines left alone, overwrite, a loop skipped,
file checked then applied, the exported file taken back as "nothing to do", bad columns), `qa/org-check.mjs` (20 in Chrome: the banner and its place, the dialog's numbers and warnings, applying and the banner count
dropping, the chart showing the leads, the file checked and then applied, the download, no serious accessibility violations, no console errors).

Found and fixed while testing: the preview counted people in a team with no lead as zero (a NULL comparison).
Not done: the per-team "Set reporting lines" button on the Teams screen still exists and is unchanged; a person's manager is not suggested from their team when they are added; the import only sets lines (it cannot clear one).
