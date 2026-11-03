# Speed and scale

How AgnoWFM keeps screens quick as the data grows, what to set in production, and how to check it.

## What was changed, and why

| Where | Before | Now |
|---|---|---|
| Data Management › coverage and quality | Read every interval of history for every queue on each open (about 680 ms at 450,000 rows, growing) | Reads `interval_daily`, one row per queue per day, kept exact by database triggers (migration 058). About 20 ms, flat as history grows |
| WFM Groups › list | One query per group, and group membership found by scanning each person's group list | One set-based query; membership uses a GIN index (`eligible_group_ids @>`). About 23 ms for the whole list |
| Generate Schedule, Rotations | Downloaded every active person in the group to count them and list names | Generate asks for a summary (people, contracted hours, teams) and a person picker for exclusions (`excludeEmployeeIds`). Rotations lists 100 people a page, searchable. Nobody downloads a whole group |
| Browser | Every screen asked again for the same lists (groups, queues, teams, templates) | One shared cache: a second asker shares the answer and the request; the screen shows what is held at once and refreshes behind it; any change made through the app marks everything stale so nothing edited is shown as current. The small reference lists also survive a reload (per sign-in, per tab) |
| HTTP | No caching hints | `Cache-Control: private, no-cache` + ETag on every read (the browser asks, the gateway answers 304 with no body); code-defined lists (connector catalog, developer events) may be reused for a minute |
| Static files | Not compressed | nginx gzip for text, JSON, JavaScript, CSS, SVG; `index.html` is never cached so a release is picked up at once, hashed assets under /assets are cached for a week (immutable) |
| Grid library | Whole community bundle registered | Only the modules the screens use |

## Running more than one gateway

The gateway keeps no session state (sign-in is a signed token) and pushes live events through NATS, so any number of copies can sit behind the load balancer.

| Variable | Default | Meaning |
|---|---|---|
| `GATEWAY_ROLE` | `all` | `all`: one process does everything. `web`: answers requests only. `jobs`: also runs the timers and workers (schedule runs, webhooks, reports, connector pulls, the adherence watcher, offer/bid tickers). Run **exactly one** `jobs` (or `all`) process and as many `web` as needed |
| `DB_POOL_MAX` | 12 | Database connections per process. Keep (processes) x this under the database's `max_connections`, or put a pooler (PgBouncer, transaction mode) in front |

Notes: caches that live in a process (the adherence judgement, permission lookups) are short-lived by design and rebuild per process, so a change made on one web process can take a few seconds to show on another. Point the adherence screens at one process if that matters.

## Budgets that are tested

`backend/gateway/test/performanceBudget.test.ts` fails if the lists every screen opens (groups, queues, group summary, coverage, teams) are slower than their budget, if reads lose their caching headers, or if the group-size summary stops matching the people list. `test/intervalRollup.test.ts` proves the daily rollup equals a fresh aggregate after every kind of change and stays quick at about 290,000 intervals for one queue.

## Measured (development machine, one gateway process)

| Call | Before | After |
|---|---|---|
| Coverage, 450,000 history rows | 680 ms | about 20 ms |
| WFM Groups summary | 258 ms | about 23 ms |
| Screen open, repeated lists | a request per screen per list | first screen asks; others reuse for 1.5 s and show held data at once |

Browser network trace per screen (18 screens, same data): duplicate requests for groups, queues and versions are gone; the heaviest screens opened with 9 requests where most opened with 4 to 7.

## Not done / know before you rely on it

* A browser measurement on a 50,000-person tenant for the screens that list people (only the adherence page was measured at that size).
* The multi-process mode is set up and type-checked but was run here only as a single process (`all`); run a `web` + `jobs` pair against your load balancer before relying on it.
* The adherence judgement, when recomputed, is still done inside the gateway process (see `ADHERENCE_SCALE.md`).

## Why schedule builds were slow, and what changed

Measured with `scripts/bench-scale.mjs` (100 people, 40-hour five-day agents, one template set, solver time 30 s, one engine on a laptop).

