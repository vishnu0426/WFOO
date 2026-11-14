# Forecasting > Forecasts: one row per forecast, its versions underneath

Before, every version of every forecast was its own row across 11 columns, so a group's live forecast and its drafts looked unrelated, names and horizons wrapped to four or five lines at 1280 px (rows about 85 px tall), the last column was clipped, the Owner column held the same name on every row, and a row could only be clicked open. Now:

- **One row per forecast.** A forecast is a WFM group's short-term or long-term forecast (the data model already works this way: publishing a version archives the one that was live for the same group and type, so a forecast never has more than one live version). Click the arrow to open its **versions**, live first, then drafts and reviews newest first, then archived ones (dimmed). A version cloned from another says **from v2**. The versions' auto-generated names ("Short-term v5 (copy of v1)") are no longer repeated: the row says v5, from v1, and the full name is in the tooltip; a name someone typed is still shown.
- **Live ones are pinned to the top**, under a "Live" heading, then "Not live yet" for forecasts that have only drafts or archived versions. Each row says which version is live ("Live: v3") and how many versions the forecast has and how many are still in progress ("4 versions · 3 open").
- **One line per row.** The horizon is "4 Nov – 15 Dec · 6 wk" (the year only when it is not this year; weeks for whole weeks, days for odd lengths, months for long ones; it never breaks across lines). The "Updated" cell is "Today 09:08", "Yesterday" or "12 Nov" with the full time in the tooltip. Long names and model names are cut with a tooltip. Rows are about 59 px, the Updated column is fully on screen at 1280 px, and the page does not scroll sideways.
- **Fewer columns by default:** Forecast, Status, Horizon, Model, WAPE, Versions, Updated. **Channel, Interval and Owner** are one click away under **Columns** (remembered in the browser).
- **A menu on every row** (the dots on the right), offering what the version's status and the person's permissions allow:
  - *Open* the version on the dashboard; *Compare…* it with another version of the same forecast; the next step: *Submit for approval*, *Approve*, *Publish…* (explains that the live version is archived), *Return to draft…* (reason required); *Clone to edit* (live or archived versions); *Export CSV*; *Archive…* (reason required) for a draft, submitted or approved version; *Delete…* (not the live one).
  - A forecast's own row acts on the version it shows.
- **Compare** opens a panel beside the list: a sentence ("v2 is 4.2% higher than v1 (live) over the 42 days they share (+1,230 contacts). They differ most on Thu 12 Nov (+59 contacts, +9%)."), the figures side by side (contacts over the shared days, the busiest day, average handle time, peak agents needed, agent hours, adjusted intervals, model, typical daily miss), both daily volumes on one chart, and a day-by-day table. It compares with the live version first (the live version with the one it was cloned from) and any other version of the forecast can be picked. Totals count only the days both versions cover.
- **Filters** (search, status, group) keep the forecasts that have a matching version and, while a filter is on, show only the versions that match.

## API

- `GET /forecast/versions/:id/compare?with=<id>`: `with` is the baseline; the answer is `{ base, version, adjusted: { base, version }, overlap, onlyA, onlyB, summary, biggest, rows: [{ day, a, b, delta, deltaPct }] }` where `a` is the baseline and `b` the version in the address. Both must be versions of the same group and type (400 otherwise). Read permission is enough.
- `POST /forecast/versions/:id/archive` `{ reason }`: from draft, submitted or approved to archived. The reason is required (3 or more characters) and goes to the audit log. The live version cannot be archived (409: publish another to replace it); an archived version can be cloned back into a draft. Needs forecast approve or delete permission.

## Tests

`test/forecastLineage.test.ts` (16, no stack: grouping into forecasts, pinning the live ones, filters, "from vN", the one-line horizon, the optional columns, the row menu by status and permission, which version a comparison starts from, the short date), `test/forecastCompare.test.ts` (5: the day-by-day arithmetic, totals over shared days only, the biggest difference, versions with no shared day or no staffing figures), `test/forecastLineageApi.test.ts` (6: an unchanged copy compares equal; an adjustment shows as +20% on its day with the edit counted; refusals; archiving needs a reason, keeps the version, leaves the live one alone and is refused for the live one and for one already archived; an archived version can be cloned), `qa/forecasts-check.mjs` (29 in Chrome at 1280 px: three rows for three forecasts, live pinned under their heading, one line per row, the Forecast and Updated columns on screen, no horizontal scroll, hidden and optional columns remembered, versions with their origin, the menu by status, Compare, Archive needing a reason, Publish archiving the old live version, filters, opening a forecast, no serious accessibility violations with a menu open, no console errors).

## Found while testing

- A section heading row that spans more columns than the table has adds phantom columns to a fixed-width table and squeezed the Forecast column to a few letters; the span now counts the real columns, and the check measures the column.
- Chips and labels in one cell had no space between them in the page's text ("v2from v1NEW"); there are real spaces now.

## Not done

- A forecast is a group's short-term or long-term forecast with all its versions. Two unrelated builds for one group and type (for example a new 18-week forecast started from scratch) are versions of the same forecast, not two forecasts; the "from vN" mark shows which were cloned from which.
- Archiving cannot be undone in one step (clone the archived version instead); there is no "Archived" toggle to hide archived versions by default (they are listed last, dimmed).
- Versions cannot be renamed.
- The Compare panel compares the group's total volume, not queue by queue.
