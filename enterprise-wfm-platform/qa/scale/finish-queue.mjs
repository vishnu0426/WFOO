#!/usr/bin/env node
/**
 * Finishes the run-2 queue after the laptop went into standby overnight: waits on the SCALE "rerun" jobs that are still queued
 * (they were all queued together with the others), re-queues the ones the standby broke, and logs each result as phase "schedule-queue".
 * Signs in again before every call round, because a test token expires over a run this long.
 *   $env:QA_ADMIN_PASSWORD='...'; $env:QA_OUT='<tmp>/wfm-qa/run2'; node qa/scale/finish-queue.mjs S06,S08,S09,S10,S11,S12,S13
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, WEEK_FROM } from './scenarios.mjs';

const BASE = 'http://localhost:4000';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa', 'run2'), 'scale');
const SUP = path.join(os.tmpdir(), 'wfm-qa', 'scale', 'engine-supervisor.log');
const KEYS = process.argv[2].split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 500)); };
const crashCount = () => { try { return fs.readFileSync(SUP, 'utf8').split('\n').filter((l) => /EXIT/.test(l) && !/code=0/.test(l)).length; } catch { return 0; } };
let tok = null, tokAt = 0;
async function call(m, p, b) {
  for (let i = 1; ; i++) {
    try {
      if (!tok || Date.now() - tokAt > 10 * 60_000) {
        const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' }), signal: AbortSignal.timeout(60_000) });
        tok = (await r.json()).token; tokAt = Date.now();
      }
      const r = await fetch(`${BASE}/api/v1${p}`, { method: m, signal: AbortSignal.timeout(120_000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined });
      const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
      if (r.status === 401) { tok = null; throw new Error('401'); }
      if (!r.ok) { const e = new Error(`${m} ${p} -> ${r.status} ${j?.error?.message ?? String(txt).slice(0, 300)}`); e.status = r.status; throw e; }
      return j;
    } catch (e) { if (e.status || i >= 8) throw e; await sleep(5000 * i); }
  }
}
const groups = Object.fromEntries((await call('GET', '/config/groups')).map((g) => [g.name, g]));
const tpl = await call('GET', '/scheduling/templates');
const jobs = [];
for (const key of KEYS) {
  const s = SCENARIOS.find((x) => x.key === key), g = groups[`SCALE ${s.key} ${s.name}`];
  const existing = (await call('GET', `/scheduling/jobs?groupId=${g.id}&active=true`))[0];
  let job = existing, requeued = false;
  if (!job) {
    job = await call('POST', '/scheduling/jobs', { groupId: g.id, from: WEEK_FROM, weeks: s.longPlan ? 13 : 1, windowWeeks: s.longPlan ? 4 : 1, solveWeeks: s.longPlan ? 4 : 1, timeLimitSec: 90, templateIds: tpl.filter((t) => t.name.startsWith(`SCALE ${key} `) && !t.name.includes('Boundary')).map((t) => t.id), useHistory: false, name: `SCALE ${key} rerun` });
    requeued = true;
  }
  jobs.push({ s, job, requeued, t0: Date.now() });
}
log({ phase: 'queue-resume', keys: KEYS, requeued: jobs.filter((x) => x.requeued).map((x) => x.s.key), crashesBefore: crashCount() });
const c0 = crashCount();
while (jobs.some((x) => !x.done)) {
  await sleep(15_000);
  for (const x of jobs.filter((y) => !y.done)) {
    const r = await call('GET', `/scheduling/jobs/${x.job.id}`).catch(() => null); const j = r?.job ?? r; if (!j) continue;
    if (j.status === 'RUNNING') x.started ??= Date.now();
    if (!['DONE', 'FAILED', 'CANCELLED'].includes(j.status)) continue;
    x.done = true;
    const row = { phase: 'schedule-queue', key: x.s.key, people: x.s.size, requeued: x.requeued, status: j.status, wallSec: Math.round((Date.now() - x.t0) / 1000), runSec: x.started ? Math.round((Date.now() - x.started) / 1000) : null, error: j.error ?? undefined, attempts: j.attempts, note: j.progress?.note };
    if (j.versionId) {
      const v = await call('GET', `/scheduling/versions/${j.versionId}`).catch(() => ({})); const st = v.stats ?? {};
      Object.assign(row, { versionId: j.versionId, solver: st.solver?.status, backend: st.solver?.backend, attemptsLog: (st.solver?.attempts ?? []).slice(0, 16), parts: st.solver?.parts, candidates: st.solver?.candidates, shifts: st.shifts, coveragePercent: st.coverage?.percent, statsRaw: JSON.stringify(st).slice(0, 1500) });
    }
    log(row);
  }
}
log({ phase: 'queue-end', crashesDuring: crashCount() - c0 });
