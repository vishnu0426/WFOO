# Enterprise WFM Platform

Workforce management: demand forecasting, capacity planning, staged data ingestion, configuration, workforce (employees,
teams, skills, availability, time off) and scheduling (shift templates, OR-Tools CP-SAT schedule generator, validation,
compare, publish) are live against a real backend. Intraday, the overview dashboard, the audit view and user management are
still the reference prototype and are built next (see `docs/BACKEND_ARCHITECTURE.md`, phase 3).

```
React (Vite, Tailwind, AG Grid)  :3000
        │  REST /api/v1 + WebSocket /ws
Node/TypeScript gateway          :4000   JWT + RBAC, tenant isolation, audit, orchestration
        │  gRPC
Python engine                    :50051  forecasting tournament, Erlang C/A staffing, CP-SAT scheduling
        │
PostgreSQL (schema wfm, row-level security) · Redis (cache, rate limit) · NATS JetStream (events, live feed)
```

## Run it

Prerequisites: Node 20+, Python 3.11+, PostgreSQL, Redis, NATS (`nats-server -js`).

1. Create `backend/.env` from `backend/.env.example` and set `DATABASE_URL` and `JWT_SECRET`. One file for the whole backend — the gateway and the Python engine both read it.
2. `.\scripts\dev.ps1` starts the engine, gateway and front-end in separate windows.
3. Open http://localhost:3000. The first start creates the organisation and an administrator; the password is printed
   once in the gateway window unless you set `BOOTSTRAP_ADMIN_PASSWORD`.

Nothing is seeded. The order for a new organisation is: Configuration › WFM Groups (a group and its queues) →
Data Management › Staged Ingestion (interval history CSV; a template is downloadable) → Forecasting › Forecast Builder →
publish the forecast → Workforce (teams, skills, employees) and Scheduling › Shift Templates → Scheduling › Generate Schedule.

## AG Grid

The adjustments grid uses AG Grid Enterprise. Set `VITE_AG_GRID_LICENSE` in `.env.local` to remove the evaluation watermark.

## Tests

```
cd backend/engine  && .venv\Scripts\python -m pytest
cd backend/gateway && npm run check
# end-to-end API suite against a running stack (creates its own data):
cd backend/gateway && $env:BASE_URL='http://localhost:4000'; $env:ADMIN_PASSWORD='...'; $env:TENANT='ORG'; npm test
# note: the suites create their own groups, people and schedules, so point them at a throwaway database, not production
```

## Documents

- `docs/BACKEND_RESEARCH.md`: how market WFM products and WFM Labs design their backends, with sources.
- `docs/BACKEND_ARCHITECTURE.md`: architecture, data model, API, gRPC contract, NATS subjects, phases.
- `docs/REVERSE_ENGINEERING.md`: analysis of the original prototype.
