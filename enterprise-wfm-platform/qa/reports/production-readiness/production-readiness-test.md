# Production Readiness Test

Enterprise WFM Platform · release gate and 50,000-person scale, re-tested · 1–2 November 2026

Admin app :3000 · employee portal :3001 · gateway :4000 · engine :50051 · branch `qa/production-readiness`. Machine: 1 laptop: Intel i5-10310U 4 cores / 8 threads, 15.7 GB RAM (about 3 GB free), one engine, Vite dev servers

## Verdict: NO-GO

Do not launch for a 50,000-person organisation yet. The release gate is a conditional GO: both critical defects and 18 others are fixed, and three high items are left, all small. The scale re-test is much better than the first run: all 13 groups now build, the engine no longer crashes when a solve fails, the 2,000-person limits are gone, and 355,800 re-checked shifts have 0 rule breaks. But these still block a large organisation: one over-limit request freezes the whole API (DEF-31), the job queue kills or repeats builds that are still running (DEF-47), the optimiser crashes on many parts and leaves those parts as the plain starting roster (DEF-48), large builds take 20–75 minutes when two run at once (DEF-46), and screens that load every employee now take up to 72 s (DEF-50). For organisations of a few thousand people, closing the release-gate items is enough.

| Track | First run | Re-test | Open critical | Open high | Open medium | Open low |
| --- | --- | --- | --- | --- | --- | --- |
| Release gate | NO-GO | **CONDITIONAL GO** | 0 | 3 | 4 | 3 |
| 50,000-person scale | NOT READY | **NOT READY** | 1 | 6 | 2 | 2 |

- **Release gate:** Both critical defects and 18 others are fixed and checked. Three high items remain open, and none needs a large change: rotate the bootstrap admin password and force a change (DEF-03, a setting); add an AG Grid licence key or move to the Community edition (DEF-07, a setting or purchase); and label the last 6 form fields on Alerts & reports (DEF-06, a small code fix). Close those and NATS certificate checking (DEF-19), and this gate is a GO.
- **50,000-person scale:** All 13 groups built and passed an independent check of every shift with 0 rule breaks (first run: 9 of 13, and nothing built when started together). Engine crashes are contained, the two-at-a-time limit holds, and the 2,000-person limits are gone. Still blocking: an over-limit request froze the API for 20 minutes, the queue failed or repeated live builds, CP-SAT crashed on every part of two groups, two builds at once took 20–75 minutes each, and the Time off screen now takes 72 s.

## Still blocking launch

| ID | Track | Severity | Defect | Status | What to do |
| --- | --- | --- | --- | --- | --- |
| DEF-03 | Release gate | High | Administrator uses a password on the app's own blocklist and is never asked to change it | Still open | Rotate before go-live. Apply checkNewPassword() to BOOTSTRAP_ADMIN_PASSWORD and set must_change_password=true for the bootstrap admin. |
| DEF-06 | Release gate | High | Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical) | Partly fixed | Add aria-label to icon buttons (lucide icons inside <button>), label selects/inputs. |
| DEF-07 | Release gate | High | AG Grid Enterprise runs without a licence key | Still open | Set VITE_AG_GRID_LICENSE for the production build (or switch to the Community edition). Using Enterprise in production unlicensed breaches the licence. |
| DEF-30 | 50k scale | Critical | Preparing a large schedule freezes the gateway for every user | Partly fixed | Build candidates in a worker thread or in the engine; compute the candidate count arithmetically and pick the thinning level once instead of rebuilding the list; cap per-request CPU for report screens and cache their results. |
| DEF-31 | 50k scale | High | An over-limit schedule request is not refused — it runs 8½ minutes and then drops | Still open | Estimate people × days × starts × lengths before building and refuse at once. |
| DEF-37 | 50k scale | High | At 3,000+ people the optimiser adds nothing: schedules are the greedy starting roster | Partly fixed | Split earlier (smaller parts, solved safely — see DEF-29), give large groups a longer default limit, and show 'starting roster only' prominently on the schedule. |
| DEF-46 | 50k scale | High | Large builds take 20–75 minutes when two run at once, almost all of it before the solver starts | New | Profile candidate preparation. Every candidate shift scans tenant-wide arrays: all approved time off, all 2,008 availability rows and every published shift of other groups (blockedReason, preferenceFor). Index them by employee once (Map) before the loop, and move preparation off the API process (worker thread or the engine). |
| DEF-47 | 50k scale | High | The queue fails or repeats builds that are still running | New | Send the heartbeat from outside the busy event loop (or make preparation yield properly), give the sweeper a much longer grace period, never overwrite a DONE job, and make a job's run single-owner (check the worker and attempt before writing results). |
| DEF-48 | 50k scale | High | CP-SAT crashes on many parts, so those parts get only the starting roster | New | Capture the worker's stderr and a core dump to find the abort (often memory, or a model OR-Tools rejects); try fewer search workers or a per-process memory limit; report 'starting roster only' on the schedule when every solver fails. |
| DEF-50 | 50k scale | High | Screens that load every employee became very slow once the 2,000 limit was lifted | New | Make every screen and picker that needs employees use paging or a search endpoint (names and ids only), and cap or refuse the unpaged list on large organisations. |

## 50,000-person scale re-test

50,000 employees in 13 WFM groups, one organisation, schedule week from 2026-11-02. Same data, forecasts and machine as the first run; only the code changed.

