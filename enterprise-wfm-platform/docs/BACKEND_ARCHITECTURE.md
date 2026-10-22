# Backend architecture for the Enterprise WFM Platform

Derived from `docs/BACKEND_RESEARCH.md` and the front-end contract in `docs/REVERSE_ENGINEERING.md`.
Stack: **Node.js (TypeScript) gateway, Python engine, PostgreSQL, Redis, NATS JetStream, gRPC.**

```
                    React front-end (src/)  ----REST /api, WebSocket /ws---->  GATEWAY  (Node.js, TypeScript)
                                                                              |  auth (JWT) + RBAC + tenant context
                                                                              |  validation, audit, orchestration
                                          gRPC (typed, protos in backend/proto)|
                                                   +--------------------------+-----------------------+
                                                   v                                                  v
                                          ENGINE (Python)                                  PostgreSQL (system of record)
                                   forecast tournament, Erlang C/A staffing,               schema wfm, RLS per tenant
                                   intraday reforecast, CP-SAT scheduler,                  migrations in backend/db
                                   schedule validator
                                                                             Redis  cache, live agent state, rate limit,
                                                                                    idempotency, RBAC cache (tenant-prefixed)
                                          NATS JetStream  wfm.<tenant>.<domain>.<event>
   ACD / telephony ---> ingest.interval, adherence.state --->  WORKERS (in the gateway process, separable)
                                                               adherence worker -> Redis state + Postgres events
                                                               ingest worker    -> interval_history upsert
                                                               fan-out          -> WebSocket to the browser
```

## 1. Services and responsibilities

| Service | Owns | Does not do |
|---|---|---|
| **Gateway** (Node, TS) | HTTP/WebSocket API, JWT auth, RBAC (7 roles), tenant isolation, request validation, audit trail, orchestration of engine calls, CSV parsing/staging, event publishing/fan-out. | Any numerical work (forecasting, Erlang, optimisation). |
| **Engine** (Python, gRPC) | Model tournament + backtest, Erlang C/A staffing (concurrency, async workload, blending, occupancy cap, shrinkage), intraday reforecast, CP-SAT schedule generation, schedule validation, staffing traceability. Stateless. | Storage, auth. |
| **PostgreSQL** | System of record: config, workforce, history, forecasts (versioned), schedules (versioned), adherence events, audit, import jobs. | Live wallboard state (Redis). |
| **Redis** | `wfm:{tenant}:state:{agent}` live state, computed staffing cache, RBAC permission cache, idempotency keys, rate limits. | Anything that must survive without Postgres. |
| **NATS JetStream** | Event backbone with replay; streams `WFM_INGEST`, `WFM_STATE`, `WFM_EVENTS`. | Long-term storage. |

## 2. Front-end module -> backend capability

| Module (sidebar) | Backend it needs | Phase |
|---|---|---|
| Sign-in / Security & Access | `POST /auth/login`, `GET /auth/me`, users + roles + permission matrix, JWT, Redis denylist | 1 |
| Configuration > WFM Groups | groups CRUD, queues CRUD, service targets (SL, answer time, occupancy, shrinkage, method, patience, concurrency, model) | 1 |
| Data Management > Staged Ingestion | 5-stage pipeline: upload -> parse/validate -> diff -> quality audit -> atomic commit -> rollback; data types incl. `HISTORICAL_VOLUME`, `HISTORICAL_AHT`, `ACTUALS`, `EMPLOYEES`, `TIME_OFF` | 1 (interval data), 2 (workforce) |
| Data Management > Data Quality | issue detection (gaps, duplicates, outliers, orphan schedules) | 1 |
| **Forecasting** (6 sections) | versions + lifecycle, leaderboard (backtest), builder, adjustments (mandatory reason), scenarios, accuracy heatmap, capacity plan, staffing traceability, special events | 1 |
| Audit & Governance | append-only audit ledger with before/after snapshots | 1 |
| Workforce (employees, teams, skills, availability, time off) | CRUD + eligibility rules + time-off approval workflow | 2 |
| Scheduling (generate, timeline, templates, compare, replay) | shift templates, CP-SAT generation, versioned schedules, validation on every edit, smart-move alternatives, compare, publish | 2 |
| Configuration > Activities / Rules / Weights | activity definitions, scheduling rules, optimisation weights | 2 |
| Intraday & RTA | state ingest over NATS, adherence worker, current state in Redis, live coverage, rolling reforecast, rule-based recommendations | 3 |
| Overview | aggregates over the above | 3 |

## 3. Data model (schema `wfm`, every table has `tenant_id`, RLS enforced)

