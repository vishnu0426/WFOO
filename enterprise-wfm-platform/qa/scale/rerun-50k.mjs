#!/usr/bin/env node
/**
 * Second 50,000-person run (re-test after the fixes): reuses the SCALE groups, people and published forecasts already loaded,
 * then 1) checks the over-limit request is refused, 2) queues all 13 builds at once (the case that failed every build in run 1)
 * while probing the gateway, 3) retries anything that failed one group at a time.
 *   $env:QA_ADMIN_PASSWORD='...'; $env:QA_OUT='<tmp>/wfm-qa/run2'; node qa/scale/rerun-50k.mjs [boundary,parallel,retry]
 * Builds are named "SCALE Sxx rerun"; rows go to <QA_OUT>/scale/results.jsonl.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, WEEK_FROM } from './scenarios.mjs';

const BASE = 'http://localhost:4000';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa', 'run2'), 'scale');
fs.mkdirSync(OUT, { recursive: true });
const SUP = path.join(os.tmpdir(), 'wfm-qa', 'scale', 'engine-supervisor.log');
const STEPS = (process.argv[2] ?? 'boundary,parallel,retry').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 600)); };
async function call(t, m, p, b, { tries = 6, timeoutMs = 120_000 } = {}) {
  for (let i = 1; ; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${BASE}/api/v1${p}`, { method: m, signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
      if (!r.ok) { const e = new Error(`${m} ${p} -> ${r.status} ${j?.error?.message ?? String(txt).slice(0, 300)}`); e.status = r.status; e.ms = Math.round(performance.now() - t0); throw e; }
      return Object.assign(j ?? {}, { __ms: Math.round(performance.now() - t0) });
    } catch (e) { if (e.status || i >= tries) throw e; await sleep(5000 * i); }
  }
}
const exits = () => { try { return fs.readFileSync(SUP, 'utf8').split('\n').filter((l) => /EXIT/.test(l)).map((l) => ({ line: l, code: Number(/code=(\d+)/.exec(l)?.[1]) })); } catch { return []; } };
const crashCount = () => exits().filter((x) => x.code !== 0).length;
const engineUp = async (maxMs = 180_000) => { const t = Date.now(); while (Date.now() - t < maxMs) { try { const h = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) })).json(); if (h.engine) return true; } catch { /* busy */ } await sleep(5000); } return false; };

