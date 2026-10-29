# Rotation patterns

A rotation puts people on a fixed repeating pattern instead of matching shifts to a forecast each period. Scheduling › Rotation Patterns.

## Two kinds
* **Repeat a day cycle** (4-on-4-off, 2-2-3, DuPont): a sequence of 2 to 84 days, each a shift template or a day off. Crews run the same cycle a number of days apart.
* **Rotate weekly templates**: a list of weekly templates (seven days each), each worked for one or more weeks, then the next (a week of days, then a week of lates). The rotation is at most 12 weeks. The anchor date must be the first day of the group's pay week, and crews start a whole number of weeks apart. It is stored as the day cycle it unrolls to (`kind = WEEKLY`, `steps`, and the compiled `sequence`), so generating shifts is the same code for both.

## Ready-made patterns
4-on-4-off, 4-on-4-off days then nights, 2-2-3 (also called Panama), DuPont, five on two off, and two weekly rotations. A preset fills the shape; you point each shift letter at one of your own templates, and everything can be edited afterwards. Cycle lengths follow the commonly published forms; sources differ on some. Fixed day crews and night crews (Pitman as usually described) are not represented, because every crew in a pattern runs the same sequence.

## What the pattern means (before anyone is on it)
`POST /scheduling/rotations/analyse`, shown live as the pattern is edited: average hours a week, the most hours and days in any seven, the longest run of working days, the shortest rest between shifts (including where the cycle wraps), weekend days a week and the share of weekends fully off, per crew, with warnings against the company limits (Configuration › Scheduling Rules) and the group's full-time hours.

## Starting position
Each person can start at a point in the pattern instead of following their crew: a cycle day, or the first day of a week of a weekly rotation. They are on that point on the day they join (their start date, else the anchor date). `rotation_members.start_cycle_day`.

## Does it cover the demand?
`GET /scheduling/rotations/:id/preview`: the saved pattern with the people in it now against the staffing target (published forecast, or manual coverage windows) for the next 7 to 28 days. Nothing is generated.

## Filling the gaps
`POST /scheduling/versions` with `fillFromVersionId` makes a separate draft that schedules the people who are **not** in the rotation's crews against the need the rotation leaves short. The rotation's people are counted as covering (the same carry-over the schedule uses for shifts running past midnight), so the new draft's coverage view shows both together. The rotation roster itself is not changed.

## Time off
A rotation does not put anyone on a shift during approved time off. This holds when the roster is generated, and afterwards: approving leave (by a manager, or automatically in self-service) takes the person off their rotation shifts from today on, and cancelling it puts the shifts back. Days already past are never touched, and a request nobody has approved changes nothing. Generating reports how many shifts were left out for leave (`leaveShiftsSkipped`), and the coverage preview counts the leave as a gap.

## Gaps left, offered as overtime
Scheduling › VTO & Overtime has a "Gaps still to cover" card: for the next 3, 7 or 14 days it lists the stretches where the published roster has fewer people than the staffing target, with the hours short. A rotation and the schedule that fills its gaps are published side by side and are counted together. A rotation with no forecast is measured against the group's coverage windows. "Offer overtime" fills in the offer form for that stretch. The offer then goes through the usual rules: everyone who can take it without breaking a limit is asked, in the organisation's order, and that includes crew members on a day off. People on approved leave, and people the company's weekly limits would stop, are not asked.

## Not done
Rotation crews with fixed day and night roles (Pitman) cannot be represented. A crew member cannot be given extra work as part of the fill itself; it goes through an overtime offer, which they can accept or decline.
