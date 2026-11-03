#!/usr/bin/env node
/**
 * 50,000-employee scale test through the real pipeline (gateway -> engine -> database).
 *   $env:QA_ADMIN_PASSWORD='...'; node qa/scale/scale-test.mjs setup|forecast|schedule|all
 * Resumable: every phase skips what already exists (groups are named "SCALE Sxx …").
 * Results: <tmp>/wfm-qa/scale/results.jsonl (one JSON row per measured step).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, WEEK_FROM, TOTAL } from './scenarios.mjs';

const BASE = process.env.QA_API ?? 'http://localhost:4000';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'scale');
fs.mkdirSync(OUT, { recursive: true });
const PHASE = process.argv[2] ?? 'all';
const ONLY = process.argv[3]?.split(',');            // optional: S01,S02
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 400)); };

async function call(token, method, p, body, { tries = 4, timeoutMs = 300_000 } = {}) {
  for (let i = 1; ; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${BASE}/api/v1${p}`, { method, signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) { const e = new Error(`${method} ${p} -> ${r.status} ${json?.error?.message ?? text.slice(0, 200)}`); e.status = r.status; e.ms = ms; e.body = json; throw e; }
      return Object.assign(json ?? {}, { __ms: ms, __bytes: text.length });
    } catch (e) {
      if (e.status || i >= tries || !/fetch failed|ECONN|socket|terminated|aborted|timeout/i.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const TODAY = '2026-10-31';

// ---------------------------------------------------------------- synthetic history
const SHAPES = {
  standard: [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3],
  office: [0, 0, 0, 0, 0, 0, 0, 10, 55, 75, 80, 76, 64, 68, 74, 72, 62, 50, 34, 18, 0, 0, 0, 0],
  flat24: [30, 25, 22, 20, 22, 30, 40, 55, 68, 75, 78, 76, 72, 72, 74, 72, 68, 62, 56, 50, 46, 42, 38, 34],
  weekend: [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3],
};
function history(s, queue, peakPeople, seedBase) {
  let seed = seedBase; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const shape = SHAPES[s.shape], max = Math.max(...shape);
  // contacts per 15 min at the peak so that Erlang needs about `peakPeople` agents (AHT 300 s, ~85% occupancy, before shrinkage)
  const peakContacts = (peakPeople * 0.75 * 900 * 0.85) / 300;
  const rows = ['queue,date,interval,volume,aht'];
  const gapDays = s.historyGaps ? new Set([12, 13, 14, 30, 31].map((n) => addDays(TODAY, -n))) : new Set();
  const outlierDays = s.outliers ? new Set([9, 23, 40].map((n) => addDays(TODAY, -n))) : new Set();
  for (let n = 84; n >= 1; n--) {
    const day = addDays(TODAY, -n); if (gapDays.has(day)) continue;
    const dow = (new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7;
    let f = s.shape === 'office' ? (dow >= 5 ? 0 : 1) : s.shape === 'weekend' ? (dow >= 5 ? 1.6 : 1) : s.shape === 'flat24' ? 1 : (dow >= 5 ? 0.55 : 1);
    if (outlierDays.has(day)) f *= 5;
    for (let q = 0; q < 96; q++) {
      let mean = (shape[Math.floor(q / 4)] / max) * peakContacts * f;
      if (s.lowVolume) mean = rnd() < 0.35 ? 0 : mean * 0.5;          // intermittent
      const v = Math.max(0, Math.round(mean + Math.sqrt(mean + 1) * (rnd() * 2 - 1)));
      rows.push(`${queue},${day},${String(Math.floor(q / 4)).padStart(2, '0')}:${String((q % 4) * 15).padStart(2, '0')},${v},${290 + Math.round(rnd() * 30)}`);
    }
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------- helpers
/** Everyone in a scenario group. GET /workforce/employees stops at 2,000 rows (DEF-29), so page through it by employee-number prefix (1,000 each). */
async function groupEmployees(tok, s) { const out = []; for (let k = 0; k * 1000 <= s.size; k++) out.push(...(await call(tok, 'GET', `/workforce/employees?q=${s.key}-0${k}`, undefined, { timeoutMs: 300_000 }))); return out; }
const groupName = (s) => `SCALE ${s.key} ${s.name}`;
async function groupsByName(tok) { return Object.fromEntries(((await call(tok, 'GET', '/config/groups')) ?? []).map((g) => [g.name, g])); }
const listOf = (x) => (Array.isArray(x) ? x : Object.values(x).filter((v) => typeof v === 'object' && v && !Array.isArray(v) ? false : Array.isArray(v)).flat());

