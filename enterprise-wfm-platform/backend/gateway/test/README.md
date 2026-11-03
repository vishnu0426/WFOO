# Running the gateway tests

Most files here talk to a running gateway (they are integration tests), so a few things must be true of the gateway under test. A wrong setup shows up as failures that look like bugs but are not.

Start a separate gateway for tests, on its own database and port (never the one you use day to day):

| Setting on the gateway under test | Why |
| --- | --- |
| `DATABASE_URL` pointing at an empty throwaway database | Migrations run on start. Several tests assume a clean tenant (feed health counts receipts of the last 24 hours). |
| `FORCE_PASSWORD_CHANGE=false`, `BOOTSTRAP_ADMIN_PASSWORD=...` | Tests sign in as `admin` and as accounts they create. |
| `NATS_CONSUMER_PREFIX=<something unique>` | Gateways on one NATS server share delivery consumers by name. Without a prefix an event for the test tenant can be taken by another gateway (for example the one you develop against), and the webhook tests wait for a delivery that never arrives. |
| `WEBHOOK_BACKOFF_SCALE=0.02` | Webhook retries wait 30 s by default; the retry test only waits 30 s. |
| `CHANNEL_BACKOFF_SCALE=0.02` | Email and SMS retries wait 30 s by default; the test waits for the second try. |
| `ADHERENCE_WATCH_SEC=5` | The adherence alert watcher runs every 60 s by default; the alert test waits 30 s for it. |
| `PORTAL_URL=http://localhost:3001`, `APP_URL=http://localhost:3000` | The single sign-on test checks where people are sent back to. |
| `ENGINE_ADDR` of a running engine | Schedule and forecast tests solve for real. |

`backend/gateway/.env.test` (git-ignored) is the place to keep these, then `tsx --env-file=.env.test src/index.ts` with `DATABASE_URL` and `PORT` overridden on the command line.

Run the tests with the same values in the environment of the test process:

```
BASE_URL=http://localhost:4011 ADMIN_PASSWORD=... TENANT=ORG DATABASE_URL=<the same throwaway database> JWT_SECRET=<the gateway's> PORTAL_URL=http://localhost:3001 APP_URL=http://localhost:3000 npm test
```

`DATABASE_URL` and `JWT_SECRET` in the test process are needed by the files that import gateway code directly (secrets, integrations engine, build speed). Add `--test-force-exit` when a single file is run on its own: importing gateway code opens a database pool that keeps Node alive.

`test/forced/passwordChange.test.ts` is not part of `npm test`: it needs a gateway with the forced password change switched ON and a brand new database (the bootstrap administrator can only be tested once). Run it with `npm run test:password` against its own gateway.

`test/orgLoginApi.test.ts` runs its second-organisation cases only when `TEST_DATABASE_URL` points at the test database; without it those cases are skipped, whatever other test files left behind.