const tok = (await call(null, 'POST', '/auth/login', { username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' })).token;
const groups = Object.fromEntries((await call(tok, 'GET', '/config/groups')).map((g) => [g.name, g]));
const G = (s) => groups[`SCALE ${s.key} ${s.name}`];
const allTpl = await call(tok, 'GET', '/scheduling/templates');
const tplFor = (s) => allTpl.filter((t) => t.name.startsWith(`SCALE ${s.key} `) && !t.name.includes('Boundary')).map((t) => t.id);
const bodyFor = (s, extra = {}) => ({ groupId: G(s).id, from: WEEK_FROM, weeks: s.longPlan ? 13 : 1, windowWeeks: s.longPlan ? 4 : 1, solveWeeks: s.longPlan ? 4 : 1, timeLimitSec: 90, templateIds: tplFor(s), useHistory: false, name: `SCALE ${s.key} rerun`, ...extra });
log({ phase: 'start', run: 'rerun', steps: STEPS, crashesBefore: crashCount(), exitsBefore: exits().length, health: await fetch(`${BASE}/health`).then((r) => r.json()) });

async function versionRow(versionId) {
  const v = await call(tok, 'GET', `/scheduling/versions/${versionId}`).catch((e) => ({ error: e.message }));
  const st = v.stats ?? {};
  return { versionId, solver: st.solver?.status, backend: st.solver?.backend, attemptsLog: (st.solver?.attempts ?? []).map((a) => typeof a === 'string' ? a : `${a.backend ?? a.name}: ${a.status ?? a.result ?? ''} ${a.note ?? a.error ?? ''}`.trim()).slice(0, 8), parts: st.solver?.parts ?? st.solver?.partitions, candidates: st.solver?.candidates, thinned: st.solver?.thinned, shifts: st.shifts, peopleUsed: st.people, coveragePercent: st.coverage?.percent, violations: st.violations ?? st.ruleViolations, statsRaw: JSON.stringify(st).slice(0, 1500) };
}

// ---------------------------------------------------------------- 1. over-limit request (run 1: ran 8.5 min, then the connection dropped)
if (STEPS.includes('boundary')) {
  const s = SCENARIOS.find((x) => x.boundary), g = G(s);
  const tname = `SCALE ${s.key} Boundary every start`;
  let t = (await call(tok, 'GET', '/scheduling/templates')).find((x) => x.name === tname);
  const def = { name: tname, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '00:00', latestStart: '23:45', startStepMinutes: 15, minDurationHours: 4, durationHours: 12, lengthStepMinutes: 15, mealMinutes: 30, breakCount: 2, breakMinutes: 15, groupIds: [g.id], status: 'ACTIVE' };
  t = t ? await call(tok, 'PUT', `/scheduling/templates/${t.id}`, def) : await call(tok, 'POST', '/scheduling/templates', def);
  const out = { phase: 'boundary', key: s.key, people: s.size };
  for (const [kind, p] of [['direct build', '/scheduling/versions'], ['background job', '/scheduling/jobs']]) {
    const t0 = Date.now();
    const r = await call(tok, 'POST', p, { groupId: g.id, from: WEEK_FROM, weeks: 1, timeLimitSec: 30, templateIds: [t.id], useHistory: false, name: 'SCALE boundary rerun' }, { timeoutMs: 600_000, tries: 1 })
      .then((v) => ({ status: 201, id: v.id, job: v.status, stats: v.stats?.solver }), (e) => ({ status: e.status ?? 'no answer', message: e.message.slice(0, 400) }));
    if (r.status === 201 && kind === 'background job') {                // a queued job: wait for it to finish or be refused
      let j = r; while (!['DONE', 'FAILED', 'CANCELLED'].includes(j.status ?? j.job) && Date.now() - t0 < 20 * 60_000) { await sleep(5000); const x = await call(tok, 'GET', `/scheduling/jobs/${r.id}`).catch(() => null); if (x) j = x.job ?? x; }
      Object.assign(r, { finalStatus: j.status, error: j.error, note: j.progress?.note });
    }
    out[kind] = { ms: Date.now() - t0, ...r };
  }
  await call(tok, 'PUT', `/scheduling/templates/${t.id}`, { name: tname, workDays: [0], earliestStart: '00:00', latestStart: '00:00', durationHours: 8, status: 'INACTIVE' }).catch(() => {});
  out.healthAfter = await fetch(`${BASE}/health`).then((x) => x.json()).catch((e) => e.message);
  log(out);
}

// ---------------------------------------------------------------- 2. all 13 at once (run 1: up to 10 ran together, all failed, gateway frozen 40+ min)
const results = {};
if (STEPS.includes('parallel')) {
  await engineUp();
  const probe = { samples: 0, failures: 0, worstHealthMs: 0, worstGroupsMs: 0, slowOver2s: 0, over10s: 0, healthMs: [], maxRunning: 0, runningSamples: [] };
  let stop = false;
  const prober = (async () => {
    while (!stop) {
      const a = Date.now();
      try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(30000) }); if (!r.ok) probe.failures++; } catch { probe.failures++; }
      const b = Date.now(); probe.worstHealthMs = Math.max(probe.worstHealthMs, b - a); probe.healthMs.push(b - a);
      try { await call(tok, 'GET', '/config/groups', undefined, { tries: 1, timeoutMs: 30000 }); } catch { probe.failures++; }
      const c = Date.now() - b; probe.worstGroupsMs = Math.max(probe.worstGroupsMs, c); if (c > 2000) probe.slowOver2s++; if (c > 10000) probe.over10s++; probe.samples++;
      await sleep(3000);
    }
  })();
  const crashes0 = crashCount(), t00 = Date.now();
  const jobs = [];
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    const j = await call(tok, 'POST', '/scheduling/jobs', bodyFor(s)).catch((e) => ({ error: e.message }));
    jobs.push({ s, job: j, t0, error: j.error, maxNote: '' });
    if (j.error) log({ phase: 'schedule-parallel', key: s.key, status: 'REFUSED', error: j.error });
  }
  log({ phase: 'parallel-queued', queued: jobs.filter((x) => !x.error).length, ms: Date.now() - t00 });
  const deadline = Date.now() + 4 * 3600_000;
  while (jobs.some((x) => !x.done && !x.error) && Date.now() < deadline) {
    await sleep(10_000);
    let running = 0;
    for (const x of jobs.filter((y) => !y.done && !y.error)) {
      const r = await call(tok, 'GET', `/scheduling/jobs/${x.job.id}`, undefined, { tries: 2, timeoutMs: 60_000 }).catch(() => null);
      const job = r?.job ?? r; if (!job) continue;
      x.last = job; if (job.status === 'RUNNING') { running++; x.started ??= Date.now(); }
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) {
        x.done = true;
        const row = { phase: 'schedule-parallel', key: x.s.key, people: x.s.size, status: job.status, wallSec: Math.round((Date.now() - x.t0) / 1000), runSec: x.started ? Math.round((Date.now() - x.started) / 1000) : null, error: job.error ?? undefined, attempts: job.attempts, note: job.progress?.note };
        if (job.versionId) Object.assign(row, await versionRow(job.versionId));
        results[x.s.key] = row; log(row);
      }
    }
    probe.maxRunning = Math.max(probe.maxRunning, running); probe.runningSamples.push(running);
  }
  stop = true; await prober;
  for (const x of jobs.filter((y) => !y.done && !y.error)) log({ phase: 'schedule-parallel', key: x.s.key, status: 'TIMEOUT_4H', note: x.last?.progress?.note });
  const hs = probe.healthMs.sort((a, b) => a - b), q = (p) => hs[Math.min(hs.length - 1, Math.floor(p * hs.length))];
  log({ phase: 'probe-during-parallel', minutes: Math.round((Date.now() - t00) / 60000), samples: probe.samples, failures: probe.failures, healthP50: q(0.5), healthP95: q(0.95), worstHealthMs: probe.worstHealthMs, worstGroupsMs: probe.worstGroupsMs, slowOver2s: probe.slowOver2s, over10s: probe.over10s, maxRunning: probe.maxRunning, engineCrashesDuring: crashCount() - crashes0 });
}

