/**
 * An employee's week at a glance through the API: a real published schedule with meals, approved leave, balances and today's status, checked against what the shifts say. Needs a
 * running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/employeeGlanceApi.test.ts
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
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('employee week at a glance', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', group: any, ids: string[] = [], versionId = '';
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Glance ${RUN}` })).json;
    assert.ok(group.id, JSON.stringify(group));
    for (let i = 1; i <= 8; i++) {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `GL${RUN}-${i}`, firstName: `G${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
      assert.equal(r.status, 201, r.text); ids.push(r.json.id);
    }
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `GT${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 });
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '08:00', endTime: '17:00', headcount: 4 })).status, 201);
    const today = new Date();
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, from: iso(today), weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [t.json.id], useHistory: false });
    assert.equal(v.status, 201, v.text); versionId = v.json.id;
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${versionId}/publish`, {})).status, 200);
  });

  it("lists the week's published shifts with the meal out of paid time, and totals them", async () => {
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts`)).json as any[];
    const who = shifts[0].employeeId as string;
    const g = (await call(admin, 'GET', `/workforce/employees/${who}/glance`)).json;
    assert.equal(g.week.days.length, 7);
    const mine = shifts.filter((s) => s.employeeId === who && s.day >= g.week.from && s.day <= g.week.to);
    assert.ok(mine.length > 0);
    for (const s of mine) {
      const row = g.week.days.find((d: any) => d.day === s.day);
      assert.ok(row?.shift, `a shift on ${s.day}`);
      assert.equal(row.shift.paidHours, 8, 'a 9 hour shift with a 1 hour unpaid meal is 8 paid hours');
    }
    assert.equal(g.week.paidHours, mine.length * 8);
    assert.equal(g.week.contractHours, 40);
    assert.equal(g.week.belowContract, mine.length * 8 < 40);
  });

  it('shows approved leave on its day and in what is coming up', async () => {
    const who = ids[7];
    const day = new Date(); day.setDate(day.getDate() + 3);
    const r = await call(admin, 'POST', '/workforce/time-off', { employeeId: who, type: 'VACATION', startDate: iso(day), endDate: iso(day), reason: 'test' });
    assert.ok([200, 201].includes(r.status), r.text);
    if (r.json?.id && r.json.status === 'REQUESTED') await call(admin, 'POST', `/workforce/time-off/${r.json.id}/decide`, { decision: 'APPROVED' });
    const g = (await call(admin, 'GET', `/workforce/employees/${who}/glance`)).json;
    assert.ok(g.upcomingTimeOff.some((t: any) => t.startDay === iso(day)), JSON.stringify(g.upcomingTimeOff));
    assert.ok(Array.isArray(g.balances));
  });

  it('says nothing about today when there is no agent activity, and never invents adherence', async () => {
    const g = (await call(admin, 'GET', `/workforce/employees/${ids[0]}/glance`)).json;
    assert.equal(g.adherenceLast7, null, 'no finished day has been judged');
    assert.ok(g.now === null || typeof g.now.status === 'string');
  });

  it('refuses a person who does not exist, and an email address as an agent extension', async () => {
    assert.equal((await call(admin, 'GET', '/workforce/employees/00000000-0000-4000-8000-000000000000/glance')).status, 404);
    const bad = await call(admin, 'PUT', `/workforce/employees/${ids[0]}`, { extension: 'someone@example.com' });
    assert.equal(bad.status, 400, bad.text);
  });
});
