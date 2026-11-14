# Staffing (capacity)

Forecasting > Staffing. How many full-time people the selected forecast implies, by week or month, set against the people you have.

## What changed

The page used to show four tiles (average, busiest, shrinkage, Erlang factor), a one-bar chart and a table. A group with 355 people against a need of 233 read as "Hires needed 0, short-handed None" with no word about the surplus. Shrinkage showed 10% here but 20% in the Builder, Scenarios and the group's own setting.

- **It opens on the position.** A coloured box says **Over by 122 FTE** (amber), **Short by N FTE** (red) or **About right** (green; within 5% of the need, at least one person), with a sentence: "You have 333 FTE (355 people) against an average need of 233. That is 100 FTE more than needed (+43%)." When the running schedule covers under 95% of intervals the sentence adds that the people are there but not at the right times, with a link to Schedule Quality. That is the "over-staffed overall, yet not covered by interval" story. With nobody assigned it says so.
- **Tiles:** People needed (average), Busiest week or month, People you have (FTE, with the head count and "40 h = 1 FTE"), and the Gap as a signed number with "More than needed" or "Fewer than needed".
- **A waterfall from workload to people needed:** Workload, + Service-level buffer (the Erlang factor), + Shrinkage, = People needed, then People you have, then the Surplus or Shortfall as a floating bar. The steps add up exactly.
- **Where the numbers come from, under the chart.** "Shrinkage 10% — from the group's shrinkage categories (breaks 5% + training 3% + absence 2%). The flat 20% setting is not used while categories exist. Change it on WFM Groups." And "Service-level buffer ×1.19" in plain words, with the full-time hours.
- **A line for several periods, a sentence for one.** Several months or weeks get a line for people needed, a dashed line for the busiest day, and the people you have as a reference line. One period gets "2027-01: 5.0 people needed on average, 6.2 on the busiest day." instead of a one-bar chart.
- **The headcount plan says a surplus out loud:** "No hiring is needed. You start 122 above the need and, after attrition, are still 108 above it at the end." (or "Hire N people over M months, starting in the first month"). "First month short-handed: None" became "Short-handed: Never in this period".

## The shrinkage mismatch

Staffing uses the **total of the group's shrinkage categories** when it has any, and the flat percentage only when it has none (WFM Groups > Shrinkage says so). The Builder and Scenarios were showing the flat figure. The group now carries `shrinkageEffectivePercent`, `shrinkageSource` and `shrinkageCategories`, and the Builder (its shrinkage box and the "saved targets" line), Scenarios (baseline column and placeholders) and this page show the same effective number. The Builder says when it is the total of the categories. The flat setting is still stored and is what the group form edits.

## People you have

Active people whose main group is this one. Their contract hours are added up and divided by the group's full-time hours to give FTE, so part-timers count as part of a person. People who work in the group only as a second group are not counted. The headcount plan below still works in heads (one person = one FTE), as before.

## API

`GET /forecast/versions/:id/capacity` adds `headcount: { people, fte }` and `shrinkageSource: { source, effectivePct, flatPct, categories }`. `GET /config/groups` adds `shrinkageEffectivePercent`, `shrinkageSource`, `shrinkageCategories`. No migration.

## Checked

- 14 unit tests (`capacityStory.test.ts`): over, short and about right; the build-up adds up and lays out as a waterfall; months weighted by days; the sentences; the shrinkage note; the plan note.
- 6 API tests (`capacityApi.test.ts`): flat shrinkage with no categories, categories taking over on the group and the capacity plan and the group list, people and FTE counted from contract hours.
- 26 browser checks (`qa/capacity-check.mjs`): the over-staffed state, its words and colour, the tiles, the waterfall, the shrinkage source and the WFM Groups link, the same 10% in the Builder and Scenarios, line chart versus a single sentence, the plan note, a short-staffed group in red with the hiring line, no sideways scroll, accessibility scan, console. The Scenarios, Builder and Adjustments checks still pass.

## Not covered

- The "covers only N% of intervals" sentence is unit-tested but not seen in the browser: the test stack has no published schedule for these groups.
- Pooling and the Weekly/Monthly toggle are unchanged.
- The headcount plan counts heads, not FTE, as before; the new position box counts FTE.
- A leave of absence, a long-term sick person or someone not yet started is counted if their status is Active.