| Cause | What it cost | Change |
|---|---|---|
| Every solve started a new solver process, and loading the solver libraries (OR-Tools, pandas, SciPy) takes 4 to 5 s on this machine. A 4-week build is four weekly solves, a 13-week plan thirteen | 4 to 5 s per solve, 20 s on a 4-week build, over a minute on a 13-week plan | The engine keeps one process ready with the libraries loaded (`ENGINE_WARM_WORKERS`, default 1), hands it the job and starts the next while that one solves |
| CP-SAT returned only the starting roster (a week of a long build gets a quarter of the time of 4 weeks), so HiGHS and then SCIP were tried, each building its own model first, and the build ran past the time asked for. They found nothing | 4 weeks asked for 30 s took 56 s, and the result was the starting roster | Backups share what is left of the allowance and are skipped when under `ENGINE_BACKUP_MIN_SEC` (3 s) remain. The attempts list says "skipped" |
| CP-SAT searched for the whole allowance even when the answer had stopped improving | 1 week asked for 30 s took 30 s for a roster it had in about 8 s | The search runs in stages from the best roster so far and stops when a stage gains under `ENGINE_STALL_PCT` (0.3%). 1 week, 30 s asked: 16.6 s, same coverage, objective 900,500 (30 s unstaged: 932,930, 60 s unstaged: 900,850) |

Result, same data, 30 s asked per window:

| Range | Before | After | Shifts | Rule violations |
|---|---|---|---|---|
| 1 week | 38 s | 18 s | 500 | 0 |
| 2 weeks | not measured | 30 s | 1,000 | 0 |
| 4 weeks | 56 s (starting roster only) | 32 s (CP-SAT) | 2,000 | 0 |
| 13 weeks (4 windows) | 137 s | 115 s | 6,500 | 0 |
| 26 weeks (13 solved, rest repeat) | 137 s | 117 s | 13,000 | 0 |
| 52 weeks (13 solved, rest repeat) | 142 s | 119 s | 26,000 | 0 |

What still takes the time: the solver time asked for, per window of four weeks. A 13-week plan is four windows, and a 26 or 52 week plan solves its first 13 weeks the same way and repeats the cycle after that. Ask for less time (the roster is usually as good in half) or fewer solved weeks to shorten it.

`backend/gateway/test/scheduleEveryRange.test.ts` builds 1, 2, 4, 13, 26 and 52 weeks and checks each has every shift (16 people x 5 days x weeks), a shift on every day, no rule violation, and a time within windows x (solver time + overhead). Engine tests in `test_backends.py` cover the ready process, the shared time allowance and the early stop.

Worth knowing: on this 100-person, one-week model HiGHS proved its answer optimal in 34 s with an objective 2% lower (better) than CP-SAT's. It is the backup in the chain, not the first choice; this was one model, not enough to change the default order.

Not verified: groups of thousands of people with the staged search (the 2,000 and 4,000-person figures in `SCALE_BENCHMARK.md` pre-date it), and the engine test `test_weekend_shifts_are_spread_over_a_long_period` fails (weekend counts differ by 5; limit 4) both with and without these changes.

## Why CP-SAT sometimes "does not work", and very large groups

**What was happening** (100 to 2,000 people, one week; `scripts/bench-scale.mjs`, plus timing the engine directly):