| Measure | Run 1 (31 Oct) | Run 2 (1 Nov) |
| --- | --- | --- |
| All builds started together | 0 of 12 built | 6 of 13 built |
| Builds running at once (limit 2) | up to 10 | 2 |
| Gateway while building (health check) | no answer for most of 42 min | p50 546 ms, p95 5.8 s, worst 32.1 s; 7 failed of 435 |
| Schedules built (any way) | 9 of 13 | 13 of 13 |
| Engine crashes | 15 | 0 |
| Over-limit request | ran 8.5 min, then the connection dropped | still no answer: both requests timed out after 5 min and the API answered nobody for 20 min, until the gateway was restarted |
| Shifts re-checked by the independent checker | 250,495 | 355,809 |
| Rule breaks found | 0 | 0 |

### Per group

| Group | People | Run 1 | Run 2 all at once | Run 2 result | Solver | Covered | Shifts | Rule breaks |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: |
| S01 · Voice office hours | 6,000 | built (98.4%) | DONE · 20.1 min | built (queued with all 13) | cpsat+greedy | 98.6% | 30,000 | 0 |
| S02 · Voice 24x7 with nights | 6,000 | failed | DONE · 41 min | built (queued with all 13) | cpsat | 83.1% | 30,000 | 0 |
| S03 · Chat part-time mix | 5,000 | failed | DONE · 96.5 min | built (queued with all 13) | cpsat | 95.9% | 20,001 | 0 |
| S04 · Email back office | 3,000 | built (43.5%) | DONE · 55.7 min | built (queued with all 13) | cpsat | 87.1% | 14,999 | 0 |
| S05 · Multi-skill EN/ES | 5,000 | failed | DONE · 100 min | built (queued with all 13) | greedy | 91.7% | 20,000 | 0 |
| S06 · Time off and availability | 4,000 | built (95.8%) | Interrupted by standby | built (re-queued after the standby) | greedy | 95.8% | 19,600 | 0 |
| S07 · Rotation 4-on-4-off | 2,000 | built (67.4%) | DONE · 105.7 min | built (queued with all 13) | cpsat | 67.4% | 6,479 | 0 |
| S08 · Weekend retail peaks | 4,000 | built (83.9%) | Interrupted by standby | built (re-queued after the standby) | cpsat | 83.9% | 20,000 | 0 |
| S09 · London site (Europe/London) | 4,000 | failed | Interrupted by standby | built (re-queued after the standby) | cpsat | 95.1% | 20,000 | 0 |
| S10 · Long plan 13 weeks | 2,000 | built (95.8%) | Interrupted by standby | built (re-queued after the standby) | cpsat | 95.8% | 129,730 | 0 |
| S11 · Overstaffed (VTO) | 3,000 | built (96.5%) | Interrupted by standby | built (same queue, after the standby) | cpsat | 96.5% | 15,000 | 0 |
| S12 · Understaffed (overtime) | 3,000 | built (51.2%) | Interrupted by standby | built (re-queued after the standby) | cpsat | 51.2% | 15,000 | 0 |
| S13 · Candidate-limit boundary | 3,000 | built (96.1%) | Interrupted by standby | built (re-queued after the standby) | cpsat | 96.1% | 15,000 | 0 |

"Covered" is the share of required staff-hours the schedule meets. "Rule breaks" are counted by an independent checker that re-reads every shift against each person's rules (double-booking, rest, weekly hours, days in a row, leave, unavailable hours, weekends, night consent, shift length).

### Organisations above 2,000 people

| Check | Run 1 | Run 2 |
| --- | --- | --- |
| Employee list, no filter | stopped at 2,000 rows without saying so | all 50,656 rows; but the call takes 40 s and sends 42 MB |
| Employee list, paged (?limit=50&offset=40000) | no paging | 50 rows, correct total (x-total-count 50,656) |
| Bulk edit someone beyond the first 2,000 | silently skipped | updated (S04-02999 minimum rest 12 h) |
| Re-import someone beyond the first 2,000 | failed | updated; a one-row file took 16–45 s while builds ran |
| Direct (wait-for-it) build of 3,000+ people | not tried | refused at once with a clear message to use a background build |

### API reads at 50,000 people

| Read | Run 1 time | Run 2 time | Run 2 size | Rows |
| --- | --- | --- | --- | --- |
| employees (unfiltered) | 968 ms | 39.6 s | 42,008 kB | 50,656 |
| employees of a 6,000 group | 987 ms | 903 ms | 4,888 kB | 6,000 |
| time off (all) | 28 ms | 42 ms | 149 kB | 427 |
| availability (all) | 41 ms | 58 ms | 414 kB | 2,008 |
| schedule versions | 38 ms | 60 ms | 578 kB | 73 |
| shifts of a 6,000 group (1 wk) | 1.1 s | 1.6 s | 18,281 kB | 30,000 |
| schedule plan view | 18.4 s | 3.8 s | 1 kB | — |
| live coverage (6,000 group) | 125 ms | 107 ms | 26 kB | — |
| adherence (6,000 group) | 431 ms | 1.2 s | 3,501 kB | — |
| rollup by site | 2.6 s | 3.6 s | 27 kB | — |
| forecast versions | 12 ms | 20 ms | 27 kB | 43 |
| audit log | 26 ms | 31 ms | 53 kB | 100 |
| attendance summary | 738 ms | 1.1 s | 25 kB | — |
| users | 11 ms | 12 ms | 11 kB | 44 |
| self-service logins | 5 ms | 7 ms | 4 kB | 18 |

### Admin screens at 50,000 people (Chrome, dev server)

| Screen | Run 1 | Run 2 | Memory | Problems |
| --- | --- | --- | --- | --- |
| Employees list | 5.1 s | 3.9 s | 34 MB | none |
| Overview | 1.1 s | 2.3 s | 52 MB | none |
| Schedule timeline | 43.8 s | 27.3 s | 295 MB | none |
| All schedules | 2.6 s | 1.2 s | 307 MB | none |
| Live coverage | 30.3 s | 30.1 s | 38 MB | none |
| Adherence | 30.2 s | 30.2 s | 101 MB | none |
| Time off | 3.1 s | 72.1 s | 108 MB | none |
| Year plan | 8 s | 2.8 s | 38 MB | none |
| Schedule quality | 120.4 s | 54.1 s | 40 MB | none |

