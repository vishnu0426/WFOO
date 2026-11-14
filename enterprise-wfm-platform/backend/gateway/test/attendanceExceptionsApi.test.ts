/**
 * Excusing attendance problems through the API, and the daily note about those nobody has excused. Shifts today run 00:00 to 02:00 so they are over for the rest of the day; the tests skip
 * themselves in the first two and a half hours after midnight UTC. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/attendanceExceptionsApi.test.ts
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
const addDay = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const nowUtc = new Date();
const today = nowUtc.toISOString().slice(0, 10);
const tooEarly = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes() < 150;

describe('attendance exceptions', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', analyst = '', group: any, tplId = '';
  let who: any[] = [];                       // people with a shift today, in the order the week lists them
  const week = async (q = '') => (await call(admin, 'GET', `/attendance/week?from=${today}&to=${today}&groupId=${group.id}${q}`)).json;
  const day = async (p: any) => (await week(`&q=${encodeURIComponent(p.employeeNumber)}`)).people[0].days[0];
  const punch = (id: string, i: string, o: string | null) => call(admin, 'POST', '/attendance/punches', { employeeId: id, day: today, clockIn: `${today}T${i}:00Z`, clockOut: o ? `${today}T${o}:00Z` : null });
  const excuse = (items: any[], extra: any = {}) => call(admin, 'POST', '/attendance/exceptions', { items, reasonCode: 'CLOCK_FAULT', note: 'badge reader down', paid: false, ...extra });

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `EXC ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '00:00', latestStart: '00:00', durationHours: 2, mealMinutes: 0 });
    assert.equal(t.status, 201, t.text); tplId = t.json.id;
    // the solver rosters a varying number of people on a day that has already started: build again (a new group) until enough have a shift today
    for (let attempt = 1; attempt <= 3; attempt++) {
      const g = await call(admin, 'POST', '/config/groups', { name: `Exc ${attempt} ${RUN}` });
      assert.equal(g.status, 201, g.text); group = g.json;
      for (let i = 1; i <= 8; i++) assert.equal((await call(admin, 'POST', '/workforce/employees', { employeeNumber: `EX${attempt}${RUN}-${i}`, firstName: `E${i}`, lastName: `Ex${RUN}`, primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).status, 201);
      for (let d = 0; d < 7; d++) await call(admin, 'POST', `/config/groups/${g.json.id}/coverage-windows`, { dayOfWeek: d, startTime: '00:00', endTime: '02:00', headcount: 8 });
      const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: today, weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [tplId], useHistory: false });
      assert.equal(v.status, 201, v.text);
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`, {})).status, 200);
      who = (await week()).people.filter((p: any) => p.days.some((d: any) => d.scheduledHours > 0));
      if (who.length >= 7) break;
    }
    assert.ok(who.length >= 7, `the schedule gave ${who.length} people a shift today`);
    await call(admin, 'POST', '/users', { username: `exview${RUN}`, displayName: 'Viewer', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    analyst = (await call(null, 'POST', '/auth/login', { username: `exview${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
    if (!tooEarly) {
      await punch(who[0].employeeId, '00:40', '02:00');       // late
      await punch(who[1].employeeId, '00:00', '00:50');       // left early
      await punch(who[6].employeeId, '00:30', '01:00');       // late and left early
      // everyone else scheduled has no punch: missed
    }
  });

  it('excuses a missed punch: the day stops being a problem and says who excused it and why', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const before = await week();
    const target = who[2];
    assert.deepEqual((await day(target)).issues, ['missed']);
    const r = await excuse([{ employeeId: target.employeeId, day: today, kind: 'missed' }]);
    assert.equal(r.status, 201, r.text); assert.equal(r.json.excused, 1);
    const d = await day(target);
    assert.deepEqual(d.issues, ['excused']); assert.equal(d.status, 'EXCUSED');
    assert.equal(d.excused[0].reasonCode, 'CLOCK_FAULT'); assert.equal(d.excused[0].note, 'badge reader down'); assert.equal(d.excused[0].by, 'Administrator'); assert.equal(d.excused[0].level, 'MANAGER');
    const after = await week();
    assert.equal(after.counts.missed, before.counts.missed - 1); assert.equal(after.counts.excused, 1);
    assert.equal((await week('&issue=excused')).total, 1);
    assert.equal((await week('&issue=missed')).people.some((p: any) => p.employeeId === target.employeeId), false);
  });

  it('excusing the same problem again just changes the reason', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const target = who[2];
    assert.equal((await excuse([{ employeeId: target.employeeId, day: today, kind: 'missed' }], { reasonCode: 'SYSTEM_OUTAGE', note: '' })).status, 201);
    const d = await day(target);
    assert.equal(d.excused.length, 1); assert.equal(d.excused[0].reasonCode, 'SYSTEM_OUTAGE');
  });

  it('excuses one of two problems on a day and leaves the other', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const p = who[6];
    assert.deepEqual((await day(p)).issues, ['late', 'early']);
    const before = await week();
    assert.equal((await excuse([{ employeeId: p.employeeId, day: today, kind: 'late' }, { employeeId: p.employeeId, day: today, kind: 'missed' }])).status, 201, 'an excuse for a problem the day does not have is harmless');
    const d = await day(p);
    assert.deepEqual(d.issues, ['early', 'excused']); assert.deepEqual(d.excused.map((x: any) => x.kind), ['late'], 'only the real problem is shown as excused');
    const after = await week();
    assert.equal(after.counts.late, before.counts.late - 1); assert.equal(after.counts.early, before.counts.early, 'the early leave still counts'); assert.equal(after.counts.excused, before.counts.excused + 1);
  });

  it('refuses "Other" without a note, a day that has not happened, an unknown person, and people who may not', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const item = { employeeId: who[3].employeeId, day: today, kind: 'missed' };
    assert.equal((await excuse([item], { reasonCode: 'OTHER', note: '' })).status, 400);
    assert.equal((await excuse([item], { reasonCode: 'OTHER', note: 'power cut at the depot' })).status, 201);
    assert.equal((await excuse([{ ...item, day: addDay(today, 5) }])).status, 400);
    assert.equal((await excuse([{ ...item, employeeId: '00000000-0000-4000-8000-000000000000' }])).status, 404);
    assert.equal((await excuse([])).status, 400);
    assert.equal((await call(analyst, 'POST', '/attendance/exceptions', { items: [item], reasonCode: 'CLOCK_FAULT', note: '', paid: false })).status, 403);
    assert.equal((await call(analyst, 'GET', `/attendance/exceptions?from=${today}&to=${today}`)).status, 200, 'but they can read them');
  });

  it('undoes an excuse', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const target = who[3];
    const id = (await day(target)).excused[0].id;
    assert.equal((await call(admin, 'DELETE', `/attendance/exceptions/${id}`)).status, 200);
    assert.deepEqual((await day(target)).issues, ['missed']);
    assert.equal((await call(admin, 'DELETE', `/attendance/exceptions/${id}`)).status, 404);
  });

  it('excuses everything under a filter in one go, across pages', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const missed = (await week()).counts.missed;
    assert.ok(missed >= 2, `${missed} missed left`);
    const r = await call(admin, 'POST', '/attendance/exceptions/by-filter', { groupId: group.id, from: today, to: today, issue: 'missed', reasonCode: 'SYSTEM_OUTAGE', note: 'clock outage', paid: true });
    assert.equal(r.status, 201, r.text); assert.equal(r.json.matched, missed); assert.equal(r.json.excused, missed);
    const w = await week();
    assert.equal(w.counts.missed, 0); assert.ok(w.counts.excused >= missed);
    assert.equal((await call(admin, 'POST', '/attendance/exceptions/by-filter', { groupId: group.id, from: today, to: today, issue: 'missed', reasonCode: 'CLOCK_FAULT' })).json.matched, 0, 'nothing left to match');
  });

  it('pays an excused missed day at the scheduled hours only when it was excused as paid', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    const csv = (await call(admin, 'GET', `/attendance/payroll-export.csv?from=${today}&to=${today}`)).text.split('\n');
    const row = (p: any) => csv.find((l) => l.startsWith(`${p.employeeNumber},`))!.split(',');     // employee_number,name,day,scheduled,actual,regular,overtime,status
    const unpaid = row(who[2]);                                                                       // excused as unpaid at the start
    assert.equal(unpaid[7], 'EXCUSED'); assert.equal(Number(unpaid[5]), 0, 'excused but not paid: no regular hours');
    const target = who[4];                                                                            // excused in bulk as paid
    await excuse([{ employeeId: target.employeeId, day: today, kind: 'missed' }], { paid: true });
    const paid = (await call(admin, 'GET', `/attendance/payroll-export.csv?from=${today}&to=${today}`)).text.split('\n').find((l) => l.startsWith(`${target.employeeNumber},`))!.split(',');
    assert.equal(paid[7], 'EXCUSED'); assert.equal(Number(paid[5]), 2, 'paid: the scheduled hours are regular hours'); assert.equal(Number(paid[4]), 0, 'worked hours stay what was worked');
  });

  it('will not change a day inside an approved payroll run', async (t) => {
    const from = addDay(today, -40), to = addDay(today, -34);
    const run = await call(admin, 'POST', '/payroll/runs', { groupId: group.id, from, to });
    if (run.status !== 201) return t.skip(`could not make a payroll run (${run.status})`);
    const ok = await call(admin, 'POST', `/payroll/runs/${run.json.id}/approve`, {});
    if (ok.status !== 200) return t.skip(`could not approve it (${ok.status}: ${ok.text.slice(0, 80)})`);
    const lockedDay = addDay(today, -37);
    const r = await excuse([{ employeeId: who[0].employeeId, day: lockedDay, kind: 'missed' }]);
    assert.equal(r.status, 409, r.text); assert.equal(r.json.error.code, 'PAY_PERIOD_LOCKED'); assert.match(r.json.error.message, /already approved/);
  });

  it('sends one note about what is still unexcused, to the people who look after those teams, once a day', async (t) => {
    if (tooEarly) return t.skip('too soon after midnight');
    // leave one missed day unexcused so there is something to tell
    const target = who[5];
    await call(admin, 'DELETE', `/attendance/exceptions/${(await day(target)).excused?.[0]?.id ?? '00000000-0000-4000-8000-000000000000'}`);
    const unexcused = (await week()).counts;
    const left = unexcused.missed + unexcused.late + unexcused.early + unexcused.open;
    assert.ok(left >= 1, 'something is left to tell');
    const r = await call(admin, 'POST', '/attendance/digest', { groupId: group.id, day: today });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.sent, true); assert.equal(r.json.exceptions, left); assert.ok(r.json.notified >= 1, 'the managers were told (nobody here has a team supervisor)');
    const again = await call(admin, 'POST', '/attendance/digest', { groupId: group.id, day: today, force: false });
    assert.equal(again.json.sent, false); assert.equal(again.json.reason, 'already sent');
    assert.equal((await call(analyst, 'POST', '/attendance/digest', { groupId: group.id, day: today })).status, 403);
    assert.equal((await call(admin, 'POST', '/attendance/digest', { groupId: '00000000-0000-4000-8000-000000000000', day: today })).status, 404);
  });
});