1. *The model took longer to build than the time asked for.* Building it in Python cost 6.2 s for 17,500 candidate shifts and 22.5 s for 70,000 (a quarter of it adding up thousands of variables one at a time with the built-in `sum`). The solver then got a floor of half the allowance, 5 s, and with a model that size found no solution better than the starting roster, so the answer was the greedy roster ("starting roster only", gap 1.0). Using OR-Tools' own `LinearExpr.sum` cut the build to 1.8 s and 9.1 s. 500 people with 10 s asked went from 24 s to 14 s, 2,000 people from 73 s to 49 s.
2. *It returns the starting roster when the allowance is short for the size.* At 10 s asked, 500 and 2,000 people both came back "starting roster only"; at 60 s both improved. Coverage was the same either way (95.8% and 96.9%): the starting roster already covers the forecast as well, and what CP-SAT adds is the secondary terms (contract hours, preferences, fairness). So "not working" is mostly "had no time to add anything", and the report says so.
3. *Past a few thousand people it cannot work at all as one model.* The number of choices is people x days x start times: 50,000 people is over five million, and the gateway refused the request ("more than 900,000 possible shifts"). The engine also refuses a single request above 300,000 and runs big models one at a time, because each copy of the model per search thread uses memory.
4. *Crashes and odd statuses are contained, not absent.* A native abort or out-of-memory in the solver ends only its own process (it runs in a separate process); the chain then tries HiGHS, SCIP and the starting roster, and says which. Forcing CP-SAT alone turns any such failure into "the solver did not return a schedule".

**How the large commercial products are described** (public patent and research material, not their internals; I found nothing on how NICE, Verint or Calabrio work): contact-centre schedulers are described as working in two stages, anonymous shifts first (how many people on which shift, by integer programming or column generation), then named people given to them, with greedy or search heuristics for the second stage and simulation to test the result. None of the sources describe one model over every named person.

**What this product now does** above 6,000 people (`SCHEDULE_REPRESENTATIVES_ABOVE`; sample size `SCHEDULE_REPRESENTATIVE_COUNT`, default 1,600): people with the same contract rules are one kind; a sample of each kind in proportion is solved against its share of the demand (an ordinary solve, in parts if needed); every other person takes the roster of a sample member of their own kind, dropping any shift their own time off, availability, rest or labour-law rules forbid. The report says how many were dropped. See `representatives.ts`.

| 50,000 people, 1 week, 60 s asked, one engine on a 16 GB / 8-core laptop | |
|---|---|
| Before | Refused ("more than 900,000 possible shifts") |
| Now | Built: 250,000 shifts, 50,000 people scheduled, forecast covered 97.4%, 0 rule violations, 192 s (about 110 s of it the solver; two parts solved one after the other because each is large). With the faster model build: solve step 111 s to 89 s |

Limits of that run: the people were identical full-timers with no time off or availability, so 0 of 242,000 copied shifts were dropped; a real group will lose some. Teams are not matched, so people in one team can have the same days off. Quiet slots needing only a few people can round to zero in the sample. Nothing here has been run with 50,000 people across several weeks, with published history for everyone, or with skills.

**API stall at that size:** the steps after the solve (placing meals and breaks, optimising breaks, checking rules, and the later re-check when a schedule is opened) are plain computing in the gateway process and block it for several seconds at once: 8.6 s was the longest measured during a build, and opening the finished schedule recomputes for about 14 s. Run big builds in a `GATEWAY_ROLE=jobs` process so the web processes keep answering (see above); the steps themselves have not been made to yield.

Tests: `test/representatives.test.ts` (choosing the sample), `test/representativeSchedule.test.ts` (a 240-person group sent down this path: everyone scheduled, no violations, approved time off honoured, cover within 8 points of solving every person).

## Capacity: what sizes itself, what to watch, how to scale

### Sized automatically (an environment variable always wins)

| What | How it is chosen | Override |
|---|---|---|
| Database connections per gateway process | 80% of the database's `max_connections`, after its reserved connections and at least 10 for other tools, divided by (`GATEWAY_MAX_REPLICAS` + 1 jobs process), between 4 and 50. Logged at start as `[autosize]` | `DB_POOL_MAX` |
| Parts of one build sent to the engines at once | 2 per engine plus 1, at least 3, worked out for each build from the engines found at that moment | `SCHEDULE_PART_PARALLEL` |
| Solves an engine runs at once | one per 4 cores and per 4 GB of memory (the container limit when there is one), 2 to 8 (1 on less than 6 GB). A large solve still takes every slot | `ENGINE_MAX_SOLVES` |
| Solver processes kept ready | the smaller of 2 and the solve slots | `ENGINE_WARM_WORKERS` |
| Gateway heap | 75% of the container's memory limit, set by `docker/gateway-entry.sh` before Node starts (Node cannot change it while running; tried). Without a container limit Node's own default applies (about 4 GB on a 16 GB machine); the gateway logs a warning when a jobs process has a small heap on a big machine | `NODE_OPTIONS=--max-old-space-size=...` |
| Engines | `ENGINE_DISCOVER=name:port` looks the name up every 10 s (`ENGINE_DISCOVER_SEC`); new engines are used at once and vanished ones are dropped. Engines named in `ENGINE_ADDR` are never dropped | `ENGINE_ADDR` |