// ---------------------------------------------------------------- 3. one at a time for anything that did not finish
if (STEPS.includes('retry')) {
  const done = new Set(fs.readFileSync(path.join(OUT, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => /^schedule-/.test(r.phase) && r.status === 'DONE').map((r) => r.key));
  for (const s of SCENARIOS.filter((x) => !done.has(x.key))) {
    for (const [mode, extra] of [['in parts', {}], ['whole', { splitAbove: 900000 }]]) {
      const row = { phase: 'schedule-seq', key: s.key, people: s.size, mode, engineReadyBefore: await engineUp() };
      const before = crashCount(), t0 = Date.now();
      try {
        const job = await call(tok, 'POST', '/scheduling/jobs', bodyFor(s, extra));
        let j = job;
        while (!['DONE', 'FAILED', 'CANCELLED'].includes(j.status) && Date.now() - t0 < 2 * 3600_000) { await sleep(5000); const r = await call(tok, 'GET', `/scheduling/jobs/${job.id}`).catch(() => null); if (r) j = r.job ?? r; }
        Object.assign(row, { status: j.status, error: j.error ?? undefined, note: j.progress?.note, wallSec: Math.round((Date.now() - t0) / 1000), engineCrashesDuring: crashCount() - before, attempts: j.attempts });
        if (j.versionId) Object.assign(row, await versionRow(j.versionId));
      } catch (e) { row.status = 'ERROR'; row.error = e.message; }
      log(row);
      if (row.status === 'DONE') break;
    }
  }
}
log({ phase: 'end', run: 'rerun', crashesAfter: crashCount(), exitsAfter: exits().length, engineExits: exits().slice(-6).map((x) => x.line) });
