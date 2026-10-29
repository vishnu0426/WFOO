/**
 * The coverage view on Schedule Timeline: the day at 15, 30 and 60 minutes, the period summary and hour-by-hour heatmap, a second version
 * to compare against, and the explanation behind any interval (who is working it, and why each other person is not).
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const SUNDAY = '2026-11-01';

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const ctx: Record<string, any> = {};
let admin = '';

describe('coverage view', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `CovView ${RUN}` });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '09:00', latestStart: '09:00', durationHours: 8.5, mealMinutes: 30, breakCount: 0, breakMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    ctx.people = [];
    for (let i = 1; i <= 7; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `CV${RUN}-${i}`, firstName: `Person${i}`, lastName: 'Test', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
      assert.equal(e.status, 201, e.text); ctx.people.push(e.json);
    }
    for (let d = 0; d < 7; d++) {
      const w = await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 4 });
      assert.equal(w.status, 201, w.text);
    }
    const gen = (headcount?: number) => call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: SUNDAY, weeks: 1, weekStart: 6, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    const v1 = await gen(); assert.equal(v1.status, 201, v1.text); ctx.v1 = v1.json;
    const v2 = await gen(); assert.equal(v2.status, 201, v2.text); ctx.v2 = v2.json;
  });

  const cover = (q: string) => call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/coverage?${q}`);

  it('serves the day at 15, 30 and 60 minutes', async () => {
    for (const [grain, n] of [['15', 96], ['30', 48], ['60', 24]] as const) {
      const r = await cover(`day=${SUNDAY}&grain=${grain}`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.slots.length, n, `${grain}-minute grain`);
    }
    assert.equal((await cover(`day=${SUNDAY}&grain=45`)).status, 400);
  });

  it('adds a period summary that agrees with the daily figures, and an hour-by-hour heatmap', async () => {
    const r = await cover(`day=${SUNDAY}&grain=60`);
    assert.equal(r.json.heat.length, 7);
    assert.ok(r.json.heat.every((d: any) => d.hours.length === 24));
    const s = r.json.summary;
    const need = r.json.daily.reduce((n: number, d: any) => n + d.requiredHours, 0);
    assert.ok(Math.abs(s.requiredHours - need) < 0.2, `summary ${s.requiredHours} vs daily ${need}`);
    assert.ok(s.coveragePercent >= 0 && s.coveragePercent <= 100);
    assert.equal(typeof r.json.shrinkage, 'number');
    // 09:00-17:00 is needed on every day, nothing at night
    const nine = r.json.heat[1].hours[10];
    assert.equal(nine.need, 4);
    assert.equal(r.json.heat[1].hours[3].need, 0);
  });

  it('puts a second version of the same group beside the first, and refuses one from another group', async () => {
    const r = await cover(`day=${SUNDAY}&grain=30&compare=${ctx.v2.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.compare.id, ctx.v2.id);
    assert.equal(r.json.compare.seq, ctx.v2.seq);
    assert.equal(r.json.compare.scheduled.length, r.json.slots.length);
    assert.ok(r.json.compare.scheduled.every((n: number) => Number.isInteger(n) && n >= 0), 'a head count per interval');
    assert.ok(r.json.compare.scheduled[20] > 0, 'the other version has people working at 10:00');
    const g2 = await call(admin, 'POST', '/config/groups', { name: `CovView other ${RUN}` });
    const other = await call(admin, 'POST', '/scheduling/templates', { name: `Other ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '09:00', latestStart: '09:00', durationHours: 8.5, mealMinutes: 30, breakCount: 0, breakMinutes: 15 });
    assert.equal(other.status, 201, other.text);
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `CVX${RUN}`, firstName: 'Solo', lastName: 'Other', primaryGroupId: g2.json.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e.status, 201, e.text);
    for (let d = 0; d < 7; d++) await call(admin, 'POST', `/config/groups/${g2.json.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 1 });
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g2.json.id, from: SUNDAY, weeks: 1, weekStart: 6, timeLimitSec: 10, coverageSource: 'MANUAL', templateIds: [other.json.id] });
    assert.equal(v.status, 201, v.text);
    assert.equal((await cover(`day=${SUNDAY}&compare=${v.json.id}`)).status, 400);
  });

  it('explains an interval: who is working and why each other person is not', async () => {
    const r = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/interval?day=${SUNDAY}&slot=40`);   // 10:00
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.needed, 4);
    assert.equal(r.json.scheduled, r.json.working.length);
    const off = r.json.notWorking.reduce((n: number, g: any) => n + g.people, 0);
    assert.equal(r.json.working.length + off, ctx.people.length, 'every person is either working or has a reason');
    assert.ok(r.json.working.every((w: any) => w.startSlot <= 40 && 40 < w.endSlot));
    const quiet = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/interval?day=${SUNDAY}&slot=12`);   // 03:00: nothing needed, nobody working
    assert.equal(quiet.json.needed, 0);
    assert.equal(quiet.json.working.length, 0);
    assert.equal((await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/interval?day=2030-01-01&slot=40`)).status, 400);
    assert.equal((await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/interval?day=${SUNDAY}&slot=96`)).status, 400);
  });
});