async function setupGroup(tok, s) {
  const t0 = Date.now();
  let g = (await groupsByName(tok))[groupName(s)];
  const step = {};
  if (!g) {
    let siteId;
    if (s.site) {
      const sites = await call(tok, 'GET', '/config/sites');
      siteId = (Array.isArray(sites) ? sites : sites.sites ?? []).find((x) => x.name === 'SCALE London')?.id ?? (await call(tok, 'POST', '/config/sites', { name: 'SCALE London', timezone: 'Europe/London', country: 'United Kingdom' })).id;
    }
    g = await call(tok, 'POST', '/config/groups', { name: groupName(s), timezone: s.tz, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 85, model: s.model, ...(siteId ? { siteId } : {}) });
  }
  // skills
  let skillIds = {};
  if (s.skills) {
    const all = await call(tok, 'GET', '/workforce/skills');
    for (const nm of ['SCALE English', 'SCALE Spanish']) skillIds[nm] = (all.find((k) => k.name === nm) ?? await call(tok, 'POST', '/workforce/skills', { name: nm, category: 'LANGUAGES' })).id;
  }
  // queues + history
  const qs = (await call(tok, 'GET', '/config/queues')).filter((q) => q.wfmGroupId === g.id);
  const wantQueues = s.skills ? [['EN', 0.65, 'SCALE English'], ['ES', 0.35, 'SCALE Spanish']] : [['Main', 1, null]];
  for (const [suffix, share, skill] of wantQueues) {
    const qname = `SCALE ${s.key} ${suffix}`;
    if (qs.some((q) => q.name === qname)) continue;
    await call(tok, 'POST', '/config/queues', { name: qname, channel: s.channel, wfmGroupId: g.id, ahtDefault: 300, ...(s.channel === 'CHAT' ? { concurrency: 3 } : {}), ...(s.channel === 'EMAIL' ? { turnaroundHours: 24 } : {}), ...(skill ? { skillId: skillIds[skill] } : {}) });
    const t1 = Date.now();
    const csv = history(s, qname, s.size * s.demand * share, 7 + s.key.charCodeAt(2) * 31 + suffix.length);
    const up = await call(tok, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: `${qname}.csv`, csv });
    const c = await call(tok, 'POST', `/data/imports/${up.id}/commit`);
    step[`history_${suffix}`] = { rows: csv.split('\n').length - 1, kb: Math.round(csv.length / 1024), status: c.status ?? up.status, ms: Date.now() - t1 };
  }
  if (s.skills) await call(tok, 'PUT', `/config/groups/${g.id}/skills`, { skills: [{ skillId: skillIds['SCALE English'], minProficiency: 1 }] }).catch((e) => (step.groupSkills = e.message));
  // team + templates
  const teamName = `SCALE ${s.key} team`;
  if (!(await call(tok, 'GET', '/workforce/teams')).some((t) => t.name === teamName)) await call(tok, 'POST', '/workforce/teams', { name: teamName });
  const tpls = await call(tok, 'GET', '/scheduling/templates');
  for (const [nm, days, a, b, extra] of s.templates) {
    const tname = `SCALE ${s.key} ${nm}`;
    if (tpls.some((t) => t.name === tname)) continue;
    await call(tok, 'POST', '/scheduling/templates', { name: tname, workDays: days, earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, groupIds: [g.id], ...(extra ?? {}) });
  }
  // employees (CSV import, in chunks well under the 5 MB limit)
  const have = await groupEmployees(tok, s);
  step.employeesBefore = have.length;
  if (have.length < s.size) {
    const head = 'employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,max_weekly_hours,days_per_week,hire_date,skills';
    const rows = [];
    for (let i = have.length + 1; i <= s.size; i++) {
      const pt = s.partTime && i % 2 === 0;
      const sk = s.skills ? (i % 5 === 0 ? 'SCALE Spanish:4' : i % 5 === 1 ? 'SCALE English:4;SCALE Spanish:3' : 'SCALE English:4') : '';
      rows.push(`${s.key}-${String(i).padStart(5, '0')},Emp${i},${s.key}x${i},${teamName},${groupName(s)},${pt ? 'PART_TIME' : 'FULL_TIME'},${pt ? 20 : 40},${pt ? 24 : 48},${pt ? 4 : 5},20${10 + (i % 15)}-0${1 + (i % 9)}-15,${sk}`);
    }
    const imports = [];
    for (let i = 0; i < rows.length; i += 10000) {
      const csv = [head, ...rows.slice(i, i + 10000)].join('\n');
      const t1 = Date.now();
      const r = await call(tok, 'POST', '/workforce/employees/import', { csv, dryRun: false, stopOnError: false }, { timeoutMs: 600_000, tries: 1 });
      imports.push({ rows: Math.min(10000, rows.length - i), kb: Math.round(csv.length / 1024), ms: Date.now() - t1, committed: r.committed, errorCount: r.errorCount, firstError: r.errors?.[0]?.message });
    }
    step.imports = imports;
  }
  const capped = await call(tok, 'GET', `/workforce/employees?groupId=${g.id}`, undefined, { timeoutMs: 600_000 });
  step.listGroupReturned = capped.length; step.listMs = capped.__ms; step.listKb = Math.round(capped.__bytes / 1024);
  const emps = await groupEmployees(tok, s); step.employees = emps.length;
  const ids = emps.map((e) => e.id);
  // bulk edit skips anyone outside the first 2,000 (DEF-30), so change people one by one, 8 at a time
  const bulk = async (subset, changes) => { let ok = 0, err = 0; for (let i = 0; i < subset.length; i += 8) { await Promise.all(subset.slice(i, i + 8).map((id) => call(tok, 'PUT', `/workforce/employees/${id}`, changes).then(() => ok++, () => err++))); } return { ok, err }; };
  if (s.nights) { const t1 = Date.now(); step.nightUpdate = await bulk(ids.filter((_, i) => i % 3 !== 0), { allowOvernight: true, nightShiftConsent: true }); step.nightsMs = Date.now() - t1; step.nightConsent = ids.filter((_, i) => i % 3 !== 0).length; }
  if (s.noWeekend) { const sub = ids.filter((_, i) => i % 10 < s.noWeekend * 10); step.noWeekendUpdate = await bulk(sub, { allowWeekend: false }); step.noWeekend = sub.length; }
  if (s.timeOff && !step.timeOffDone) {
    const sub = emps.filter((_, i) => i % 10 === 0); let ok = 0, err = 0; const t1 = Date.now();
    const existing = await call(tok, 'GET', '/workforce/time-off');
    const already = new Set((Array.isArray(existing) ? existing : existing.requests ?? []).filter((r) => r.reason === 'QA scale leave').map((r) => r.employeeId));
    for (const e of sub) {
      if (already.has(e.id)) { ok++; continue; }
      await call(tok, 'POST', '/workforce/time-off', { employeeId: e.id, type: 'VACATION', startDate: addDays(WEEK_FROM, 1), endDate: addDays(WEEK_FROM, 3), reason: 'QA scale leave', approve: true }).then(() => ok++, () => err++);
    }
    step.timeOff = { people: sub.length, ok, err, ms: Date.now() - t1 };
  }
  if (s.avail) {
    const sub = emps.filter((_, i) => i % 10 === 5); let ok = 0, err = 0, firstErr; const t1 = Date.now();
    for (const e of sub) await call(tok, 'PUT', `/employees/${e.id}/availability`.replace(/^/, '/workforce'), { windows: [0, 1, 2, 3, 4].map((d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '12:00', kind: 'UNAVAILABLE' })) }).then(() => ok++, (x) => { err++; firstErr ??= x.message; });
    step.availability = { people: sub.length, ok, err, firstErr, ms: Date.now() - t1 };
  }
  log({ phase: 'setup', key: s.key, groupId: g.id, size: s.size, ms: Date.now() - t0, ...step });
  return g;
}

