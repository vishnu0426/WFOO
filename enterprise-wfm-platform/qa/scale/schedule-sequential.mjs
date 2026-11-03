#!/usr/bin/env node
/**
 * Second scheduling pass: one group at a time (enqueue, wait until it finishes, then the next), so the engine only ever sees one solve.
 *   $env:QA_ADMIN_PASSWORD='...'; node qa/scale/schedule-sequential.mjs S07,S04,S11 [timeLimitSec]
 * Logs phase "schedule-seq" rows to <tmp>/wfm-qa/scale/results.jsonl, with engine restarts seen during each build.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, WEEK_FROM } from './scenarios.mjs';

const BASE = process.env.QA_API ?? 'http://localhost:4000';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'scale');
const KEYS = (process.argv[2] ?? SCENARIOS.map((s) => s.key).join(',')).split(',');
const LIMIT = Number(process.argv[3] ?? 90);
const SPLIT = process.argv[4] ? Number(process.argv[4]) : undefined;     // optional splitAbove: 900000 = solve the group whole, never in parts
const engineUp = async (maxMs = 180_000) => { const t = Date.now(); while (Date.now() - t < maxMs) { try { const h = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) })).json(); if (h.engine) return true; } catch { /* gateway busy */ } await sleep(5000); } return false; };
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 700)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(t, m, p, b, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(`${BASE}/api/v1${p}`, { method: m, signal: AbortSignal.timeout(120_000), headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
      if (!r.ok) { const e = new Error(`${m} ${p} -> ${r.status} ${j?.error?.message ?? String(txt).slice(0, 200)}`); e.status = r.status; throw e; }
      return j;
    } catch (e) { if (e.status || i >= tries) throw e; await sleep(5000 * i); }
  }
}
const restarts = () => { try { return fs.readFileSync(path.join(OUT, 'engine-supervisor.log'), 'utf8').split('\n').filter((l) => /EXIT/.test(l)).length; } catch { return 0; } };
const tok = (await call(null, 'POST', '/auth/login', { username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' })).token;
const groups = Object.fromEntries((await call(tok, 'GET', '/config/groups')).map((g) => [g.name, g]));
const allTpl = await call(tok, 'GET', '/scheduling/templates');

for (const key of KEYS) {
  const s = SCENARIOS.find((x) => x.key === key); const g = groups[`SCALE ${s.key} ${s.name}`];
  const row = { phase: 'schedule-seq', key, people: s.size, limitSec: LIMIT };
  try {
    const templateIds = allTpl.filter((t) => t.name.startsWith(`SCALE ${key} `) && !t.name.includes('Boundary')).map((t) => t.id);
    row.engineReadyBefore = await engineUp();            // a restarting engine fails a job at once, so wait for it
    if (SPLIT) row.splitAbove = SPLIT;
    const before = restarts(), t0 = Date.now();
    const job = await call(tok, 'POST', '/scheduling/jobs', { groupId: g.id, from: WEEK_FROM, weeks: s.longPlan ? 13 : 1, windowWeeks: s.longPlan ? 4 : 1, solveWeeks: s.longPlan ? 4 : 1, timeLimitSec: LIMIT, templateIds, useHistory: false, name: `SCALE ${key} schedule`, ...(SPLIT ? { splitAbove: SPLIT } : {}) });
    let j = job, prepMs = null;
    while (!['DONE', 'FAILED', 'CANCELLED'].includes(j.status) && Date.now() - t0 < 3 * 3600_000) {
      await sleep(5000);
      const r = await call(tok, 'GET', `/scheduling/jobs/${job.id}`).catch(() => null); if (!r) continue;
      j = r.job ?? r;
      if (prepMs === null && /Solving/.test(j.progress?.note ?? '')) prepMs = Date.now() - t0;
    }
    Object.assign(row, { status: j.status, error: j.error ?? undefined, wallSec: Math.round((Date.now() - t0) / 1000), prepareSec: prepMs === null ? null : Math.round(prepMs / 1000), engineCrashesDuring: restarts() - before, attempts: j.attempts });
    if (j.versionId) {
      const v = await call(tok, 'GET', `/scheduling/versions/${j.versionId}`);
      const st = v.stats ?? {};
      Object.assign(row, { versionId: j.versionId, solver: st.solver?.status, backend: st.solver?.backend, parts: st.solver?.parts ?? st.solver?.partitions, candidates: st.solver?.candidates, thinned: st.solver?.thinned, shifts: st.shifts, peopleUsed: st.people, coveragePercent: st.coverage?.percent, violations: st.violations ?? st.ruleViolations, statsRaw: JSON.stringify(st).slice(0, 1200) });
    }
  } catch (e) { row.status = 'ERROR'; row.error = e.message; }
  log(row);
}
