# Forecasting > Forecast Dashboard: one context bar, quiet charts, and a faster page

## What changed

- **One context bar** instead of seven filter boxes on two rows: **Group · Forecast · Date range**, then an **Advanced** box. Every control has its own icon (before, all seven shared one slider icon).
  - *Forecast* lists the group's forecasts grouped as Short-term and Long-term (the separate Type box is gone). Choosing a long-term forecast switches the type for you.
  - *Date range* is a switch (Day · Week · All · Custom) with its date (or From and To). A **Today** button appears when the forecast covers today and you are not on it.
  - *Advanced* holds **Interval** and **Queue**, with a count on the button when either is not its default. Reset puts them back.
- **The selection is shared and remembered.** Range, dates, interval and queue are one selection for all Forecasting pages and are kept between visits (`wfm_fc_view` in the browser, per group). Adjustments opens on the dashboard's queue and day, Models on its queue, and changing them there changes them here. Moving to another forecast keeps what still fits (dates inside the new forecast, a queue the group has) and otherwise falls back to the defaults below.
- **Opens on today when the forecast covers today**, otherwise on its first day. (This was already the rule; the 3 Jan 2027 start in the review is a forecast that begins in the future, which has no "today" in it. The remembered selection and the Today button are what was missing.)
- **Quiet charts become one line.** *Handle time by time of day*, when every value is within 1% (or 1 second) of the same number: "Handle time is a steady 180 sec across this range: the forecast uses one average, so there is no pattern to chart." *Required versus scheduled staff*, when no published schedule covers the range: "No published schedule covers this range, so there is nothing to set the requirement against. It peaks at 30 agents around 09:30. Publish a schedule under Scheduling." (or "No agents are needed in this range"). Each has **Show chart** to draw it anyway and **Hide chart**. A handle time that changes through the day, and a requirement with a schedule, are drawn as before.
- **Exports say what they export and sit with the table:** **Export this view** (exactly the rows in the table below, as shown, with the dates, interval and queue chosen) and **Export all intervals (CSV)** (every interval of the whole forecast). Delete moved next to Clone to edit in the header.

## Why the page was slow

Every request for the dashboard's data (`GET /forecast/versions/:id/data`) read all of the forecast's rows from the database, twice, before it looked in the cache, so a single day cost the same as the whole forecast: about 700 ms each (measured: a 4-queue, 18-week forecast), and again on every change of date, range or interval. A request for one queue was not cached at all. Now the cache is asked first (the key is the forecast's revision, the group's staffing settings and the queue), and the rows are read only when the answer has to be worked out. Measured on the same forecast: **about 85 to 130 ms per request** (from about 700), and the first request for a given queue after a forecast is created, edited or published still works it out once (about 0.7 to 2 s). The dashboard also no longer asks twice for the same forecast's summary. The first chart is up in about 1.2 s on a development server.

## Not changed / limits

- The first look at a forecast after it is created, adjusted or published (and the first look at each queue) still takes the 0.7 to 2 s to work out. Warming that in the background after publishing is not done.
- A 15-minute view still spans at most 14 days, and a long-term forecast can be split by time of day for at most 31.
- The Forecasts, Builder, Scenarios, Staffing and Accuracy pages do not use the shared date or queue (they have no such filter); they share the group and forecast as before.
- "Export this view" for a single day exports the busy hours shown (quiet overnight intervals are left out of the day view, as they are in the table).

## Tests

`test/forecastView.test.ts` (12, no stack: the opening day, carrying a selection to another forecast, the window and the limits, flat series, the remembered selection), `test/forecastDataCacheApi.test.ts` (3: the same answer twice for the group and for each queue, queues kept apart and adding up to the group, and a changed forecast is a new answer), `qa/forecast-dashboard-check.mjs` (26 in Chrome: one bar with Group, Forecast and date range, Interval and Queue behind Advanced, one row and one slider icon, opens on today or the first day, Advanced, Today, the selection shared with Adjustments and kept across a reload, quiet and drawn charts, the exports and the CSV equal to the table, data requests quick, no serious accessibility violations, no console errors). `qa/forecast-seed.mjs` builds the busy and flat groups it uses.
