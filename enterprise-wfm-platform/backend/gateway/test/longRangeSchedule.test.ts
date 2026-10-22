/**
 * Long-range scheduling: when a requested schedule period reaches past the published short-term forecast, a
 * published long-term forecast's daily totals are projected onto intervals (using the queue's own historical
 * intraday shape) and staffed through the normal Erlang pipeline, so scheduling isn't capped at the short-term
 * forecast's ~18-week reach. Every day built this way is reported back as `projected`, lower confidence.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npm test
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

async function buildGroupWithForecast(admin: string, tag: string, opts: { long: boolean }) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const toMonday = (7 - ((start.getDay() + 6) % 7)) % 7;
  const from = iso(addDays(start, toMonday || 7)); // a Monday strictly in the future, clear of "today" partial-day edge cases

  const g = await call(admin, 'POST', '/config/groups', { name: `LR ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
  assert.equal(g.status, 201, g.text);
  const queueName = `LR Voice ${tag}`;
  assert.equal((await call(admin, 'POST', '/config/queues', { name: queueName, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
  const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queueName, 70) });
  assert.equal(up.status, 201, up.text);
  assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);

  // fromDay pinned to the schedule's own start date, so the short forecast's 7-day range lines up exactly
  // with the schedule's first requested week, and the long forecast's range covers the second week beyond it.
  const sf = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 1, fromDay: from });
  assert.equal(sf.status, 201, sf.text);
  for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${sf.json.id}/${step}`, {})).status, 200, step);

  let lf: any = null;
  if (opts.long) {
    const r = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'LONG', days: 60, fromDay: from });
    assert.equal(r.status, 201, r.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${r.json.id}/${step}`, {})).status, 200, step);
    lf = r.json;
  }

  const team = await call(admin, 'POST', '/workforce/teams', { name: `LR team ${tag}` });
  assert.equal(team.status, 201, team.text);
  const tplR = await call(admin, 'POST', '/scheduling/templates', { name: `LR tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 });
  assert.equal(tplR.status, 201, tplR.text);
  const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
  for (let i = 1; i <= 14; i++) lines.push(`LR${tag}-${i},Agent${i},Test${i},LR team ${tag},LR ${tag},FULL_TIME,40,5`);
  const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
  assert.equal(imp.status, 200, imp.text); assert.equal(imp.json.committed, true);

  return { group: g.json, queue: queueName, shortForecast: sf.json, longForecast: lf, from };
}

describe('long-range scheduling from the long-term forecast', () => {
  let admin = '';
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('projects the second week from the long-term forecast when the short-term one only covers the first', async () => {
    const ctx = await buildGroupWithForecast(admin, `A${RUN}`, { long: true });
    assert.equal(ctx.shortForecast.toDay, iso(addDays(new Date(ctx.from + 'T00:00:00'), 6)), 'the 1-week short forecast covers exactly 7 days');

    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 2, timeLimitSec: 45 });
    assert.equal(r.status, 201, r.text);
    assert.ok(!r.json.stats.uncoveredDays || r.json.stats.uncoveredDays.length === 0, `expected full coverage, got uncovered ${JSON.stringify(r.json.stats.uncoveredDays)}`);
    assert.equal(r.json.stats.projectedDays?.length, 7, `expected the second week (7 days) projected, got ${JSON.stringify(r.json.stats.projectedDays)}`);
    const expectedProjected = new Set(Array.from({ length: 7 }, (_, i) => iso(addDays(new Date(ctx.from + 'T00:00:00'), 7 + i))));
    for (const d of r.json.stats.projectedDays) assert.ok(expectedProjected.has(d), `${d} should be in the projected second week`);
    assert.ok(r.json.stats.coverage.percent > 0, 'the projected week should still produce a real, non-trivial staffing target');

    const cov = await call(admin, 'GET', `/scheduling/versions/${r.json.id}/coverage?day=${[...expectedProjected][0]}&grain=60`);
    assert.equal(cov.status, 200, cov.text);
    assert.equal(cov.json.projected, true, 'the viewed day is flagged projected');
    const projectedDaily = cov.json.daily.filter((d: any) => expectedProjected.has(d.day));
    assert.equal(projectedDaily.length, 7);
    assert.ok(projectedDaily.every((d: any) => d.projected === true), 'every day in the projected week is flagged in the daily breakdown');
    assert.ok(projectedDaily.some((d: any) => d.requiredHours > 0), 'the projected days carry a real (non-zero) staffing requirement, not just zeros');
    const shortWeekDaily = cov.json.daily.filter((d: any) => !expectedProjected.has(d.day));
    assert.ok(shortWeekDaily.every((d: any) => d.projected === false), 'the first (short-term-forecast) week is not flagged projected');
  });

  it('reports the gap as uncovered, not silently projected, when there is no published long-term forecast', async () => {
    const ctx = await buildGroupWithForecast(admin, `B${RUN}`, { long: false });
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 2, timeLimitSec: 45 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.stats.uncoveredDays?.length, 7, `expected the second week uncovered, got ${JSON.stringify(r.json.stats.uncoveredDays)}`);
    assert.ok(!r.json.stats.projectedDays || r.json.stats.projectedDays.length === 0, 'nothing to project without a published long-term forecast');
  });

  it('still refuses when neither a short-term nor a long-term forecast is published', async () => {
    const tag = `C${RUN}`;
    const g = await call(admin, 'POST', '/config/groups', { name: `LR empty ${tag}` });
    assert.equal(g.status, 201, g.text);
    // templates and people so the request reaches the forecast lookup itself, not an earlier "nothing to schedule" check
    assert.equal((await call(admin, 'POST', '/scheduling/templates', { name: `LR empty tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 })).status, 201);
    const team = await call(admin, 'POST', '/workforce/teams', { name: `LR empty team ${tag}` });
    assert.equal(team.status, 201, team.text);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: `employee_number,first_name,last_name,team,wfm_group\nLRE${tag},Agent,Test,LR empty team ${tag},LR empty ${tag}`, dryRun: false });
    assert.equal(imp.status, 200, imp.text); assert.equal(imp.json.committed, true);

    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: '2031-01-06', weeks: 1 });
    assert.equal(r.status, 400);
    assert.match(r.text, /no published short-term or long-term forecast/i);
  });
});
