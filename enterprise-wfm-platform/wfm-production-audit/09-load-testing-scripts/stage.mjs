// One audit stage against the server, driven only through the app's REST API.
//   node stage.mjs <runDir> <steps>      steps: setup,employees,history,forecast,schedule  (comma list, or "all")
// Env: QA_API (http://192.168.9.186:3000), TOKEN_FILE (session token of the TEST org admin), EXPECT_TENANT (test org id),
//      HORIZONS (default 1,4,13,26,52), TIME_LIMIT (solver seconds per window, default 60), FROM (first schedule day, a Monday)
// Every request first checks that the token belongs to EXPECT_TENANT; anything else aborts before a single write.
// Results: <runDir>/results.jsonl (one line per step) and <runDir>/created.json (ids the app returned, for cleanup).
import fs from 'node:fs';
import path from 'node:path';

const [runDir, stepsArg = 'all'] = process.argv.slice(2);
const BASE = process.env.QA_API ?? 'http://192.168.9.186:3000';
const EXPECT = process.env.EXPECT_TENANT;
// Sign in with the test org's admin from env (QA_USER / QA_PASSWORD / QA_TENANT, set by the person running this), or read a token file.
const TOKEN = process.env.TOKEN_FILE ? fs.readFileSync(process.env.TOKEN_FILE, 'utf8').trim() : await (async () => {
  if (!process.env.QA_PASSWORD || !process.env.QA_TENANT) { console.error('Set QA_TENANT, QA_USER and QA_PASSWORD (or TOKEN_FILE).'); process.exit(2); }
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: process.env.QA_TENANT, username: process.env.QA_USER ?? 'admin', password: process.env.QA_PASSWORD }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) { console.error(`Sign-in failed: ${r.status} ${j?.error?.code ?? ''}`); process.exit(2); }
  return j.token;
})();
const FROM = process.env.FROM ?? '2026-11-16';
const HORIZONS = (process.env.HORIZONS ?? '1,4,13,26,52').split(',').map(Number);
const TIME_LIMIT = Number(process.env.TIME_LIMIT ?? 60);
const steps = stepsArg === 'all' ? ['setup', 'employees', 'history', 'forecast', 'schedule'] : stepsArg.split(',');
const setup = JSON.parse(fs.readFileSync(path.join(runDir, 'setup.json'), 'utf8'));
const RUN = setup.tag.TEST_RUN_ID;
const createdFile = path.join(runDir, 'created.json');
const created = fs.existsSync(createdFile) ? JSON.parse(fs.readFileSync(createdFile, 'utf8')) : { tenantId: EXPECT, items: [] };
const keep = (kind, id, name) => { created.items.push({ kind, id, name, at: new Date().toISOString() }); fs.writeFileSync(createdFile, JSON.stringify(created, null, 1)); };
const log = (o) => { const line = JSON.stringify({ at: new Date().toISOString(), run: RUN, ...o }); fs.appendFileSync(path.join(runDir, 'results.jsonl'), line + '\n'); console.log(line.slice(0, 400)); };

const claims = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString());
if (!EXPECT || claims.tid !== EXPECT) { console.error(`ABORT: token tenant ${claims.tid} is not the expected test tenant ${EXPECT}`); process.exit(2); }

