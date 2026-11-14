# Schedule Timeline: a full-height workspace with an issues panel

Scheduling > Schedule Timeline, the planner's most-used screen.

## What it was like

The day's timeline started about 520 px down, below the fold on a 1280 x 665 screen, in a fixed-height box inside a scrolling page (two scrolls) that showed about 8 rows. The time axis began where the first shift began, so afternoons needed sideways scrolling. Agents sorted as text (First10, First100, First11…). The agent filter said 129 while the summary said 351 people. The violations list was plain text far below the timeline, with no way to jump to a person, and it said "must be fixed before publishing" on a schedule that was already published. Finding and fixing one violation took 8+ actions and about 2,000 px of scrolling.

## What it is now

- **The schedule fills the screen.** The page scrolls inside its own frame (as the Forecasting pages do), so the toolbar stays put. On opening a schedule the page scrolls once so the day sits just under the toolbar and the timeline fills the rest of the screen: on a 665 px screen it starts at 359 px and runs to the bottom edge. (If a banner above it has something to say, such as "out of date, Regenerate", the page is left where it is so the banner is seen.) Only two things scroll inside it: the timeline and the panel.
- **A compact two-row toolbar:** the schedule picker with its status, and what can be done with it; then Day/Week, the day buttons with coverage, the date jump, Saved views and View. Search, Filters and "Hide panel" moved down beside the day's title, over what they act on. Undo and Redo moved into the panel (Ctrl+Z and Ctrl+Shift+Z still work).
- **The whole day across the screen by default** (the **Fit** time scale): no sideways scrolling, labels every 1, 2 or 4 hours so they never crowd. The axis covers the hours the day is staffed or needs staffing, whoever is shown, so filtering or thinning the morning does not move the start of the day. 15m, 30m, 1h and 2h are still there for those who want a fixed scale.
- **Only the rows in view are drawn** (a window over the list, with a margin), so a day with hundreds of people scrolls smoothly. Dragging and resizing still work and still ask for a reason first.
- **People in natural order:** First1, First2 … First9, First10, First11 … First100, in the timeline and the roster (and when the roster is sorted by name).
- **An Issues panel beside the schedule** (can be put away on a small screen):
  - **This schedule:** coverage, violations, paid against needed hours, overtime, and the two head counts named apart: "351 people in this schedule · 129 on shift this day". The filter now reads "Everyone on shift this day (129)", the same number in the same words.
  - **Selected person:** click a bar and the panel shows the person, the shift, where it came from, what is wrong with their day, and Their week / Remove shift.
  - **Rule violations:** each is a button. One click opens its day, scrolls to the person's row (opening their team if it was folded), selects it and flashes it; filters that would hide the person are cleared. This day's issues are listed first, then by date.
  - **Short on this day:** each stretch where cover is short, with its time and how short, a click to scroll to it and flash it on the staffing strip, and **Add shift** to fill it.
  - **Labour-law warnings:** the same, for the rules that only warn.
- **The words fit the status.** A draft says "These must be fixed before this schedule can be published." A published schedule says "4 rules are broken in the published schedule. Fix them, then republish." An archived one says it is for reference only.
- **Shift bar labels are readable.** A colour chosen for shifts that is too light for the white label is darkened just enough (a contrast of 4.5 to 1), keeping its hue.
- **The other Scheduling pages** (Generate Schedule, Schedule Quality, All Schedules, Shift Templates and the rest) share the same page frame and now scroll inside it like the Forecasting pages.

## Checked

- 13 unit tests (`scheduleIssues.test.ts`): natural order, fitting a day to a width, which rows are on screen, short windows, ordering and words for the issues panel.
- 37 browser checks (`qa/timeline-check.mjs`, at 1280 x 665 with 130 people and a published schedule that breaks rules): the timeline starts in the top half and fills the screen, the day fits with no sideways scroll, the axis, only the visible rows drawn and the next ones swapped in on scroll, two scrolling areas inside the workspace, the published-schedule wording, every violation a button, the head counts and the filter agreeing, one click from a violation to the person (day opens, row in view and flashing, panel shows what is wrong), short stretches listed and flashing on the strip, selecting a bar, Undo off then naming the edit then putting the shift back, dragging a bar asks for a reason, 1h scale brings sideways scrolling back, Week view, the roster in natural order, the other Scheduling pages open, no sideways page scroll, accessibility scan, console. Seeding is `qa/timeline-seed.mjs`.

## Not covered

- A 351-person day was not measured; 130 people were (the drawn rows are a fixed few either way).
- Week view still draws every person's week (not windowed).
- The default of one screen of Gantt on a very short screen (665 px) is about 4 rows; the panel can be hidden, and the toolbar is two rows, but a taller screen shows more.
- A violation on a day the person has no shift (for example a rest rule across days) says so instead of focusing a row.
- Undo history is still only for this browser tab and the 25 most recent edits, as before.

## Second round: a more compact header, and the Roster as a tab

Bugs found on a 1920 px screen, and what was done:

- **The Filters menu ran off the right edge** (it opens to the left of its button and I had moved the button to the far right). It now opens to the right-aligned side and stays inside the screen.
- **A banner was hidden behind the sticky toolbar.** The page used to scroll itself so the schedule sat under the toolbar; a banner that loaded later ended up behind it. The automatic scroll is gone. The schedule now fills whatever is left of the screen below the toolbar and any banner, so nothing is ever hidden. The out-of-date banner is one slim line ("May be out of date · Demand is 4% higher… · Regenerate · Why"); the detail is behind "Why".
- **The page was not compact.** The page title is one slim line (its sub-title is behind a help mark). The legend is one **Key** button in the corner of the time axis instead of two lines. "Select everyone shown" is a link, "Select all (68)", in the title row, and the bulk bar appears only once someone is ticked. People rows are **compact by default** (a saved choice is kept). Saved views moved up beside Add shift; the time scale (Fit, 15m, 30m, 1h, 2h) sits in the title row, where it can be reached without opening a menu. Undo/Redo and "Hide" are in the panel; a hidden panel leaves a "Show issues" button.
- **Meal blocks no longer read "Meal 1…".** A block shows "Meal 12:00" when it is wide, "Meal" when medium and nothing when too narrow.
- **The fixed time scale in the screenshot** (15m, which shows about 8 hours and scrolls sideways) could not be traced to a cause: the scale is not remembered between visits and the default is Fit. The scale buttons are now always visible in the title row, so it is one click to get back to Fit.

**Roster is a tab** beside Timeline (Timeline | Roster), under the same header, the same filters and search, and the same issues panel. One row per person, one column per day (each headed with its coverage), then Paid hours and Issues. Days that break a rule are red; a person with a violation has a "!" and red name. Only the rows in view are drawn. Options: **Sort** (name in natural order, paid hours, most issues first), **Times / Hours** in the cells, **Group by team** (in the View menu, shared with the timeline; teams fold), search and Filters, and **Export** (CSV, Excel, PDF). Clicking a cell opens that person's day on the timeline, selects them and flashes their row; clicking an issue in the panel does the same. The old Roster grid at the bottom of the page is gone. Quality, Compare and Replay are still separate pages.

Checked: 12 more unit tests (`rosterView.test.ts`) and 56 browser checks in all (`qa/timeline-check.mjs`), including the compact header, Key, the Filters menu inside the screen, compact rows, every Roster option, a cell opening the timeline, and Select all with the bulk bar.

## Third round: it opens at the actual time

- **Opens on today, on the group's own clock.** A schedule used to open on its first day. It now opens on today when today is inside the schedule, else on its first day. A link from the Year Plan still wins. "Today" and "now" are read in the **group's time zone**, not the computer's: a group in Asia/Kolkata at 22:00 UTC is already on the next day at 03:30.
- **The current time is brought into view, once.** On opening, the timeline scrolls so the first people on shift right now are at the top (or the first to start after now, if nobody is on at that moment), and the "now" line marks the time. With a fixed scale wider than the screen it also centres the time. It happens once per schedule per visit and never again after that.
- **The axis names whose clock it is on:** "Time (UTC+5:30)" instead of "Time (local)".
- **A Now button** in the title row (shown when today is inside the schedule) goes back to today and the current time from any day or from the Roster. The "now" line moves each minute.
- Checked: 11 more unit tests (the date and time in four time zones, midnight, an unknown zone, the zone label, which day opens, which row shows at a given time) and 10 browser checks (opens on today, the clock label, the "now" line at the right slot, the first people shown are on shift now, the Now button, and a group in Pacific/Kiritimati). The browser check adapts to the hour it is run: outside the staffed hours it checks that no "now" line is drawn.
- Not covered: the time-zone case in the browser only differs from UTC for part of each day, so the unit tests carry the day-boundary cases. The "first problem" part of the earlier proposal (opening on the day with a violation) is not built.

## Fourth round: more people on screen, and no gap

From a pair of screenshots (Fit against 15m) and the question "why only 5 people?":

- **Row height: compact for everyone, once.** An earlier "Roomy" choice kept 65 px rows (5 people on a 1080 screen). The setting is stored under a new key, so everyone starts on compact; "Row height > Roomy / Compact" in the View menu is still there and the choice made from now on is kept.
- **One slim strip instead of two.** "Staffing net" and "Open need" are one 26 px strip that stays at the top of the timeline: the coloured heat cells with the short stretches drawn on top as dashed boxes ("+37"); click one to add a shift. That gives back about 70 px, two more people. On a 1280 x 665 screen 7 people now show (it was 4 to 5).
- **The schedule always reaches the bottom of the screen.** It used to be sized for a page scrolled to the top; scrolled down it left a gap with the next card peeking in. Its bottom edge now stays at the bottom of the screen as the page scrolls, up to where it rests under the toolbar.
- **A fixed scale starts where the work is.** 15m, 30m, 1h and 2h are wider than the screen. They now begin at the current time (on today) or at the day's first shift instead of midnight, once for each day and scale. Fit still shows the whole day.
- Checked: 5 more browser checks (71 in all): an old "Roomy" setting does not keep roomy rows, the slim strip, 6+ people visible at 665 px, Roomy and back, no gap below the schedule when scrolled, and 15m starting at the right place. The drag test now grabs the bar by its left end, since the middle of a bar can be a meal.
- Not built: a full-screen "Focus" view (hides the sidebar and page header, about 14 people on a 1080 screen). With the panel open the title line still wraps onto two lines at 1280 px (scale, search and Filters drop under the day's name); hiding the panel puts it back on one.