### Employee portal for one of the 50,000

Signed in as an S01 agent: home in 7.4 s (ok); portal API /me/home 200 214 ms, /me/schedule 200 38 ms, /me/time-off 200 35 ms, /me/swaps 200 44 ms, /me/offers 200 39 ms, /me/notifications 200 12 ms; 4 shifts visible this period.

## Release gate re-test

Both critical defects and 18 others are fixed and checked. Three high items remain open, and none needs a large change: rotate the bootstrap admin password and force a change (DEF-03, a setting); add an AG Grid licence key or move to the Community edition (DEF-07, a setting or purchase); and label the last 6 form fields on Alerts & reports (DEF-06, a small code fix). Close those and NATS certificate checking (DEF-19), and this gate is a GO.

| Area | Result |
| --- | --- |
| Playwright suite | 104 of 108 passed |
| Functional API checks | 100 of 101 |
| UI journeys (admin + portal) | 33 of 35 |
| Security attack tests | 14 of 16 |
| Access control (role × route) | 1,934 checks over 327 guarded routes, 0 leaks |
| Screens crawled | 51 admin + 5 portal |
| Static checks | TypeScript — admin web app: ok; TypeScript — employee portal: ok; TypeScript — gateway: ok; Production build — admin: ok; Production build — portal: ok; Secrets scan of both bundles: ok; Engine unit tests (pytest): FAIL; Gateway's own API suite (75 files, first run only): FAIL |

| Re-test result | Release gate | 50k scale |
| --- | --- | --- |
| Fixed | 20 | 8 |
| Partly fixed | 3 | 3 |
| Still open | 4 | 1 |
| Still applies | 1 | 0 |
| New | 3 | 5 |
| Not re-tested | 0 | 2 |

## All defects

50 defects across both tracks (the CSV has the full text: `defects.csv`).

