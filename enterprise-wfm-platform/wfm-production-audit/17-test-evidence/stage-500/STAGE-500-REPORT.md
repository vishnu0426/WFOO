# Stage 500 — 500 employees, 5 groups, 5 channels/sites, test org AUDITTR0042

Run 2026-11-14 · TEST_RUN_ID `TR0042S500` · driven from the signed-in admin page; every step guarded by `/auth/me` tenant = AUDIT TR0042. Real org untouched.

## Set-up and data

| Group | Channel | Site / time zone | People | Queue settings |
|---|---|---|---:|---|
| G001 | Voice | Kolkata | 100 | AHT 300 s |
| G002 | Voice | Manila | 100 | AHT 300 s |
| G003 | Chat | London | 100 | AHT 540 s, 2 chats at once |
| G004 | Email | New York | 100 | AHT 420 s, reply within 24 h |
| G005 | Back office | Mexico City | 100 | AHT 900 s, turnaround 48 h, Mon–Fri template |

* Data made by `gen.cjs`, which runs identically on disk and in the page: checksums of all 6 CSVs equal on both sides.
* Setup: 64 records in 4.2 s, values read back correct.
* Employees: dry run caught my own mistake (status `INACTIVE` is not an app status → fixed to `SUSPENDED`); then 500 imported, **4,500 / 4,500 field checks match**.
* History: 24,560 rows over 5 queues, **0 rejected** (AHT left blank on empty intervals). Server time per 5,400-row file ≈ 1 s once the browser pane was visible; my earlier 25–74 s readings came from the hidden pane slowing my script, not the server (server: only 5 of 1,772 requests ever over 5 s).

## Forecasts (10 published: 4-week + 53-week per group, 3.3–4.6 s each)

Models picked by the app: ETS (G001, G003, G004), ensemble (G002), seasonal naive (G005).

| Check (`check_forecast_multi.py`) | Result |
|---|---|
| Voice net agents = Erlang C 80/20, occupancy ≤ 85 % | 3,337 / 3,344 match; the 7 others sit on the boundary (SL 0.7967–0.8007 or occupancy 0.8501) — export rounding, not defects |
| Chat net agents = Erlang C on AHT ÷ (2 × 0.85) | 1,678 / 1,680 (2 boundary cases) |
| Email net = ceil(day workload ÷ (48 slots × 900 s × 85 %)), worked 08:00–20:00 | 28 / 28 days, 28 / 28 hours |
| Back office, same on 4-day rolling average | 28 / 28 days, 28 / 28 hours |
| Gross = ceil(net ÷ 0.7) | 207 mismatches, **all MATH-01** (net 21 → 31, net 42 → 61) — now seen in every channel |
| Day = Σ intervals, week = Σ days | 160 / 160 |

Accuracy against the 28 held-back days (daily): voice G001 WAPE 5.3 % (vs truth 4.1 %), voice G002 12.3 % (9.9 %), chat 8.1 % (8.3 %), email 2.7 % (2.6 %), back office 7.9 % (8.2 %, weekdays only). All under-forecast (bias −2.6 to −12.3 %), mostly the 91-day cycle in the test data that 90 days of history cannot show.

**New defect FC-02:** back office has no weekend rows in its history (closed). The app forecast ≈ 1,722 items for every Saturday and Sunday, so 27 % of its staffing requirement lands on days nobody works and its schedule coverage reads 57 %. History quality flags the gap (CRITICAL) but says it fills "from the same weekday", which does not exist, and offers no "closed" option.

## Schedules — 27 plans, all checked independently

Table: `schedule_table.md` (same folder). Summary:

| Horizon | Plans | Solve time (each, 100 people) | Hard-rule breaks mine / app | Coverage app (my reproduction, first 4 weeks) |
|---|---:|---|---|---|
| 1 week | 5 | 32–37 s | 0 / 0 | voice 90.4–90.5, chat 80.7, email 80.4, back office 57.1 |
| 4 weeks | 5 | 54–82 s | 0 / 0 | match within 0.05 pt |
| Quarter (13) | 5 | 218–232 s | 0 / 0 | match within 0.15 pt |
| Half (26), 13 solved + repeated | 5 | 196–229 s | 0 / 0 | match on first 4 weeks |
| Half (26), all solved (G001) | 1 | 434 s | 0 / 0 | 89.6 / 89.58 |
| Year (52), 13 solved + repeated | 5 | ≈ 220–230 s (G005 time lost in a page reload) | 0 / 0 | match on first 4 weeks |
| Year (52), all solved (G001) | 1 | 841 s | 0 / 0 | 89.4 / 89.58 |

Totals: 27 plans, 222,000+ shifts, **0 hard-rule breaks** (overlap, rest ≥ 11 h, ≤ 6 days in a row, weekly max, days per week, template window/length, breaks inside shifts, back office never on weekends, **no SUSPENDED person scheduled**, every active person scheduled). App coverage reproduced in all 27.

Other observations
* **Duplicate-job guard works:** a second plan for a group that is already building is refused with 409 ("A schedule is already being built for this group").
* Two plans at once ran without queueing delay (queue time 0–1 s).
* Coverage for email drifts down over long horizons (80.4 → 76.2 %) because later weeks use the higher long-range forecast.
* Back office 57 %: FC-02 (weekends) plus my template ending by 18:00 while the requirement runs to 20:00 (16.7 % of the requirement) — the second part is my configuration, not a defect.

## API health during the stage

* Probe every 5 s (≈ 75 min of solving): 450 samples, **4 failures**, p50 68 ms, p95 601 ms, p99 26.5 s.
* **PERF-02:** at 10:54:33–10:55:19 UTC the API stopped answering for ~46 s (4 calls timed out at 30 s, 5 more queued). It coincided with my export of four finished plans, two of them full-year (≈ 23–24k shifts).
* Controlled repeat: opening the never-opened full-year fully-solved plan once (`GET /scheduling/versions/:id`, which runs `liveStats` over the whole horizon) did not return within ~3.5 min and froze the API for ~8 s at the 70 s mark (all pings queued and returned together). Outcome unknown — the page was reloaded during the test. Opening the same plan again: **2.35 s, no freeze**.

## Not covered at this stage

Employee portal (needs you to sign in as test employees), bids, VTO/overtime offers, swaps, time-off approval, publishing, adherence; server CPU/RAM (no shell).
