/**
 * The Today endpoint through the API: the verdict is honest, each problem is listed with its fix, the figures match the detailed screens, and sign-ins stay out of recent changes. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/overviewToday.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const isoToday = () => new Date().toISOString().slice(0, 10);

describe('Today', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', group: any;
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Today ${RUN}` })).json;
    assert.ok(group.id, JSON.stringify(group));
  });
  const today = (extra = '') => call(admin, 'GET', `/overview/today?groupId=${group.id}${extra}`);

  it('does not say all is well for a group with nothing set up, and lists what to do about each gap', async () => {
    const r = await today();
    assert.equal(r.status, 200, r.text);
    assert.notEqual(r.json.verdict.status, 'OK');
    const ids = r.json.attention.map((i: any) => i.id);
    assert.ok(ids.includes('forecast-none') && ids.includes('schedule-none'), ids.join());
    const fix = r.json.attention.find((i: any) => i.id === 'forecast-none').action;
    assert.deepEqual([fix.module, fix.section, fix.allowed], ['forecasting', 'forecast-builder', true]);
    assert.deepEqual(r.json.kpis.map((k: any) => k.key), ['coverage', 'adherence', 'accuracy', 'people']);
    assert.ok(r.json.verdict.notChecked.length > 0 || r.json.verdict.status === 'ATTENTION');
  });

  it('counts the active people in the group, and has a target on the figures that have one', async () => {
    for (let i = 1; i <= 3; i++) assert.equal((await call(admin, 'POST', '/workforce/employees', { employeeNumber: `TD${RUN}-${i}`, firstName: `T${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).status, 201);
    const r = await today();
    const people = r.json.kpis.find((k: any) => k.key === 'people');
    assert.equal(people.value, 3);
    const pol = (await call(admin, 'GET', '/config/scheduling-policy')).json;
    assert.equal(r.json.kpis.find((k: any) => k.key === 'coverage').target, pol.scheduling.targetCoverage, 'the coverage target is the setting of the company');
    assert.equal(r.json.kpis.find((k: any) => k.key === 'adherence').target, 88);
    assert.equal(r.json.kpis.find((k: any) => k.key === 'accuracy').target, 92);
  });

  it('leaves sign-ins out of recent changes unless asked', async () => {
    await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    const hidden = await today();
    assert.equal(hidden.json.signInsHidden, true);
    assert.ok(hidden.json.recent.length > 0 && hidden.json.recent.every((x: any) => !['LOGIN', 'LOGIN_FAILED'].includes(x.action)), JSON.stringify(hidden.json.recent.map((x: any) => x.action)));
    const shown = await today('&includeSignIns=1');
    assert.ok(shown.json.recent.some((x: any) => x.action === 'LOGIN'), 'sign-ins appear when asked for');
  });

  it('flags a published schedule that does not match its forecast, and a forecast that is missing, in the rail', async () => {
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `TT${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 });
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '08:00', endTime: '18:00', headcount: 2 })).status, 201);
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, from: isoToday(), weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [t.json.id], useHistory: false });
    assert.equal(v.status, 201, v.text);
    const pub = await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`, {});
    assert.equal(pub.status, 200, pub.text);
    const r = await today();
    const ids = r.json.attention.map((i: any) => i.id);
    assert.ok(!ids.includes('schedule-none'), 'a schedule is published');
    assert.ok(ids.includes('forecast-none'), 'but no forecast is: the rail says so, and the verdict is not "on track"');
    assert.notEqual(r.json.verdict.status, 'OK');
    assert.equal(r.json.drivers.schedule.name, v.json.name);
  });
});
