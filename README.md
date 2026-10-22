# WFO – Workforce Optimization (demo)

| Layer | Tech | Role |
|---|---|---|
| `web/` | React + Vite + TS, **dnd-kit**, **Apache ECharts** | Zoom/Amazon-WFM-style UI: schedule grid, forecast heatmap, live adherence |
| `gateway/` | **Node.js** (Express, ws) | REST + WebSocket API, JWT auth, CRUD |
| `engine/` | **Python** (gRPC) | Model-tournament forecasting (`forecasting.py`), Erlang C/A staffing (`staffing.py`), intraday reforecast, greedy auto-scheduler |
| `proto/wfo.proto` | **gRPC** | Node -> Python contract |
| Postgres | data | agents, shifts, call history, time off, swaps (DB `wfo`) |
| Redis | cache/live | forecast cache, live agent state hash `wfo:status` |
| NATS | events | `wfo.shift.*`, `wfo.timeoff.*`, `wfo.swap.*`, `wfo.adherence` -> pushed to browsers via WebSocket |

## Run
Postgres must be running with a `wfo` database; edit `gateway/.env` for credentials. Then `./start.ps1`
(starts redis, nats, engine, gateway, web) and open http://localhost:5173.
Login: `manager / manager123` (edit schedule, approve requests) or `agent / agent123` (read-only + requests).

First-time setup: `cd engine; python -m venv .venv; .venv\Scripts\pip install -r requirements.txt;
.venv\Scripts\python -m grpc_tools.protoc -I../proto --python_out=. --grpc_python_out=. wfo.proto`,
then `npm install` in `gateway/` and `web/`.

The adherence feed is simulated by `gateway/src/simulator.js` (set `SIMULATOR=off` to disable, `DEMO_HOUR=11` to pin the clock).

## Forecasting (Forecast & Staffing page)
Tabs: **Forecast** (versions, P10-P90 bands, interval + bulk edits, publish/clone/CSV export, model leaderboard), **Staffing coverage**
(scheduled vs required, the original view), **Intraday** (plan vs actual vs reforecast), **Capacity plan** (long-term FTE),
**What-if** (scenario comparison), **Accuracy** (hold-out backtest, realised WAPE/bias), **Data & targets** (SL/shrinkage/occupancy,
CSV import, live feed, special events, queues).

How it works
- Queues belong to a *forecast group* (agents shared). Per queue: clean history (outliers/events) -> daily models (seasonal naive,
  weighted average, Holt-Winters, gradient boosting, ensemble, Croston for sparse queues) -> rolling-origin backtest -> best by MASE, and it
  must beat seasonal naive -> weekday arrival profile -> P10/P90 -> queues reconciled to the group total.
- Staffing: Erlang C or A per interval, chat concurrency, email as spread backlog workload, occupancy cap, shrinkage, optional
  cross-skilled voice+chat pool.
- A **published** short-term forecast per group drives the schedule (`/api/forecast`, auto-scheduler); until every group has one the
  original weekly-average forecast is used. Starter forecasts are created on first run.
- Data: 400 days of synthetic 15-minute history (`gateway/src/synth.js`), CSV import (`/api/wfm/import`, dry-run validation), and a live
  feed via `POST /api/wfm/ingest` or NATS `wfo.ingest.interval`. The simulator writes today's actuals (`SIM_SURPRISE` scales them).

Engine deps changed: run `.venv\Scripts\pip install -r requirements.txt` and regenerate the stubs (command above).
Engine tests: `.venv\Scripts\python test_engine.py`.

### Starting empty vs demo data
A fresh install has **no** queues, history, events or forecasts: the Forecast page walks you through creating a group, adding queues,
importing history and creating a forecast. Set `SEED_DEMO=1` in `gateway/.env` (before first start on an empty database) to load the
synthetic 400-day demo instead; it also enables the simulator that invents today's actuals. Forecasts are numbered per group and type
(Short-term v1, v2, …); clones are "vN (copy of vM)" and anything made in the last 15 minutes carries a NEW badge.
