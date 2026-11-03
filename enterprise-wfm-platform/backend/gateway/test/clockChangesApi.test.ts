/**
 * Daylight saving through the API: a night shift scheduled over the spring clock change is listed with the hours it is really worked for.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/clockChangesApi.test.ts
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

let admin = '';
const ctx: Record<string, any> = {};

describe('shifts over a daylight-saving change', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('prepares a New York group with night cover every night and people who may work nights', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `NY nights ${RUN}`, timezone: 'America/New_York' });
    assert.equal(g.status, 201, g.text); ctx.ny = g.json;
    const u = await call(admin, 'POST', '/config/groups', { name: `UTC nights ${RUN}`, timezone: 'UTC' });
    assert.equal(u.status, 201, u.text); ctx.utc = u.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Night ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '22:00', latestStart: '22:00', durationHours: 8, mealMinutes: 0, flexMinutes: 0 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    for (const [key, group] of [['ny', ctx.ny], ['utc', ctx.utc]] as const) {
      for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '22:00', endTime: '23:45', headcount: 1 })).status, 201);
      for (let i = 1; i <= 3; i++) {
        const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `CC${key}${RUN}-${i}`, firstName: `Night${i}`, lastName: key.toUpperCase(), primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48, allowOvernight: true, nightShiftConsent: true });
        assert.equal(e.status, 201, e.text);
      }
    }
  });

  it('lists the people whose night shift runs over the spring change, with scheduled and worked hours', async () => {
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.ny.id, from: '2027-03-08', weeks: 1, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    assert.equal(v.status, 201, v.text);
    const r = await call(admin, 'GET', `/scheduling/versions/${v.json.id}/clock-changes`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.timezone, 'America/New_York');
    const c = r.json.changes.find((x: any) => x.day === '2027-03-14');
    assert.ok(c, JSON.stringify(r.json));
    assert.equal(c.kind, 'FORWARD'); assert.equal(c.minutes, 60); assert.equal(c.at, '02:00');
    assert.ok(c.people.length >= 1, 'somebody works the night of Saturday 13 March: it is covered every night');
    for (const p of c.people) { assert.equal(p.day, '2027-03-13'); assert.equal(p.scheduledHours, 8); assert.equal(p.workedHours, 7); assert.equal(p.start, '22:00'); }
  });

  it('says nothing for a zone that does not change its clocks', async () => {
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.utc.id, from: '2027-03-08', weeks: 1, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    assert.equal(v.status, 201, v.text);
    const r = await call(admin, 'GET', `/scheduling/versions/${v.json.id}/clock-changes`);
    assert.deepEqual(r.json.changes, []);
  });
});