// ---------------------------------------------------------------- forecasting
async function forecastGroup(tok, s, g) {
  const out = { phase: 'forecast', key: s.key, model: s.model };
  const vers = (await call(tok, 'GET', `/forecast/versions?groupId=${g.id}`));
  let pub = vers.find((v) => v.status === 'PUBLISHED' && v.kind !== 'LONG' && v.name?.startsWith('SCALE'));
  if (!pub) {
    const t0 = Date.now();
    const f = await call(tok, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: s.longPlan ? 6 : 2, fromDay: WEEK_FROM, model: s.model, name: `SCALE ${s.key} short ${s.model}` }, { timeoutMs: 600_000, tries: 1 });
    out.createMs = Date.now() - t0;
    out.summary = f.summary ? JSON.stringify(f.summary).slice(0, 600) : null;
    if (s.adjust) {
      const a = await call(tok, 'PATCH', `/forecast/versions/${f.id}/adjustments`, { mode: 'pct', value: s.adjust, from: WEEK_FROM, to: addDays(WEEK_FROM, 6), reason: 'QA scale: campaign launch week' }).catch((e) => ({ error: e.message }));
      out.adjust = a.error ?? 'applied';
    }
    for (const st of ['submit', 'approve', 'publish']) await call(tok, 'POST', `/forecast/versions/${f.id}/${st}`, {});
    pub = f;
  }
  out.versionId = pub.id;
  if (s.longPlan && !vers.some((v) => v.kind === 'LONG' && v.status === 'PUBLISHED')) {
    const t0 = Date.now();
    const lf = await call(tok, 'POST', '/forecast/versions', { groupId: g.id, kind: 'LONG', days: 365, name: `SCALE ${s.key} long 365d` }, { timeoutMs: 600_000, tries: 1 }).catch((e) => ({ error: e.message }));
    out.longMs = Date.now() - t0; out.long = lf.error ?? 'created';
    if (!lf.error) for (const st of ['submit', 'approve', 'publish']) await call(tok, 'POST', `/forecast/versions/${lf.id}/${st}`, {}).catch((e) => (out.long = e.message));
  }
  // what the forecasting screens ask for, at this group size
  for (const [k, p] of [['dashboard', `/forecast/versions/${pub.id}`], ['leaderboard', `/forecast/versions/${pub.id}/leaderboard`], ['scenarios', `/forecast/versions/${pub.id}/scenarios`], ['accuracy', `/forecast/accuracy?groupId=${g.id}`], ['historyQuality', `/forecast/history-quality?groupId=${g.id}`]]) {
    const t0 = Date.now();
    const r = await call(tok, 'GET', p, undefined, { timeoutMs: 180_000, tries: 1 }).then((x) => ({ ok: true, kb: Math.round(x.__bytes / 1024) }), (e) => ({ ok: false, err: e.message.slice(0, 160) }));
    out[k] = { ms: Date.now() - t0, ...r };
  }
  log(out);
}

