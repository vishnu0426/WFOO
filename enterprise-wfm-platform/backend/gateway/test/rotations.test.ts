/**
 * Rotating rosters: a fixed repeating cycle (4-on-4-off style), materialized into ordinary schedule_shifts rows so
 * the rest of the platform (publish, validation, RTA adherence) sees them like any other shift.
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
const mondayOnOrAfter = (d: Date) => addDays(d, (8 - d.getDay()) % 7 || 7); // a Monday strictly in the future, so it never lands on today

const ctx: Record<string, any> = {};
let admin = '';

describe('rotating rosters', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); admin = r.json.token; });

  it('prepares a group, a fixed-time template and four crew members', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Rot ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Rot Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '07:00', startStepMinutes: 15, durationHours: 12, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    await call(admin, 'POST', '/workforce/teams', { name: `Rot team ${RUN}` });
    // 12h shifts, 4 on the trot: a calendar week can hold 46h of them, so these need a higher weekly cap than a desk job's default 40h.
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,max_weekly_hours,days_per_week'];
    for (let i = 1; i <= 4; i++) lines.push(`RT${RUN}-${i},Rot${i},Crew${i},Rot team ${RUN},Rot ${RUN},FULL_TIME,46,60,7`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    ctx.emps = (await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json;
    assert.equal(ctx.emps.length, 4);
  });

  it('rejects a sequence whose length does not match the cycle', async () => {
    const anchor = iso(mondayOnOrAfter(new Date()));
    const r = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Bad ${RUN}`, cycleDays: 8, sequence: [ctx.tpl.id, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDate: anchor });
    assert.equal(r.status, 400, r.text);
  });

  it('creates a 4-on-4-off pattern with two crews and generates real shifts', async () => {
    const anchor = iso(mondayOnOrAfter(new Date()));
    ctx.anchor = anchor;
    const sequence = [ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, null, null, null, null];  // DDDD-OOOO, 8-day cycle
    const p = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `4-on-4-off ${RUN}`, cycleDays: 8, sequence, crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 4 }], anchorDate: anchor });
    assert.equal(p.status, 201, p.text); ctx.pattern = p.json;

    const members = [
      { employeeId: ctx.emps[0].id, crewName: 'Crew A' }, { employeeId: ctx.emps[1].id, crewName: 'Crew A' },
      { employeeId: ctx.emps[2].id, crewName: 'Crew B' }, { employeeId: ctx.emps[3].id, crewName: 'Crew B' },
    ];
    assert.equal((await call(admin, 'PUT', `/scheduling/rotations/${ctx.pattern.id}/members`, { members })).status, 200);

    const through = iso(addDays(new Date(anchor + 'T00:00:00'), 15)); // just under 2 cycles
    const m = await call(admin, 'POST', `/scheduling/rotations/${ctx.pattern.id}/materialize`, { through });
    assert.equal(m.status, 201, m.text);
    assert.ok(m.json.shiftsPlaced > 0);
    ctx.versionId = m.json.versionId;

    const shifts = (await call(admin, 'GET', `/scheduling/versions/${ctx.versionId}/shifts`)).json;
    const byEmp = (id: string) => shifts.filter((s: any) => s.employeeId === id).map((s: any) => s.day).sort();
    // Crew A works the pattern's first 4 days of the cycle (days 0-3 from anchor), Crew B the next 4 (offset by 4).
    const crewADays = byEmp(ctx.emps[0].id);
    const crewBDays = byEmp(ctx.emps[2].id);
    assert.ok(crewADays.includes(anchor), `Crew A should work the anchor day, got ${JSON.stringify(crewADays)}`);
    assert.ok(!crewBDays.includes(anchor), `Crew B should be off on the anchor day, got ${JSON.stringify(crewBDays)}`);
    const day4 = iso(addDays(new Date(anchor + 'T00:00:00'), 4));
    assert.ok(crewBDays.includes(day4), `Crew B should work day 4, got ${JSON.stringify(crewBDays)}`);
    assert.ok(!crewADays.includes(day4), `Crew A should be off on day 4, got ${JSON.stringify(crewADays)}`);
    // nobody ever has two shifts the same day
    for (const e of ctx.emps) assert.equal(new Set(byEmp(e.id)).size, byEmp(e.id).length);
  });

  it('the roster is a normal DRAFT schedule version: it validates and can be published like any other', async () => {
    const val = (await call(admin, 'GET', `/scheduling/versions/${ctx.versionId}/validate`)).json;
    assert.equal(val.ok, true, JSON.stringify(val.violations?.slice(0, 3)));
    const v = (await call(admin, 'GET', `/scheduling/versions/${ctx.versionId}`)).json;
    assert.equal(v.kind, 'ROTATION');
    const pub = await call(admin, 'POST', `/scheduling/versions/${ctx.versionId}/publish`);
    assert.equal(pub.status, 200, pub.text);
  });

  it('extends an already-published roster further without breaking it', async () => {
    const through2 = iso(addDays(new Date(ctx.anchor + 'T00:00:00'), 40));
    const m2 = await call(admin, 'POST', `/scheduling/rotations/${ctx.pattern.id}/materialize`, { through: through2 });
    assert.equal(m2.status, 201, m2.text);
    assert.equal(m2.json.versionId, ctx.versionId, 'extends the same evergreen version, does not create a new one');
    const v = (await call(admin, 'GET', `/scheduling/versions/${ctx.versionId}`)).json;
    assert.equal(v.status, 'PUBLISHED', 'stays published after extending');
    assert.equal(v.periodEnd, through2);
  });

  it('refuses to materialize a date already covered', async () => {
    const r = await call(admin, 'POST', `/scheduling/rotations/${ctx.pattern.id}/materialize`, { through: ctx.anchor });
    assert.equal(r.status, 400, r.text);
  });

  it('will not delete a pattern whose roster is published', async () => {
    const r = await call(admin, 'DELETE', `/scheduling/rotations/${ctx.pattern.id}`);
    assert.equal(r.status, 409, r.text);
  });
});
