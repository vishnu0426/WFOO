#!/usr/bin/env node
/**
 * Run-2 fallback: builds the remaining groups one at a time through the direct build endpoint (POST /scheduling/versions),
 * which does not go through the job queue whose stale-heartbeat sweeper was failing live builds. Waits for a running job first.
 *   $env:QA_ADMIN_PASSWORD='...'; $env:QA_OUT='<tmp>/wfm-qa/run2'; node qa/scale/direct-builds.mjs <waitJobId> S06,S08,...
 * Logs phase "schedule-job-wait" and "schedule-direct" rows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SCENARIOS, WEEK_FROM } from './scenarios.mjs';

const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa', 'run2'), 'scale');
const SUP = path.join(os.tmpdir(), 'wfm-qa', 'scale', 'engine-supervisor.log');
const [WAIT, KEYS] = [process.argv[2], process.argv[3].split(',')];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 500)); };
const crashCount = () => { try { return fs.readFileSync(SUP, 'utf8').split('\n').filter((l) => /EXIT/.test(l) && !/code=0/.test(l)).length; } catch { return 0; } };
/** plain http: no client-side timeout, a direct build of thousands of people can run longer than fetch allows */
const req = (method, p, token, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : undefined;
  const r = http.request({ host: 'localhost', port: 4000, path: '/api/v1' + p, method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let t = ''; res.setEncoding('utf8'); res.on('data', (c) => (t += c)); res.on('end', () => { let j; try { j = JSON.parse(t); } catch { j = t; } resolve({ s: res.statusCode, j }); });
  });
  r.on('error', reject); r.setTimeout(0); if (data) r.write(data); r.end();
});
const login = async () => (await req('POST', '/auth/login', null, { username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' })).j.token;
let tok = await login();
const get = async (p) => { let r = await req('GET', p, tok); if (r.s === 401) { tok = await login(); r = await req('GET', p, tok); } return r.j; };
const versionRow = async (id) => { const st = (await get(`/scheduling/versions/${id}`)).stats ?? {}; return { versionId: id, solver: st.solver?.status, backend: st.solver?.backend, attemptsLog: (st.solver?.attempts ?? []).slice(0, 16), parts: st.solver?.parts, candidates: st.solver?.candidates, shifts: st.shifts, coveragePercent: st.coverage?.percent, statsRaw: JSON.stringify(st).slice(0, 1500) }; };

if (WAIT && WAIT !== '-') {                                         // the job that was already running when the queue was stopped
  const t0 = Date.now(); let j;
  for (;;) { j = await get(`/scheduling/jobs/${WAIT}`); j = j.job ?? j; if (['DONE', 'FAILED', 'CANCELLED'].includes(j.status)) break; await sleep(15_000); }
  const s = SCENARIOS.find((x) => j.params?.name?.startsWith(`SCALE ${x.key} `));
  log({ phase: 'schedule-queue', key: s?.key, people: s?.size, requeued: false, status: j.status, waitedSec: Math.round((Date.now() - t0) / 1000), error: j.error ?? undefined, attempts: j.attempts, note: j.progress?.note, ...(j.versionId ? await versionRow(j.versionId) : {}) });
}
const groups = Object.fromEntries((await get('/config/groups')).map((g) => [g.name, g]));
const tpl = await get('/scheduling/templates');
for (const key of KEYS) {
  const s = SCENARIOS.find((x) => x.key === key), g = groups[`SCALE ${s.key} ${s.name}`];
  const body = { groupId: g.id, from: WEEK_FROM, weeks: s.longPlan ? 13 : 1, windowWeeks: s.longPlan ? 4 : 1, solveWeeks: s.longPlan ? 4 : 1, timeLimitSec: 90, templateIds: tpl.filter((t) => t.name.startsWith(`SCALE ${key} `) && !t.name.includes('Boundary')).map((t) => t.id), useHistory: false, name: `SCALE ${key} rerun direct` };
  const c0 = crashCount(), t0 = Date.now();
  tok = await login();
  const r = await req('POST', '/scheduling/versions', tok, body).catch((e) => ({ s: 'no answer', j: { error: { message: e.message } } }));
  const row = { phase: 'schedule-direct', key, people: s.size, mode: 'built directly, one at a time', status: r.s === 201 || r.s === 200 ? 'DONE' : 'FAILED', http: r.s, wallSec: Math.round((Date.now() - t0) / 1000), engineCrashesDuring: crashCount() - c0, error: r.s >= 300 || typeof r.s !== 'number' ? (r.j?.error?.message ?? String(r.j).slice(0, 300)) : undefined };
  const vid = r.j?.id ?? r.j?.version?.id;
  if (vid) Object.assign(row, await versionRow(vid));
  log(row);
}
log({ phase: 'direct-end' });
