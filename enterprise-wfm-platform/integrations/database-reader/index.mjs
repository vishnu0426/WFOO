#!/usr/bin/env node
/**
 * Direct database connectivity, the relay-family way: this runs on the customer's own network, reads their
 * database with a read-only login they hold, and relays new/changed rows out to the WFM Integration Station over
 * HTTPS. We never reach into their network -- see the plan's correction on this method.
 *
 * Postgres today (via the `pg` driver). Oracle/SQL Server/Informix follow the identical shape -- swap the driver
 * (`oracledb`, `mssql`, `informix-connector-or-odbc-bridge`) and the two SQL statements below; everything else
 * (the watermark loop, the outbound POST, retry) stays the same.
 *
 * Usage:
 *   node index.mjs --gateway http://localhost:4000 --connector <connector-id> --key <api-key> \
 *     --pg "postgres://readonly_user:pw@host:5432/dbname" --table call_history --watermark-column updated_at \
 *     [--interval-seconds 60] [--once]
 */
import pg from 'pg';

function args() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; }
  return a;
}

async function post(gateway, connectorId, key, path, body) {
  const res = await fetch(`${gateway}/api/v1/integrations/${connectorId}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function runOnce(client, opts, watermark) {
  const { rows } = await client.query(`SELECT * FROM ${opts.table} WHERE ${opts.watermarkColumn} > $1 ORDER BY ${opts.watermarkColumn} ASC LIMIT 5000`, [watermark]);
  if (!rows.length) return watermark;
  const out = await post(opts.gateway, opts.connector, opts.key, '/live', { rows });
  console.log(`[${new Date().toISOString()}] posted ${rows.length} row(s), accepted ${out.accepted}${out.errors?.length ? `, ${out.errors.length} error(s): ${JSON.stringify(out.errors.slice(0, 3))}` : ''}`);
  return rows[rows.length - 1][opts.watermarkColumn];
}

async function main() {
  const o = args();
  for (const k of ['gateway', 'connector', 'key', 'pg', 'table', 'watermark-column']) if (!o[k]) { console.error(`Missing --${k}`); process.exit(1); }
  const opts = { gateway: o.gateway, connector: o.connector, key: o.key, table: o.table, watermarkColumn: o['watermark-column'] };
  const client = new pg.Client({ connectionString: o.pg });
  await client.connect();
  console.log(`Connected. Reading ${opts.table}, watermark column ${opts.watermarkColumn}.`);

  let watermark = o['from-watermark'] ?? '1970-01-01T00:00:00Z';
  const intervalMs = Math.max(5, Number(o['interval-seconds'] ?? 60)) * 1000;
  do {
    try { watermark = await runOnce(client, opts, watermark); }
    catch (e) { console.error(`[${new Date().toISOString()}] error: ${e.message}`); }
    if (!o.once) await new Promise((r) => setTimeout(r, intervalMs));
  } while (!o.once);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
