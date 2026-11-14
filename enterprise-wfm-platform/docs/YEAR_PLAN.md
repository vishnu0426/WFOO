# Year Plan: consistent tiles, a labelled map, a clear week rule

Scheduling > Year Plan shows one row per week of a schedule. The review found three things; all are changed in `src/components/scheduling/YearPlanPanel.tsx`.

## What changed

- **Same tiles as the Forecast Dashboard.** The five tiles (Forecast covered, Shifts, Live (locked) through, Solved weeks, Rule violations) now use the dashboard's `Metric` tile: sentence-case labels, normal number font, one bordered strip. Colour sits on the status line ("On target", "A little short", "Short of the forecast", "fix before publishing").
- **"Weeks at a glance".** The coloured squares have a visible heading and one line of help ("One square per week, in order. Click one to open it."). Each square has a screen-reader label ("Week 1, Nov 13 – Nov 15: Overstaffed, 95.1% covered"). Squares are laid out 13 to a row, so a 52-week plan reads as four quarters. The existing legend stays under them.
- **Week convention shown, and part-weeks explained.** The header says "Weeks run Monday to Sunday (your pay week)", taken from the schedule's own pay-week setting (the plan API now returns `weekStartDay`). A schedule that starts or ends mid-week gets part-week rows: the first row starts on the schedule's first day, not the Monday before it, and carries "3 days only". The schedule picker says "1 wk" for 7 days and "N days" when the length is not a whole number of weeks. The rows are still pay weeks, so a 7-day schedule starting Friday shows two rows (3 + 4 days).
- The empty last table header now has a hidden "Open" label (accessibility).

## Verified

`qa/yearplan-check.mjs`, 15 browser checks at 1280 px against a test stack: API returns `weekStartDay` and per-week `days` (3+4 for a Friday-start week); tile style; heading and help text; labelled squares; week rule text; part-week row; picker label; a square opens the roster; axe, scrolling and console clean. Type check clean for the app and gateway.

## Not done

- A full 52-cell year heatmap with month labels: the squares are laid out by quarter but have no month headings.
- Checked only with a Monday pay week and a 1-week schedule; a long plan and a Sunday pay week were not looked at in the browser.
- The other schedule screens' tiles were not compared.
