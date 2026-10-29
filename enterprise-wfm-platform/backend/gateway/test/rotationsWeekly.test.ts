/**
 * Rotation patterns: weekly-template rotations, a starting position for each person, the pattern analysis, and the coverage preview.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const SUNDAY = '2026-11-01';   // a pay week that starts on Sunday: the group below says so

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const ctx: Record<string, any> = {};
let admin = '';
const person = async (n: number) => {
  const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `RW${RUN}-${n}`, firstName: `Person${n}`, lastName: 'Rot', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
  assert.equal(e.status, 201, e.text); return e.json;
};
const shiftsOf = async (versionId: string, employeeId: string) => ((await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts`)).json as any[]).filter((s) => s.employeeId === employeeId);

describe('rotations: weekly templates, starting positions, analysis, preview', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `Rot ${RUN}`, payWeekStart: 6 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const mk = async (name: string, start: string) => {
      const t = await call(admin, 'POST', '/scheduling/templates', { name: `${name} ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: start, latestStart: start, durationHours: 8.5, mealMinutes: 30, breakCount: 0, breakMinutes: 15 });
      assert.equal(t.status, 201, t.text); return t.json;
    };
    ctx.day = await mk('Day', '07:00'); ctx.late = await mk('Late', '14:00');
    ctx.people = [await person(1), await person(2), await person(3), await person(4)];
  });

  const steps = () => ([
    { name: 'Days', weeks: 2, days: [null, ctx.day.id, ctx.day.id, ctx.day.id, ctx.day.id, ctx.day.id, null] },     // Sunday first: Monday to Friday
    { name: 'Lates', weeks: 1, days: [null, ctx.late.id, ctx.late.id, ctx.late.id, ctx.late.id, ctx.late.id, null] },
  ]);
  const weekly = (over: any = {}) => ({ wfmGroupId: ctx.group.id, name: `Weekly ${RUN}`, kind: 'WEEKLY', steps: steps(), cycleDays: 21, sequence: [], crews: [{ name: 'Crew A', offsetDays: 0 }], anchorDate: SUNDAY, ...over });

  it('creates a weekly rotation and stores it as the day cycle it unrolls to', async () => {
    const r = await call(admin, 'POST', '/scheduling/rotations', weekly());
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.kind, 'WEEKLY'); assert.equal(r.json.cycleDays, 21); assert.equal(r.json.sequence.length, 21);
    assert.equal(r.json.steps.length, 2);
    assert.equal(r.json.sequence[1], ctx.day.id); assert.equal(r.json.sequence[0], null);
    assert.equal(r.json.sequence[15], ctx.late.id, 'the third week is the Lates step');
    ctx.weekly = r.json;
  });

  it('refuses a weekly rotation that does not start on the pay week, or whose crew is not offset by whole weeks', async () => {
    const monday = await call(admin, 'POST', '/scheduling/rotations', weekly({ name: 'Wrong day', anchorDate: addDays(SUNDAY, 1) }));
    assert.equal(monday.status, 400); assert.match(monday.text, /first day of a pay week.*Sunday/);
    const odd = await call(admin, 'POST', '/scheduling/rotations', weekly({ name: 'Odd offset', crews: [{ name: 'A', offsetDays: 3 }] }));
    assert.equal(odd.status, 400); assert.match(odd.text, /multiple of 7/);
    const none = await call(admin, 'POST', '/scheduling/rotations', weekly({ name: 'No steps', steps: [] }));
    assert.equal(none.status, 400);
  });

  it('gives each person their own starting position and generates from it', async () => {
    const [a, b, c] = ctx.people;
    const set = await call(admin, 'PUT', `/scheduling/rotations/${ctx.weekly.id}/members`, { members: [
      { employeeId: a.id, crewName: 'Crew A' },                          // follows the crew: week 1 of the rotation
      { employeeId: b.id, crewName: 'Crew A', startCycleDay: 7 },        // starts in week 2 (Days)
      { employeeId: c.id, crewName: 'Crew A', startCycleDay: 14 },       // starts in week 3 (Lates)
    ] });
    assert.equal(set.status, 200, set.text);
    const members = (await call(admin, 'GET', `/scheduling/rotations/${ctx.weekly.id}/members`)).json;
    assert.equal(members.find((m: any) => m.employeeId === c.id).startCycleDay, 14);
    assert.equal(members.find((m: any) => m.employeeId === a.id).startCycleDay, null);
    const g = await call(admin, 'POST', `/scheduling/rotations/${ctx.weekly.id}/materialize`, { through: addDays(SUNDAY, 20) });
    assert.equal(g.status, 201, g.text); ctx.versionId = g.json.versionId;
    const on = async (e: any, day: string) => (await shiftsOf(ctx.versionId, e.id)).find((s) => s.day === day)?.templateId ?? null;
    const monday = addDays(SUNDAY, 1);
    assert.equal(await on(a, monday), ctx.day.id, 'A is in the Days week');
    assert.equal(await on(b, monday), ctx.day.id, 'B started in week 2, also Days');
    assert.equal(await on(c, monday), ctx.late.id, 'C started in week 3, the Lates week');
    assert.equal(await on(a, addDays(monday, 14)), ctx.late.id, 'A reaches the Lates week two weeks on');
    assert.equal(await on(c, addDays(monday, 7)), ctx.day.id, 'C wraps round to the Days step');
    assert.equal(await on(a, SUNDAY), null, 'Sunday is a day off in every step');
  });

  it('starts a new joiner part-way through a day cycle, on the day they join', async () => {
    const d = ctx.people[3];
    const cyc = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `4on4off ${RUN}`, cycleDays: 8, sequence: [ctx.day.id, ctx.day.id, ctx.day.id, ctx.day.id, null, null, null, null], crews: [{ name: 'Crew A', offsetDays: 0 }], anchorDate: SUNDAY });
    assert.equal(cyc.status, 201, cyc.text); assert.equal(cyc.json.kind, 'DAY_CYCLE');
    const join = addDays(SUNDAY, 9);
    const bad = await call(admin, 'PUT', `/scheduling/rotations/${cyc.json.id}/members`, { members: [{ employeeId: d.id, crewName: 'Crew A', effectiveFrom: join, startCycleDay: 8 }] });
    assert.equal(bad.status, 400, 'day 9 of an 8-day cycle does not exist'); assert.match(bad.text, /within the cycle/);
    const ok = await call(admin, 'PUT', `/scheduling/rotations/${cyc.json.id}/members`, { members: [{ employeeId: d.id, crewName: 'Crew A', effectiveFrom: join, startCycleDay: 2 }] });
    assert.equal(ok.status, 200, ok.text);
    const g = await call(admin, 'POST', `/scheduling/rotations/${cyc.json.id}/materialize`, { through: addDays(join, 12) });
    assert.equal(g.status, 201, g.text);
    const days = (await shiftsOf(g.json.versionId, d.id)).map((s) => s.day).sort();
    // on the join date they are on cycle day 2: two more days of work, then four off, then four on
    assert.deepEqual(days, [join, addDays(join, 1), addDays(join, 6), addDays(join, 7), addDays(join, 8), addDays(join, 9)]);
    const weeklyBad = await call(admin, 'PUT', `/scheduling/rotations/${ctx.weekly.id}/members`, { members: [{ employeeId: d.id, crewName: 'Crew A', startCycleDay: 3 }] });
    assert.equal(weeklyBad.status, 400); assert.match(weeklyBad.text, /beginning of a week/);
  });

  it('analyses a pattern before anyone is on it: hours, runs, rest and the limits it breaks', async () => {
    const r = await call(admin, 'POST', '/scheduling/rotations/analyse', { wfmGroupId: ctx.group.id, cycleDays: 8, sequence: [ctx.day.id, ctx.day.id, ctx.day.id, ctx.day.id, null, null, null, null], crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 4 }], anchorDate: SUNDAY });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.crews.length, 2);
    assert.equal(r.json.crews[0].shiftsPerCycle, 4); assert.equal(r.json.crews[0].longestRun, 4);
    assert.equal(r.json.crews[0].averageWeeklyHours, 28);        // four 8-hour shifts every 8 days
    assert.equal(r.json.payWeekStart, 6);
    assert.ok(r.json.findings.some((f: any) => f.level === 'WARN' && /averages 28 h/.test(f.text)), 'against a 40 h contract');
    // a weekly rotation can be analysed straight from its steps, without a cycle length
    const w = await call(admin, 'POST', '/scheduling/rotations/analyse', { wfmGroupId: ctx.group.id, kind: 'WEEKLY', steps: steps(), crews: [{ name: 'A', offsetDays: 0 }], anchorDate: SUNDAY });
    assert.equal(w.status, 200, w.text); assert.equal(w.json.cycleDays, 21);
    assert.equal(w.json.crews[0].averageWeeklyHours, 40);        // five 8-hour shifts every week
    assert.equal(w.json.crews[0].weekendDaysPerWeek, 0);
  });

  it('previews how the pattern covers the staffing target, before generating', async () => {
    const empty = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Empty ${RUN}`, cycleDays: 2, sequence: [ctx.day.id, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDate: SUNDAY });
    assert.equal(empty.status, 201, empty.text);
    const none = await call(admin, 'GET', `/scheduling/rotations/${empty.json.id}/preview?from=${SUNDAY}&days=7&coverageSource=MANUAL`);
    assert.equal(none.json.available, false); assert.match(none.json.reason, /Add people/);
    for (let d = 0; d < 7; d++) await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: d, startTime: '07:00', endTime: '15:00', headcount: 3 });
    const r = await call(admin, 'GET', `/scheduling/rotations/${ctx.weekly.id}/preview?from=${SUNDAY}&days=7&coverageSource=MANUAL`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.available, true);
    assert.equal(r.json.daily.length, 7); assert.equal(r.json.heat.length, 7);
    assert.equal(r.json.people, 3);
    assert.ok(r.json.summary.coveragePercent > 0 && r.json.summary.coveragePercent <= 100);
    assert.ok(r.json.summary.requiredHours > 0);
    const sunday = r.json.daily[0], monday = r.json.daily[1];
    assert.equal(sunday.scheduledHours, 0, 'nobody works Sunday in this rotation');
    assert.ok(monday.scheduledHours > 0);
    assert.ok(Math.abs(r.json.summary.requiredHours - r.json.daily.reduce((n: number, d: any) => n + d.requiredHours, 0)) < 0.2);
  });

  it('fills what the rotation leaves short from the people who are not in its crews', async () => {
    const [a, b, c, d] = ctx.people;
    // the weekly rotation puts two on days (07:00-15:30) and one on lates (from 14:00); 3 are wanted from 07:00 to 15:00 every day, so the morning is one short
    const fill = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: SUNDAY, weeks: 1, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [ctx.day.id], fillFromVersionId: ctx.versionId, name: `Fill ${RUN}` });
    assert.equal(fill.status, 201, fill.text);
    assert.equal(fill.json.settings.fillsFrom.versionId, ctx.versionId);
    assert.equal(fill.json.settings.weekStart, 6, 'the group pay week');
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${fill.json.id}/shifts`)).json as any[];
    const who = new Set(shifts.map((s) => s.employeeId));
    assert.ok(who.has(d.id), 'the person who is in no crew of the rotation is scheduled');
    for (const m of [a, b, c]) assert.ok(!who.has(m.id), 'the people in the rotation crews are not scheduled a second time');
    // the coverage view counts the rotation's people too: on Monday at 08:00 three are wanted and three are there
    const cov = (await call(admin, 'GET', `/scheduling/versions/${fill.json.id}/coverage?day=${addDays(SUNDAY, 1)}&grain=60`)).json;
    const monday = cov.heat[1].hours[8];
    assert.deepEqual(monday, { need: 3, have: 3 });
    const alone = (await call(admin, 'GET', `/scheduling/rotations/${ctx.weekly.id}/preview?from=${SUNDAY}&days=7&coverageSource=MANUAL`)).json;
    assert.ok(cov.summary.coveragePercent > alone.summary.coveragePercent, `the filled schedule covers ${cov.summary.coveragePercent}%, the rotation alone ${alone.summary.coveragePercent}%`);
  });

  it('will not fill from a schedule that does not exist, or when nobody is left to do the filling', async () => {
    const missing = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: SUNDAY, weeks: 1, coverageSource: 'MANUAL', templateIds: [ctx.day.id], fillFromVersionId: '00000000-0000-4000-8000-000000000000' });
    assert.ok(missing.status === 404 || missing.status === 400, missing.text);
    // a group whose only person is in the crew has nobody left
    const g = (await call(admin, 'POST', '/config/groups', { name: `Solo ${RUN}`, payWeekStart: 6 })).json;
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `RWS${RUN}`, firstName: 'Only', lastName: 'One', primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
    const pat = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: g.id, name: `Solo ${RUN}`, cycleDays: 7, sequence: [null, ctx.day.id, ctx.day.id, ctx.day.id, ctx.day.id, ctx.day.id, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDate: SUNDAY });
    assert.equal(pat.status, 201, pat.text);
    await call(admin, 'PUT', `/scheduling/rotations/${pat.json.id}/members`, { members: [{ employeeId: e.json.id, crewName: 'A' }] });
    const gen = await call(admin, 'POST', `/scheduling/rotations/${pat.json.id}/materialize`, { through: addDays(SUNDAY, 6) });
    assert.equal(gen.status, 201, gen.text);
    for (let dw = 0; dw < 7; dw++) await call(admin, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: dw, startTime: '07:00', endTime: '15:00', headcount: 2 });
    const none = await call(admin, 'POST', '/scheduling/versions', { groupId: g.id, from: SUNDAY, weeks: 1, coverageSource: 'MANUAL', templateIds: [ctx.day.id], fillFromVersionId: gen.json.versionId });
    assert.equal(none.status, 400); assert.match(none.text, /nobody is left to fill/);
  });
});