- **Platform**: `tenants`, `users` (role, tenant, optional employee link), `role_permissions`, `audit_log` (actor, role, action, entity, before/after JSONB, reason, request id).
- **Config**: `wfm_groups`, `queues`, `activities`, `shift_templates`, `shift_template_rules`, `scheduling_rules`, `optimization_objectives`.
- **Workforce**: `teams`, `skills`, `employees`, `employee_skills`, `availability_windows`, `time_off`.
- **Actuals (planning's counterpart)**: `interval_history(tenant, queue, interval_start UTC, volume, aht, abandoned)`, `agent_state_events`, `adherence_intervals`.
- **Forecasting**: `special_events`, `forecast_versions` (seq per group+kind, status, model summary JSONB, rev), `forecast_intervals` (queue, day, slot, volume, aht, p10, p90, manual), `forecast_scenarios`, plus lifecycle and adjustments recorded in `audit_log`.
- **Scheduling**: `schedules` (version, status, forecast version link, solver stats), `shifts`, `shift_activities`, `schedule_violations`.
- **Ingestion**: `import_jobs`, `import_rows` (staged, with per-row status and diff), `data_quality_issues`.
- **Conventions**: UUID keys; times stored UTC with the IANA zone on tenant/employee; 15-minute `slot` = 0..95 in the queue's local day; composite indexes lead with `tenant_id`; forecasts and schedules are never overwritten.

## 4. API conventions

REST under `/api/v1`, JSON **camelCase** (matches `src/types/wfm.ts`), Bearer JWT, `X-Request-Id`, `Idempotency-Key` on POSTs that create or import, errors as `{ error: { code, message, details } }`, list endpoints paged. RBAC is a permission check per route (`forecast:approve`, `schedule:publish`, `data:import`, ...), resolved from the role matrix and cached in Redis.

### Roles (from the reference)
`WFM_ADMIN`, `WFM_MANAGER`, `FORECAST_PLANNER`, `SCHEDULER`, `SUPERVISOR_RTA`, `ANALYST`, `AGENT`. Approval and publish permissions are separate from create/edit, so **submit and approve can require different people**.

### Forecasting endpoints (phase 1)
```
GET/POST  /forecast/groups ...                         GET/PUT /forecast/groups/:id
GET       /forecast/versions?groupId=                  POST    /forecast/versions            (builder)
GET       /forecast/versions/:id                       DELETE  /forecast/versions/:id
GET       /forecast/versions/:id/data?grain&from&to&queueId
GET       /forecast/versions/:id/leaderboard           (models, WAPE MAPE MAE RMSE bias stability)
PATCH     /forecast/versions/:id/adjustments           (reason mandatory, draft only)
POST      /forecast/versions/:id/{submit,approve,reject,publish,clone}
GET       /forecast/versions/:id/export.csv
POST      /forecast/versions/:id/scenarios/compare     GET/POST/DELETE  .../scenarios
GET       /forecast/accuracy?groupId&days              (heatmap + realised)
GET       /forecast/versions/:id/capacity
POST      /forecast/trace-staffing
GET/POST/DELETE /forecast/events
```

### Workforce and scheduling endpoints (phase 2)
```
GET/POST/PUT/DELETE /workforce/employees[/:id]   PUT /workforce/employees/:id/skills   POST /workforce/employees/import (dryRun first)
GET/POST/PUT/DELETE /workforce/teams  /workforce/skills      GET/PUT /workforce/employees/:id/availability
GET/POST /workforce/time-off   POST /workforce/time-off/:id/decide
GET/POST/PUT/DELETE /scheduling/templates
POST /scheduling/versions (generate)   GET /scheduling/versions[/:id]   GET .../shifts | .../coverage | .../validate
POST /scheduling/versions/:id/shifts   DELETE .../shifts/:shiftId?reason=   (draft only, reason required)
POST /scheduling/versions/:id/publish (blocked while rule violations exist)   GET /scheduling/compare?a=&b=   GET /scheduling/mine
```
Requirement = the published short-term forecast's "agents on schedule" per 15 minutes (shrinkage already included), so coverage
counts everyone on shift; meals and breaks are placed afterwards and staggered. Known limits: rest is not checked against a
previous period's last shift, and cross-skill (per-skill) coverage arrives with intraday.

### Ingestion endpoints (phase 1)
```
POST /data/imports                (upload, creates a staged job, returns parse + validation summary)
GET  /data/imports/:id            (rows, errors, diff: new/updated/unchanged, quality audit)
POST /data/imports/:id/commit     (atomic; records what changed for rollback)
POST /data/imports/:id/rollback
GET  /data/quality                (issues) ;  GET /data/coverage
POST /data/ingest                 (live interval feed)   NATS: wfm.<tenant>.ingest.interval
```

## 5. gRPC contract (`backend/proto/wfm.proto`)

`ForecastSeries` (tournament + backtest, events, reconcile), `Staffing`, `Intraday`, and (phase 2) `Schedule`: CP-SAT over
candidate shifts (employee x day x template x start, already filtered for availability, time off, eligibility and template days)
with hard rules (one shift a day, rest, weekly maximum, days in a row, days per week) and weighted goals (coverage, overstaffing,
contract hours, preferences, weekend fairness); returns assignments plus solver status, gap and size. Staffing traceability is
served by the gateway from `Staffing`. The gateway re-validates every stored schedule independently of the solver. Large payloads use
`grpc.max_*_message_length = -1`; engine fits queues in a warm process pool.

## 6. Events (NATS JetStream)

| Subject | Producer | Consumer |
|---|---|---|
| `wfm.<t>.ingest.interval` | ACD feed / gateway import | ingest worker -> `interval_history` |
| `wfm.<t>.state.agent` | ACD/agent desktop | adherence worker -> Redis + `agent_state_events` |
| `wfm.<t>.adherence.changed` | adherence worker | WebSocket fan-out |
| `wfm.<t>.forecast.{created,submitted,approved,published}` | gateway | fan-out, schedule invalidation |
| `wfm.<t>.schedule.{generated,published}` | gateway | fan-out |
| `wfm.<t>.audit` | gateway | audit sink |

## 7. Build phases

1. **Foundation + forecasting + data** (this delivery): repo layout, migrations, tenant RLS, auth/RBAC, audit, groups/queues, staged CSV ingestion with diff/rollback, complete forecasting path, Python engine, front-end wiring for those screens.
2. **Workforce + scheduling** (delivered): employees/teams/skills/availability/time off, shift templates, CP-SAT generator with break placement, validation, versions, compare, publish. Schedule replay waits for phase 3 data.
3. **Real time**: NATS state feed, adherence worker, Redis live state, intraday reforecast and recommendations, overview aggregates.

## 8. Explicit non-goals for now
Payroll/HRIS two-way sync, shift bidding marketplace, mobile agent app, multi-region deployment, Kafka. Each has a clear seam (events, engine RPC) when needed.
