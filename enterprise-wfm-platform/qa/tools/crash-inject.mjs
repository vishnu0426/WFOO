// DEF-14 re-check: kill the CP-SAT solver child process in the middle of a schedule build and confirm the engine survives.
//   QA_ADMIN_PASSWORD=... node qa/tools/crash-inject.mjs   -> <tmp>/wfm-qa/crash-inject.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const API = 'http://localhost:4000/api/v1';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'));
const SUP = path.join(OUT, 'scale', 'engine-supervisor.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const exits = () => fs.existsSync(SUP) ? fs.readFileSync(SUP, 'utf8').split('\n').filter((l) => /EXIT/.test(l)).length : 0;
const workers = () => {
  const ps = `Get-CimInstance Win32_Process -Filter \\"Name like 'python%'\\" | Where-Object { $_.CommandLine -like '*solve_worker*' } | ForEach-Object { $_.ProcessId }`;
  return execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number);
};

const tok = (await call(null, 'POST', '/auth/login', { username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' })).token;
const g = (await call(tok, 'GET', '/config/groups')).find((x) => x.name === 'Demo Support');
const tpl = (await call(tok, 'GET', '/scheduling/templates')).filter((t) => !t.name.startsWith('SCALE ') && (!t.wfmGroupId || t.wfmGroupId === g.id)).map((t) => t.id);
const from = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 14); return d.toISOString().slice(0, 10); })();
const before = exits(), t0 = Date.now();
const job = await call(tok, 'POST', '/scheduling/jobs', { groupId: g.id, from, weeks: 1, timeLimitSec: 60, templateIds: tpl, useHistory: false, name: 'QA crash-inject' });
console.log('job', job.id, job.status ?? job.error);
let killed = [], seen = false;
for (let i = 0; i < 240 && !killed.length; i++) {
  const w = workers();
  if (w.length) { seen = true; await sleep(1500); for (const pid of w) { try { execSync(`taskkill /F /PID ${pid}`); killed.push(pid); } catch { /* gone */ } } }
  else await sleep(500);
}
console.log('solver worker seen:', seen, 'killed:', killed);
let j = job;
while (!['DONE', 'FAILED', 'CANCELLED'].includes(j.status) && Date.now() - t0 < 15 * 60_000) { await sleep(4000); const r = await call(tok, 'GET', `/scheduling/jobs/${job.id}`); j = r.job ?? r; }
const h = await (await fetch('http://localhost:4000/health')).json().catch(() => ({}));
let solver;
if (j.versionId) { const v = await call(tok, 'GET', `/scheduling/versions/${j.versionId}`); solver = v.stats?.solver; }
const row = { at: new Date().toISOString(), jobId: job.id, workerSeen: seen, killedPids: killed, jobStatus: j.status, jobError: j.error, attempts: j.attempts, wallSec: Math.round((Date.now() - t0) / 1000), engineExitsDuring: exits() - before, engineHealthAfter: h.engine ?? h, solverBackend: solver?.backend, solverStatus: solver?.status, solverNotes: JSON.stringify(solver ?? {}).slice(0, 400) };
console.log(row);
fs.writeFileSync(path.join(OUT, 'crash-inject.json'), JSON.stringify(row, null, 1));
