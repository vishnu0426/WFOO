# Real-time adherence for large groups

Intraday › Real-Time Adherence is built to work for a group of tens of thousands of people. The screen never downloads everyone: it asks for a summary, then a page of people at a time, and opens one person only when asked.

## What the screen shows

| Part | What it is |
|---|---|
| Totals | Adherence today, in, out, not counted. For "my teams" or everyone. |
| Teams | One tile per team, worst first: day percentage, people, how many are out. Click one to list its people. |
| People | Two views: **Needs attention** (out of adherence, longest first) and **Everyone**. Search, status and team filters, sort by any column, all done on the server. |
| Timeline | A **List / Timeline** switch beside the refresh box. Timeline draws one bar per person on a shared time axis: the scheduled day behind (work as a pale band, meals and breaks in their own colour, from Activity Definitions) and what they actually did in front (green in adherence, red out, amber unscheduled, blue no state, grey explained), with a line for now. 40 people a page, same filters and search, and an order choice (needs attention first, out the longest, lowest adherence, name). Click a bar to open the person. |
| One person | A drawer with their day: scheduled against actual, each stretch out of adherence with **Explain** (or **Remove** an explanation). |
| Export | The people the filters show, as a file (up to 200,000). |
| Saved views | A person's own named filter sets (status, teams, search, my teams / everyone). |
| My teams | A supervisor who manages teams opens on their own people. Switch to Everyone any time. |
| Over time | Adherence over finished days, by team or by person, with a trend line. Days are judged once and kept. |
| Alerts | Team managers get one inbox message listing who has been out of adherence for longer than a limit (default 10 minutes). |

## API (all under `/api/v1/intraday`)

| Call | Returns |
|---|---|
| `GET /adherence/summary?groupId&day&scope=all|mine` | Totals, teams, staffing chart, unmapped states, `myTeams` (the teams I manage that have people in this group). No people. |
| `GET /adherence/agents?groupId&day&status=OUT,UNSCHEDULED&team=A&team=B&q&scope&sort&dir&limit&offset` | A page of people (no timelines). `X-Total-Count` has the number that match. `team=~none` is people with no team. |
| `GET /adherence/timelines?...same filters&limit&offset` | A page (up to 100) of people with their timelines and explanations, in the same order as the list; only these people are judged in full. |
| `GET /adherence/agents/:employeeId?groupId&day` | One person with timeline and explanations, judged on their own. |
| `GET /adherence/export.csv?...same filters` | The file. |
| `GET /adherence/history?groupId&from&to&by=team|agent&team&q&scope&sort&limit&offset` | Adherence over days. Up to 93 days; days not judged yet are built eight at a time (`building` says how many are left; ask again). |
| `GET/PUT /adherence/alert-settings` | `{ alertAfterMin, enabled }`. |
| `GET/POST/DELETE /views?screen=adherence` | A person's saved views. |
| `GET /adherence?groupId&day` | The old full response with every person's timeline. Kept for compatibility; `summary=1` now uses the shared cache. Do not use it for big groups. |

## How it stays fast

* **One shared judgement per group and day**, kept for `ADHERENCE_CACHE_SEC` (default 5 s; never more often than every other time the judgement takes, so a huge group cannot keep the server busy). Every supervisor, the dashboard tile and the alert watcher cut their view from it. Adding or removing an explanation drops it at once. A finished day is kept ten minutes.
* **The database is read in one short transaction** and then released: the per-person judging holds no connection.
* **Each person's day is judged in one pass** without building timelines (those are built only for the person opened).

Measured on the development machine (people with 12 state events each, one Node process):

| People | Judge a whole group (cold) | Page, filter or sort from the cache | Old full response |
|---|---|---|---|
| 8,000 | about 0.6 s | 15 ms | 2.3 s, 4.4 MB |
| 30,000 | about 3.5 to 4 s | 150 to 370 ms | 13 s, 24 MB |

Fifty thousand people extrapolates to about 6 to 7 s to judge. At that size set `ADHERENCE_CACHE_SEC` to 15 or more.

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `ADHERENCE_CACHE_SEC` | 5 | How long a judgement of today is shared. |
| `ADHERENCE_WATCH_SEC` | 60 | How often the alert watcher looks (0 = off). It only judges groups whose people sent a state in the last 30 minutes and that have a published schedule. |
| `ADHERENCE_EVENT_RETENTION_DAYS` | 45 | Raw agent events older than this are deleted, in slices, once an hour (0 = keep everything). |

## Alerts

Once a minute the watcher finds people out of adherence longer than the limit and not yet reported for this stretch (the state they are stuck in; a person who stays out is not reported again until it changes). It sends one inbox message per team manager (people with no team, or a team with no manager, are not messaged) and one `adherence.out` event, which webhooks and the alert rules under Administration › Alerts & Reports can use.

## Not done

* The judgement is still recomputed from the day's events every few seconds. A worker that keeps each person's state up to date as events arrive (so reads are lookups, not recalculation) would remove the recomputation and is the next step for groups much larger than 50,000.
* `agent_state_events` is pruned by age, not partitioned. At about 5 million events a day, partition it by day when it reaches that size.
* The screen polls; it does not receive pushed changes.
* The alert watcher and the screens judge on the gateway's own thread (in slices, so other requests still get in). A very large deployment should give the work its own process.
