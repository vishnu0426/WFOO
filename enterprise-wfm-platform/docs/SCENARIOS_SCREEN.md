# Scenarios (what-if)

Forecasting > Scenarios. Sets "what if" cases against the selected forecast and shows agents needed, service level and cost next to the baseline.

## What changed

The screen used to open on two blank rows of five percentage boxes, a forecast picker that listed archived versions, and results only after pressing **Compare with baseline**.

- **Start from a chip.** **+10% volume**, **+15 s handle time**, **Shrinkage 25%**, **Holiday week** (+25% volume, 35% shrinkage), plus any scenario saved with this forecast, plus **Blank scenario**. A chip adds a scenario that is already filled in; every value can be changed. Up to five at a time.
- **Scenarios are columns beside the baseline, in fixed-width columns** (a 190 px label column, then 170 px per scenario) so the baseline sits next to its labels instead of being stretched across a wide screen. Each scenario column has a colour dot that matches its line in the chart. The page is held to a readable maximum width.
- **The answer comes first.** A sentence per scenario ("Holiday week needs 3.2 more agents (+21%); service level −4.0 pts; costs $23,918 more."), then the result rows: agents needed (FTE) and the change against the baseline (red for more, green for fewer), service level and its change in points, staffing cost and its change, agent hours, contacts, and for short-term peak agents and occupancy. What a scenario changes (volume %, handle time as % or seconds, shrinkage, service level, occupancy cap) sits underneath under "Change this". A chart of agent hours per day follows.
- **It recomputes by itself.** About half a second after anything is typed or a chip is clicked. There is no Compare button. A column shows "…" until its own answer arrives, so it never shows another scenario's numbers; the table dims while it works. A value out of range is explained instead of sent.
- **With no scenario yet the baseline is four tiles** (agents needed, service level with the goal, peak agents, staffing cost) and a dashed "Add a scenario to compare with this baseline" button, not a table of empty rows. A chip already in use goes quiet instead of adding a duplicate.
- **Cost.** The group can have a **cost of one agent hour** (in the organisation's currency, saved on the group; needs permission to change configuration). It is set where it is needed: a "Set cost per hour" link in the cost tile, or in the cost row of the table ("Agent hours times $30 an hour. Change rate"). Cost = agent hours x that rate. Without a rate the cost rows are replaced by that link.
- **Archived forecasts are hidden in the Forecast picker** on this page and on Adjustments, Staffing, Models and the other pages that share the picker. A "Show archived (n)" box brings them back; the choice is remembered. The forecast being looked at always stays in the list.

## How "+15 s handle time" is applied

As the same share of the average handle time on every interval (15 s on a 260 s average is +5.8%), so its effect matches the equivalent percentage. The baseline column shows the average it is added to. Saved scenarios keep the seconds.

## API

`POST /forecast/versions/:id/scenarios/compare` takes up to five scenarios (an empty list returns the baseline alone) and accepts `ahtAddSec` (-600 to 600) beside the existing parameters. The answer adds `cost`, `impactCostDelta` per result, and `costPerHour`, `currency`, `avgAhtSec` at the top. `PUT /config/groups/:id` accepts `agentCostPerHour` (zero or more, or null to clear). Migration `085_group_agent_cost.sql`.

## Checked

- 11 unit tests (`scenarioForm.test.ts`): presets, values to parameters and back, ranges, wording of changes and money, and the sentence for each scenario.
- 7 API tests (`scenariosApi.test.ts`): baseline alone, more volume needs more agents, seconds equal the matching percentage, limits, cost from the rate, rate kept and cleared.
- 41 browser checks (`qa/scenarios-check.mjs`): tiles and the dashed add button in the empty state, a cost rate set from the tile, chips, a chip going quiet when used, the sentence per scenario, columns as wide as their content with the Baseline heading lined up with its numbers, results above "Change this", live recompute with no button, seconds unit, holiday week, cost row, remove, save, saved chip after reload and deleting it, five-scenario limit, out-of-range message, archived hidden and shown, no sideways scroll at 1280 px, accessibility scan, console. The Adjustments, Builder, history and Forecasts checks still pass.

## Not covered

- Cost is staffing hours times one rate. It leaves out overtime, premiums and benefits.
- The comparison is not saved as a set: saved scenarios are single scenarios kept with the forecast.
- A long-term forecast shows contacts, agents, cost and the daily hours; service level, peak and occupancy are for short-term only (as before).
- "Holiday week" is a fixed starting point (+25% volume, 35% shrinkage), not learned from the customer's own events.
