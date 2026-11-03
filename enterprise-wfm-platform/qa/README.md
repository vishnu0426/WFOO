# WFM production-readiness suite

Playwright (Chrome) + API tests for the admin web app (:3000), the employee portal (:3001) and the gateway (:4000).
**It creates data** (`QA-…` records, `qa.*` users, the "Demo Support" group) — run it against a test stack only.

## Run

```powershell
cd qa
npm install
node ..\scripts\demo-seed.mjs --api http://localhost:4000 --user admin --password <admin password> --tenant ORG   # once
$env:QA_ADMIN_PASSWORD='<admin password>'; node seed-finish.mjs      # only if demo-seed stopped half way
$env:QA_ADMIN_PASSWORD='<admin password>'
npx playwright test                         # everything (~20 min)
npx playwright test --project=api-security  # one area
node tools\build-report.mjs                 # rebuild reports\report.html, defects.csv, summary.json
```

Run output (traces, screenshots, raw results) goes to `%TEMP%\wfm-qa`, **outside the repo**: the admin Vite dev server watches
the whole project folder and crashes (EBUSY) when Playwright locks a trace file inside it. Override with `QA_OUT`.

## Projects

| Project | What it covers |
|---|---|
| `setup` | Signs the admin in through the UI and saves the session |
| `admin-crawl` | Opens all 51 admin screens by URL: crashes, JS errors, failing API calls, axe WCAG 2.1 AA, load time, screenshot |
| `admin-e2e` | Sign-in errors, sidebar/deep links/back-forward, keyboard reach, command palette, team CRUD + stored XSS, read-only role, bad session, sign-out |
| `portal-e2e` | Sign-in, forced first password change, all sections, schedule views, time-off form, offers, inbox, change password, session/sign-out |
| `api-functional` | Module-by-module API flows: configuration, workforce, forecasting, scheduling (incl. schedule-rule integrity), intraday, data, audit/admin, self-service |
| `api-rbac` | Every guarded route × every role (from `route-inventory.json`, built by `tools/route-inventory.mjs`) |
| `api-security` | Password policy, JWT forgery, revocation, token-in-URL, brute force, enumeration, headers, CORS, SQLi, payload limits, IDOR, CSV injection, date validation |
| `responsive` | Phone width (Pixel 7) for both apps |
| `performance` | API latency, modest concurrency, page load |

Generated test-only passwords for the `demo.agent*` and `qa.*` logins are in `test-data.json`.