async function call(method, p, body, { timeoutMs = 300_000 } = {}) {
  if (claims.tid !== EXPECT) throw new Error('tenant guard');
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/v1${p}`, { method, signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) { const e = new Error(`${method} ${p} -> ${r.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? text.slice(0, 300)}`); e.status = r.status; e.ms = ms; e.body = json; throw e; }
  return { data: json, ms, bytes: text.length, total: r.headers.get('x-total-count') };
}
const list = (d) => (Array.isArray(d) ? d : d?.items ?? d?.sites ?? d?.rows ?? []);

// the server must agree on who we are before anything is written
const me = (await call('GET', '/auth/me')).data;
if (me.user?.tenantId !== EXPECT) { console.error('ABORT: /auth/me tenant mismatch'); process.exit(2); }
log({ step: 'guard', tenant: me.user.tenantName, user: me.user.username, role: me.user.role });

const CH = { VOICE: { aht: 300 }, CHAT: { aht: 540, concurrency: 2 }, EMAIL: { aht: 420, turnaroundHours: 24 }, BACKOFFICE: { aht: 900, turnaroundHours: 48 } };
const OPEN = { VOICE: ['07:00', '13:00'], CHAT: ['08:00', '14:00'], EMAIL: ['06:00', '14:00'], BACKOFFICE: ['08:00', '09:30'] };
const byName = (arr) => Object.fromEntries(arr.map((x) => [x.name, x]));

async function groupsMap() { return byName(list((await call('GET', '/config/groups')).data)); }

if (steps.includes('setup')) {
  const t0 = Date.now(); const out = { step: 'setup' };
  const sites = byName(list((await call('GET', '/config/sites')).data));
  const siteIds = {};
  for (const g of setup.groups) {
    if (!sites[g.site] && !siteIds[g.site]) { const s = (await call('POST', '/config/sites', { name: g.site, timezone: g.tz, country: 'India' })).data; keep('site', s.id, g.site); siteIds[g.site] = s.id; }
    siteIds[g.site] ??= sites[g.site]?.id;
  }
  const skills = byName((await call('GET', '/workforce/skills')).data);
  for (const sk of setup.skills) if (!skills[sk]) { const s = (await call('POST', '/workforce/skills', { name: sk, category: sk.includes('LANG') ? 'LANGUAGES' : 'CHANNELS' }).catch(async (e) => ({ data: (await call('POST', '/workforce/skills', { name: sk })).data, note: e.message }))).data; keep('skill', s.id, sk); }
  const groups = await groupsMap();
  for (const g of setup.groups) {
    let grp = groups[g.name];
    if (!grp) { grp = (await call('POST', '/config/groups', { name: g.name, timezone: g.tz, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 85, siteId: siteIds[g.site] })).data; keep('group', grp.id, g.name); }
    const qs = list((await call('GET', '/config/queues')).data).filter((q) => q.wfmGroupId === grp.id);
    if (!qs.some((q) => q.name === g.queue)) { const c = CH[g.channel]; const q = (await call('POST', '/config/queues', { name: g.queue, channel: g.channel === 'BACKOFFICE' ? 'BACKOFFICE' : g.channel, wfmGroupId: grp.id, ahtDefault: c.aht, ...(c.concurrency ? { concurrency: c.concurrency } : {}), ...(c.turnaroundHours ? { turnaroundHours: c.turnaroundHours } : {}) })).data; keep('queue', q.id, g.queue); }
    const tname = `${g.name} Flex`;
    const tpls = list((await call('GET', '/scheduling/templates')).data);
    if (!tpls.some((t) => t.name === tname)) {
      const [a, b] = OPEN[g.channel];
      const t = (await call('POST', '/scheduling/templates', { name: tname, workDays: g.channel === 'BACKOFFICE' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, minDurationHours: 4, durationHours: 9, lengthStepMinutes: 60, mealMinutes: 30, breakCount: 2, breakMinutes: 15, groupIds: [grp.id] })).data;
      keep('template', t.id, tname);
    }
  }
  const teams = byName((await call('GET', '/workforce/teams')).data);
  for (const t of setup.teams) if (!teams[t.name]) { const r = (await call('POST', '/workforce/teams', { name: t.name })).data; keep('team', r.id, t.name); }
  log({ ...out, ms: Date.now() - t0, groups: setup.groups.length, teams: setup.teams.length, skills: setup.skills.length });
}

if (steps.includes('employees')) {
  const csvAll = fs.readFileSync(path.join(runDir, 'employees.csv'), 'utf8').trim().split(/\r?\n/);
  const head = csvAll[0], rows = csvAll.slice(1);
  const CHUNK = Number(process.env.EMP_CHUNK ?? 10000);
  for (const dryRun of [true, false]) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const csv = [head, ...rows.slice(i, i + CHUNK)].join('\n');
      const t0 = Date.now();
      const r = await call('POST', '/workforce/employees/import', { csv, dryRun, stopOnError: false }, { timeoutMs: 900_000 }).catch((e) => ({ error: e.message, body: e.body }));
      const d = r.data ?? {};
      log({ step: dryRun ? 'employees-dryrun' : 'employees-commit', chunk: i / CHUNK, rows: Math.min(CHUNK, rows.length - i), kb: Math.round(csv.length / 1024), ms: Date.now() - t0, committed: d.committed, valid: d.valid ?? d.rowsOk, errorCount: d.errorCount, errors: (d.errors ?? []).slice(0, 5), error: r.error });
      if (dryRun && (r.error || d.errorCount)) { log({ step: 'employees', status: 'STOPPED_AFTER_DRYRUN' }); process.exit(1); }
    }
  }
  const prefix = await call('GET', `/workforce/employees?q=${encodeURIComponent(RUN + '-')}&limit=1`);
  log({ step: 'employees-count', expected: rows.length, serverTotal: prefix.total, ms: prefix.ms });
}

if (steps.includes('history')) {
  for (const g of setup.groups) {
    const lines = fs.readFileSync(path.join(runDir, `history_${g.queue}.csv`), 'utf8').trim().split(/\r?\n/).map((l) => l.split(','));
    // send only the columns the importer maps (queue, date, interval, offered -> volume, abandoned, aht); the full file stays local as truth
    const idx = ['queue', 'date', 'interval', 'offered', 'abandoned', 'aht'].map((c) => lines[0].indexOf(c));
    const csv = lines.map((r) => idx.map((i) => r[i]).join(',')).join('\n');
    const t0 = Date.now();
    const up = await call('POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: `${g.queue}.csv`, csv }, { timeoutMs: 600_000 });
    keep('import', up.data.id, g.queue);
    const c = await call('POST', `/data/imports/${up.data.id}/commit`, {}, { timeoutMs: 600_000 });
    log({ step: 'history', queue: g.queue, rows: lines.length - 1, kb: Math.round(csv.length / 1024), uploadMs: up.ms, commitMs: c.ms, ms: Date.now() - t0, status: c.data?.status ?? up.data?.status, staged: JSON.stringify(up.data).slice(0, 300) });
  }
}

if (steps.includes('forecast')) {
  const groups = await groupsMap();
  for (const g of setup.groups) {
    const grp = groups[g.name];
    for (const spec of [{ kind: 'SHORT', weeks: 4, fromDay: FROM, name: `${g.name} short 4w` }, { kind: 'LONG', days: 371, name: `${g.name} long 53w` }]) {
      const t0 = Date.now();
      const f = await call('POST', '/forecast/versions', { groupId: grp.id, ...spec }, { timeoutMs: 900_000 }).catch((e) => ({ error: e.message }));
      if (f.error) { log({ step: 'forecast', group: g.name, kind: spec.kind, error: f.error, ms: Date.now() - t0 }); continue; }
      keep('forecastVersion', f.data.id, spec.name);
      const lc = {};
      for (const st of ['submit', 'approve', 'publish']) lc[st] = await call('POST', `/forecast/versions/${f.data.id}/${st}`, {}).then((x) => x.ms, (e) => e.message);
      log({ step: 'forecast', group: g.name, kind: spec.kind, id: f.data.id, createMs: f.ms, lifecycle: lc, model: f.data.model ?? f.data.summary?.model, summary: JSON.stringify(f.data.summary ?? {}).slice(0, 500) });
    }
  }
}

if (steps.includes('schedule')) {
  const groups = await groupsMap();
  const tpls = list((await call('GET', '/scheduling/templates')).data);
  const probe = { samples: 0, failures: 0, worstMs: 0, over2s: 0 };
  const timer = setInterval(async () => {
    const a = Date.now();
    try { await call('GET', '/config/groups', undefined, { timeoutMs: 30_000 }); } catch { probe.failures++; }
    const ms = Date.now() - a; probe.samples++; probe.worstMs = Math.max(probe.worstMs, ms); if (ms > 2000) probe.over2s++;
  }, 5000);
  const variants = HORIZONS.flatMap((w) => [{ weeks: w, solveWeeks: Math.min(w, 13), tag: 'default' }, ...(w > 13 && process.env.FULL_SOLVE !== '0' ? [{ weeks: w, solveWeeks: w, tag: 'full-solve' }] : [])]);
  for (const g of setup.groups) {
    const grp = groups[g.name];
    const templateIds = tpls.filter((t) => t.name === `${g.name} Flex`).map((t) => t.id);
    for (const v of variants) {               // one at a time: the server's engine is shared with real users
      const name = `${g.name} ${v.weeks}w ${v.tag}`;
      const body = { groupId: grp.id, from: FROM, weeks: v.weeks, windowWeeks: Math.min(4, v.weeks), solveWeeks: v.solveWeeks, timeLimitSec: TIME_LIMIT, templateIds, useHistory: false, name };
      const t0 = Date.now();
      const j = await call('POST', '/scheduling/jobs', body).catch((e) => ({ error: e.message }));
      if (j.error) { log({ step: 'schedule', name, status: 'REFUSED', error: j.error }); continue; }
      const jobId = (j.data.job ?? j.data).id; keep('scheduleJob', jobId, name);
      let job;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const r = await call('GET', `/scheduling/jobs/${jobId}`).catch(() => null);
        job = r?.data?.job ?? r?.data; if (job && ['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) break;
        if (Date.now() - t0 > 3 * 3600_000) { log({ step: 'schedule', name, status: 'TIMEOUT_3H' }); break; }
      }
      const row = { step: 'schedule', name, weeks: v.weeks, solveWeeks: v.solveWeeks, status: job?.status, wallSec: Math.round((Date.now() - t0) / 1000), error: job?.error ?? undefined };
      const vid = job?.versionId ?? job?.result?.versionId;
      if (vid) {
        keep('scheduleVersion', vid, name);
        const ver = (await call('GET', `/scheduling/versions/${vid}`, undefined, { timeoutMs: 600_000 })).data;
        const st = ver.stats ?? {};
        Object.assign(row, { versionId: vid, solver: st.solver?.status, backend: st.solver?.backend, phasesSec: st.solver?.phasesSec, shifts: st.shifts ?? ver.shifts?.length, people: st.people, coverage: st.coverage, violations: st.violations ?? st.ruleViolations, stats: JSON.stringify(st).slice(0, 1500) });
      }
      log(row);
    }
  }
  clearInterval(timer);
  log({ step: 'probe-during-scheduling', ...probe });
}
