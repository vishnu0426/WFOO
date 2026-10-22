#!/usr/bin/env node
/**
 * File/SFTP relay: watches a local directory for export files and relays each row out to the WFM Integration
 * Station's historical backfill endpoint. No SFTP client dependency here on purpose -- point this at the local
 * landing folder your own SFTP server (or transfer tooling) already writes into, which is the realistic customer
 * setup: their file transfer stays theirs, this script only picks up what lands.
 *
 * Usage:
 *   node index.mjs --gateway http://localhost:4000 --connector <connector-id> --key <api-key> \
 *     --dir ./incoming --through 2026-01-31 [--interval-seconds 60] [--once]
 *
 * Expects a CSV with a header row; every other row becomes one raw object (column name -> value) that the
 * connector's field mapping then translates, same as any other method.
 */
import { readdir, readFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

function args() {
  const a = {}; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[++i]; }
  return a;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

async function post(gateway, connectorId, key, through, rows) {
  const res = await fetch(`${gateway}/api/v1/integrations/${connectorId}/backfill`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ rows, through }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`backfill failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function processOnce(o) {
  const files = (await readdir(o.dir)).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (!files.length) return 0;
  await mkdir(path.join(o.dir, 'processed'), { recursive: true });
  let total = 0;
  for (const f of files) {
    const full = path.join(o.dir, f);
    const rows = parseCsv(await readFile(full, 'utf8'));
    if (rows.length) {
      const out = await post(o.gateway, o.connector, o.key, o.through, rows);
      console.log(`[${new Date().toISOString()}] ${f}: ${rows.length} row(s), staged ${out.rowsMapped}${out.mappingErrors?.length ? `, ${out.mappingErrors.length} mapping error(s)` : ''}`);
      total += rows.length;
    }
    await rename(full, path.join(o.dir, 'processed', f));
  }
  return total;
}

async function main() {
  const o = args();
  for (const k of ['gateway', 'connector', 'key', 'dir', 'through']) if (!o[k]) { console.error(`Missing --${k}`); process.exit(1); }
  const intervalMs = Math.max(5, Number(o['interval-seconds'] ?? 60)) * 1000;
  do {
    try { await processOnce(o); } catch (e) { console.error(`[${new Date().toISOString()}] error: ${e.message}`); }
    if (!o.once) await new Promise((r) => setTimeout(r, intervalMs));
  } while (!o.once);
}

main().catch((e) => { console.error(e); process.exit(1); });
