// Watches the scale schedule jobs straight from PostgreSQL (read-only), plus whether the gateway answers /health.
// Prints one line whenever a job's status or step changes, and exits when no SCALE job is QUEUED or RUNNING.
//   node qa/scale/watch-jobs.mjs <DATABASE_URL>
import pg from '../../backend/gateway/node_modules/pg/lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = path.join(os.tmpdir(), 'wfm-qa', 'scale', 'health-samples.jsonl');
const c = new pg.Client({ connectionString: process.argv[2] }); await c.connect();
const seen = new Map();
for (;;) {
  const t0 = Date.now(); let health = 'timeout';
  try { const r = await fetch('http://localhost:4000/health', { signal: AbortSignal.timeout(15000) }); health = r.status; } catch { /* timeout */ }
  fs.appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), health, ms: Date.now() - t0 }) + '\n');
  const r = await c.query(`SELECT params->>'name' nm, status, progress->>'note' note, progress->>'done' done, progress->>'total' total, left(coalesce(error,''),160) err FROM wfm.schedule_jobs WHERE params->>'name' LIKE 'SCALE%' ORDER BY created_at`);
  for (const x of r.rows) { const k = `${x.status}|${x.note}|${x.done}`; if (seen.get(x.nm) !== k) { seen.set(x.nm, k); console.log(`${new Date().toISOString().slice(11, 19)} ${x.nm}: ${x.status} ${x.note ?? ''} ${x.done ?? ''}/${x.total ?? ''} ${x.err} | health ${health} ${Date.now() - t0}ms`); } }
  if (!r.rows.some((x) => ['QUEUED', 'RUNNING'].includes(x.status))) { console.log('all scale jobs finished'); break; }
  await new Promise((res) => setTimeout(res, 30000));
}
await c.end();