### Overload means waiting, not failing
When every engine says it is full, a request waits for room (0.2 s growing to 2 s between tries, with some randomness) before it is given "engine busy": up to `ENGINE_QUEUE_WAIT_SEC` (30) for quick calculations and `ENGINE_BUILD_QUEUE_WAIT_SEC` (300) for schedule builds. A cancelled build stops waiting. Beyond one engine's solve slots, builds queue inside the engine in arrival order. On SIGTERM an engine stops taking new calls and lets work under way finish for up to `ENGINE_DRAIN_SEC` (100); the gateway sends new work to another engine.

### Metrics (Prometheus text)
Gateway `GET /metrics` (port 4000): event-loop delay (p50, p99, max since the last scrape), requests in flight and finished by outcome and speed, database connections used and waiting, memory, each engine's calls in flight, `wfm_gateway_engine_busy_total`, `wfm_gateway_engine_busy_wait_seconds_total`, `wfm_schedule_jobs{state}` and `wfm_schedule_jobs_oldest_queued_seconds`, and the sizes chosen at start. Engine `GET :9109/metrics` (`ENGINE_METRICS_PORT`, `ENGINE_METRICS_HOST`; 0 turns it off): solve slots and slots used, `wfm_engine_solves_waiting`, wait time, solver processes that died, solves that returned only the starting roster, memory. Gateway metrics need `Authorization: Bearer $METRICS_TOKEN` when that is set, otherwise they answer only callers on this machine or a private network, and the web proxy does not publish them. No names or tenants appear in them.

What to alert on: event-loop delay p99 above 1 s for 5 minutes (a process has too much plain computing: more `web` processes, or builds in `jobs`); `wfm_schedule_jobs_oldest_queued_seconds` above 10 minutes or `wfm_engine_solves_waiting` above 0 for long (add engines); database connections waiting above 0 (raise the database limit or lower `GATEWAY_MAX_REPLICAS`); `wfm_engine_solver_process_deaths_total` rising (memory).

### Scaling out
`deploy/k8s/wfm.yaml`: web gateways on a CPU autoscaler (2 to 10), exactly one jobs gateway, engines found by name and scaled by KEDA on `queued builds + solves waiting` (2 to 12), and a network policy so only the gateways reach an engine (it has no login of its own). It parses as YAML and has not been applied to a cluster. In Docker Compose everything stays on one machine as before.

### Tested
`test/capacity.test.ts` (pool and part sizing, waiting for a full engine, engines coming and going), `test/overload.test.ts` (metrics format and content; 300 requests at once, none a server error, counted; health stays quick under load), `test/buildRush.test.ts` (7 builds at once against 2 solve slots: all finish valid, up to 5 seen waiting), engine tests for sizing and the metrics text. Engine lookup by name was run with one engine (found, used for a 7-build rush). Not tested: several engines found by name, engines appearing and disappearing live, SIGTERM draining (Windows machine), the Kubernetes manifest, the heap script, 5 million people.

## Sign-in capacity, API traffic and what runs over gRPC

**gRPC is only between the gateway and the engine.** Browsers, the mobile app and integrations talk to the gateway in REST/JSON over HTTP (`/api/v1`, plus a WebSocket at `/ws` for live events). The gateway talks to the Python engine in gRPC (forecasts, staffing, schedule solves). Moving the browser side to gRPC would not help: browsers cannot speak plain gRPC (it needs a proxy), and the JSON answers are already compressed to about a tenth of their size. The traffic that is large is the browser's, so that is where the work went.

