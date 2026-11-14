# Scheduled forecast refresh

Forecasts used to go stale until someone pressed Reforecast. Each forecast (a group's short-term or long-term forecast) can now refresh itself on a schedule and tell the people who approve forecasts how it went.

## Where it is

Forecasting > Forecasts. On a forecast's row menu choose **Auto-refresh…**. A forecast with a schedule on shows an "Auto-refresh Monday at 06:00" chip under its name; click it to open the same panel.

## What a run does

1. **Checks the data is fresh.** If the newest interval history is older than the limit (default 3 days) the run is **skipped**, says why ("check the data feed") and nothing changes.
2. **Measures how the live forecast did** against what really happened (last finished week, error a day, running high or low, worst queues, compared with the previous run). Short-term forecasts only.
3. **Builds a new draft** from the latest history, as long as the live forecast unless a length is set. It is named "… · auto refresh" and shows an "auto refresh" tag in the list.
4. **Compares the draft with the live version** over the days they share (volume change and the biggest day).
5. **Archives an earlier automatic draft nobody touched** (an adjusted, submitted or approved draft is never touched). Optional, on by default.
6. **Tells everyone whose role has the "approve forecasts" permission**: the web bell (live), and the in-app inbox used by the mobile and employee apps.

It only ever makes a **draft**. It never submits or publishes: a person reviews it, submits it and publishes it as usual.

## Schedule

Every week (day, hour) or every day (hour), in the group's own time zone. A schedule is tried **once per occasion**: if it fails it is not retried every five minutes (press Run now to try again). Missed an hour (gateway down)? It runs later that day. Run now never counts as the scheduled run.

## Safeguards

- One run at a time per forecast (database-level); a second Run now answers "already running".
- A run cut off by a restart is marked failed after 30 minutes.
- Every run, including skipped and failed ones, is kept with its report (panel > Earlier runs) and audited (actor "Auto-refresh").
- Who can do what: anyone who can read forecasts sees the schedule and reports; changing it, Run now and run-due need permission to create forecasts.

## Settings

`FORECAST_REFRESH=off` turns the scheduler off (Run now still works). `FORECAST_REFRESH_TICK_SECONDS` (default 300, minimum 60) is how often due schedules are looked for.

## API

`GET /forecast/refresh[?groupId=]`, `PUT /forecast/refresh/:groupId/:kind`, `POST …/run` (202, runs in the background), `GET …/runs`, `POST /forecast/refresh/run-due`. Migration `083_forecast_refresh.sql`.

## Checked

- 15 unit tests (`forecastRefreshMath.test.ts`): when due, next run, freshness, the sentences, notification wording, horizon.
- 9 API tests (`forecastRefreshApi.test.ts`): defaults, save and validation, permissions, run makes a draft with accuracy, comparison and notification, replacing an untouched draft, keeping an adjusted one, stale data skipped, concurrent run refused, once per occasion, history.
- 17 browser checks (`qa/refresh-check.mjs`): panel, save, Run now to a finished report, accessibility scan, chip, new draft in the list, open the draft.

## Not covered

- **Long-term** refresh uses the same code but is not exercised by the API test.
- The accuracy sentence needs about four days of finished data in a week; on a fresh setup it says there is not enough yet.
- A run takes seconds to a minute (the engine tests the models); a very long history was not load-tested.
- The scheduler ticks every five minutes, so a run starts up to five minutes after its hour.
- Email is not sent; notifications go to the bell and the inbox.
