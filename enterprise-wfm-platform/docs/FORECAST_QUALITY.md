# Forecast quality: one page, one set of periods, a safer Forget

Forecasting > Forecast quality. It joins the Accuracy and Models screens as two tabs of one page.

## What changed

- **One page with two tabs.** "Forecast quality" has the breadcrumb Forecasting / Forecast quality and two tabs, **Accuracy** (the headline Forecast accuracy, accuracy over time, the test on recent history) and **Models** (which method was best, and what the system has learned). The sidebar has one "Forecast quality" entry instead of Accuracy and Models, and it stays marked while on either tab. Each tab keeps its own address (`/forecasting/accuracy-heatmap`, `/forecasting/model-leaderboard`), so bookmarks and links still land where they did. The tabs are a real tab list: arrow keys move between them.
- **The same look-back periods on both tabs: 8, 12, 26 and 52 weeks** (default 12). Models used 1 month, 3 months, 6 months and 1 year, Accuracy 8, 12 and 26 weeks. The choice is remembered and shared: pick 26 weeks on one tab and the other opens on 26 weeks. Models asks the server in days (weeks x 7, 56 to 364). The Accuracy page's "7, 14, 28 days" is a different thing, the length of the test window, and is unchanged.
- **Forget is not next to Learn now.** It was already behind a "More" button but asked for confirmation with a browser pop-up. It is now a red item in a "More actions" menu (which closes on a click elsewhere or Escape, and is not shown at all when nothing has been learned), and it opens a dialog that says what will change:
  - "6 weekday corrections across 1 queue will be deleted, for example Sales Mon +12%."
  - New forecasts go back to the plain model output until it learns again.
  - Forecasts already made keep their numbers, and nothing in a published schedule changes.
  - It starts learning again at the next import (not while Learning is off) or on Learn now, but needs at least N days of each weekday first.
  - **This cannot be undone.** To stop it adding corrections without deleting these, switch Learning off instead.
  - A **reason is required** (3 letters or more). The button stays off until it is given. Escape and Cancel delete nothing.
- **The reason is enforced and recorded.** `DELETE /forecast/learning/factors` now needs a `reason` and answers "Say why the learned corrections are being cleared." without one; it is on the audit trail.
- **The learning figures are named for what they are**, to match the accuracy work: the model table's "Avg. miss" is "Test miss", and the learning history's "Average miss" is "28-day miss" (each check's miss over the 28 days before it). The model table's empty last column header now reads "Actions" for screen readers.

## Checked

- 5 unit tests (`periods.test.ts`): the four presets, the default, reading a remembered value, days within what the server takes.
- The learning API test now covers forgetting: refused with no reason (clears nothing), allowed with one; 5 pass (they need the test database).
- 29 browser checks (`qa/quality-check.mjs`): the single page and tabs, the sidebar, arrow keys, the periods on both tabs and carrying over, Forget behind the menu, the dialog's text, the reason rule, Escape and Cancel, the deletion, the menu disappearing, the reason on the audit trail, no sideways scroll, accessibility scan, console. The Accuracy, Forecasts, Staffing and Scenarios checks still pass.

## Not covered

- The look-back periods are standardised on these two screens. Other screens with their own date choices (the Dashboard's date range, the Accuracy test window, the scheduling screens) were not changed.
- Learning can be switched off and on, but a cleared set of corrections cannot be restored: it has to be learned again from new data.
- A deep link to the old "Models" label in saved notes or documents will still work (the address is unchanged), but reads "Forecast quality".
