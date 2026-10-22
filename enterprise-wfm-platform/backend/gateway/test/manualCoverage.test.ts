/**
 * Schedule generation without any forecast: an admin sets staffing directly as a handful of recurring weekly
 * coverage windows (day of week, start/end time, headcount), and Generate Schedule solves against that instead of
 * requirementFor()'s forecast-derived array. Confirms the manual path works end to end with zero forecast data
 * anywhere in sight, and that the existing forecast-driven path (the default) is completely unaffected.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const nextMonday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return iso(addDays(t, (7 - ((t.getDay() + 6) % 7)) % 7 || 7)); };

const ctx: Record<string, any> = {};
let admin = '';

describe('schedule generation without a forecast: manual coverage windows', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token; });

  it('prepares a group with no forecast at all, a template and two employees', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `NoForecast ${RUN}` });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '09:00', latestStart: '09:00', durationHours: 8, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    ctx.emps = [];
    for (let i = 1; i <= 2; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `NF${RUN}-${i}`, firstName: `Person${i}`, lastName: 'Test', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
      assert.equal(e.status, 201, e.text); ctx.emps.push(e.json);
    }
    ctx.from = nextMonday();
  });

  it('refuses manual-coverage generation with a clear message when no coverage windows are set', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, /No coverage windows/);
  });

  it('lists no coverage windows yet, then adds one for every day of the week', async () => {
    assert.deepEqual((await call(admin, 'GET', `/config/groups/${ctx.group.id}/coverage-windows`)).json, []);
    for (let d = 0; d < 7; d++) {
      const w = await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 1 });
      assert.equal(w.status, 201, w.text);
    }
    const list = (await call(admin, 'GET', `/config/groups/${ctx.group.id}/coverage-windows`)).json;
    assert.equal(list.length, 7);
    assert.equal((await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: 0, startTime: '17:00', endTime: '09:00', headcount: 1 })).status, 400, 'end must be after start');
  });

  it('generates a schedule with no forecast version at all', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    assert.equal(r.status, 201, r.text); ctx.version = r.json;
    assert.equal(r.json.coverageSource, 'MANUAL');
    assert.equal(r.json.forecastVersionId, null);
    assert.equal(r.json.forecastName, null);
    assert.ok(r.json.stats.shifts > 0, 'at least one shift was placed to meet the manual coverage target');
  });

  it('reads back, computes coverage and validates without a forecast anywhere', async () => {
    const got = await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}`);
    assert.equal(got.status, 200, got.text); assert.equal(got.json.coverageSource, 'MANUAL');
    const cov = await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/coverage?day=${ctx.from}&grain=60`);
    assert.equal(cov.status, 200, cov.text);
    assert.ok(cov.json.slots.some((s: any) => s.required > 0), 'the manual coverage window shows up as required headcount');
    const val = await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/validate`);
    assert.equal(val.status, 200, val.text); assert.equal(val.json.ok, true, val.text);
  });

  it('publishes a manual-coverage schedule like any other', async () => {
    const pub = await call(admin, 'POST', `/scheduling/versions/${ctx.version.id}/publish`);
    assert.equal(pub.status, 200, pub.text); assert.equal(pub.json.status, 'PUBLISHED');
  });

  it('leaves the default, forecast-driven path completely unaffected when coverageSource is omitted', async () => {
    const group = `WithForecast ${RUN}`, queue = `WithForecast Voice ${RUN}`;
    const g = await call(admin, 'POST', '/config/groups', { name: group, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text);
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const rows = ['queue,date,interval,volume,aht'];
    for (let n = 35; n >= 1; n--) { const d = addDays(today, -n); for (let s = 32; s < 40; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},4,300`); }
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: rows.join('\n') });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 3 });
    assert.equal(f.status, 201, f.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `WF Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '08:00', latestStart: '08:00', durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(t.status, 201, t.text);
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `WF${RUN}`, firstName: 'With', lastName: 'Forecast', primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e.status, 201, e.text);
    const gen = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: nextMonday(), weeks: 1, timeLimitSec: 15, templateIds: [t.json.id] });
    assert.equal(gen.status, 201, gen.text);
    assert.equal(gen.json.coverageSource, 'FORECAST', 'defaults to the forecast-driven path when coverageSource is not given');
    assert.ok(gen.json.forecastVersionId, 'still resolves and records the published forecast as before');
  });
});
