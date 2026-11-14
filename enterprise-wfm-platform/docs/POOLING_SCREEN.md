# Pooling benefit

Forecasting > Staffing, at the bottom of the page. Shows what one shared pool of people would save against separate pools for two or more groups, for one day.

## What changed

The picker used to list every group in the organisation as a checkbox pill (about 90 of them, a wall that pushed the page down). Most could not be compared, because each group needs a published short-term forecast covering the day, and nothing said so until Compare was pressed.

- **Only groups that can be compared are listed.** A short scrolling box holds the groups with a published short-term forecast for the chosen day, each with its site, channels and number of people. The others are one collapsed line: "94 groups can't be compared on this day: no published short-term forecast covers it", which opens to list them. A line says "11 of 105 groups can be compared on 2026-11-14".
- **Search** by name, site or channel (every word must match), with "No group matches that search" when nothing does.
- **What is picked is always in view.** Chips with a remove button, "Picked 2 of 8", and Clear. Up to eight groups; at the limit it says so instead of silently ignoring the click.
- **Quick picks.** The pairs of groups that already share people (a person whose main group is one and who may also work in the other), with the number shared; and "All at <site>" for a site with two or more comparable groups (up to six sites shown). One click picks them.
- **The answer appears by itself** about 0.6 s after the second group is picked, and again as picks change. There is no Compare button. With fewer than two picked, a line says "Pick at least two groups to compare."
- **One sentence first:** "Pooling Sales and Support needs 12 fewer agent hours on the day (−8%), and 4 fewer agents at the busiest time." or "…gives no gain on this day: kept apart they already meet the target as well." Three groups read "A, B and C". The four tiles and the chart follow, unchanged.
- **Changing the day** drops any picked group that has no forecast on the new day and refreshes the list.

## API

`GET /forecast/pooling/candidates?day=YYYY-MM-DD` returns every active group with `siteId`, `siteName`, `queues`, `channels`, `people`, `ready` and `forecastName`, and `sharedPairs` (`a`, `b`, `people`). The comparison endpoint `GET /forecast/pooling?groupIds=…&day=…` is unchanged (two to eight groups).

## Checked

- 11 unit tests (`poolingPicker.test.ts`): ready versus not, search, site and pair quick picks, the limit of eight, the sentence.
- 6 API tests (`poolingApi.test.ts`): only groups with a published forecast covering the day are ready, site, channels and people, a day the forecast does not cover, the pair that shares people, a bad day refused, the comparison still works and says why a group is not ready.
- 25 browser checks (`qa/pooling-check.mjs`): the short list instead of a wall, the collapsed "can't be compared" line, no Compare button, the quick picks, the answer sentence with nothing pressed, chips and removing one, search by name and channel, a site pick, three groups in the sentence, a day with no forecasts clearing the picks, no sideways scroll, accessibility scan, console. The Staffing and Scenarios checks still pass.

## Not covered

- "Shares people" counts people whose main group is one group and who may also work in the other; people shared in other ways are not seen.
- Groups are matched on the day only; whether two groups' people really are cross-trained enough to pool is the planner's call, as before.
- The limit of eight is checked in the browser by unit test only (the test stack had too few comparable groups to reach it).
