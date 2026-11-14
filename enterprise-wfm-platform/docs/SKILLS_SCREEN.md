# Workforce > Skills: seeing coverage risk

Planners need to see which skills are thinly covered before an absence leaves a queue without one.

- **Who holds it, honestly.** The People column counts people who can actually be scheduled (active). Someone who has left, is suspended or is still onboarding is not counted; "+N not active" says how many more
  are on record. (The old count included them, which hid risk.)
- **A link to those people.** The number opens Employees already filtered to active people who hold the skill (`/workforce/employees?skill=<id>&status=ACTIVE`; the same link form works from anywhere).
- **Levels.** A small bar shows how the holders are spread over levels 1 to 5 (darker is more skilled); hover for the counts.
- **Coverage flag.** A skill is flagged **Thin** (fewer than N people) or **Nobody**. N defaults to 3 and is set above the table ("Flag skills held by fewer than N people"; kept in this browser). A skill that a
  WFM group requires is judged by the people *qualified for that group* (in the group and at or above the level it asks for), so ten people with French at level 1 do not hide that only one can meet level 4. Nobody
  holding a skill that no group requires is shown as a note, not as an alarm. A summary line above the table counts the skills at risk.
  The rules are in `backend/gateway/src/modules/skillCoverage.ts` (pure, tested); `GET /workforce/skills?thin=N` returns `activeHolders`, `levels`, `requiredBy` (group, level asked, people qualified) and `risk`.
- **Less noise.** The code moved into a tooltip on the name (a screen reader still hears it). The Certification column appears only when some skill requires certification.
- **Delete** is behind a "more actions" menu and names who loses the skill (up to eight names and the count) and which WFM groups lose a requirement, because deleting a skill removes it from the groups that need it.

Tests: `test/skillCoverage.test.ts` (7, no stack), `test/skillCoverageApi.test.ts` (6: a suspended person not counted, levels, a group requirement at level 5 with nobody qualified, thin by threshold, an unused skill),
`qa/skills-check.mjs` (20 in Chrome: columns, the code in a tooltip, the summary and flags with reasons, the level bar, the threshold, the link opening exactly those five people, the delete dialog, accessibility, no console errors).

Not done: the threshold is per browser, not a company setting; "qualified" counts people eligible for the group (primary or eligible groups) and active, not whether they are rostered or on leave on a given day; the level bar shows
counts without a legend on the page (the numbers are in the hover text and the accessible name); skills a person holds beyond the 60 the API allows are not a concern here.

## Why a skill says "Nobody" when someone has it, and how to fix it

A skill that a WFM group requires is judged by the people **qualified for that group**: active, at or above the level the group asks for, and **eligible for that group**. So "1 person holds it" and "nobody qualified" can both be
true: the person may simply not be on the group's list. The reason now says which it is:

- "2 people have it at level 3 or higher but are not eligible for Support, which requires it" (they exist, in another group)
- "2 people in Support have it, but below level 4, which Support requires" (they are in the group, too low)
- "Nobody in Support has it at level 3 or higher, and Support requires it"
- "Only 1 person is qualified for Support at level 3 or higher; 2 people more have it but are not eligible for it" (thin)

(The level bar shows proportions, not totals: one person at level 5 fills the whole bar.)

**Fix...** appears beside the reason of a flagged skill that a group requires. It opens a dialog for that group with the two things that can be done, each a list to tick, one reason, one button:
1. **Add people who already have it to the group.** People who hold the skill at the level asked for but are not eligible for the group (shown with their level and home group; all ticked). They become eligible for it; their own group stays.
   `POST /workforce/skills/:id/add-to-group` `{ groupId, employeeIds, reason }` changes only people who really qualify, whatever ids are sent, and does nothing a second time.
2. **Give the skill to people in the group** who lack it or have it below the level (none ticked: a skill is never given by default). Level defaults to the one the group asks for. Uses the existing bulk edit (a level already held is raised).
`GET /workforce/skills/:id/fix?groupId=` lists both. Both are audited with the reason. A skill no group requires has no Fix (there is no group to measure against): select people under Employees and use "Add skill".

Tests added: wording cases in `skillCoverage.test.ts` (11), the fix flow in `skillCoverageApi.test.ts` (9: why nobody is qualified, the lists, only real qualifiers added, reason required, idempotent) and `qa/skills-check.mjs` (29 in Chrome, including the wording and the whole Fix flow).
