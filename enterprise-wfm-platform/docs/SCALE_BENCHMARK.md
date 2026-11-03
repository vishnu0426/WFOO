# Scale benchmark: groups of thousands

Measured through the real pipeline (gateway builds the candidate shifts, the engines solve, the gateway checks and saves), not the engine alone. Script: `scripts/bench-scale.mjs` (`node scripts/bench-scale.mjs --base http://localhost:4012 --password ... --sizes 500,1000,2000,4000 --weeks 1 --limit 60`).

**Setup:** one WFM group per size, 40-hour five-day agents, three shift templates (06:00-08:00, 08:30-10:30 and 11:30-13:30 starts, 8.5 hours), a published forecast sized so about half the crew is needed at the busiest hour, one week, solver limit 60 s, no availability limits, time off or skills. Two engines (one core each) and one gateway on one 16 GB Windows laptop, shared with a browser and an editor. Single runs, not averages.

| People | Candidate shifts | How it was solved | Wall time | Forecast covered | Rule violations | Slowest API answer meanwhile |
|---:|---:|---|---:|---:|---:|---:|
| 500 | 52,500 | whole | 67 s | 95.8% | 0 | not measured |
| 1,000 | 105,000 | whole | 69 s | 96.5% | 0 | not measured |
| 2,000 | 210,000 | 3 parts, side by side | 101 s | 96.9% | 0 | 0.66 s |
| 4,000 | 420,000 | 5 parts, side by side | 136 s | 97.2% | 0 | 1.9 s |

Before this work a 2,000-person group was **thinned** to 84,000 candidate shifts (only the longest length, every fourth start) and a 4,000-person group was **refused** ("168,000 possible shifts, more than the solver can take"). While a 2,000-person group was being prepared the API stalled for up to 13.7 seconds with two failed requests, because building the choices ran without a pause. Both are fixed: groups past one solve's limit are split, and the gateway lets other requests in while it builds.

## How a big group is split

- One solve is kept to about 120,000 candidate shifts. Past that, the people are split into the fewest parts of about 90,000 candidates each (by team where possible), and every quarter-hour of demand is shared out between the parts in proportion to their size, in whole people that add up exactly.
- The parts run at the same time on the available engines. Cover, rule checks and the stored statistics are for the whole group, not per part.
- What is given up: pooling across parts (a part cannot lend someone to another) and weekend fairness across parts. The report says when a group was solved in parts. In a small, tight group the loss can be visible (the regression test forces a 16-person group into two parts and allows up to 15 points of lower cover than solving it whole); at thousands of people it was not visible in the numbers above.

## What this does not show

- One week at one 60-second limit. Longer plans solve window by window (see `LONG_PLANS.md`), so a 52-week plan of 4,000 people would be 13 windows of this kind, which the time estimate puts at roughly half an hour or more with two engines (an estimate; a plan that large was not run).
- Demand here is smooth and the crew is uniform. Real groups have availability, time off, skills and part-timers, which make the model harder, not easier.
- Coverage of 96-97% at 60 s is what the solver reached in the time given. It is `FEASIBLE`, never proven optimal. More time or more engines raises it.
- Nothing above 4,000 people was run. Memory in the gateway grows with the number of candidate shifts (a million options is a few hundred MB); the gateway refuses past 900,000 candidates even in parts.
- Machine: a laptop. A server with more cores will do better; this is a floor, not a promise for any particular hardware.