// ---------------------------------------------------------------- scheduling
async function templatesFor(tok, s) { return (await call(tok, 'GET', '/scheduling/templates')).filter((t) => t.name.startsWith(`SCALE ${s.key} `) && !t.name.includes('Boundary')).map((t) => t.id); }

async function boundaryCheck(tok, s, g) {
  const tname = `SCALE ${s.key} Boundary every start`;
  let t = (await call(tok, 'GET', '/scheduling/templates')).find((x) => x.name === tname);
  if (!t) t = await call(tok, 'POST', '/scheduling/templates', { name: tname, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '00:00', latestStart: '23:45', startStepMinutes: 15, minDurationHours: 4, durationHours: 12, lengthStepMinutes: 15, mealMinutes: 30, breakCount: 2, breakMinutes: 15, groupIds: [g.id] });
  const t0 = Date.now();
  const r = await call(tok, 'POST', '/scheduling/versions', { groupId: g.id, from: WEEK_FROM, weeks: 1, timeLimitSec: 30, templateIds: [t.id], useHistory: false, name: 'SCALE boundary' }, { timeoutMs: 600_000, tries: 1 })
    .then((v) => ({ status: 201, version: v.id, stats: v.stats?.solver }), (e) => ({ status: e.status, message: e.message.slice(0, 300) }));
  await call(tok, 'PUT', `/scheduling/templates/${t.id}`, { name: tname, workDays: [0], earliestStart: '00:00', latestStart: '00:00', durationHours: 8, status: 'INACTIVE' }).catch(() => {});
  log({ phase: 'boundary', key: s.key, ms: Date.now() - t0, ...r, healthAfter: await fetch(`${BASE}/health`).then((x) => x.json()).catch((e) => e.message) });
}