| ID | Track | Severity | Defect | Re-test | Note |
| --- | --- | --- | --- | --- | --- |
| DEF-01 | Release gate | Critical | A disabled user's existing session keeps working | Fixed | Old token refused straight after the account is disabled: 200 before, 401 immediately after and 6 s later. |
| DEF-14 | Release gate | Critical | Forecast/schedule engine crashes with a native abort inside the CP-SAT solver, and stays down | Fixed | Crash injection: the CP-SAT solver process was killed mid-build. The engine stayed up (0 restarts), the build fell back to HiGHS and finished DONE ("cpsat: failed (the solver process ended without an answer)", "highs: feasible"). Each solve now runs in its own process. |
| DEF-02 | Release gate | High | Admin can book overlapping time off for the same person | Fixed | A second, overlapping admin booking now returns 409 with a clear message naming the existing vacation. |
| DEF-03 | Release gate | High | Administrator uses a password on the app's own blocklist and is never asked to change it | Still open | Admin still signs in with the blocklisted bootstrap password and is not asked to change it (mustChangePassword=false). SEC-01 fails. |
| DEF-04 | Release gate | High | Ctrl+K search shows fake prototype records and cannot find real ones | Fixed | Prototype SEED_ data is gone. In the live palette "Jane" and "Voice Inbound" now find nothing, while "Agent1" lists the real employees, "Demo Support" the real group and "Shift Templates" the screen; Enter opens the result. |
| DEF-05 | Release gate | High | Admin sidebar cannot be used with a keyboard or screen reader | Fixed | Sidebar items are now focusable buttons: Tab reaches Overview, Workforce, Employees, Teams, Skills and the rest (A-03 passes). |
| DEF-06 | Release gate | High | Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical) | Partly fixed | Unnamed buttons are gone: 530 elements on 51 screens down to 0. Still 6 form fields without labels on Administration > Alerts & reports (critical "label" rule). |
| DEF-07 | Release gate | High | AG Grid Enterprise runs without a licence key | Still open | ag-grid-enterprise is still a dependency, there is no licence key in any env file, and the licence banner is still logged on 4 screens (Employees, Time off, Attendance, Activities). |
| DEF-08 | Release gate | Medium | CSV formula injection in the audit export | Fixed | The audit CSV now writes the team name with a leading apostrophe ('=HYPERLINK...), so spreadsheets show it as text. |
| DEF-09 | Release gate | Medium | Session token accepted in the URL (?token=) on every REST route | Fixed | GET /users?token=<valid JWT> now returns 401. |
| DEF-10 | Release gate | Medium | Response time reveals whether a username exists | Fixed | Median sign-in time is 293 ms for a real user and 301 ms for an unknown one. |
| DEF-11 | Release gate | Medium | Impossible calendar date returns 500 and leaks the PostgreSQL error | Fixed | 2026-02-30 now returns 400 "One of the values is not valid (check dates and numbers)." with no database text. |
| DEF-12 | Release gate | Medium | Failed sign-in attempts are not written to the audit log | Fixed | A failed admin sign-in now appears in the audit log. |
| DEF-13 | Release gate | Medium | Forecast Builder takes ~34 s to finish loading | Fixed | History-quality API answers in 21 ms (2 ms cached); Forecast Builder settles in 6.6 s on the dev server (was about 34 s). |
| DEF-15 | Release gate | Medium | Admin JavaScript is a single 4.2 MB chunk (1.18 MB gzipped) | Fixed | Screens are now lazy-loaded: entry chunk 282 kB (87 kB gzip) across 35 chunks. AG Grid (2.7 MB) and exceljs (940 kB) load only on screens that use them. |
| DEF-16 | Release gate | Medium | Employee list is not paginated | Partly fixed | ?limit= and ?offset= are now accepted, but paging happens after a capped 2,000-row load: x-total-count says 2000 on a 50,656-person tenant, offset 40000 returns 0 rows, and 50 rows cost the same ~500 ms as 2,000. Push LIMIT/OFFSET (or keyset paging) into the SQL and return the true total (see scale DEF-29). |
| DEF-17 | Release gate | Medium | Portal is not usable on a phone browser | Fixed | At 412 px the portal has no sidebar and no sideways scroll; content uses the full width on every section. |
| DEF-18 | Release gate | Medium | Colour contrast below WCAG AA on every screen of both apps | Partly fixed | Low-contrast elements roughly halved (822 to 457) but still present on all 51 admin screens; the portal sign-in still has 2. |
| DEF-19 | Release gate | Medium | NATS TLS certificate checking is switched off | Still open | backend/.env still has NATS_TLS_REJECT_UNAUTHORIZED=false. |
| DEF-43 | Release gate | Medium | Adherence takes about 2 s per call on a large tenant | New | Found in this re-test. |
| DEF-20 | Release gate | Low | Offers show an empty group name to the employee | Fixed | Code check: /me/offers now joins wfm_groups and returns group_name. Not seen live, because the demo agent had no open offers during the run. |
| DEF-21 | Release gate | Low | No URLs per section: reload always returns to Home, Back leaves the app | Fixed | Each portal section has its own URL; reloading on /inbox stays on Inbox (P-08 passes). |
| DEF-22 | Release gate | Low | Time-off form accepts end-before-start until it is submitted | Fixed | The form flags an end date before the start date before it is submitted (P-05 passes). |
| DEF-23 | Release gate | Low | Hire date in 2099 is accepted | Fixed | Hire date 2099-01-01 now returns 400 "hireDate must be between 1950 and a year from now". |
| DEF-24 | Release gate | Low | Malformed JSON returns error code INTERNAL | Fixed | Broken JSON now returns 400 BAD_JSON. |
| DEF-25 | Release gate | Low | Unauthenticated endpoints reveal account existence and organisation name | Still open | Unchanged (a configuration choice): /auth/discover still returns the organisation for a known login and an empty list for an unknown one; /auth/login-options names the organisation. Set LOGIN_DISCOVERY=false if org codes are handed out another way. |
| DEF-26 | Release gate | Low | No favicon — 404 on every page load | Fixed | Both apps link /favicon.svg, served as image/svg+xml. |
| DEF-27 | Release gate | Low | scripts/demo-seed.mjs cannot finish | Fixed | Code check: the seed now handles the forced password change. Not re-run, because it rewrites the demo data. |
| DEF-44 | Release gate | Low | Gateway process ended once with no log line | New | Found in this re-test; seen once. |
| DEF-45 | Release gate | Low | Engine unit tests: 3 of 91 fail after the solver change | New | Found in this re-test. |
| DEF-28 | Release gate | Info | Existing data to clean before go-live | Still applies | Still a pre-launch housekeeping item. The database now also holds the 50,000-person SCALE test data and QA- records from both runs. |
| DEF-29 | 50k scale | Critical | Engine crashes on large solves and takes every running build down with it | Fixed | Each solve now runs in its own process. CP-SAT still died natively on parts of S01, S05, S06 and S10 (exit code 0xC0000409), but only that process ended: the engine server itself had 0 crashes, other builds carried on, and every build finished. The crashes themselves are now DEF-48. |
| DEF-30 | 50k scale | Critical | Preparing a large schedule freezes the gateway for every user | Partly fixed | Normal builds no longer freeze the API: with two 4,000–6,000-person builds preparing at once for 2 hours, health checks had a median of 546 ms. But 21 of 435 took over 10 s and 7 got no answer within 30 s, and the over-limit request in DEF-31 still froze everything. |
| DEF-31 | 50k scale | High | An over-limit schedule request is not refused — it runs 8½ minutes and then drops | Still open | The same request (every 15-minute start and length for 3,000 people) got no answer: the direct build and the background job both timed out after 5 minutes, and the gateway sat at 100% of one core and answered nobody for 20 minutes until it was restarted. The new up-front size check lets it through because its estimate assumes the thinnest setting. |
| DEF-32 | 50k scale | High | Employee list stops at 2,000 people without saying so | Fixed | The list returns all 50,656 people, and ?limit=&offset= pages correctly with the true total. But the unpaged list now takes 40 s and sends 42 MB even with nothing else running, and screens that still load it pay for it (DEF-50). |
| DEF-33 | 50k scale | High | Bulk edit silently skips anyone outside the first 2,000 | Fixed | Bulk edit of S04-02999 (beyond the first 2,000) was applied. |
| DEF-34 | 50k scale | High | Re-importing existing employees fails once the organisation has more than 2,000 people | Fixed | Re-importing S04-02999 was matched and updated (dry run and commit). It took 16–45 s for one row while builds ran. |
| DEF-35 | 50k scale | High | The 'two builds at a time' limit is not enforced | Fixed | All 13 builds were queued together; never more than 2 ran at once. The queue has a new problem with long builds, see DEF-47. |
| DEF-36 | 50k scale | Medium | Jobs fail at once while the engine restarts, and timeouts are reported as 'engine not reachable' | Fixed | The gateway now retries: its log shows 'ENGINE_UNAVAILABLE; trying again (attempt 2 of 3)' and 'ENGINE_CRASHED; trying again'. One build (S13) still failed with a 2-minute engine timeout while the database was recovering from a crash; it built on the next try. |
| DEF-37 | 50k scale | High | At 3,000+ people the optimiser adds nothing: schedules are the greedy starting roster | Partly fixed | Groups are now split into parts of 667–800 people that CP-SAT improves: S02 (failed in run 1) reached 83.1%, S09 95.1%, S11 96.5%. Where CP-SAT crashes (DEF-48) the part is still the greedy starting roster: all of S05 and S06, 2 of 8 parts of S01. |
| DEF-38 | 50k scale | Medium | Email (24 h turnaround) demand is spread across the night | Fixed | Email back office (S04) coverage rose from 43.5% to 87.1%. |
| DEF-39 | 50k scale | Medium | Full-timers scheduled well below contract hours with no warning | Fixed | Full-timers now average their 40 contract hours in 11 groups (S06 39.2 h with 400 people on leave; S07 37.3 h on the 4-on-4-off rota). First run: 21.7–32.7 h in several groups. |
| DEF-40 | 50k scale | Medium | Screens and reads for a 6,000-person group are slow and heavy | Partly fixed | Faster: schedule plan view 18.4 s to 3.8 s, schedule timeline 44 s to 27 s, schedule quality 120 s to 54 s, all schedules 2.6 s to 1.2 s. Still slow: shifts of a 6,000-person group are 18 MB in one call, live coverage and adherence screens take about 30 s to settle, and the Time off screen got much slower (DEF-50). |
| DEF-41 | 50k scale | Low | Model choice is not explained: unsuitable models run, unavailable ones fall back quietly | Not re-tested | Forecasts from the first run were reused. |
| DEF-42 | 50k scale | Low | Publishing a schedule does not notify the people on it | Not re-tested | Schedules were not published in this run. |
| DEF-46 | 50k scale | High | Large builds take 20–75 minutes when two run at once, almost all of it before the solver starts | New | Found in this re-test. |
| DEF-47 | 50k scale | High | The queue fails or repeats builds that are still running | New | Found in this re-test. |
| DEF-48 | 50k scale | High | CP-SAT crashes on many parts, so those parts get only the starting roster | New | Found in this re-test. |
| DEF-49 | 50k scale | Medium | The gateway stopped again with no log line, right after an engine crash | New | Found in this re-test. |
| DEF-50 | 50k scale | High | Screens that load every employee became very slow once the 2,000 limit was lifted | New | Found in this re-test. |

### Defect details

#### DEF-03 · High · Administrator uses a password on the app's own blocklist and is never asked to change it

- **Track / area:** Release gate · Security · Configuration
- **Re-test:** Still open. Admin still signs in with the blocklisted bootstrap password and is not asked to change it (mustChangePassword=false). SEC-01 fails.
- **Steps:** Sign in as admin (tenant ORG)
- **Expected:** Strong password; temporary/bootstrap passwords force a change
- **Actual:** Password is in EASY list of passwordPolicy.ts and contains the username; mustChangePassword=false
- **Fix:** Rotate before go-live. Apply checkNewPassword() to BOOTSTRAP_ADMIN_PASSWORD and set must_change_password=true for the bootstrap admin.

#### DEF-06 · High · Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical)

- **Track / area:** Release gate · Accessibility
- **Re-test:** Partly fixed. Unnamed buttons are gone: 530 elements on 51 screens down to 0. Still 6 form fields without labels on Administration > Alerts & reports (critical "label" rule).
- **Steps:** axe-core WCAG 2.1 AA scan of all 51 admin screens
- **Expected:** 0 critical violations
- **Actual:** button-name: 530 elements on 51/51 screens; plus select-name and missing form labels on one screen
- **Fix:** Add aria-label to icon buttons (lucide icons inside <button>), label selects/inputs.

#### DEF-07 · High · AG Grid Enterprise runs without a licence key

- **Track / area:** Release gate · Release · Licensing
- **Re-test:** Still open. ag-grid-enterprise is still a dependency, there is no licence key in any env file, and the licence banner is still logged on 4 screens (Employees, Time off, Attendance, Activities).
- **Steps:** Open Workforce › Employees (console)
- **Expected:** Licensed grid, no watermark
- **Actual:** Console prints the AG Grid Enterprise licence banner; grids show the trial watermark
- **Fix:** Set VITE_AG_GRID_LICENSE for the production build (or switch to the Community edition). Using Enterprise in production unlicensed breaches the licence.

#### DEF-16 · Medium · Employee list is not paginated

- **Track / area:** Release gate · Performance · Scale
- **Re-test:** Partly fixed. ?limit= and ?offset= are now accepted, but paging happens after a capped 2,000-row load: x-total-count says 2000 on a 50,656-person tenant, offset 40000 returns 0 rows, and 50 rows cost the same ~500 ms as 2,000. Push LIMIT/OFFSET (or keyset paging) into the SQL and return the true total (see scale DEF-29).
- **Steps:** GET /workforce/employees (≈ 420 people)
- **Expected:** Paged/filtered
- **Actual:** 328 kB per call; 40 req/s with p95 627 ms at 25 concurrent
- **Fix:** Server-side paging and field selection; the grid can use the AG Grid server-side row model.

#### DEF-18 · Medium · Colour contrast below WCAG AA on every screen of both apps

- **Track / area:** Release gate · Accessibility
- **Re-test:** Partly fixed. Low-contrast elements roughly halved (822 to 457) but still present on all 51 admin screens; the portal sign-in still has 2.
- **Steps:** axe scan
- **Expected:** 4.5:1 for text
- **Actual:** 822 elements on 51/51 admin screens; portal login and 4/5 sections
- **Fix:** Darken #A3A3A3/#737373 secondary text on white/#FAFAF8 backgrounds.

#### DEF-19 · Medium · NATS TLS certificate checking is switched off

- **Track / area:** Release gate · Security · Configuration
- **Re-test:** Still open. backend/.env still has NATS_TLS_REJECT_UNAUTHORIZED=false.
- **Steps:** backend/.env
- **Expected:** NATS_TLS_REJECT_UNAUTHORIZED=true in production
- **Actual:** false
- **Fix:** Set to true with a trusted CA for production.

#### DEF-43 · Medium · Adherence takes about 2 s per call on a large tenant

- **Track / area:** Release gate · Performance · Intraday
- **Re-test:** New. Found in this re-test.
- **Steps:** GET /intraday/adherence?groupId=<Demo Support> 15 times, on the tenant that now also holds the 50,656-person scale data
- **Expected:** Close to the first run (p95 23 ms): the group still has the same people
- **Actual:** p50 1,913 ms, p95 2,232 ms. The three SQL queries behind it take about 20 ms in total when run directly as the database owner (row-level security does not apply there), so the time goes on row-level-security checks or work in the gateway. /workforce/employees is 641 ms and 1.6 MB for 2,000 rows, and under 25 parallel requests it manages 1 request per second (p50 15 s, p95 21 s; all 200).
- **Fix:** Profile the endpoint as the app role (RLS on); make sure the RLS policy uses an indexed, STABLE tenant lookup; add an index on employees(primary_group_id) and a GIN index on eligible_group_ids.

#### DEF-25 · Low · Unauthenticated endpoints reveal account existence and organisation name

- **Track / area:** Release gate · Security · Sign-in
- **Re-test:** Still open. Unchanged (a configuration choice): /auth/discover still returns the organisation for a known login and an empty list for an unknown one; /auth/login-options names the organisation. Set LOGIN_DISCOVERY=false if org codes are handed out another way.
- **Steps:** POST /auth/discover {identifier:<email>}; GET /auth/login-options
- **Expected:** Off in production unless needed
- **Actual:** Returns the organisation for a real e-mail, [] otherwise (rate-limited 15 per 15 min)
- **Fix:** Set LOGIN_DISCOVERY=false for production if the org code is distributed another way.

#### DEF-44 · Low · Gateway process ended once with no log line

- **Track / area:** Release gate · Reliability · Gateway
- **Re-test:** New. Found in this re-test; seen once.
- **Steps:** Run the API-latency test (12 endpoints x 15 calls) straight after the full suite
- **Expected:** The gateway stays up, or logs why it stopped
- **Actual:** The process ended with exit code 127 and nothing in its log; the test got ECONNRESET. After a restart the same test ran cleanly, so it did not reproduce.
- **Fix:** Run the gateway under a process manager that restarts it, and log uncaughtException, unhandledRejection and process exit before quitting.

#### DEF-45 · Low · Engine unit tests: 3 of 91 fail after the solver change

- **Track / area:** Release gate · Tooling · Engine tests
- **Re-test:** New. Found in this re-test.
- **Steps:** cd backend/engine && python -m pytest -q
- **Expected:** 91 passed (as in the first run)
- **Actual:** 88 passed, 3 failed. test_a_failing_primary_falls_through_to_the_next_solver and test_every_solver_failing_still_ends_with_the_greedy_roster stub solve_cpsat, but the solver now runs in a separate process the stub never reaches (both pass with ENGINE_ISOLATE_SOLVES=0). test_no_history_changes_nothing is flaky: the same request can give a different roster (it failed 1 of 2 times in-process).
- **Fix:** Stub solve_cpsat_isolated (or set ENGINE_ISOLATE_SOLVES=0) in those two tests; fix the CP-SAT random seed and use 1 search worker in the determinism test.

#### DEF-28 · Info · Existing data to clean before go-live

- **Track / area:** Release gate · Data hygiene
- **Re-test:** Still applies. Still a pre-launch housekeeping item. The database now also holds the 50,000-person SCALE test data and QA- records from both runs.
- **Steps:** Configuration › Integration Station; Data Management › Staged imports
- **Expected:** —
- **Actual:** A connector points at nats://192.168.9.81:4222 (TIMEOUT); 6 failed history imports (672–5,000 rows rejected); test employees EXT7172 etc.
- **Fix:** Start production from a clean database; do not migrate this test data.

#### DEF-30 · Critical · Preparing a large schedule freezes the gateway for every user

- **Track / area:** 50k scale · Gateway · Availability
- **Re-test:** Partly fixed. Normal builds no longer freeze the API: with two 4,000–6,000-person builds preparing at once for 2 hours, health checks had a median of 546 ms. But 21 of 435 took over 10 s and 7 got no answer within 30 s, and the over-limit request in DEF-31 still froze everything.
- **Steps:** Start schedule builds for groups of 5,000–6,000 people; call GET /health and the admin app meanwhile
- **Expected:** The API stays responsive while schedules are built in the background
- **Actual:** Gateway pinned at 100% of one CPU core (Node main thread, 430→604 MB); /health timed out at 15–30 s continuously for 40+ minutes; DB sessions sat 'idle in transaction' waiting for the gateway; S03 spent 16 minutes preparing. Opening Schedule Quality for a 6,000-person group did the same for 2+ minutes.
- **Fix:** Build candidates in a worker thread or in the engine; compute the candidate count arithmetically and pick the thinning level once instead of rebuilding the list; cap per-request CPU for report screens and cache their results.

#### DEF-31 · High · An over-limit schedule request is not refused — it runs 8½ minutes and then drops

- **Track / area:** 50k scale · Scheduling · Limits
- **Re-test:** Still open. The same request (every 15-minute start and length for 3,000 people) got no answer: the direct build and the background job both timed out after 5 minutes, and the gateway sat at 100% of one core and answered nobody for 20 minutes until it was restarted. The new up-front size check lets it through because its estimate assumes the thinnest setting.
- **Steps:** S13: one template with every 15-minute start and every length 4–12 h, 3,000 people, POST /scheduling/versions
- **Expected:** Immediate 400: 'too many possible shifts' (the 900,000 limit exists in the code)
- **Actual:** 510 s, then the connection failed; /health afterwards showed Redis down; the gateway answered nobody meanwhile
- **Fix:** Estimate people × days × starts × lengths before building and refuse at once.

#### DEF-37 · High · At 3,000+ people the optimiser adds nothing: schedules are the greedy starting roster

- **Track / area:** 50k scale · Scheduling · Optimiser
- **Re-test:** Partly fixed. Groups are now split into parts of 667–800 people that CP-SAT improves: S02 (failed in run 1) reached 83.1%, S09 95.1%, S11 96.5%. Where CP-SAT crashes (DEF-48) the part is still the greedy starting roster: all of S05 and S06, 2 of 8 parts of S01.
- **Steps:** Schedule any group with ≥ 210,000 candidate shifts (S01, S06, S08, S11, S12, S13) with a 90 s limit
- **Expected:** CP-SAT improves on the starting roster; or the screen says the result is unoptimised
- **Actual:** Every one: 'cpsat: feasible (starting roster only), highs: unknown, scip: unknown, greedy: feasible', gap 1 (100%). Valid schedules, often 95–98% covered, but contract hours, preferences and fairness are not optimised. Only S04/S07 (≤ 75,000 candidates) were optimised.
- **Fix:** Split earlier (smaller parts, solved safely — see DEF-29), give large groups a longer default limit, and show 'starting roster only' prominently on the schedule.

#### DEF-40 · Medium · Screens and reads for a 6,000-person group are slow and heavy

- **Track / area:** 50k scale · Performance · Large groups
- **Re-test:** Partly fixed. Faster: schedule plan view 18.4 s to 3.8 s, schedule timeline 44 s to 27 s, schedule quality 120 s to 54 s, all schedules 2.6 s to 1.2 s. Still slow: shifts of a 6,000-person group are 18 MB in one call, live coverage and adherence screens take about 30 s to settle, and the Time off screen got much slower (DEF-50).
- **Steps:** Open screens with the 6,000-person group selected; call the shift and plan APIs
- **Expected:** < 5 s
- **Actual:** Schedule Timeline 44 s, 236 MB browser heap; Live Coverage and Adherence 30 s; Schedule Quality > 120 s; plan view API 18 s; shifts API returns everything at once (15 MB for one week; 79 MB for 2,000 people × 13 weeks — about 1 GB for 6,000 × 52 weeks)
- **Fix:** Page and window the shift APIs (by day/team), virtualise the timeline, precompute report screens.

#### DEF-41 · Low · Model choice is not explained: unsuitable models run, unavailable ones fall back quietly

- **Track / area:** 50k scale · Forecasting
- **Re-test:** Not re-tested. Forecasts from the first run were reused.
- **Steps:** Request ARIMA for S09, Croston for S04, GBM for S06
- **Expected:** The screen says what each model needs and warns when the chosen one is worse than a naive forecast
- **Actual:** ARIMA used though worse than seasonal naive (MASE 2.6, WAPE 7.7% vs ~0.1–0.2% elsewhere, stability VARIABLE). GBM needs 120 days of history and Croston a sparse daily series; both fell back with a note only in the summary.
- **Fix:** Show eligibility next to each model and warn when the selected model loses to the baseline.

#### DEF-42 · Low · Publishing a schedule does not notify the people on it

- **Track / area:** 50k scale · Self-service
- **Re-test:** Not re-tested. Schedules were not published in this run.
- **Steps:** Publish S01 (6,000 people) → sign in as S01-00001
- **Expected:** 'Your schedule for 2–8 Nov is published'
- **Actual:** 0 notifications (shifts are visible)
- **Fix:** Confirm intended behaviour; if not, notify on publish (batched).

#### DEF-46 · High · Large builds take 20–75 minutes when two run at once, almost all of it before the solver starts

- **Track / area:** 50k scale · Scheduling · Performance
- **Re-test:** New. Found in this re-test.
- **Steps:** Queue the 13 SCALE builds together (2 run at a time) on a gateway that has been up for a few hours; S01's 24,288-shift schedule from the first run is published
- **Expected:** A few minutes per group (the solver itself needs 1.5–3 minutes)
- **Actual:** S01 20 min, S02 41 min, S03 76 min, S05 44 min for the build itself; the solver's share was 90–190 s. The gateway sat at 100% of one core while the engine was idle. On a freshly restarted gateway, one build at a time, groups of 3,000–4,000 took 4–9 minutes.
- **Fix:** Profile candidate preparation. Every candidate shift scans tenant-wide arrays: all approved time off, all 2,008 availability rows and every published shift of other groups (blockedReason, preferenceFor). Index them by employee once (Map) before the loop, and move preparation off the API process (worker thread or the engine).

#### DEF-47 · High · The queue fails or repeats builds that are still running

- **Track / area:** 50k scale · Scheduling · Job queue
- **Re-test:** New. Found in this re-test.
- **Steps:** Run two large background builds at once, or one long build, and watch schedule_jobs
- **Expected:** A running build keeps its slot and its status until it finishes
- **Actual:** While a build prepares, its heartbeat falls more than 30 s behind, so the sweeper hands it back to the queue while it is still running. S02 and S05 were built twice (two S02 versions). S05 showed QUEUED while running. S09 and S10 failed with 'The server restarted twice while this was running' with no restart, and S10 saved an empty version. After the laptop's standby, S05's finished build was overwritten as FAILED.
- **Fix:** Send the heartbeat from outside the busy event loop (or make preparation yield properly), give the sweeper a much longer grace period, never overwrite a DONE job, and make a job's run single-owner (check the worker and attempt before writing results).

#### DEF-48 · High · CP-SAT crashes on many parts, so those parts get only the starting roster

- **Track / area:** 50k scale · Scheduling · Engine
- **Re-test:** New. Found in this re-test.
- **Steps:** Build S05 (5,000 people, two skills) or S06 (4,000 people, leave and availability) as a background plan
- **Expected:** CP-SAT solves each 750–800-person part
- **Actual:** The solver process ended with exit code 0xC0000409 (a native abort) on every part of S05 and S06 and on 2 of 8 parts of S01. HiGHS and SCIP returned 'unknown', so those parts used the greedy roster. In S05, 1,000 people got no shifts at all.
- **Fix:** Capture the worker's stderr and a core dump to find the abort (often memory, or a model OR-Tools rejects); try fewer search workers or a per-process memory limit; report 'starting roster only' on the schedule when every solver fails.

#### DEF-49 · Medium · The gateway stopped again with no log line, right after an engine crash

- **Track / area:** 50k scale · Reliability · Gateway
- **Re-test:** New. Found in this re-test.
- **Steps:** Background build of S10 (13-week plan); the engine's solver crashed and the gateway logged 'ENGINE_CRASHED; trying again'
- **Expected:** The gateway retries the build, or logs why it stops
- **Actual:** The gateway process ended with exit code 127 and nothing more in its log. This is the second time (release-gate DEF-44). The build failed and was retried after the gateway was back.
- **Fix:** Log uncaughtException, unhandledRejection and process exit before quitting; run the gateway under a supervisor that restarts it.

#### DEF-50 · High · Screens that load every employee became very slow once the 2,000 limit was lifted

- **Track / area:** 50k scale · Performance · Workforce
- **Re-test:** New. Found in this re-test.
- **Steps:** Open Workforce > Time off in Chrome on the 50,656-person organisation; call GET /workforce/employees with no paging
- **Expected:** A few seconds, as in the first run (3.1 s)
- **Actual:** Time off took 72 s to settle (first run 3.1 s). The unpaged employee list takes 40 s and sends 42 MB with nothing else running. The Employees screen itself pages and opens in 3.9 s.
- **Fix:** Make every screen and picker that needs employees use paging or a search endpoint (names and ids only), and cap or refuse the unpaged list on large organisations.

## What works well

- All 13 scenario groups (50,000 people) built: 24x7 nights, part-timers, multi-skill, leave and availability, a 4-on-4-off rota, another time zone, a 13-week plan, over- and under-staffing, and the candidate-limit case. In the first run, 4 groups never built.
- Independent re-check of every shift in all 13 schedules (about 355,800 shifts, including the 13-week plan): 0 double-bookings, 0 rest or weekly-hour breaks, 0 shifts on approved leave or in unavailable hours, 0 weekend shifts for the 1,200 people who may not work weekends.
- A crashing solve no longer takes the engine or other builds down: each part runs in its own process and falls back to HiGHS, SCIP and then the greedy roster.
- The two-builds-at-a-time limit holds with 13 builds queued at once.
- The 2,000-person limits are gone: the employee list, bulk edit and re-import work for all 50,656 people, with paging and a true total.
- Full-timers now get their contract hours (40 h on average), and the email back office is 87% covered instead of 44%.
- A wait-for-it build of 3,000+ people is refused at once with a clear message to build in the background.
- Role-based access control: 1,934 role × route checks over 327 guarded routes and 6 roles — no route answered without its permission, no role wrongly blocked, every guarded route returns 401 when signed out.
- Token security: alg:none, role-swapped payload, bad signature, expired and garbage tokens all rejected; sign-out revokes the token server-side.
- Brute force: sign-in locks after 10 failures per IP+user; password change locks after 5; password policy rejects short, common, username-based and repeated-character passwords.
- Injection: SQL-injection probes on sign-in, search and IDs gave no 5xx and no bypass; HTML in names and reasons renders as text (no dangerouslySetInnerHTML anywhere).
- Tenant/employee isolation: an agent cannot see, cancel or give away another agent's requests or shifts; mass-assignment fields are ignored.
- Validation is strong across configuration (duplicates, time zones, SL > 100 %, queue hours), templates, forecast lifecycle (no publish before approve, no deleting a published forecast) and live feeds (negative volume, future events, unknown agents).

## Method and limits

- Same machine as the first run: one laptop (Intel i5-10310U, 4 cores, 16 GB RAM with about 3 GB free), one engine under a restart supervisor, Vite dev servers. Same 50,656 people and the published forecasts from the first run; only the code changed.
- Step 1: the over-limit request (every 15-minute start and length for 3,000 people), as a direct build and as a background job. Step 2: all 13 builds queued together, health-checked every 3 s by the test and every 15 s separately. Step 3: groups that did not finish were built again one at a time.
- The laptop went into Modern Standby from 23:49 to 10:01 local time during step 2. Only the 2 hours 8 minutes before that count as the 'together' result (6 builds finished, 0 failed). The builds that broke during the standby were built again afterwards.
- During step 3 the database crashed once and recovered (about 2.8 GB of memory was free, and a second gateway on the test settings was using 2.6 GB), and the gateway and engine were restarted. All 13 groups built in the end.
- Every schedule was re-checked by an independent script that reads each shift and each person's own rules (validate.mjs); it does not trust the solver's statistics.
- The release-gate part of this report is the 1 November re-test (Playwright suite, functional, security, access-control, accessibility and static checks); it was not repeated.
- Raw results: <tmp>/wfm-qa/run2/scale/results.jsonl; scripts in qa/scale (rerun-50k.mjs, finish-queue.mjs, direct-builds.mjs, validate.mjs, probe-50k.mjs) and qa/tools/build-production-report.mjs.
