/**
 * Two gaps closed after comparing rotation patterns with UKG/SAP-tier products: a pattern can skip a day marked as
 * a holiday, and a person's crew membership can be effective-dated so a mid-cycle join or leave reconciles the
 * already-generated future.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npm test
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
const plus = (day: string, n: number) => iso(addDays(new Date(day + 'T00:00:00'), n));
const mondayOnOrAfter = (d: Date) => addDays(d, (8 - d.getDay()) % 7 || 7);

const ctx: Record<string, any> = {};
let admin = '';

describe('rotation patterns: holidays and effective-dated membership', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); admin = r.json.token; });

  it('prepares a group, a template and two people', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `RotH ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `RotH Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '07:00', startStepMinutes: 15, durationHours: 12, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    await call(admin, 'POST', '/workforce/teams', { name: `RotH team ${RUN}` });
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,max_weekly_hours,days_per_week'];
    for (let i = 1; i <= 2; i++) lines.push(`RH${RUN}-${i},Rh${i},Crew${i},RotH team ${RUN},RotH ${RUN},FULL_TIME,46,60,7`);
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false })).json.committed, true);
    ctx.emps = (await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json;
    ctx.anchor = iso(mondayOnOrAfter(new Date()));
  });

  it('skips a holiday day when the pattern observes holidays, and reports how many were skipped', async () => {
    const holidayDay = plus(ctx.anchor, 1); // the second work day of a DDDD-OOOO cycle
    const ev = await call(admin, 'POST', '/forecast/events', { groupId: ctx.group.id, name: `RotH holiday ${RUN}`, kind: 'holiday', startDay: holidayDay });
    assert.equal(ev.status, 201, ev.text); ctx.holidayEventId = ev.json.id;

    const sequence = [ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, null, null, null, null];
    const p = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Holiday-aware ${RUN}`, cycleDays: 8, sequence, crews: [{ name: 'Crew A', offsetDays: 0 }], anchorDate: ctx.anchor, observesHolidays: true });
    assert.equal(p.status, 201, p.text); ctx.pattern = p.json;
    assert.equal(p.json.observesHolidays, true);
    assert.equal((await call(admin, 'PUT', `/scheduling/rotations/${ctx.pattern.id}/members`, { members: [{ employeeId: ctx.emps[0].id, crewName: 'Crew A' }] })).status, 200);

    const through = plus(ctx.anchor, 7);
    const m = await call(admin, 'POST', `/scheduling/rotations/${ctx.pattern.id}/materialize`, { through });
    assert.equal(m.status, 201, m.text);
    assert.equal(m.json.holidaysSkipped, 1, m.text);

    const shifts = (await call(admin, 'GET', `/scheduling/versions/${m.json.versionId}/shifts`)).json;
    const days = shifts.map((s: any) => s.day).sort();
    assert.ok(days.includes(ctx.anchor), 'still works the anchor day');
    assert.ok(!days.includes(holidayDay), `should not work the holiday day, got ${JSON.stringify(days)}`);
    assert.ok(days.includes(plus(ctx.anchor, 2)), 'still works the day after the holiday');
  });

  it('does not skip a holiday when the pattern is told not to observe holidays', async () => {
    const holidayDay2 = plus(ctx.anchor, 8); // start of the next work block, cycle day 0 again
    const ev2 = await call(admin, 'POST', '/forecast/events', { groupId: ctx.group.id, name: `RotH holiday 2 ${RUN}`, kind: 'holiday', startDay: holidayDay2 });
    assert.equal(ev2.status, 201, ev2.text);

    assert.equal((await call(admin, 'PUT', `/scheduling/rotations/${ctx.pattern.id}`, {
      name: ctx.pattern.name, cycleDays: ctx.pattern.cycleDays, sequence: ctx.pattern.sequence, crews: ctx.pattern.crews, anchorDate: ctx.pattern.anchorDate, status: 'ACTIVE', observesHolidays: false,
    })).status, 200);

    const through2 = plus(ctx.anchor, 15);
    const m2 = await call(admin, 'POST', `/scheduling/rotations/${ctx.pattern.id}/materialize`, { through: through2 });
    assert.equal(m2.status, 201, m2.text);
    assert.equal(m2.json.holidaysSkipped, 0, 'holiday observance is off, so nothing is counted as skipped');

    const shifts = (await call(admin, 'GET', `/scheduling/versions/${m2.json.versionId}/shifts`)).json;
    const days = shifts.map((s: any) => s.day).sort();
    assert.ok(days.includes(holidayDay2), `should work through the holiday once observance is off, got ${JSON.stringify(days)}`);
  });

  it('reconciles an already-generated roster when membership becomes effective-dated: a leave date removes the tail, a join date adds the head', async () => {
    const from = iso(mondayOnOrAfter(new Date()));
    const sequence = [ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, null, null, null, null];
    const p = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Effective-dated ${RUN}`, cycleDays: 8, sequence, crews: [{ name: 'Crew A', offsetDays: 0 }], anchorDate: from, observesHolidays: false });
    assert.equal(p.status, 201, p.text);
    const pattern = p.json;
    const [alice, bob] = ctx.emps;

    assert.equal((await call(admin, 'PUT', `/scheduling/rotations/${pattern.id}/members`, { members: [{ employeeId: alice.id, crewName: 'Crew A' }] })).status, 200);
    const through = plus(from, 11); // two work blocks: day 0-3 and day 8-11
    const m = await call(admin, 'POST', `/scheduling/rotations/${pattern.id}/materialize`, { through });
    assert.equal(m.status, 201, m.text);
    let shifts = (await call(admin, 'GET', `/scheduling/versions/${m.json.versionId}/shifts`)).json;
    assert.deepEqual(shifts.map((s: any) => s.day).sort(), [from, plus(from, 1), plus(from, 2), plus(from, 3), plus(from, 8), plus(from, 9), plus(from, 10), plus(from, 11)].sort());

    // Alice leaves after day 9 (mid second block); Bob joins from day 8 (start of second block)
    const leaveAfter = plus(from, 9), joinFrom = plus(from, 8);
    const upd = await call(admin, 'PUT', `/scheduling/rotations/${pattern.id}/members`, {
      members: [{ employeeId: alice.id, crewName: 'Crew A', effectiveTo: leaveAfter }, { employeeId: bob.id, crewName: 'Crew A', effectiveFrom: joinFrom }],
    });
    assert.equal(upd.status, 200, upd.text);
    assert.ok(upd.json.resync, 'a resync ran because the roster was already generated into the future');
    assert.ok(upd.json.resync.added >= 1 && upd.json.resync.removed >= 1, JSON.stringify(upd.json.resync));

    shifts = (await call(admin, 'GET', `/scheduling/versions/${m.json.versionId}/shifts`)).json;
    const aliceDays = shifts.filter((s: any) => s.employeeId === alice.id).map((s: any) => s.day).sort();
    const bobDays = shifts.filter((s: any) => s.employeeId === bob.id).map((s: any) => s.day).sort();
    assert.deepEqual(aliceDays, [from, plus(from, 1), plus(from, 2), plus(from, 3), plus(from, 8), plus(from, 9)].sort(), `Alice should keep everything through her leave date, got ${JSON.stringify(aliceDays)}`);
    assert.deepEqual(bobDays, [plus(from, 8), plus(from, 9), plus(from, 10), plus(from, 11)].sort(), `Bob should only have shifts from his join date, got ${JSON.stringify(bobDays)}`);
  });
});
