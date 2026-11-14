# AgnoWFM

Workforce management: demand forecasting, capacity planning, staged data ingestion, configuration, workforce (employees,
teams, skills, availability, time off) and scheduling (shift templates, OR-Tools CP-SAT schedule generator, validation,
compare, publish) are live against a real backend. Intraday, the overview dashboard, the audit view and user management are
still the reference prototype and are built next (see `docs/BACKEND_ARCHITECTURE.md`, phase 3).

Open source only: every solver and library used is open source (CP-SAT, HiGHS, SCIP, Timefold Community Edition, NumPy, SciPy, statsmodels).

```
React (Vite, Tailwind, AG Grid)  :3000
        │  REST /api/v1 + WebSocket /ws
Node/TypeScript gateway          :4000   JWT + RBAC, tenant isolation, audit, orchestration
        │  gRPC
Python engine                    :50051  forecasting tournament, Erlang C/A staffing, scheduling solvers, validator
        │                 (optional)  Timefold solver service (Java) :8090
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

## How schedules are built, and what keeps the application up

- **Solvers, in order:** CP-SAT first (the best; the only one that can prove a roster is the best possible), then HiGHS and SCIP (the same rules, other algorithms), then Timefold if its service is set up, and last the plain starting roster, which always exists and always obeys the rules.
  The first good answer wins; if one solver fails, runs out of time or hands back a roster that breaks a rule, the next is tried. Every answer says which solver made it and what that means (`advice`).
- **Timefold** (optional, `backend/timefold-service`, Java) is a backup that searches differently, useful when the exact solvers run out of time on a very large problem. It is used only for requests whose rules it implements
  (not skill-based demand or preferred usual times), never first, and a circuit breaker stops asking it for a minute after three failures in a row. Without it nothing is lost. See `docs/SOLVER_BACKENDS.md`.
- **Every roster is checked** by an independent validator before the engine answers, and again before it can be published. If the check cannot run, publishing waits (503) rather than going ahead.
- **Memory:** a request too large for the machine is refused with a clear reason instead of taking the engine down; solves reserve their memory before they start.
- **Forecast models:** seasonal naive, weighted weekly average, Holt-Winters, gradient boosting, SARIMA, ARIMA, Croston and a small LSTM compete in a walk-forward backtest; the best by error is used and the comparison is shown.

## Docker

```
cp backend/.env.example backend/.env          # fill it in
docker compose up -d --build                  # redis, nats, engine, gateway, web (host networking, Linux)
docker compose --profile db up -d --build     # also a PostgreSQL, if there is none on the host
docker compose --profile timefold up -d --build   # also the Timefold solver service (set TIMEFOLD_TOKEN and TIMEFOLD_URL=http://127.0.0.1:8090)
```
Images: `docker/Dockerfile.backend` (gateway and engine; the engine installs only the hash-locked Python packages), `docker/Dockerfile.frontend`, `docker/Dockerfile.timefold` (Java 21, runs as a non-root user).
The Timefold image was written but **not built or run here** (no Docker on the machine where this was done); the service itself was built and tested with Maven and a JDK.

## Supply chain

Hash-locked Python requirements, CycloneDX SBOMs for the engine, gateway, admin app and the Timefold service (`docs/sbom/`), and scan results in `docs/DEPENDENCIES.md`.

## AG Grid

Tables use AG Grid Community (MIT licence): no licence key, no watermark.

## Tests

```
cd backend/engine  && .venv\Scripts\python -m pytest
cd backend/gateway && npm run check
# Timefold service (Java 21 + Maven): cd backend/timefold-service && mvn package; then set TIMEFOLD_JAVA_HOME and run the engine's test_timefold.py
# end-to-end API suite against a running stack (creates its own data):
cd backend/gateway && $env:BASE_URL='http://localhost:4000'; $env:ADMIN_PASSWORD='...'; $env:TENANT='ORG'; npm test
# note: the suites create their own groups, people and schedules, so point them at a throwaway database, not production
```

## Documents

- `docs/AVAILABILITY_SCREEN.md`: the Availability screen: a team-week grid with painting, copy week and one save.
- `docs/BUILDER_AND_ADJUSTMENTS.md`: the Forecast Builder (section index, sticky footer, goals as sentences, the data check open, an events calendar) and Adjustments (Clone to edit in the locked banner, drag to select on the chart, words for the choices).
- `docs/FORECASTS_SCREEN.md`: the Forecasts list: one row per forecast with its versions underneath, live ones pinned, a row menu, compare and archive.
- `docs/FORECAST_REFRESH.md`: scheduled forecast refresh: a weekly or daily draft with an accuracy report and a notification, never published by itself.
- `docs/SCENARIOS_SCREEN.md`: what-if scenarios as columns beside the baseline, preset chips, live results, staffing cost, archived forecasts hidden in the picker.
- `docs/STAFFING_SCREEN.md`: the capacity page: over / short / about right in colour and words, a waterfall from workload to people needed, where shrinkage comes from, and the same shrinkage on every screen.
- `docs/POOLING_SCREEN.md`: the pooling picker: only comparable groups, search, quick picks for a site or a pair that shares people, and the answer in one sentence.
- `docs/FORECAST_ACCURACY.md`: one headline accuracy figure (100% - WAPE, daily, last 28 days) shown the same on the Overview, Dashboard, Accuracy and Models screens, with every other measure named for what it is.
- `docs/FORECAST_QUALITY.md`: Accuracy and Models as two tabs of one Forecast quality page, shared look-back periods, and Forget what was learned behind a menu with a reason and a plain statement of the consequences.
- `docs/ENGINE_REVIEW.md`: the engine code review checked point by point: what was fixed (fit warnings logged, leftovers), what the review got wrong, and the plan for the larger items.
- `docs/YEAR_PLAN.md`: Year Plan with the dashboard's tiles, a labelled "Weeks at a glance" map, the pay-week rule in the header, and part-week rows.
- `docs/GENERATE_SCHEDULE.md`: Generate Schedule checklist where every failed check offers its fix (start on a covered date, open the draft, build a forecast, use manual windows), clearer template labels, estimated solver time.
- `docs/SCHEDULE_WORKSPACE.md`: Schedule Timeline as a full-height workspace: the day fitted to the screen, only visible rows drawn, natural name order, and an issues panel where one click takes you to the person or the short stretch.
- `docs/FORECAST_DASHBOARD.md`: the Forecast Dashboard: one context bar, a selection shared across Forecasting pages, quiet charts as one line, clearer exports, and why it was slow.
- `docs/ATTENDANCE_SCREEN.md`: the Time & Attendance screen: one row per person, problem chips that filter, a person side panel, paging, and what late / early leave / missed mean.
- `docs/TIME_OFF_SCREEN.md`: the Time Off screen: list and calendar, an approval drawer with balance, rules and cover per day, and bulk approve of requests that pass.
- `docs/SKILLS_SCREEN.md`: the Skills screen: who holds each skill, thin coverage flags, and deleting safely.
- `docs/ORG_CHART_SETUP.md`: the Org chart: assigning managers to everyone from teams or a file.
- `docs/TEAMS_SCREEN.md`: the Teams screen: teams without a lead, and deleting a team safely.
- `docs/EMPLOYEES_SCREEN.md`: the Employees screen: the table, the bulk bar, and the side panel that shows a person's week, today, adherence and leave.
- `docs/STAFFING_FORMULAS.md`: the staffing formulas used (Erlang C by default, Erlang A optional), the conventions that differ between products, and what is deliberately not built.
- `docs/TODAY_PAGE.md`: the Today page: what it says and never says, every figure and how it is calculated, and its tests.
- `docs/BACKEND_RESEARCH.md`: how market WFM products and WFM Labs design their backends, with sources.
- `docs/BACKEND_ARCHITECTURE.md`: architecture, data model, API, gRPC contract, NATS subjects, phases.
- `docs/REVERSE_ENGINEERING.md`: analysis of the original prototype.
