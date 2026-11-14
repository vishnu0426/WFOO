# Workforce > Employees: what a supervisor can answer from here

A supervisor opens an employee to answer "where is this person this week, and are they OK?". The side panel now answers it without three or four more screens.

## The table
- **The checkbox is the first column** (pinned left, before the name). It used to sit between the name and Team.
- **Default columns fit a 1280 px screen:** Employee (pinned), Team, WFM group, Contract, Skills (takes the spare width), Status. **Columns** (top right of the table) switches Employment type, Shift times, Email and Agent
  extension on, and any of them off; the choice is remembered in the browser. Email is a column of its own, with the full address on hover.
- **A bar appears at the bottom of the screen as soon as anyone is selected** and stays in view while the list scrolls: how many are selected (or all that match the filters), **Assign team, Assign group, Add skill,
  Set contract** (each opens the bulk editor with that one change already ticked, a reason is still required and kept per person), **Edit selected** (every field), **Export CSV**, **Clear selection**. It steps aside
  while the bulk editor is open.
- **Export CSV** writes the people selected (or everyone the filters match, fetched 500 at a time) with number, name, email, extension, team, group, type, contract and maximum hours, status and skills. A cell that starts
  with `=`, `+`, `-` or `@` is written as text, so a spreadsheet cannot run it as a formula.

## The side panel (click a row)
| Tab | What it shows |
|---|---|
| **Overview** | **Right now:** doing what is scheduled, out of adherence (and for how long), state unreadable, or not scheduled, with the scheduled and actual activity (the same judgement the Adherence screen uses). **This week:** the pay week's seven days, each with the published shift (start, end, paid hours, overnight), approved or requested time off, or "Off", and the paid hours against the contract with "Below contract" or "Over their maximum". **Adherence, last 7 days:** adherent minutes over scheduled minutes of the finished days kept. **Leave balances this year** and what is coming up (the same figures the person sees in the app) |
| **Contract** | Assignment (team, group, with a quick assign), contact, hours, days per week, start and end times |
| **Skills** | Edited in place: add, remove, change the level, Save skills (audited). Read-only without write access |
| **Availability** | When they can and cannot work (available, not available, prefers), with a link to the Availability screen |
| **Login** | The app login: create one, reset the password |

How it is worked out (`backend/gateway/src/modules/employeeGlance.ts`, `GET /workforce/employees/:id/glance`): paid time of a shift is its length less an unpaid meal or split-shift gap (a paid meal stays in, breaks stay in);
the week starts on the group's pay-week day, in the group's time zone; only **published** shifts count (a draft is not where anyone is); adherence is total adherent minutes over total scheduled minutes, never an average of
percentages; "Adherence, last 7 days" is empty (and says so) until finished days have been judged and kept. A team-limited supervisor only gets people in their scope.

## Also fixed
- An **agent extension that is an email address** is refused when saving (`400`): it looked like a mix-up in the data. Existing values are not changed.
- The filter buttons (WFM groups, Teams, Status, Skills) now have names that start with what they show, which the accessibility check required.
- AG Grid's deprecated tooltip options were replaced.

## Tests
- `test/employeeGlance.test.ts` (4, no stack): paid hours, the week, over-maximum, overnight, by hand.
- `test/employeeGlanceApi.test.ts` (4): a real published schedule with meals (8 paid hours from a 9 hour shift with an unpaid hour), approved leave, balances, no invented adherence, 404, extension refused.
- `qa/employees-check.mjs` (27, Chrome at 1280 px): checkbox first, columns fit, bar appears and is on screen, export file contents, quick assign opens with the change ticked, column choice remembered, five tabs and what each
  shows, no serious accessibility violations, no console errors.

Not done: the Overview tab shows today's status but not a timeline of today's activities; leave balances are the policy's (entitlement, carried over, used), not payroll's; the review's "Agent extension shows an email" was not
reproduced (the field showed what was stored), so the fix refuses new bad values rather than changing stored ones.
