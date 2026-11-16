# 01 — Application discovery (Phase 1)

Date: 2026-11-14 · Target: AgnoWFM on `192.168.9.186` · Source checked: branch `Super-Admin-multitenant` @ `7e0d851`
Status of this phase: **discovery complete; nothing has been written to the server.**

## 1. How the discovery was done (and what it could not see)

| Source | What was used | Limit |
|---|---|---|
| Server, unauthenticated | `curl` of the three portals, `/health`, `/metrics`, `/auth/login-options`, TCP port check | Not signed in (see §7). No module was exercised on the server. |
| Source code | Gateway, engine, migrations, both UIs, docker/k8s files | Assumes the server runs this code. **Not yet confirmed** (no version endpoint without login). |
| Earlier QA runs on this codebase | 50k and 100k scale runs (2026-11-02/03), release-gate fixes | Ran on a laptop stack, not on this server. Cited as prior evidence only. |

## 2. What is running on 192.168.9.186

| Port | What answers | Notes |
|---|---|---|
| 3000 | nginx 1.27.5 → admin portal "AgnoWFM" (React SPA) + `/api/v1` proxy | Strong security headers (CSP, HSTS, nosniff, frame SAMEORIGIN) |
| 3001 | Employee portal "Your schedule, time off, swaps and offers" (React SPA) | Same `/api/v1` self-service endpoints (`/me/*`) |
| 3002 | "Platform Super Admin" portal | Not in the brief; tenant/licence administration |
| 4000 | Node gateway **directly**, bypassing nginx | See DISC-02 |
| 5432 | PostgreSQL, reachable from the LAN | See DISC-03 |
| 6379 / 4222 / 50051 | closed from the LAN (good) | |

`/health` answer at 09:03 UTC: `status: degraded, db: true, redis: false, nats: true, jetstream: true, engine: true, rowLevelSecurity: true` → **Redis is down on the server** (DISC-01).
`/metrics` (gateway): DB pool max **13** connections, 1 engine, RSS 236 MB, 13.1 GB free RAM on the machine, 391 requests served so far (a fresh install).

## 3. Architecture (from the code)

| Layer | Technology | Where |
|---|---|---|
| Admin portal | React 18 + Vite, Tailwind, AG Grid **Community**, recharts; own History-API router | `src/` |
| Employee portal | React + Vite, separate app | `employee-portal/` |
| Super-admin portal | React + Vite | `superadmin-portal/` |
| Mobile | native app (not in scope of this brief) | `mobile/` |
| API gateway | Node.js / TypeScript, Express, REST `/api/v1` + WebSocket `/ws`, OpenAPI at `/api/v1/openapi.json` (login needed) | `backend/gateway` (~131 module files) |
| Engine | Python gRPC (port 50051): forecasting, staffing (Erlang C / Erlang A / simulation), schedule optimisation | `backend/engine` |
| Optimiser | OR-Tools CP-SAT (each solve in its own process), fallback chain greedy → HiGHS → SCIP; optional Timefold service (Java) | `scheduling.py`, `backends.py`, `solve_worker.py` |
| Forecast models | statistical (SARIMA, exponential smoothing family, seasonal baselines), LSTM, walk-forward model choice, learned weekday multipliers | `forecasting.py`, `lstm.py`, `forecast/learning.ts` |
| Database | PostgreSQL 16, schema `wfm`, **92 migrations**, multi-tenancy by `tenant_id` + **row-level security** | `backend/db/migrations` |
| Cache | Redis 7 (sessions/user state cache, rate limits, result caches) — **down on server** | |
| Messaging | NATS 2.10 + JetStream (events, webhooks outbox consumers) | |
| Background work | Postgres-backed job queue `schedule_jobs` (SKIP LOCKED, heartbeat, reaper, max 2 solves at once), forecast refresh scheduler, report scheduler, adherence watcher, webhook outbox | `scheduleJobs.ts`, `forecast/refresh.ts`, `reports.ts` |
| Auth | Username + password (bcrypt), JWT bearer, per-org login (org code), OIDC SSO, SCIM 2.0, MFA (super-admin), API keys (read-only scopes), forced change of temporary passwords | `auth.ts`, `sso.ts`, `scim.ts`, `platform/mfa.ts` |
| Observability | Prometheus `/metrics`, request IDs + `traceparent`, structured logs, `[build]`/`[live]` phase timings | `metrics.ts`, `observe.ts` |
| Deployment | docker-compose with `network_mode: host` (all services on one machine), Dockerfiles for backend/frontend/timefold, nginx front, k8s manifests in `deploy/k8s` | |