async function rotationSetup(tok, s, g) {
  const tpl = (await templatesFor(tok, s))[0];
  const pats = await call(tok, 'GET', '/scheduling/rotations');
  let pat = (Array.isArray(pats) ? pats : pats.patterns ?? []).find((p) => p.name === 'SCALE 4on4off');
  const out = { phase: 'rotation', key: s.key };
  if (!pat) pat = await call(tok, 'POST', '/scheduling/rotations', { wfmGroupId: g.id, name: 'SCALE 4on4off', cycleDays: 8, sequence: [tpl, tpl, tpl, tpl, null, null, null, null], crews: [{ name: 'A', offsetDays: 0 }, { name: 'B', offsetDays: 4 }], anchorDate: WEEK_FROM, kind: 'DAY_CYCLE' }).catch((e) => ({ error: e.message }));
  if (pat.error) { log({ ...out, error: pat.error }); return; }
  const emps = await groupEmployees(tok, s);
  const t0 = Date.now();
  const m = await call(tok, 'PUT', `/scheduling/rotations/${pat.id}/members`, { members: emps.slice(0, 2000).map((e, i) => ({ employeeId: e.id, crewName: i % 2 ? 'B' : 'A' })) }).catch((e) => ({ error: e.message }));
  out.membersMs = Date.now() - t0; out.members = m.error ?? emps.length;
  const t1 = Date.now();
  const mat = await call(tok, 'POST', `/scheduling/rotations/${pat.id}/materialize`, { through: addDays(WEEK_FROM, 27) }, { timeoutMs: 600_000, tries: 1 }).catch((e) => ({ error: e.message }));
  out.materializeMs = Date.now() - t1; out.materialize = mat.error ?? JSON.stringify(mat).slice(0, 300);
  log(out);
}

