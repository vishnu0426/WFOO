# Forecast accuracy: one headline figure

Accuracy was shown as 96.8% on the Overview, 3.2% WAPE on the Dashboard, a 1.3% daily miss on the Accuracy page and a 1.3% average miss on Models: different measures, different windows, named differently, so nobody could tell which was the real one.

## The definition

**Forecast accuracy = 100% − WAPE.** WAPE is how far the **published forecast** was from what **really arrived**, added up **per day**, over the **last 28 days**, as a share of real volume. It is the check the Models screen already ran (`evaluate`), so the number is the same one the self-learning is based on. Target 92% or better (good), 85 to 92 worth watching, below that poor.

## Where it shows, and what it is called

| Screen | What it shows |
|---|---|
| Overview | KPI "Forecast accuracy", the headline, with "Last 28 days: published forecasts missed by x% a day on average", the change against the 28 days before |
| Forecast Dashboard | Tile "Forecast accuracy" (the headline); its own range figure is named "Miss in this view", or "Test miss" for a version not yet published. It used to be a bare "WAPE" |
| Accuracy | The headline at the top, large, with a definition on hover and for screen readers |
| Models | "Forecast accuracy" (the headline) in the learning tiles. It used to be "Average miss, last 28 days" |
| Forecasts list | Column "Test miss" (the backtest on the last 4 weeks of history) with a tooltip. It used to be "WAPE" |

Every other figure is a different measure and says so: **Latest week miss** (one full week; moves more than the headline), **Test miss** and its 15-minute, hourly and daily versions (a test run now on recent history: how good the method is, not how published forecasts did), **Miss in this view** (the days on screen). The words live in one file (`src/services/accuracyTerms.ts`), so a screen cannot invent its own.

## When the data is thin

- Under **2 completed weeks** (fewer than 14 compared days) the headline is still shown, muted, with "Needs 2+ completed weeks of data (n days so far)". The Overview carries the same note.
- With **nothing compared** it shows a dash and "Needs a published forecast compared with actuals."
- On the Accuracy page, a trend with **one week** shows "Needs 2+ completed weeks" instead of a one-point chart; the week stays in the table.

## The Accuracy page frame

It now has a breadcrumb (Forecasting / Accuracy) and the same Group box as the other forecasting pages, instead of its own selector. The hold-out card is "Test on recent history", its figures "Test miss" so they cannot be mistaken for the headline.

## API

`GET /forecast/accuracy-headline?groupId=` returns `name`, `definition`, `windowDays`, `from`, `to`, `days`, `accuracyPct`, `missPct`, `biasPct`, `state` (`OK`, `SPARSE`, `NONE`), `note`, `targetPct`, `previousAccuracyPct`, `deltaPts` (against the 28 days before, only when both have 14+ days). `evaluate(tenant, group, endDay?)` takes an optional end day for the earlier window. No migration.

## Checked

- 7 unit tests (`accuracyHeadline.test.ts`): the figure, rounding, definition, thin and empty data, the change on the earlier window.
- 5 API tests (`accuracyHeadlineApi.test.ts`, with the test database to date a forecast back): 100% − WAPE with its definition, the same number as the Models check, the same number on the Overview, the early-reading note, and the no-data case. The Overview, learning and Today tests still pass.
- 21 browser checks (`qa/accuracy-check.mjs`): breadcrumb and Group box, the headline matching the API, its definition and its sub-line, the other figures' new names, the sparse note and the trend chart replaced by "Needs 2+ completed weeks", the dash with nothing compared, the same figure on Overview, Dashboard and Models, the Forecasts column, no sideways scroll, accessibility scan, console.

## Not covered

- The **scheduled refresh report** still says how the live forecast did "last week": it is a weekly report and says so, but it is a one-week measure, not the 28-day headline.
- The **Builder** shows the backtest while a forecast is being made; it was already labelled as a test.
- A group with very different volumes per queue has one headline for the whole group (volume-weighted), as WAPE is.
- The target (92%) and the 14-day minimum are fixed, not settings.