## 4. Module inventory (admin portal)

Full list with status in `02-module-inventory.xlsx`. Summary:

| Area | Modules found in code | Phase-1 status |
|---|---|---|
| Administration | Organisations/tenants (super-admin), sites & regions, WFM groups (+aliases, reasons), teams, org chart / reporting lines, users & roles (RBAC permissions), configuration (activities, scheduling rules, optimisation weights, holidays, pay week, compliance packs), audit log, licensing, notifications (email/SMS channels, alert rules), API keys/webhooks, SSO/SCIM, secrets | Found, not exercised on server |
| Workforce | Employees (AG Grid infinite model, CSV import with dry run + stop-on-error), skills, availability, time off (+rules: blackouts, caps, accrual), attendance, leavers, approvals, cover/loans, shared people across groups | Found |
| Forecasting | Data import/ingestion (staged + rollback), data feeds (CSV/REST/SFTP/DB pulls, Avaya AACC preset), history quality, forecasts with numbered versions, builder, adjustments (mandatory reason), scenarios, capacity/staffing, pooling, compare, accuracy (100 − WAPE, 28 days), models page, scheduled refresh (draft only) | Found |
| Scheduling | Shift templates, Generate Schedule (CP-SAT), Year Plan / long plans **1–52 weeks**, timeline (manual edit + reason), schedule quality report, issues, approval, publish/republish, revisions & replay, compare, rotations (incl. Pitman), follow-the-sun, what-if, gap fixer, break optimiser | Found |
| Shift bidding | `bids/` – events, bidding windows, methods SENIORITY / LOTTERY / BALANCED, Hungarian-algorithm allocation | Found |
| VTO / overtime offers | `offers/` – surplus/shortage runs → offers, ordering SENIORITY / FIRST_COME / FEWEST_HOURS / MOST_HOURS / ROUND_ROBIN / RANDOM (seeded), shift trim/extend/remove | Found |
| Intraday / real-time | Live coverage, reforecast, recommended actions, RTA state map, adherence (paged, team tiles, alerts, saved views), attendance exceptions | Found; **no live ACD feed exists** to drive it |
| Self-service (portal 3001) | Home, Schedule, Time off, Swaps, Opportunities (VTO/OT/bids), Requests, Inbox, Profile, Change password | Found |
| Payroll / reports | Hours by pay code (not money), scheduled reports, PDF/CSV exports | Found |

## 5. Employee account provisioning (portal 3001)

1. Admin creates the employee (Workforce › Employees, or CSV import).
2. Admin clicks **Create app login** → `POST /api/v1/self-service/logins {employeeId}` → a user linked to the employee (`employeeId` ↔ `userId`) with a **temporary password**, shown once.
3. Employee signs in at 3001 with org code + username + temporary password → `mustChangePassword` → only the change-password screen works until changed.
4. Admin can reset → `PUT /self-service/logins/{userId}/reset-password` (new temporary password).
5. Employees can also come from SCIM / SSO. Supervisor/manager marks on the employee need a separate role on Users & Roles.

This flow is exercised in Phase 3 (needs a signed-in admin session — see §7).

## 6. Engines and the maths found

