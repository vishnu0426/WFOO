# How to run the WFM platform

Everything below is for `D:\WFOO\enterprise-wfm-platform`. The older files in `D:\WFOO` itself (`start.ps1`, `gateway\`, the top-level `README.md`) belong to an earlier demo. Ignore them.

## What runs

| Part | Tech | Port | Folder |
|---|---|---|---|
| Web app | React + Vite | 3000 | `src/` |
| Gateway (REST `/api/v1`, WebSocket `/ws`) | Node.js + TypeScript | 4000 | `backend/gateway` |
| Engine (forecasting, staffing, schedule solver) | Python gRPC | 50051 | `backend/engine` |
| Database | PostgreSQL | 5432 | schema `wfm` |
| Cache | Redis | 6379 | |
| Events | NATS **with JetStream** | 4222 | |

The gateway will not start unless PostgreSQL, Redis and NATS are reachable. The forecast and schedule screens need the engine.

## 1. One-time setup

**Install:** Node.js 20+, Python 3.12, PostgreSQL 14+, Redis, and NATS server.
On Windows: `winget install NATSAuthors.NATSServer` and a Windows Redis build from winget.

**Database.** Create an empty database, for example `wfm_platform`, and use a role that can create schemas and tables. The app creates its own schema `wfm` and never touches other databases or schemas.

**Backend settings.** One `.env` for the whole backend — the gateway and the Python engine both read it. Copy the template and fill it in (never commit the real file):

```powershell
cd D:\WFOO\enterprise-wfm-platform\backend
copy .env.example .env
```

Edit `backend\.env`:

- `DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/wfm_platform`
- `JWT_SECRET=` any long random string (16+ characters)
- Optional: `BOOTSTRAP_ADMIN_PASSWORD=` to choose the first admin password. Leave it empty and one is generated and printed once.

**Engine (Python).**

```powershell
cd D:\WFOO\enterprise-wfm-platform\backend\engine
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

The gRPC stubs (`wfm_pb2.py`) are already generated. If `backend\proto\wfm.proto` changes, regenerate them:
`.\.venv\Scripts\python -m grpc_tools.protoc -I ..\proto --python_out=. --grpc_python_out=. wfm.proto`

**Node packages.**

```powershell
cd D:\WFOO\enterprise-wfm-platform ; npm install
cd backend\gateway               ; npm install
```

**AG Grid licence (optional).** Tables use AG Grid Enterprise. Without a key they work but show a trial watermark. To add one, create `D:\WFOO\enterprise-wfm-platform\.env` containing `VITE_AG_GRID_LICENSE=your-key`.

## 2. Start everything (each time)

**One command** — checks PostgreSQL, Redis and NATS, starts Redis/NATS itself if they're on your PATH and not already running, then opens one window each for the engine, gateway, admin web app and employee portal:

```powershell
cd D:\WFOO\enterprise-wfm-platform
.\scripts\dev.ps1            # admin web app + employee portal
.\scripts\dev.ps1 -Mobile    # also opens the Expo dev server for the mobile app
```

PostgreSQL itself is not auto-installed — the script expects it reachable on 5432 (it will start it if it finds a `postgresql*` Windows service that isn't running yet) and exits with a clear message if it can't reach it.

Or start everything by hand, in four terminals (plus the two infrastructure commands below if `dev.ps1` isn't used):

```powershell
redis-server
nats-server -js          # the -js matters: it turns on JetStream
```

```powershell
# 1  engine
cd D:\WFOO\enterprise-wfm-platform\backend\engine ; .\.venv\Scripts\python server.py
# 2  gateway  (applies database migrations on start)
cd D:\WFOO\enterprise-wfm-platform\backend\gateway ; npm run dev
# 3  admin web app
cd D:\WFOO\enterprise-wfm-platform ; npm run dev
# 4  employee portal
cd D:\WFOO\enterprise-wfm-platform\employee-portal ; npm run dev
```

Open **http://localhost:3000** for the admin app, **http://localhost:3001** for the employee portal.

## 3. Sign in

The login box asks for three things:

- **Tenant:** the code from `BOOTSTRAP_TENANT_CODE` (default `ORG`).
- **User:** `admin` (or `BOOTSTRAP_ADMIN_USER`).
- **Password:** printed once in the gateway window on the very first start (look for `FIRST-RUN SETUP`), or the value of `BOOTSTRAP_ADMIN_PASSWORD`.

The app starts empty: no queues, history, forecasts or people are pre-loaded.

## 4. First use, in this order

1. **Configuration › WFM Groups:** create a group and its queues.
2. **Data Management › Staged Ingestion:** download the CSV template, fill it with your interval history (columns `queue, date, interval, volume, aht`), upload, review the diff, then commit. Every file needs a date and a time-of-day column.
3. **Forecasting › Forecast Builder:** check the live preview, then create a forecast. Submit, approve and publish it.
4. **Configuration:** define Activity Definitions, Scheduling Rules and RTA State Mapping.
5. **Workforce:** import or add employees, teams, skills and availability. **Scheduling › Shift Templates:** add shift patterns, then **Generate Schedule**.
6. **Intraday & RTA:** send live counts and agent states (see below).

Every screen has its own address, for example `/forecasting/forecast-dashboard`, `/forecasting/all-forecasts`, `/workforce/employees`, `/scheduling/generate-schedule`, `/intraday/adherence`, `/configuration/rta-mapping`.

**Live data for Intraday & RTA** (from your phone system, with a signed-in token):

- `POST /api/v1/data/ingest`: `{ "rows": [{ "queue": "Billing Voice", "day": "2026-01-05", "time": "09:15", "volume": 42, "ahtSec": 310 }] }`
- `POST /api/v1/intraday/events`: `{ "events": [{ "employeeNumber": "E100", "state": "Available", "reason": "", "at": "2026-01-05T09:00:00Z" }] }`

## 5. Checks and tests

```powershell
cd D:\WFOO\enterprise-wfm-platform ; npx tsc --noEmit                     # web app types
cd backend\gateway ; npx tsc --noEmit                                     # gateway types
cd backend\engine ; .\.venv\Scripts\python -m pytest -q                   # engine tests
```

The gateway API tests create their own groups and people, so **do not point them at your real database**. Run them against a throwaway database and a second gateway:

```powershell
# gateway on 4001 using an empty test database (create one first), then:
cd D:\WFOO\enterprise-wfm-platform\backend\gateway
$env:BASE_URL='http://localhost:4001'; $env:ADMIN_PASSWORD='the-test-admin-password'; $env:TENANT='ORG'
npx tsx --test --test-concurrency=1 test/*.test.ts
```

Run the suites one at a time (`--test-concurrency=1`): the schedule tests use the solver heavily and can time out when run in parallel.

## 5b. The mobile app for employees

A native app (Expo / React Native) lives in `mobile\`. It uses the same gateway. Give each person a login first (**Workforce › Employees**, click the person, **Create app login**), then:

```powershell
cd D:\WFOO\enterprise-wfm-platform\mobile
npm install
npm start          # press w for a browser, a for Android, i for iOS, or scan the QR code with Expo Go
```

Point the app at the gateway with **Change server address** on the sign-in screen (details and push-notification setup in `mobile\README.md`). To try it quickly, `node scripts\demo-seed.mjs` adds demo data and three logins to a test database, and `mobile\TESTING.md` lists every way to test it (browser, your phone, emulators, a real build) with a 15-minute checklist.

What to set up once in the web app (VTO and overtime ordering is in the same Self-Service Rules screen; **Scheduling** has Shift Swaps, VTO & Overtime and Shift Bidding): **Configuration › Self-Service Rules** (what is approved automatically, balances, swap rules) and **Configuration › Compliance Packs** (India, EU and US packs; choose where each applies).

## 6. If something goes wrong

| Symptom | Fix |
|---|---|
| Gateway exits with `ECONNREFUSED 4222` or `6379` | NATS or Redis is not running. Start them (step 2a). NATS needs `-js`. |
| Banner: "Cannot reach the WFM gateway" | The gateway is not running on port 4000. Start it, and check its window for errors. |
| Forecast or schedule screens say the engine is unavailable | Start the engine (step 2b). The sidebar footer shows "Forecast engine: Online" when it is up. |
| Web page loads but shows a login loop | The gateway restarted with a different `JWT_SECRET`. Sign in again. |
| A CSV import spins for a long time | Restart the gateway to pick up the latest code, then upload again. Imports now stop with an error after 4 minutes instead of hanging. |
| An import says "No date column" | The file needs a date and a time-of-day column. Use the template. |
| Forgot the admin password | Stop the gateway, set `BOOTSTRAP_ADMIN_PASSWORD` only if no users exist yet, or reset the `users.password_hash` for `admin` in the `wfm` schema. |
| Port already in use | Change `PORT` in `backend\.env` (and `WFM_API` for the web app), or stop the other program. |
