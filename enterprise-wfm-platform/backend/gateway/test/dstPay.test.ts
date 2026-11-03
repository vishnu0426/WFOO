/**
 * Payroll over a daylight-saving change: hours taken from the schedule are the scheduled hours by default, or the hours really worked when the
 * company chooses so. Punched hours are not part of this: they are real time already.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/dstPay.test.ts
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

const CODES = { REGULAR: 'REG', OVERTIME: 'OT', NIGHT: 'NGT', WEEKEND: 'WKD', HOLIDAY: 'HOL', VACATION: 'VAC', SICK: 'SICK', PERSONAL: 'PERS', HOLIDAY_LEAVE: 'HOLP', TRAINING: 'TRN', LEAVE: 'LV', OTHER: 'OTH' };
const settings = (dstPay?: string) => ({ payCodes: CODES, paidLeave: ['VACATION', 'SICK'], nightFrom: '22:00', nightTo: '06:00', dailyOvertimeAfter: null, weeklyOvertimeAfter: 168, stacking: 'EXCLUSIVE', rounding: 'NONE', hoursSource: 'SCHEDULED', ...(dstPay ? { dstPay } : {}) });

let admin = '';
const ctx: Record<string, any> = {};

describe('paying a shift over a clock change', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('prepares a New York group and publishes a week of night shifts over the spring change', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `NY pay ${RUN}`, timezone: 'America/New_York' });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Night pay ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '22:00', latestStart: '22:00', durationHours: 8, mealMinutes: 0, flexMinutes: 0 });
    assert.equal(t.status, 201, t.text);
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: d, startTime: '22:00', endTime: '23:45', headcount: 1 })).status, 201);
    for (let i = 1; i <= 3; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `DP${RUN}-${i}`, firstName: `Pay${i}`, lastName: 'Night', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 48, allowOvernight: true, nightShiftConsent: true });
      assert.equal(e.status, 201, e.text);
    }
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: '2027-03-08', weeks: 1, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [t.json.id] });
    assert.equal(v.status, 201, v.text); ctx.version = v.json;
    const pub = await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`, { acknowledgeReason: 'payroll test' });
    assert.equal(pub.status, 200, pub.text);
    const c = await call(admin, 'GET', `/scheduling/versions/${v.json.id}/clock-changes`);
    ctx.affected = c.json.changes.find((x: any) => x.day === '2027-03-14')?.people.length ?? 0;
    assert.ok(ctx.affected >= 1, 'somebody works the night of the change');
  });

  const totalFor = async (dstPay?: string) => {
    assert.equal((await call(admin, 'PUT', '/payroll/settings', settings(dstPay))).status, 200);
    const r = await call(admin, 'POST', '/payroll/runs', { groupId: ctx.group.id, from: '2027-03-08', to: '2027-03-14' });
    assert.equal(r.status, 201, r.text);
    return r.json.totals.hours as number;
  };

  it('pays the scheduled hours by default', async () => {
    const s = await call(admin, 'GET', '/payroll/settings'); assert.equal(s.json.dstPay, 'SCHEDULED');
    ctx.scheduled = await totalFor();
    assert.ok(ctx.scheduled > 0);
  });

  it('pays an hour less for each person who works through the jump when the company chooses worked hours', async () => {
    const worked = await totalFor('WORKED');
    assert.equal(Math.round((ctx.scheduled - worked) * 100) / 100, ctx.affected, `scheduled ${ctx.scheduled}, worked ${worked}`);
    assert.equal((await call(admin, 'GET', '/payroll/settings')).json.dstPay, 'WORKED');
  });

  it('keeps the choice when settings are saved without it, and goes back when asked', async () => {
    assert.equal((await call(admin, 'PUT', '/payroll/settings', settings())).status, 200);
    assert.equal((await call(admin, 'GET', '/payroll/settings')).json.dstPay, 'WORKED');
    assert.equal(await totalFor('SCHEDULED'), ctx.scheduled);
  });

  it('refuses a choice it does not know', async () => {
    assert.equal((await call(admin, 'PUT', '/payroll/settings', settings('HALF'))).status, 400);
  });
});
