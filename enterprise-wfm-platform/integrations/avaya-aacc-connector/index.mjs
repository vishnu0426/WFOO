#!/usr/bin/env node
/**
 * Avaya Aura Contact Center (AACC) history reader. Runs on the customer's own network, reads the AACC reporting database (SQL Server)
 * with a read-only login, and sends skillset interval statistics out to the WFM Integration Station over HTTPS.
 *
 * Honest limits: table and column names follow Avaya's documented iSkillsetStat table but have NOT been checked against a live AACC. Run
 * --check-columns first and set --col-* to what your table really has. Live agent state needs Avaya's real-time SDK and is not here.
 *
 * Usage:
 *   export AACC_SQL_PASSWORD=...                       # never put the password on the command line
 *   node index.mjs --server aacc-db --database <db> --user <readonly-user> --check-columns
 *   node index.mjs --server aacc-db --database <db> --user <readonly-user> --print-query
 *   node index.mjs --server aacc-db --database <db> --user <readonly-user> --gateway https://wfm.example.com --connector <id> --key <api-key> --backfill-weeks 8
 *   node index.mjs ... --gateway ... --connector ... --key ... [--interval-seconds 900]     # keeps the last two days up to date; add --once to run once
 *
 * Options: --table (default iSkillsetStat), --port, --encrypt, --trust-server-certificate,
 *          --col-timestamp --col-skillset --col-offered --col-answered --col-abandoned --col-handle-seconds --col-aht
 */
import { COLUMNS_QUERY, DEFAULT_COLUMNS, buildQuery, ident } from './lib.mjs';
import { runBackfill, runLive } from './reader.mjs';

function args() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; }
  return a;
}

const today = () => new Date().toLocaleDateString('sv-SE');     // the reader machine's own date, YYYY-MM-DD

async function openSqlServer(o) {
  const mssql = (await import('mssql')).default;
  const pool = await new mssql.ConnectionPool({
    server: o.server, port: o.port ? Number(o.port) : 1433, database: o.database, user: o.user, password: process.env.AACC_SQL_PASSWORD,
    options: { encrypt: !!o.encrypt, trustServerCertificate: !!o['trust-server-certificate'], readOnlyIntent: true },
    connectionTimeout: 15_000, requestTimeout: 60_000,
  }).connect();
  return {
    async query(text, params = {}) {
      const req = pool.request();
      for (const [k, v] of Object.entries(params)) req.input(k, mssql.NVarChar, v);      // dates travel as YYYY-MM-DD text and are cast in the query, so no time zone can shift them
      return (await req.query(text)).recordset;
    },
    close: () => pool.close(),
  };
}

function poster(o) {
  return async (path, body) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${o.gateway}/api/v1/integrations/${o.connector}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.key}` }, body: JSON.stringify(body) });
        const text = await res.text();
        if (res.ok) return JSON.parse(text);
        if (res.status < 500 || attempt >= 3) throw new Error(`${path} failed: ${res.status} ${text}`);
      } catch (e) { if (attempt >= 3 || /failed: [1-4]\d\d/.test(e.message)) throw e; }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  };
}

async function main() {
  const o = args();
  const columns = {};
  for (const [opt, key] of [['col-timestamp', 'timestamp'], ['col-skillset', 'skillset'], ['col-offered', 'offered'], ['col-answered', 'answered'], ['col-abandoned', 'abandoned'], ['col-handle-seconds', 'handleSeconds'], ['col-aht', 'aht']]) if (o[opt] !== undefined) columns[key] = o[opt] === true ? '' : o[opt];
  const table = o.table || 'iSkillsetStat';

  if (o['print-query']) { console.log(buildQuery({ table, columns })); console.log(`\nColumns used: ${JSON.stringify({ ...DEFAULT_COLUMNS, ...columns })}`); return; }
  for (const k of ['server', 'database', 'user']) if (!o[k]) { console.error(`Missing --${k}`); process.exit(1); }
  if (!process.env.AACC_SQL_PASSWORD) { console.error('Set the AACC_SQL_PASSWORD environment variable.'); process.exit(1); }

  const db = await openSqlServer(o);
  try {
    if (o['check-columns']) {
      ident(table, 'Table');
      const cols = await db.query(COLUMNS_QUERY, { table });
      if (!cols.length) console.log(`No table named ${table} was found, or this login cannot see it.`);
      else console.log(`Columns of ${table}:\n${cols.map((c) => `  ${c.name} (${c.type})`).join('\n')}\n\nPass the ones that match with --col-timestamp, --col-skillset, --col-offered, --col-answered, --col-abandoned, --col-handle-seconds.`);
      return;
    }
    for (const k of ['gateway', 'connector', 'key']) if (!o[k]) { console.error(`Missing --${k}`); process.exit(1); }
    const post = poster(o);
    if (o['backfill-weeks']) { await runBackfill({ db, post, table, columns, today: today(), weeks: Number(o['backfill-weeks']) }); return; }
    const everyMs = Math.max(30, Number(o['interval-seconds'] ?? 900)) * 1000;
    do {
      try { await runLive({ db, post, table, columns, today: today() }); }
      catch (e) { console.error(`[${new Date().toISOString()}] error: ${e.message}`); if (o.once) process.exitCode = 1; }
      if (!o.once) await new Promise((r) => setTimeout(r, everyMs));
    } while (!o.once);
  } finally { await db.close(); }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
