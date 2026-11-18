/**
 * 'Full weekends off each month' and people's own requests about days off, end to end:
 *   the company-wide and personal settings are saved and bounded; a generated four-week schedule gives everyone the weekends the rule asks for and breaks no rule; a hand edit
 *   that takes them away is reported; a person asks for weekends off together (and for a standing rule), a supervisor or manager decides, and an approved weekend is
 *   free in the next generated schedule and protected against hand edits.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test-force-exit --test test/weekendsOffApi.test.ts   (needs the engine running)
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { weekendMonths, weekendNeed } from '../src/modules/weekendRule.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, message: json?.error?.message as string | undefined };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addIso = (s: string, n: number) => iso(addDays(new Date(`${s}T00:00:00`), n));

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

const PEOPLE = 12, LIMIT = 8;
describe('weekends off each month and requests about days off, end to end', { skip: !PASSWORD }, () => {
  let admin = '', group: any, from = '', tplId = '', versionId = '';
  const tag = `W${RUN}`;
  const people: any[] = [];
  const tokens: string[] = [];
  const policy = async (patch: Record<string, unknown>) => {
    const cur = (await call(admin, 'GET', '/config/scheduling-policy')).json;
    const { minWeekendsOffMonth: _a, minDaysOffTogether: _b, ...rest } = cur;
    return call(admin, 'PUT', '/config/scheduling-policy', { ...rest, ...patch });
  };
  const shiftsOf = async () => (await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts?from=${from}&to=${addIso(from, 27)}`)).json as any[];
  const emp = async (id: string) => (await call(admin, 'GET', `/workforce/employees/${id}`)).json;

  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
    const g = await call(admin, 'POST', '/config/groups', { name: `Wkd ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); group = g.json;
    const queue = `Wkd Voice ${tag}`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: group.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 70) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    for (const body of [{ kind: 'SHORT', weeks: 8, fromDay: from }, { kind: 'LONG', days: 120, fromDay: from }]) {
      const f = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, ...body });
      assert.equal(f.status, 201, f.text);
      for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
    }
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Wkd team ${tag}` })).status, 201);
    const tpl = await call(admin, 'POST', '/scheduling/templates', { name: `Wkd tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    assert.equal(tpl.status, 201, tpl.text); tplId = tpl.json.id;
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= PEOPLE; i++) lines.push(`WK${tag}-${i},Agent${i},Wk${i},Wkd team ${tag},Wkd ${tag},FULL_TIME,40,5`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join(String.fromCharCode(10)), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    const all = (await call(admin, 'GET', `/workforce/employees?groupId=${group.id}&limit=500`)).json;
    for (const e of (all.items ?? all.employees ?? all)) if (String(e.employeeNumber).startsWith(`WK${tag}-`)) people.push(e);
    assert.equal(people.length, PEOPLE);
    for (const e of people.slice(0, 2)) {
      const c = await call(admin, 'POST', '/self-service/logins', { employeeId: e.id, role: 'AGENT' }); assert.equal(c.status, 201, c.text);
      const t = await call(null, 'POST', '/auth/login', { username: c.json.username, password: c.json.password, tenant: TENANT }); assert.equal(t.status, 200, t.text);
      tokens.push(t.json.token);
    }
  });

  it('settings: a person and the company can be given a number of weekends, within 0 to 4', async () => {
    const id = people[5].id;
    const u = await call(admin, 'PUT', `/workforce/employees/${id}`, { minWeekendsOffMonth: 2, reason: 'Weekends' });
    assert.equal(u.status, 200, u.text); assert.equal(u.json.minWeekendsOffMonth, 2);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${id}`, { minWeekendsOffMonth: 5, reason: 'Too many' })).status, 400);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${id}`, { minWeekendsOffMonth: 0, reason: 'Back' })).json.minWeekendsOffMonth, 0);
    const b = await call(admin, 'POST', '/workforce/employees/bulk', { ids: [people[6].id, people[7].id], changes: { minWeekendsOffMonth: 1 }, reason: 'Bulk' });
    assert.equal(b.status, 200, b.text);
    assert.equal((await emp(people[6].id)).minWeekendsOffMonth, 1);
    await call(admin, 'POST', '/workforce/employees/bulk', { ids: [people[6].id, people[7].id], changes: { minWeekendsOffMonth: 0 }, reason: 'Undo' });
    assert.equal((await policy({ minWeekendsOffMonth: 2 })).json.minWeekendsOffMonth, 2);
    assert.equal((await policy({})).json.minWeekendsOffMonth, 2, 'left out: kept');
    assert.equal((await policy({ minWeekendsOffMonth: 5 })).status, 400);
    assert.equal((await policy({ minWeekendsOffMonth: null })).json.minWeekendsOffMonth, null, 'cleared');
  });

  it('a person asks for the first weekend of the schedule off, together; it is refused when it holds no weekend or overlaps another request', async () => {
    const sat = addIso(from, 5), sun = addIso(from, 6);
    const r = await call(tokens[0], 'POST', '/me/off-requests', { kind: 'WEEKEND_OFF', startDate: sat, endDate: sun, reason: 'Family' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.request.status, 'REQUESTED'); assert.equal(r.json.request.kind, 'WEEKEND_OFF');
    assert.ok(r.json.request.waitingFor, 'the person is told who has it');
    assert.equal((await call(tokens[0], 'POST', '/me/off-requests', { kind: 'WEEKEND_OFF', startDate: from, endDate: addIso(from, 4) })).status, 400, 'a week with no weekend in it');
    assert.equal((await call(tokens[0], 'POST', '/me/off-requests', { kind: 'WEEKEND_OFF', startDate: sat, endDate: sat })).status, 409, 'overlaps the first');
    assert.equal((await call(tokens[0], 'POST', '/me/off-requests', { kind: 'WEEKEND_OFF', startDate: addIso(from, -30), endDate: addIso(from, -20) })).status, 400, 'in the past');
    const mine = (await call(tokens[0], 'GET', '/me/off-requests')).json;
    assert.deepEqual(mine.weekendDays, [5, 6]); assert.equal(mine.requests.length, 1);
    assert.equal(mine.limits.effective.weekendsMonth, 0);
  });

  it('the approver sees it with what they need to decide, and cannot decline without a reason', async () => {
    const list = (await call(admin, 'GET', '/workforce/off-requests?status=REQUESTED')).json;
    const row = list.items.find((x: any) => x.employeeId === people[0].id);
    assert.ok(row, 'listed for the manager');
    assert.deepEqual(row.context.weekends, [{ from: addIso(from, 5), to: addIso(from, 6) }]);
    assert.equal(row.context.scheduledShifts, 0);
    assert.equal((await call(admin, 'POST', `/workforce/off-requests/${row.id}/decide`, { status: 'REJECTED' })).status, 400, 'a reason is needed to decline');
    const ok = await call(admin, 'POST', `/workforce/off-requests/${row.id}/decide`, { status: 'APPROVED', reason: 'Fine' });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.status, 'APPROVED');
    assert.equal((await call(admin, 'POST', `/workforce/off-requests/${row.id}/decide`, { status: 'APPROVED' })).status, 409, 'already decided');
    const mine = (await call(tokens[0], 'GET', '/me/off-requests')).json;
    assert.equal(mine.requests[0].status, 'APPROVED'); assert.equal(mine.requests[0].decisionNote, 'Fine');
    assert.equal((await call(tokens[1], 'POST', `/workforce/off-requests/${row.id}/decide`, { status: 'APPROVED' })).status, 403, 'a colleague cannot decide');
  });

  it('a standing request can only ask for more than the person already has, and approving raises their own limits', async () => {
    const t = tokens[1], id = people[1].id;
    assert.equal((await policy({ minDaysOffTogether: 2 })).json.minDaysOffTogether, 2);
    assert.equal((await call(t, 'POST', '/me/off-requests', { kind: 'STANDING', minDaysTogether: 2 })).status, 400, 'the company already gives 2');
    assert.equal((await call(t, 'POST', '/me/off-requests', { kind: 'STANDING' })).status, 400, 'nothing asked for');
    const r = await call(t, 'POST', '/me/off-requests', { kind: 'STANDING', minDaysTogether: 3, minWeekendsMonth: 2, reason: 'Childcare' });
    assert.equal(r.status, 201, r.text);
    assert.equal((await call(t, 'POST', '/me/off-requests', { kind: 'STANDING', minWeekendsMonth: 3 })).status, 409, 'one is waiting already');
    const list = (await call(admin, 'GET', '/workforce/off-requests?status=REQUESTED')).json;
    const row = list.items.find((x: any) => x.id === r.json.request.id);
    assert.deepEqual(row.context.after, { daysTogether: 3, weekendsMonth: 2 });
    assert.equal((await emp(id)).minDaysOffTogether ?? 0, 0, 'nothing changes before it is decided');
    assert.equal((await call(admin, 'POST', `/workforce/off-requests/${row.id}/decide`, { status: 'APPROVED' })).status, 200);
    const after = await emp(id);
    assert.equal(after.minDaysOffTogether, 3); assert.equal(after.minWeekendsOffMonth, 2);
    assert.equal((await call(t, 'POST', `/me/off-requests/${row.id}/cancel`)).status, 409, 'an approved standing request is not cancelled by the person');
    assert.equal((await call(t, 'POST', '/me/off-requests', { kind: 'STANDING', minDaysTogether: 3 })).status, 400, 'they have 3 now');
    // put things back so the schedule below is built for the people the test set up
    await call(admin, 'PUT', `/workforce/employees/${id}`, { minDaysOffTogether: 0, minWeekendsOffMonth: 0, reason: 'Reset' });
    await policy({ minDaysOffTogether: null });
  });

  it('a person can withdraw a request that is waiting', async () => {
    const sat = addIso(from, 12), sun = addIso(from, 13);
    const r = await call(tokens[1], 'POST', '/me/off-requests', { kind: 'WEEKEND_OFF', startDate: sat, endDate: sun });
    assert.equal(r.status, 201, r.text);
    const c = await call(tokens[1], 'POST', `/me/off-requests/${r.json.request.id}/cancel`);
    assert.equal(c.status, 200, c.text); assert.equal(c.json.status, 'CANCELLED');
    const list = (await call(admin, 'GET', '/workforce/off-requests?status=REQUESTED')).json;
    assert.ok(!list.items.some((x: any) => x.id === r.json.request.id));
  });

  it('a four-week schedule gives everyone the weekends the rule asks for, keeps the approved weekend free, and breaks no rule', async () => {
    assert.equal((await policy({ minWeekendsOffMonth: 4 })).status, 200);
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 4, timeLimitSec: LIMIT });
    assert.equal(r.status, 201, r.text); versionId = r.json.id;
    const v = (await call(admin, 'GET', `/scheduling/versions/${versionId}`)).json;
    assert.equal(v.stats.violations, 0, JSON.stringify((v.violations ?? []).slice(0, 3)));
    assert.ok(v.stats.shifts >= PEOPLE * 12, `people still work: ${v.stats.shifts} shifts`);
    const worked = new Map<string, Set<string>>();
    for (const s of await shiftsOf()) worked.set(s.employeeId, (worked.get(s.employeeId) ?? new Set()).add(s.day));
    assert.equal(worked.size, PEOPLE);
    const months = weekendMonths(from, addIso(from, 27), [5, 6]);
    let judged = 0;
    for (const [id, days] of worked) for (const mo of months) {
      const need = weekendNeed(4, mo, mo.before.length);      // nothing was published before, so every earlier weekend counts as off
      const off = mo.inPeriod.filter((w) => !w.some((d) => days.has(d))).length;
      assert.ok(off >= need, `${id} in ${mo.key}: ${off} weekends off, needs ${need}`);
      if (need > 0) judged++;
    }
    assert.ok(judged > 0, 'the rule asked for something');
    const mine = worked.get(people[0].id) ?? new Set<string>();
    assert.ok(!mine.has(addIso(from, 5)) && !mine.has(addIso(from, 6)), 'the approved weekend is free');
  });

  it('a hand edit that puts a shift on the approved weekend, or takes a month\'s weekends away, is reported', async () => {
    const shifts = await shiftsOf();
    const template = shifts[0];
    const time = `${String(Math.floor(template.startSlot / 4)).padStart(2, '0')}:${String((template.startSlot % 4) * 15).padStart(2, '0')}`;
    const post = (employeeId: string, day: string) => call(admin, 'POST', `/scheduling/versions/${versionId}/shifts`, { employeeId, day, templateId: template.templateId, startTime: time, reason: 'Test: edit' });
    const a = await post(people[0].id, addIso(from, 5));
    assert.ok([200, 201].includes(a.status), a.text);
    let text = JSON.stringify(((await call(admin, 'GET', `/scheduling/versions/${versionId}`)).json.violations) ?? []);
    assert.match(text, /TIME_OFF/, `approved weekend: ${text.slice(0, 300)}`);
    // another person works one day of every weekend: no weekend is fully off for them
    const who = people[3].id, have = new Set(shifts.filter((s) => s.employeeId === who).map((s) => s.day));
    for (const w of [5, 12, 19, 26]) if (!have.has(addIso(from, w))) { const b = await post(who, addIso(from, w)); assert.ok([200, 201].includes(b.status), b.text); }
    text = JSON.stringify(((await call(admin, 'GET', `/scheduling/versions/${versionId}`)).json.violations) ?? []);
    assert.match(text, /WEEKENDS_OFF/, `the weekends rule is reported: ${text.slice(0, 400)}`);
  });

  it('an eight-week plan built a window at a time still gives the weekends the rule asks for, across the windows', async () => {
    assert.equal((await policy({ minWeekendsOffMonth: 4 })).status, 200);
    const r = await call(admin, 'POST', '/scheduling/jobs', { groupId: group.id, templateIds: [tplId], from, weeks: 8, solveWeeks: 8, windowWeeks: 4, timeLimitSec: 10 });
    assert.equal(r.status, 202, r.text);
    let job: any = null;
    for (let t0 = Date.now(); Date.now() - t0 < 6 * 60_000;) {
      job = (await call(admin, 'GET', `/scheduling/jobs/${r.json.id}`)).json;
      if (['DONE', 'FAILED', 'CANCELLED'].includes(job.status)) break;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    assert.equal(job.status, 'DONE', job.error ?? JSON.stringify(job));
    const to = addIso(from, 55);
    const v = (await call(admin, 'GET', `/scheduling/versions/${job.versionId}`)).json;
    assert.equal(v.stats.violations, 0, JSON.stringify((v.violations ?? []).slice(0, 3)));
    const worked = new Map<string, Set<string>>();
    for (const s of (await call(admin, 'GET', `/scheduling/versions/${job.versionId}/shifts?from=${from}&to=${to}`)).json as any[]) worked.set(s.employeeId, (worked.get(s.employeeId) ?? new Set()).add(s.day));
    assert.equal(worked.size, PEOPLE);
    const months = weekendMonths(from, to, [5, 6]);
    let judged = 0;
    for (const [id, days] of worked) for (const mo of months) {
      const need = weekendNeed(4, mo, mo.before.length);
      const off = mo.inPeriod.filter((w) => !w.some((d) => days.has(d))).length;
      assert.ok(off >= need, `${id} in ${mo.key}: ${off} weekends off across the windows, needs ${need}`);
      if (need > 0) judged++;
    }
    assert.ok(judged > 0, 'the rule asked for something');
    await call(admin, 'DELETE', `/scheduling/versions/${job.versionId}`);
  });

  it('clears the setting afterwards so other tests start from no rule', async () => {
    assert.equal((await policy({ minWeekendsOffMonth: null })).json.minWeekendsOffMonth, null);
    if (versionId) await call(admin, 'DELETE', `/scheduling/versions/${versionId}`);
  });
});
