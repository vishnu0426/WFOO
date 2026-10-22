# Relay-family connector scripts

These run on the **customer's own network**, next to their system, not in our cloud — the same shape a real Avaya
CMS or Cisco UCCE integration uses in the market (see the Integration Station research in the project's memory /
`run.md`): a local process reads the source, then makes one **outbound** HTTPS call out to our gateway. The
customer's firewall only needs to allow outbound 443 from this one machine, never an inbound rule.

Every script here ends up calling the same two endpoints, authenticated with the API key the Integration Station
gave you when you created the connector:

- `POST /api/v1/integrations/:id/backfill` — a bounded historical range, `{ rows: [...], through: "YYYY-MM-DD" }`. Lands in Staged Ingestion for review before it goes live, exactly like a manual CSV upload.
- `POST /api/v1/integrations/:id/live` — the ongoing incremental trickle, `{ rows: [...] }`. Writes straight into interval history / RTA agent state.

Both take **raw rows in your own system's shape** — the field mapping you set up in the Integration Station (or the
preset's defaults) does the translation, not this script. A row just needs to be a plain JSON object; what's inside
it is up to your source system.

| Script | Status |
|---|---|
| `database-reader/` | **Real, working, tested** against a throwaway Postgres table (`test/integrations.databaseReader.test.ts`). Postgres today; the query shape is the same for Oracle/SQL Server/Informix, only the driver and connection string change — see the comment at the top of `index.mjs`. |
| `sftp-poller/` | **Real, working, tested.** Watches a local directory for CSV files (already-synced from SFTP by your own transfer tooling, or an actual SFTP client you point at this same folder) and posts each row through. |
| `avaya-cms-connector/` | A working reference for the *relay-out* half (config, retry, posting to our API) plus a placeholder for CMS's own wire protocol, which needs Avaya's own CMS SDK/developer materials to implement — see the honesty note in the plan. Not runnable against a real CMS as shipped. |
| `cisco-uccx-connector/` | Same shape: real relay-out half, a placeholder for Finesse/AW-HDS-DDS parsing pending Cisco's own developer resources. |

Run any of these with:

```
node integrations/database-reader/index.mjs --gateway http://localhost:4000 --connector <id> --key <api key> ...
```