async function scheduleAll(tok, groups) {
  const jobs = [];
  const probe = { samples: 0, failures: 0, worstHealthMs: 0, worstGroupsMs: 0, slowOver2s: 0 };
  const timer = setInterval(async () => {
    const a = Date.now();
    try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(30000) }); if (!r.ok) probe.failures++; } catch { probe.failures++; }
    const b = Date.now(); probe.worstHealthMs = Math.max(probe.worstHealthMs, b - a);
    try { await call(tok, 'GET', '/config/groups', undefined, { tries: 1, timeoutMs: 30000 }); } catch { probe.failures++; }
    const c = Date.now() - b; probe.worstGroupsMs = Math.max(probe.worstGroupsMs, c); if (c > 2000) probe.slowOver2s++; probe.samples++;
  }, 3000);
  for (const s of SCENARIOS.filter((x) => !ONLY || ONLY.includes(x.key))) {
    const g = groups[s.key];
    if (s.rotation) { await rotationSetup(tok, s, g); }
    if (s.boundary) await boundaryCheck(tok, s, g);
    const existing = (await call(tok, 'GET', `/scheduling/versions?groupId=${g.id}`)).find((v) => v.name?.startsWith(`SCALE ${s.key} schedule`));
    if (existing) { jobs.push({ s, g, done: true, versionId: existing.id, skipped: true }); continue; }
    const body = { groupId: g.id, from: WEEK_FROM, weeks: s.longPlan ? 13 : 1, windowWeeks: s.longPlan ? 4 : 1, solveWeeks: s.longPlan ? 4 : 1, timeLimitSec: Number(process.env.QA_TIME_LIMIT ?? 90), templateIds: await templatesFor(tok, s), useHistory: false, name: `SCALE ${s.key} schedule` };
    const t0 = Date.now();
    const j = await call(tok, 'POST', '/scheduling/jobs', body).catch((e) => ({ error: e.message }));
    jobs.push({ s, g, job: j, t0, error: j.error });
    if (j.error) log({ phase: 'schedule', key: s.key, status: 'REFUSED', error: j.error });
  }
  // wait for all
  const deadline = Date.now() + 4 * 3600_000;
  while (jobs.some((x) => !x.done && !x.error) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    for (const x of jobs.filter((y) => !y.done && !y.error)) {
      const j = await call(tok, 'GET', `/scheduling/jobs/${x.job.id}`).catch(() => null);
      const job = j?.job ?? j; if (!job) continue;
      x.last = job;
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) {
        x.done = true; x.wallSec = Math.round((Date.now() - x.t0) / 1000);
        const row = { phase: 'schedule', key: x.s.key, people: x.s.size, status: job.status, wallSec: x.wallSec, error: job.error ?? undefined, progress: job.progress };
        if (job.versionId) {
          const v = await call(tok, 'GET', `/scheduling/versions/${job.versionId}`).catch((e) => ({ error: e.message }));
          const st = v.stats ?? {};
          Object.assign(row, { versionId: job.versionId, solver: st.solver?.status, backend: st.solver?.backend, parts: st.solver?.parts ?? st.solver?.partitions, candidates: st.solver?.candidates, thinned: st.solver?.thinned, shifts: st.shifts, peopleUsed: st.people, coveragePercent: st.coverage?.percent, violations: st.violations ?? st.ruleViolations, statsRaw: JSON.stringify(st).slice(0, 900) });
        }
        log(row);
      }
    }
  }
  clearInterval(timer);
  for (const x of jobs.filter((y) => !y.done && !y.error)) log({ phase: 'schedule', key: x.s.key, status: 'TIMEOUT_4H', progress: x.last?.progress });
  log({ phase: 'probe-during-scheduling', ...probe });
}

// ---------------------------------------------------------------- main
const tok = (await call(null, 'POST', '/auth/login', { username: process.env.QA_ADMIN_USER ?? 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: process.env.QA_TENANT ?? 'ORG' })).token;
log({ phase: 'start', run: PHASE, total: TOTAL, groups: SCENARIOS.length, health: await fetch(`${BASE}/health`).then((r) => r.json()) });
const groups = {};
for (const s of SCENARIOS.filter((x) => !ONLY || ONLY.includes(x.key))) {
  if (PHASE === 'setup' || PHASE === 'all') groups[s.key] = await setupGroup(tok, s).catch((e) => { log({ phase: 'setup', key: s.key, error: e.message }); return null; });
  else groups[s.key] = (await groupsByName(tok))[groupName(s)];
}
if (PHASE === 'forecast' || PHASE === 'all') for (const s of SCENARIOS.filter((x) => (!ONLY || ONLY.includes(x.key)) && groups[x.key])) await forecastGroup(tok, s, groups[s.key]).catch((e) => log({ phase: 'forecast', key: s.key, error: e.message }));
if (PHASE === 'schedule' || PHASE === 'all') await scheduleAll(tok, groups);
log({ phase: 'end', run: PHASE });
