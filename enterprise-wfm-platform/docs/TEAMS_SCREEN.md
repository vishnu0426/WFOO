# Workforce > Teams: keeping supervisor routing from silently breaking

Alerts, approvals and "my team" views go to a team's lead, so a team with no lead is a setup problem, not a blank.

- **Setup warning.** When active teams have no lead, a box at the top says "N teams have no lead." and what breaks, with **Assign leads**. It opens a picker on each such team (only people marked as supervisors are
  offered; the picker can show everyone and offers to mark the person chosen) and **Assign** saves it. In the table a leadless team says "No lead: assign" (amber, a button) instead of a quiet "None".
- **Spread notice.** When one team holds 90% or more of the people who are in a team (and there are at least 20 of them and two or more teams) a note says so, for example "30 of the 31 people who are in a team are in
  Alpha", and points to Employees > Assign team.
- **Delete is no longer beside Edit.** Each row has Edit and a "more actions" menu (Set reporting lines, Delete team...).
- **Delete names who is affected.** The dialog lists who is in the team (the first eight, and how many more). The server refuses to delete a team that still has people, so the dialog asks which team to move them to,
  moves them (only their team changes, not their own reporting line), then deletes the team, with a reason recorded in the history. An empty team says nobody is in it and deletes with a reason.

Code: `src/components/workforce/TeamsExtras.tsx` (used by `WorkforceHub.tsx`). Check: `qa/teams-check.mjs` (19 checks in Chrome: the warning and its count, "No lead: assign", the spread note, no trash icon, the menu,
assigning a lead inline, the delete dialog naming the person and refusing until a team and a reason are given, the person moved and not deleted, an empty team deleted, no serious accessibility violations, no console errors).

Not done: the Today page does not yet list "teams without a lead" in its attention rail; only active teams are counted (an inactive team is not routed to); the count and spread note use the teams shown (up to 100 at a time, or the search result).