| Formula | Where | Phase-1 check |
|---|---|---|
| Erlang C P(wait), SL(T), ASA | `engine/staffing.py` (Erlang B recursion), `gateway/modules/erlang.ts` | **PASS** – 307 engine + 198 gateway values match an independent log-space factorial implementation to 1e-9 (`06-mathematical-validation/results.csv`) |
| Required agents (SL target + occupancy cap) | `staffing.py` `required_agents`, `solve_agents` | **PASS** – 10 cases incl. 85 % occupancy cap |
| Erlang A (abandonment), Monte-Carlo simulation | `staffing.py`, `simulation.py` | Not yet independently checked (Phase 4) |
| Email/back-office deadline staffing, chat concurrency (efficiency 0.85) | `staffing.py` | Phase 4 |
| Shrinkage → gross staffing | gateway staffing / "effective shrinkage" | Phase 4 (needs API) |
| Forecast accuracy = 100 − WAPE, daily, 28 days; bias | `forecast/accuracyHeadline.ts` | Phase 4 |
| Coverage, schedule score, shortage | `scheduleQuality.ts`, `shiftCoverage.ts`, `skillCoverage.ts` | Phase 4 |
| Adherence (interval-based) | `adherenceRoutes.ts` | Phase 4 |
| Pay hours, DST pay | `payMath.ts` | Phase 4 |
| Bid allocation (Hungarian), offer ordering | `bids/logic.ts`, `offers/logic.ts` | Phase 3/4 |

**Important for the horizon tests:** long plans accept 1–52 weeks, but by default the solver builds **at most 13 weeks**; later weeks **repeat the last solved cycle** (`PATTERN` shifts). A 26- or 52-week plan is therefore *not* fully optimised week by week. The test matrix records solved weeks and repeated weeks separately so this is not mistaken for a full 52-week optimisation.

## 7. Blocker: signing in to the server

I did not sign in to `192.168.9.186`. My operating rules let me type test credentials only on a local development host or a hosted test environment named as such (e.g. `staging.…`); a bare LAN IP does not qualify, and the brief itself asks for an isolated environment rather than the shared server. Two ways forward (§9).

## 8. Infrastructure limits seen

* One machine runs everything (`network_mode: host`): gateway, engine, Postgres, NATS, Redis. One engine → **max 2 solves at once**; earlier runs showed one 8-core box builds ~2 schedule parts in parallel.
* DB pool max 13 per gateway.
* Redis down → rate limiting, cached user state and result caches degrade (functional impact to be measured).
* Server CPU/RAM/disk unknown except 13.1 GB free RAM (from `/metrics`); needs shell access or a monitoring agent for the load stages.

## 9. Isolated test environment – proposal

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Local throwaway stack (recommended for seeding + load stages)** | Same commit on this workstation: fresh DB per stage (`wfm_audit_<RUN>`), own gateway on :4010, own engine, `NATS_CONSUMER_PREFIX`; drop the DB afterwards | Fully isolated, cleanup = drop DB, I can sign in with test accounts | Laptop hardware ≠ server; numbers are for this box |
| B. Separate test tenant on the server | Super-admin creates `AUDIT-<RUN>` org; data imported through the app | Real server hardware/network | Shares DB, engine and CPU with real users; needs your approval per stage; you sign in for me in the browser pane |
| C. Clone of the server on a second VM | docker-compose on another host | Production-like, isolated | Needs a machine |

Suggested: run functional + maths + 50 → 200k scale on **A**, then repeat a *small* confirmation set (50, 5k, maybe 25k) on **B** with your sign-off, to calibrate laptop vs server numbers.

## 10. Phase-1 findings so far

| ID | Severity | Finding |
|---|---|---|
| DISC-01 | HIGH (ops) | `/health` reports **Redis down** (`degraded`). |
| DISC-02 | MEDIUM | Gateway port **4000 reachable directly** from the LAN, bypassing nginx (headers, any proxy limits). |
| DISC-03 | HIGH | **PostgreSQL 5432 reachable from the LAN.** Should be bound to localhost / firewalled. (Only a TCP connect was made; no login attempted.) |
| DISC-04 | MEDIUM | **`/metrics` is public** on 3000 and 4000 (pool sizes, memory, request counts, engine state). |
| DISC-05 | LOW | `/auth/login-options` discloses the org code and name without login (`LOGIN_DISCOVERY` is on). Known design choice, rate limited. |
| DISC-06 | INFO | Long plans optimise ≤ 13 weeks by default and repeat after that (affects how 26/52-week results must be read). |
| DISC-07 | INFO (carry-over) | Earlier open items: SSRF via data-feed connectors (F-2), cross-group multi-skill assignment (F-3), contention timeout (F-4). To be re-tested. |
