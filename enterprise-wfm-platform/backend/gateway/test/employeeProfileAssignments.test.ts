/**
 * Two employee-profile additions: a preferred shift template (informational, round-trips on the employee record),
 * and the single-employee rotation-membership endpoint (PUT /scheduling/rotations/member) -- deliberately separate
 * from PUT /:id/members, which replaces a whole pattern's crew list and must never be driven from a one-person screen.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
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
const mondayOnOrAfter = (d: Date) => addDays(d, (8 - d.getDay()) % 7 || 7);

const ctx: Record<string, any> = {};
let admin = '';

describe('employee profile: preferred shift template and single-employee rotation membership', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token; });

  it('prepares a group, two shift templates, two rotation patterns and an employee', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Profile ${RUN}` }); assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t1 = await call(admin, 'POST', '/scheduling/templates', { name: `Early ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '06:00', latestStart: '08:00', startStepMinutes: 30, durationHours: 8, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(t1.status, 201, t1.text); ctx.tpl1 = t1.json;
    const t2 = await call(admin, 'POST', '/scheduling/templates', { name: `Late ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '14:00', latestStart: '14:00', durationHours: 8, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(t2.status, 201, t2.text); ctx.tpl2 = t2.json;

    const anchor = iso(mondayOnOrAfter(new Date()));
    const p1 = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Pattern One ${RUN}`, cycleDays: 4, sequence: [ctx.tpl1.id, ctx.tpl1.id, null, null], crews: [{ name: 'Alpha', offsetDays: 0 }], anchorDate: anchor });
    assert.equal(p1.status, 201, p1.text); ctx.p1 = p1.json;
    const p2 = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Pattern Two ${RUN}`, cycleDays: 4, sequence: [ctx.tpl2.id, ctx.tpl2.id, null, null], crews: [{ name: 'Bravo', offsetDays: 0 }], anchorDate: anchor });
    assert.equal(p2.status, 201, p2.text); ctx.p2 = p2.json;

    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `PR${RUN}`, firstName: 'Profile', lastName: 'Test', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e.status, 201, e.text); ctx.emp = e.json;
    assert.equal(e.json.preferredTemplateId, null, 'no preference set yet');
  });

  it('round-trips a preferred shift template on the employee record', async () => {
    const set = await call(admin, 'PUT', `/workforce/employees/${ctx.emp.id}`, { preferredTemplateId: ctx.tpl1.id });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.preferredTemplateId, ctx.tpl1.id);
    assert.equal(set.json.preferredTemplateName, ctx.tpl1.name);
    const changed = await call(admin, 'PUT', `/workforce/employees/${ctx.emp.id}`, { preferredTemplateId: ctx.tpl2.id });
    assert.equal(changed.json.preferredTemplateId, ctx.tpl2.id);
    const cleared = await call(admin, 'PUT', `/workforce/employees/${ctx.emp.id}`, { preferredTemplateId: null });
    assert.equal(cleared.json.preferredTemplateId, null);
  });

  it('starts with no rotation membership', async () => {
    const m = await call(admin, 'GET', `/scheduling/rotations/member?employeeId=${ctx.emp.id}`);
    assert.equal(m.status, 200, m.text); assert.equal(m.json, null);
  });

  it('rejects a crew that does not belong to the chosen pattern', async () => {
    const r = await call(admin, 'PUT', '/scheduling/rotations/member', { employeeId: ctx.emp.id, patternId: ctx.p1.id, crewName: 'Not A Real Crew' });
    assert.equal(r.status, 400, r.text);
  });

  it('assigns the employee to a pattern and crew', async () => {
    const r = await call(admin, 'PUT', '/scheduling/rotations/member', { employeeId: ctx.emp.id, patternId: ctx.p1.id, crewName: 'Alpha', effectiveFrom: ctx.p1.anchorDate });
    assert.equal(r.status, 200, r.text);
    const m = await call(admin, 'GET', `/scheduling/rotations/member?employeeId=${ctx.emp.id}`);
    assert.equal(m.json.patternId, ctx.p1.id); assert.equal(m.json.crewName, 'Alpha'); assert.equal(m.json.effectiveFrom, ctx.p1.anchorDate);
    const p1members = await call(admin, 'GET', `/scheduling/rotations/${ctx.p1.id}/members`);
    assert.ok(p1members.json.some((x: any) => x.employeeId === ctx.emp.id));
  });

  it('switching to a different pattern clears membership in the first one', async () => {
    const r = await call(admin, 'PUT', '/scheduling/rotations/member', { employeeId: ctx.emp.id, patternId: ctx.p2.id, crewName: 'Bravo' });
    assert.equal(r.status, 200, r.text);
    const m = await call(admin, 'GET', `/scheduling/rotations/member?employeeId=${ctx.emp.id}`);
    assert.equal(m.json.patternId, ctx.p2.id); assert.equal(m.json.crewName, 'Bravo');
    const p1members = await call(admin, 'GET', `/scheduling/rotations/${ctx.p1.id}/members`);
    assert.equal(p1members.json.some((x: any) => x.employeeId === ctx.emp.id), false, 'no longer in pattern one');
    const p2members = await call(admin, 'GET', `/scheduling/rotations/${ctx.p2.id}/members`);
    assert.ok(p2members.json.some((x: any) => x.employeeId === ctx.emp.id));
  });

  it('clears rotation membership entirely when patternId is null', async () => {
    const r = await call(admin, 'PUT', '/scheduling/rotations/member', { employeeId: ctx.emp.id, patternId: null });
    assert.equal(r.status, 200, r.text);
    const m = await call(admin, 'GET', `/scheduling/rotations/member?employeeId=${ctx.emp.id}`);
    assert.equal(m.json, null);
    const p2members = await call(admin, 'GET', `/scheduling/rotations/${ctx.p2.id}/members`);
    assert.equal(p2members.json.some((x: any) => x.employeeId === ctx.emp.id), false);
  });

  it('leaves everyone else\'s membership in a pattern untouched', async () => {
    const other = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `PR2${RUN}`, firstName: 'Other', lastName: 'Person', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(other.status, 201, other.text);
    assert.equal((await call(admin, 'PUT', '/scheduling/rotations/member', { employeeId: other.json.id, patternId: ctx.p1.id, crewName: 'Alpha' })).status, 200);
    assert.equal((await call(admin, 'PUT', '/scheduling/rotations/member', { employeeId: ctx.emp.id, patternId: ctx.p1.id, crewName: 'Alpha' })).status, 200);
    const members = (await call(admin, 'GET', `/scheduling/rotations/${ctx.p1.id}/members`)).json;
    assert.ok(members.some((x: any) => x.employeeId === ctx.emp.id) && members.some((x: any) => x.employeeId === other.json.id), 'both people remain members of the same pattern');
  });
});
