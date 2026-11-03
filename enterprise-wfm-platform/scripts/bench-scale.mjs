/**
 * Scale benchmark through the real pipeline (gateway -> candidate building -> engine), not the engine alone: how long a group of N people takes to schedule,
 * how much of the forecast it covers, which solver answered, and how much the gateway had to thin the choices.
 *
 *   node scripts/bench-scale.mjs --base http://localhost:4012 --password '...' --sizes 500,1000,2000 --weeks 1 --limit 60
 *
 * Needs a gateway + engine running against a throwaway database. Each size gets its own WFM group, history, forecast and people.
 */
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:4000'), PASSWORD = arg('password', ''), TENANT = arg('tenant', 'ORG');
const SIZES = arg('sizes', '500,1000').split(',').map(Number), WEEKS = Number(arg('weeks', '1')), LIMIT = Number(arg('limit', '60'));
const RUN = Date.now().toString(36);

async function call(token, method, path, body, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await call1(token, method, path, body); }
    catch (e) { if (i >= tries || !/fetch failed|ECONN|socket|terminated/i.test(String(e.message))) throw e; await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
}
async function call1(token, method, path, body) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return json;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const CURVE = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];

function history(queue, scale) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = 70; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.45 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (CURVE[Math.floor(s / 4)] * f * scale) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`);
    }
  }
  return rows.join('\n');
}

const login = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
const admin = login.token;
const start = new Date(); start.setHours(0, 0, 0, 0);
const from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
const out = [];

for (const n of SIZES) {
  const tag = `${n}-${RUN}`, t0 = Date.now();
  process.stderr.write(`\n== ${n} people ==\n`);
  try {
    const g = await call(admin, 'POST', '/config/groups', { name: `Bench ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    const queue = `Bench voice ${tag}`;
    await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 });
    // demand sized like the 16-person test group (about half the crew is needed at the busiest hour), scaled to n people
    const scale = 0.5 * n / 16;
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: history(queue, scale) });
    await call(admin, 'POST', `/data/imports/${up.id}/commit`);
    const sf = await call(admin, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: Math.min(18, Math.max(WEEKS, 1)), fromDay: from });
    for (const s of ['submit', 'approve', 'publish']) await call(admin, 'POST', `/forecast/versions/${sf.id}/${s}`, {});
    for (const [nm, a, b] of [['Early', '06:00', '08:00'], ['Day', '08:30', '10:30'], ['Late', '11:30', '13:30']]) {
      await call(admin, 'POST', '/scheduling/templates', { name: `${nm} ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    }
    for (let t = 0; t < Math.ceil(n / 100); t++) await call(admin, 'POST', '/workforce/teams', { name: `Bench team ${tag} ${t}` });
    const header = 'employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week';
    // the import takes at most 5 MB a file, so a big group goes in several files; people are spread over teams of about 100, as a real centre is
    for (let from0 = 1; from0 <= n; from0 += 8000) {
      const lines = [header];
      for (let i = from0; i <= Math.min(n, from0 + 7999); i++) lines.push(`B${tag}-${i},Agent${i},Bench${i},Bench team ${tag} ${Math.floor((i - 1) / 100)},Bench ${tag},FULL_TIME,40,5`);
      const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join(String.fromCharCode(10)), dryRun: false });
      if (!imp.committed) throw new Error('employee import did not commit');
    }
    const tpls = (await call(admin, 'GET', '/scheduling/templates')).filter((t) => t.name.endsWith(tag)).map((t) => t.id);
    const setup = (Date.now() - t0) / 1000;
    const t1 = Date.now();
    const job = await call(admin, 'POST', '/scheduling/jobs', { groupId: g.id, from, weeks: WEEKS, windowWeeks: 4, solveWeeks: Number(arg('solve', String(WEEKS))), timeLimitSec: LIMIT, solver: arg('solver', 'AUTO'), templateIds: tpls, useHistory: false, name: `bench ${tag}` });
    let j = job, peakNote = '', worst = 0, failures = 0;
    const probe = setInterval(async () => { const t = Date.now(); try { const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) failures++; } catch { failures++; } worst = Math.max(worst, Date.now() - t); }, 500);
    while (!['DONE', 'FAILED', 'CANCELLED'].includes(j.status)) { await new Promise((r) => setTimeout(r, 2000)); j = await call(admin, 'GET', `/scheduling/jobs/${job.id}`); peakNote = j.progress?.note ?? peakNote; }
    clearInterval(probe);
    const wall = (Date.now() - t1) / 1000;
    if (j.status !== 'DONE') { out.push({ people: n, weeks: WEEKS, status: j.status, error: j.error, wallSec: Math.round(wall) }); process.stderr.write(`  ${j.status}: ${j.error}\n`); continue; }
    const v = await call(admin, 'GET', `/scheduling/versions/${j.versionId}`);
    const s = v.stats;
    out.push({ people: n, weeks: WEEKS, status: s.solver?.status, backend: s.solver?.backend, wallSec: Math.round(wall), solverSec: s.solver?.wallSec, candidates: s.solver?.candidates, shifts: s.shifts, peopleUsed: s.people, coveragePercent: s.coverage.percent, violations: s.violations, thinned: !!v.settings?.report?.thinNote, setupSec: Math.round(setup), slowestApiAnswerMs: worst, apiFailuresWhileBuilding: failures });
    process.stderr.write(`  ${JSON.stringify(out.at(-1))}\n`);
  } catch (e) { out.push({ people: n, weeks: WEEKS, status: 'ERROR', error: String(e.message).slice(0, 300) }); process.stderr.write(`  ERROR ${e.message}\n`); }
}
console.log(JSON.stringify(out, null, 2));
