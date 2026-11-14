# Forecasting > Forecast Builder and Adjustments

## Forecast Builder: the template for long forms

The Builder keeps its pattern (a sectioned form on the left, a sticky live preview on the right) and now has the things a long form needs:

- **A section index.** Scope, Period, Service parameters, Model, History check, Special events. The section being read is marked and follows the scrolling; clicking one scrolls to it. A rail down the left on wide screens (1536 px and up), a strip along the top below that. History check carries a count badge when the data check found something, and Period a "Check" badge when the horizon is not allowed.
- **A sticky footer** with **Save draft** and **Create forecast** (they used to be only at the top), always in reach. On its left: what will be created ("Short-term forecast for Sales · 6 weeks from 12 Nov 2026 · best model chosen for you") and, in red, why Create is not available (no permission, no history, a horizon outside 1 to 18 weeks or 30 to 730 days). Save draft makes the draft and stays; Create forecast makes it and opens it on the dashboard.
- **Goals as sentences:** "Answer [80] % of contacts within [20] seconds", "[85] % of logged-in time, at most", "[30] % of paid time", each with a plain restatement beneath ("80% answered within 20 s", "Agents busy at most 85% of their logged-in time", "30% of paid time is lost to breaks, training and absence").
- **The data check is open.** A queue with something to look at is expanded when the page opens (it can still be closed). It no longer sits collapsed under "1 finding". See the next section for what it says.
- **Special events on a calendar.** A month grid shows the events already recorded (by type; the build-up and tail days lighter, with the % change) and picks the dates of a new one: click the first day, then the last, and the From and To fields fill in. The list and the form are underneath.

To use the same frame for another long form: give each section an element with id `sec-<name>`, list them in `SectionNav`, call `useScrollSpy`, and put the buttons in `StickyFooter` (all in `src/components/forecasting/FormIndex.tsx`; the data-check and goal rules are in `src/services/forecastForm.ts`).

## Adjustments

- **A locked forecast says how to get unstuck.** The banner now holds the button: **Clone to edit** for a live or archived version (makes a draft and opens it), **Return to draft…** for one waiting for review or approval (asks for a reason). A locked forecast no longer shows a form of disabled boxes; the chart, the numbers and the history stay visible.
- **The choices are in words:** *Change by %*, *Add contacts*, *Set total*, *Zero out*, *Undo adjustments*, each with a line explaining it. "Zero out" is new (it sets the range to nothing, for a closure or a holiday, and is sent as "set total 0"); "Undo adjustments" is what was called "Remove" (it takes off earlier adjustments and goes back to the model's own numbers, it does not zero anything).
- **Drag across the chart to pick the intervals** (or the days of a long-term forecast). The chosen part is shaded while dragging; letting go says "Selected 08:00 to 12:00 on Thu, Nov 12 (17 intervals)" and fills the form's From and To times and focuses the value. Typing the dates and times still works and is the keyboard route.
- **A sentence says what Apply will do** before it does: "Increase the forecast by 20% on 2026-11-12 between 08:00 and 12:00 for all queues." The form now starts on the day chosen on the context bar, not on the first day of the whole forecast (which, with the old defaults, was what an untouched Apply changed).
- **The filters are the shared context bar** (Group, Forecast, Day, and Queue behind Advanced) instead of four boxes declared again; the day and queue are the ones from the Forecast Dashboard and carry between them.

## Layout fix that came with it

The forecasting pages sat in a wrapper that was meant to scroll inside the window but grew with its content instead, so the whole document scrolled and nothing inside could stick (the sticky footer, the sticky toolbars and the sticky preview did not). The wrapper now has its fixed height and scrolls itself, and is a positioning context so absolutely positioned screen-reader text cannot stretch the document. This affects Forecast Dashboard, Forecasts, Builder, Adjustments, Scenarios, Models and Staffing. Also: the notifications bell's label now begins with its unread count (an accessibility rule the page tripped).

## Tests

`test/forecastForm.test.ts` (11, no stack: the data-check summary, the goal sentences, which section is in view, why Create is blocked, the month grid and an event's ramp days, picking a range by clicks, a drag over a chart, the adjustment sentence), `qa/builder-check.mjs` (30 in Chrome at 1920 and 1440 px: the footer in view at the top and the bottom with each button once, what it says, the rail and the strip, the section mark following clicks and scrolling, the goal sentences, the finding open with its count in the index and footer and "Review it", the calendar picking two days and showing a new event, Save draft staying and Create opening the dashboard, no serious accessibility violations, no console errors), `qa/adjustments-check.mjs` (23 in Chrome: the shared bar, the locked banner with Clone to edit and no dead form, the five choices, a real mouse drag shading and selecting intervals and filling the times, the sentence, +20% applied to exactly those intervals in the API, a second drag, Zero out, Undo adjustments back to the model's numbers, Return to draft with a reason, no serious accessibility violations).

## Not done

- Drag-select works for the day chart of a short-term forecast and the daily chart of a long-term one; the long-term drag was built but not exercised in the browser check.
- Dragging is mouse-only (the form's date and time boxes are the keyboard route).
- No preview of the effect (before and after) before Apply; the sentence says what will be done, and the result is reported after.
- The events calendar picks dates and shows events; it does not move or resize an event by dragging, and a queue-specific event is shown on the group's calendar with its name only.
- The 1536 px rail and the strip were checked at 1920 and 1440 px.

## The history check, in plain words

It used to read like an error report ("Poor", "2 findings (1 serious)") and counted optional tips as problems.

- **One verdict first.** "Ready", "Ready, with a caution" (amber) or "Can't forecast yet" (red). Red only when a queue has no history at all. For example: "You can create this forecast. One thing will make it less accurate: newest data is 12 days old." It also says how many odd days will be repaired automatically.
- **Each issue is a small card:** what is wrong, what it means for the forecast, and a button. Stale data: **Import the latest data** (opens Data Management). A borrowed pattern the queue no longer needs: **Clear it (recommended)**. Heavy abandons: **Count answered calls only**. Spikes: **Add a special event**. Buttons that change a queue need permission to change queue settings.
- **Three kinds, never mixed.** Blocking (no history), cautions (old, short, missing or cut-short data), and optional tips (borrowed pattern, spikes, odd handle times, abandoned share). The section badge and the footer count blocking problems and cautions only; tips are counted on their own ("1 caution · 1 tip") and never turn anything red or amber. The footer says nothing for tips, and for a caution says you can still create the forecast.
- **Two facts per queue instead of one word:** "History length: good (56 days) · Freshness: 12 days behind", so one weak spot cannot hide that the rest is fine. "Poor" is gone.
- **Technical settings are behind "Advanced settings for this queue":** what counts as demand in the history (every call that arrived, or answered only), abandoned callers who ring again, and copying the hourly shape from another queue.
- **How old is out of date is a setting on the group** (Advanced settings for this group, default 3 days, 1 to 60). A group that imports weekly sets 8 so a normal gap is not flagged. Older than the limit is a caution; older than twice the limit (and at least 7 days) is a serious caution, still amber. The same group value is stored as `historyStaleDays` (migration 084, group update API). The scheduled refresh keeps its own, separate "skip if data is older than" limit.

Checked: 39 unit tests (`historyQuality`, `forecastForm`), 5 API tests (`historyStaleApi.test.ts`), 34 browser checks (`qa/history-check.mjs`, including the review's exact case of 56 days ending 12 days ago with a borrowed pattern, and an accessibility scan); `qa/builder-check.mjs` updated and still passing.
Not covered: the card wording for languages other than English, and the Data Management > Data Quality screen, which has its own older wording.
