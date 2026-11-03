/**
 * Every range Generate Schedule offers (1, 2, 4, 13, 26 and 52 weeks) builds successfully, covers every week, breaks no rule, and does not take longer than the
 * solver time it was given plus a fixed overhead per window. (Before: each solve loaded the solver libraries again, about 5 s each, and a model that
 * CP-SAT could not finish went on to HiGHS and SCIP, which used time and added nothing.)
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/scheduleEveryRange.test.ts   (needs the engine running)
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addIso = (s: string, n: number) => iso(addDays(new Date(`${s}T00:00:00`), n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function historyCsv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`);
    }
  }
  return rows.join('\n');
}

async function waitJob(admin: string, id: string, until: string[], maxMs = 8 * 60_000) {
  const t0 = Date.now(); let last: any = null; const seen: number[] = [];
  while (Date.now() - t0 < maxMs) {
    const r = await call(admin, 'GET', `/scheduling/jobs/${id}`);
    assert.equal(r.status, 200, r.text);
    last = r.json; seen.push(last.progress?.done ?? 0);
    if (until.includes(last.status)) return { job: last, seen };
    await sleep(1500);
  }
  assert.fail(`job did not reach ${until.join('/')} in time: ${JSON.stringify(last)}`);
}

const PEOPLE = 16, LIMIT = 6;
const SETUP_OVERHEAD_SEC = 12;                    // per build: preparing candidates, the rule check and saving, for 16 people
describe('every schedule range builds', { skip: !PASSWORD }, () => {
  let admin = '', group: any, from = '', tplId = '';
  const tag = `R${RUN}`;
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
    const g = await call(admin, 'POST', '/config/groups', { name: `Range ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); group = g.json;
    const queue = `Range Voice ${tag}`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: group.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 70) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    for (const body of [{ kind: 'SHORT', weeks: 18, fromDay: from }, { kind: 'LONG', days: 400, fromDay: from }]) {
      const f = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, ...body });
      assert.equal(f.status, 201, f.text);
      for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
    }
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Range team ${tag}` })).status, 201);
    const tpl = await call(admin, 'POST', '/scheduling/templates', { name: `Range tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    assert.equal(tpl.status, 201, tpl.text); tplId = tpl.json.id;
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= PEOPLE; i++) lines.push(`RG${tag}-${i},Agent${i},Range${i},Range team ${tag},Range ${tag},FULL_TIME,40,5`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join(String.fromCharCode(10)), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
  });

  for (const weeks of [1, 2, 4, 13, 26, 52]) {
    it(`${weeks} week${weeks > 1 ? 's' : ''}`, async () => {
      const t0 = Date.now();
      let versionId = '';
      const solved = Math.min(weeks, 13), windows = Math.ceil(solved / 4);
      if (weeks <= 4) {
        const r = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks, timeLimitSec: LIMIT });
        assert.equal(r.status, 201, r.text); versionId = r.json.id;
      } else {
        const j = await call(admin, 'POST', '/scheduling/jobs', { groupId: group.id, templateIds: [tplId], from, weeks, windowWeeks: 4, timeLimitSec: LIMIT, name: `range ${weeks} ${tag}` });
        assert.equal(j.status, 202, j.text);
        const { job } = await waitJob(admin, j.json.id, ['DONE', 'FAILED', 'CANCELLED'], 10 * 60_000);
        assert.equal(job.status, 'DONE', JSON.stringify(job.error ?? job.progress));
        versionId = job.versionId;
      }
      const sec = (Date.now() - t0) / 1000;
      const v = (await call(admin, 'GET', `/scheduling/versions/${versionId}`)).json;
      assert.equal(v.stats.violations, 0, 'no rule is broken');
      assert.equal(v.stats.shifts, PEOPLE * 5 * weeks, `every one of the ${weeks} weeks has its shifts (16 people x 5 days)`);
      const days = new Set(((await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts?from=${from}&to=${addIso(from, weeks * 7 - 1)}`)).json as any[]).map((s) => s.day));
      assert.equal(days.size, weeks * 7, 'a shift on every day of the range');
      // the allowance is per window, so the build may take that many windows of solver time, plus overhead for each; it must not take much more
      const budget = windows * (LIMIT + SETUP_OVERHEAD_SEC) + SETUP_OVERHEAD_SEC;
      assert.ok(sec < budget, `${weeks} weeks took ${sec.toFixed(0)} s; allowed ${budget} s (${windows} window${windows > 1 ? 's' : ''} x ${LIMIT} s + overhead)`);
      await call(admin, 'DELETE', `/scheduling/versions/${versionId}`);
    });
  }
});
