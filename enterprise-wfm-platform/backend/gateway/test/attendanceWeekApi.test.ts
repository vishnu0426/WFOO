/**
 * The attendance week through the API: late, early leave, missed, still clocked in, not due yet, filtered and paged, from a real published schedule and real punches. Shifts today run
 * 00:00 to 02:00 so they are over for the rest of the day; the test skips itself in the first two and a half hours after midnight on the group's clock. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/attendanceWeekApi.test.ts
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
const nowIn = (tz: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, minute: Number(g('hour')) * 60 + Number(g('minute')) };
};
const addDay = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

describe('attendance week', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', analyst = '', today = '', tomorrow = '', tooEarly = false;
  const groups: Record<string, any> = {};
  const people: Record<string, any[]> = { A: [], B: [] };
  const punch = (employeeId: string, inT: string, outT: string | null) => call(admin, 'POST', '/attendance/punches', { employeeId, day: today, clockIn: `${today}T${inT}:00Z`, clockOut: outT ? `${today}T${outT}:00Z` : null });
  const week = async (g: any, q = '', from = today, to = today) => (await call(admin, 'GET', `/attendance/week?from=${from}&to=${to}&groupId=${g.id}${q}`)).json;
  const byNumber = (v: any, n: string) => v.people.find((p: any) => p.employeeNumber === n);

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `ATT ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '00:00', latestStart: '00:00', durationHours: 2, mealMinutes: 0 });
    assert.equal(t.status, 201, t.text);
    // How many people the solver rosters on a day that has already started varies from run to run, so build the group again (a new one) until enough of them have a shift today.
    const tz = 'UTC', now = nowIn(tz);
    today = now.day; tomorrow = addDay(today, 1); tooEarly = now.minute < 150;
    const build = async (key: string, n: number, min: number) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const g = await call(admin, 'POST', '/config/groups', { name: `Att ${key}${attempt} ${RUN}` });
        assert.equal(g.status, 201, g.text); groups[key] = g.json; people[key] = [];
        for (let i = 1; i <= n; i++) {
          const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `AT${key}${attempt}${RUN}-${String(i).padStart(2, '0')}`, firstName: `${key}${String(i).padStart(2, '0')}`, lastName: `Att${RUN}`, primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
          assert.equal(e.status, 201, e.text); people[key].push(e.json);
        }
        for (let d = 0; d < 7; d++) await call(admin, 'POST', `/config/groups/${g.json.id}/coverage-windows`, { dayOfWeek: d, startTime: '00:00', endTime: '02:00', headcount: n });
        const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: today, weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [tplId], useHistory: false });
        assert.equal(v.status, 201, v.text);
        assert.equal((await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`, {})).status, 200);
        const w = await week(g.json);
        if (w.people.filter((p: any) => p.days.some((d: any) => d.scheduledHours > 0)).length >= min) return;
      }
      throw new Error(`could not get ${min} people scheduled today in group ${key}`);
    };
    const tplId = t.json.id as string;
    await build('A', 7, 6);
    await build('B', 30, 10);
    await call(admin, 'POST', '/users', { username: `atview${RUN}`, displayName: 'Viewer', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    analyst = (await call(null, 'POST', '/auth/login', { username: `atview${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
  });

  it('judges on time, late, early leave, still clocked in and missed from the shift and the punches', { skip: false }, async (t) => {
    if (tooEarly) return t.skip('too soon after midnight for a 00:00-02:00 shift to be over');
    const first = await week(groups.A);
    const scheduled = first.people.filter((p: any) => p.days.some((d: any) => d.scheduledHours > 0));
    assert.ok(scheduled.length >= 6, `the schedule gave most of the group a shift today (${scheduled.length})`);
    const [ok, late, early, open, both] = scheduled.slice(0, 5);
    await punch(ok.employeeId, '00:02', '02:01');            // within the grace
    await punch(late.employeeId, '00:30', '02:00');          // 30 minutes late
    await punch(early.employeeId, '00:00', '01:00');         // left an hour early
    await punch(open.employeeId, '00:00', null);             // never clocked out
    await punch(both.employeeId, '00:20', '01:40');          // late and early
    const v = await week(groups.A);
    const day = (p: any) => byNumber(v, p.employeeNumber).days[0];
    assert.deepEqual(day(ok).issues, ['ok'], JSON.stringify(day(ok))); assert.equal(day(ok).status, 'MATCHED');
    assert.deepEqual(day(late).issues, ['late']); assert.equal(day(late).lateMinutes, 30);
    assert.deepEqual(day(early).issues, ['early']); assert.equal(day(early).earlyLeaveMinutes, 60);
    assert.deepEqual(day(open).issues, ['open']);
    assert.deepEqual(day(both).issues, ['late', 'early']);
    const rest = scheduled.length - 5;
    assert.equal(v.counts.missed, rest, 'everyone else scheduled and not punched is missed');
    assert.equal(v.counts.late, 2); assert.equal(v.counts.early, 2); assert.equal(v.counts.ok, 1); assert.equal(v.counts.open, 1);
    assert.equal(v.graceMinutes, 5);
    assert.equal(v.people[0].problems.missed + v.people[0].problems.late + v.people[0].problems.early + v.people[0].problems.open > 0, true, 'people with problems come first');
  });

  it('filters by kind of problem while the counts stay for the whole week, and pages and searches', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const all = await week(groups.A);
    const lateOnly = await week(groups.A, '&issue=late');
    assert.equal(lateOnly.total, 2); assert.equal(lateOnly.counts.missed, all.counts.missed, 'chips do not change with the filter');
    assert.ok(lateOnly.people.every((p: any) => p.days.some((d: any) => d.issues.includes('late'))));
    const p1 = await week(groups.A, '&limit=3&offset=0'), p2 = await week(groups.A, '&limit=3&offset=3');
    assert.equal(p1.people.length, 3); assert.equal(p1.total, all.total);
    assert.ok(!p1.people.some((a: any) => p2.people.some((b: any) => b.employeeId === a.employeeId)), 'pages do not overlap');
    const one = await week(groups.A, `&q=${encodeURIComponent(all.people[0].employeeNumber)}`);
    assert.equal(one.total, 1); assert.equal(one.counts.total, 1, 'counts follow the search');
    assert.equal((await call(admin, 'GET', `/attendance/week?from=${today}&to=${today}&groupId=${groups.A.id}&issue=nonsense`)).status, 400);
    assert.equal((await call(admin, 'GET', `/attendance/week?from=${today}&to=${addDay(today, -1)}&groupId=${groups.A.id}`)).status, 400);
  });

  it('does not call a day that has not happened yet missed', async () => {
    const v = await week(groups.A, '', tomorrow, tomorrow);
    assert.equal(v.counts.missed, 0); assert.ok(v.counts.upcoming > 0, 'tomorrow\'s shifts are "not due yet"');
    assert.equal(v.feedMissing, false);
    const both = await week(groups.A, '', today, tomorrow);
    assert.ok(both.counts.upcoming >= v.counts.upcoming);
  });

  it('says the time-clock file is probably missing when nearly every finished day has no punch, and not otherwise', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const b = await week(groups.B);
    assert.ok(b.counts.dueScheduled >= 10, `group B has enough finished scheduled days (${b.counts.dueScheduled})`);
    assert.equal(b.feedMissing, true);
    assert.equal((await week(groups.A)).feedMissing, false, 'group A has punches');
  });

  it('keeps the older summary and the payroll export working, with the new fields', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const s = await call(admin, 'GET', `/attendance/summary?from=${today}&to=${today}&groupId=${groups.A.id}`);
    assert.equal(s.status, 200, s.text);
    const d = s.json.days.find((x: any) => x.lateMinutes === 30);
    assert.ok(d && d.status === 'MATCHED' && d.issues.includes('late') && d.shift === '00:00–02:00' && d.punches[0].id, 'late is a flag on a matched day, with the shift and punch ids');
    const csv = await call(admin, 'GET', `/attendance/payroll-export.csv?from=${today}&to=${tomorrow}`);
    assert.equal(csv.text.split('\n')[0], 'employee_number,name,day,scheduled_hours,actual_hours,regular_hours,overtime_hours,status');
    assert.ok(/,UPCOMING$/m.test(csv.text), 'a shift that has not happened yet is exported as UPCOMING, not MISSED');
  });

  it('can be read by someone who cannot add punches', async () => {
    assert.equal((await call(analyst, 'GET', `/attendance/week?from=${today}&to=${today}&groupId=${groups.A.id}`)).status, 200);
    assert.equal((await call(analyst, 'POST', '/attendance/punches', { employeeId: people.A[0].id, day: today, clockIn: `${today}T00:00:00Z` })).status, 403);
  });
});