**Sign-in.** Passwords are bcrypt at cost 12, about 0.25 s of CPU each. They used to run on the thread that serves every request, so a sign-in froze the whole gateway for that time. They now run on a pool of worker threads (`passwordHash.ts`, same bcryptjs so every stored hash still works; `PASSWORD_HASH_THREADS`, default cores - 1 up to 4; `PASSWORD_HASH_QUEUE_MAX`, default 400, beyond which new sign-ins are told to retry in a few seconds). Connector keys, checked on every ingest request, are remembered for 10 minutes after a correct check (by a SHA-256 of key and stored hash, so changing the key ends it at once; a wrong key is never remembered).

| 60 people signing in at once, one gateway process, 8-core laptop | Before | After |
|---|---|---|
| All 60 done | 8.2 s (about 7 a second) | 3.1 s (about 20 a second) |
| Median wait | 7.9 s | 1.6 s |
| `/health` meanwhile | 3.2 s (the whole API stopped) | 0.7 s (its normal time here) |

Signed-in sessions are stateless tokens, so the number of people simply signed in is not limited by the gateway, only by how many requests they make. For a shift change, count about 20 sign-ins a second per gateway process on this hardware, more on a server, and add `web` processes for more (the hashing threads are per process).

**What a screen costs on the wire** (this test database has 112,000 people and 200 groups, so the lists are bigger than a typical organisation's; every answer is gzip-compressed, 1,400 KB of JSON became 132 KB):

| Call | JSON | Compressed | Time |
|---|---|---|---|
| groups list | 127 KB | 15 KB | 25 ms |
| 100 people | 90 KB | 5 KB | 25 ms (was 577 ms) |
| 500 people (the default page) | 453 KB | 21 KB | 38 ms (was 446 ms) |
| schedule list (up to 100) | 292 KB, now about 114 KB | 33 KB | 13 ms |
| teams (1,219 of them) | 306 KB | 37 KB | 47 ms |
| coverage | 30 KB | 5 KB | 24 ms |
| adherence summary | 5 KB | 0.7 KB | 9 ms |

Changed for this: an index so the people list is read in name order instead of sorting every person for each page (`059_list_indexes.sql`: 150 ms in the database to 0.1 ms), and the schedule list no longer carries each schedule's full report (it is still returned with the schedule itself). Reads already revalidate with an ETag, so an unchanged list costs a "304 not modified" with no body.

Still large: the teams and schedule lists are not paged, `/config/groups/summary` takes about 230 ms with 112,000 people (it counts across all of them), and nothing was measured with many people using the system at once beyond the 300-request test.

Tests: `test/passwordHash.test.ts` (hash compatibility; the main thread is not held up), and two new cases in `test/performanceBudget.test.ts` (a page of people under 300 ms, the schedule list without reports, 30 simultaneous sign-ins with a simple call staying under 1.5 s).

## Lists, history quality, concurrent load and outbound connections

**Paged lists.** Teams (`GET /workforce/teams?limit&offset&q`, or `fields=pick` for the slim drop-down list, `counts=1` to add head counts) and schedules (`GET /scheduling/versions?limit&offset&status&groupIds&q`) come a page at a time with `X-Total-Count`; the Teams screen and All Schedules search on the server and have "Show more". Asked for nothing, teams return the first 500. With 1,219 teams and 95 schedules in the test database: a page of 100 teams 23 ms (was 154 ms for all of them), schedules 32 ms for 50.

**WFM Groups summary.** The people counts per group are now kept by the database (`group_people`, migration 061, triggers on `employees`: exact however people are added, changed, terminated or deleted) instead of counted from every person each time: 232 ms to 18 ms at 112,000 people, and no longer growing with headcount.

**History quality (was 32 s on one large group).** It scanned a year of intervals for every queue and took a median over all of them. Days, volumes and abandoned calls now come from the daily rollup (`interval_daily` gained `abandoned`, migration 060). Odd handle times, which need the intervals, look at the last 120 days against a median taken from every third day, are worked out in the background, kept for an hour (live data arriving no longer throws them away, which is why a live-fed group kept recomputing), and the screen asks again until they are in.

| Group | Before | After |
|---|---|---|
| 30 queues, 1.15 million intervals | 2.6 s | about 1 s |
| 100 queues, 3.84 million intervals | 6.4 to 7.3 s in the database, 9.3 s end to end | 0.7 to 1.0 s, odd handle times added a few seconds later |

The group that took 32 s in testing was not available; these are the largest groups built here. The cost now grows with queues and the last 120 days, not with the whole history.

**Concurrent load.** `scripts/load-users.mjs` runs many virtual users, each signing in and then opening screens (13 calls a round) with pauses, and reports sign-in time, requests a second, errors, percentiles and what the gateway reported. One gateway process, 112,000-person test database, on a laptop that was also running a browser using two cores and PostgreSQL, so treat these as a floor, not a capacity:

| Users | Requests a second | Typical call | Slowest 5% | Sign-in (median) | Errors |
|---|---|---|---|---|---|
| 50 | 52 to 98 | 1.0 to 1.7 s | 1.9 to 3.8 s | 1.7 to 3.6 s | 0 |
| 200 | 68 | 5.2 s | 12.8 s | 15 s | 0 |

Nothing failed, and the event loop stayed free (worst delay 0.35 s), but a single process on this machine gives roughly 50 to 100 requests a second, which is about 50 people opening screens continuously. More processes did not help *on this one laptop* (three gateways were slower, 37 requests a second with 47 failures, because they shared the same cores with PostgreSQL and the load generator): the scale-out claim has not been shown, and needs separate machines. `test/performanceBudget.test.ts` runs 40 people at once and asserts no server error.

**Found while testing three gateways starting together:** they all applied migrations and rebuilt row-level-security policies at once, and one stopped with "policy already exists". Startup (migrations and first-run set-up) now takes a database lock so processes take turns.

**Outbound connections (security).** Data-feed connectors (REST address, database host, SFTP host) were never checked the way webhooks were, and webhooks only refused private addresses when an option was set, so a configuration administrator could point the server at its own database, cache or message bus and read the answers or the error text (a port scan). Everything that makes the server connect to an address an administrator typed in now goes through `src/netGuard.ts`: REST pulls, database pulls, SFTP pulls, webhooks, SMS gateways and the single sign-on provider.
- Never allowed: cloud metadata addresses, "this host" (0.0.0.0, ::), multicast.
- Not allowed unless named in `OUTBOUND_ALLOW` (IP, CIDR or host name): loopback, link-local, private networks (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7). `OUTBOUND_ALLOW_PRIVATE=true` opens the private networks (not loopback) for a deployment that lives inside one.
- The name is looked up once and the connection is made to the address that was checked (a name that answers differently a moment later cannot slip through), redirects are checked before they are followed, only http and https are spoken, and answers over 25 MB are cut off.
- Saving a connector with an internal address is refused with a plain message; a connector saved earlier is refused when it runs, and what comes back never says what is at the address.
- **Action for an existing deployment:** connectors that legitimately reach a private network now need `OUTBOUND_ALLOW` set, and a development machine with local mock servers needs `OUTBOUND_ALLOW=127.0.0.0/8,::1`. Webhook receivers on a private network likewise (the old `WEBHOOK_BLOCK_PRIVATE` setting is no longer needed: blocking is the default).
- Tests: `test/netGuard.test.ts` (ranges, allow list, names, redirects, schemes) and `test/outboundGuard.test.ts` (run against a gateway without `OUTBOUND_ALLOW`: connectors and webhooks aimed at 127.0.0.1, localhost, ::1, 169.254.169.254 and private ranges are refused; a connector already saved with an internal address is refused at run time without leaking anything).
- Not covered: the Python engine's outbound calls (none made to administrator-typed addresses), and DNS names that resolve to a public address first and an internal one later are handled only because every answer is checked at connect time.
