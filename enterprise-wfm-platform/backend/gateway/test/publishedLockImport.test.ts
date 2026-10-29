/**
 * Two safeguards: days that are over are locked in a published schedule, and an employee import can be told to stop if any row has a problem.
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
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

const ctx: Record<string, any> = {};
let admin = '';

describe('safeguards: past days locked in a published schedule; stop-on-error import', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `Lock ${RUN}` });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '07:00', durationHours: 8.5, mealMinutes: 30, breakCount: 0, breakMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    ctx.people = [];
    for (let n = 1; n <= 2; n++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `PL${RUN}-${n}`, firstName: `Person${n}`, lastName: 'Lock', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
      assert.equal(e.status, 201, e.text); ctx.people.push(e.json);
    }
    // a rotation that reaches from two weeks ago to two weeks ahead, published
    const anchor = shift(-14);
    const pat = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Rot ${RUN}`, kind: 'DAY_CYCLE', cycleDays: 2, sequence: [ctx.tpl.id, null], crews: [{ name: 'A', offsetDays: 0 }, { name: 'B', offsetDays: 1 }], anchorDate: anchor });
    assert.equal(pat.status, 201, pat.text);
    const m = await call(admin, 'PUT', `/scheduling/rotations/${pat.json.id}/members`, { members: [{ employeeId: ctx.people[0].id, crewName: 'A' }, { employeeId: ctx.people[1].id, crewName: 'B' }] });
    assert.equal(m.status, 200, m.text);
    const g2 = await call(admin, 'POST', `/scheduling/rotations/${pat.json.id}/materialize`, { through: shift(14) });
    assert.equal(g2.status, 201, g2.text); ctx.versionId = g2.json.versionId;
    const pub = await call(admin, 'POST', `/scheduling/versions/${ctx.versionId}/publish`, { acknowledgeReason: 'test roster' });
    assert.equal(pub.status, 200, pub.text);
  });

  const shifts = async () => (await call(admin, 'GET', `/scheduling/versions/${ctx.versionId}/shifts`)).json as any[];
  const addBody = (day: string) => ({ employeeId: ctx.people[0].id, day, templateId: ctx.tpl.id, startTime: '09:00', reason: 'test change' });

  it('refuses to add, change or remove anything on a day that is over', async () => {
    const past = shift(-7);
    const add = await call(admin, 'POST', `/scheduling/versions/${ctx.versionId}/shifts`, addBody(past));
    assert.equal(add.status, 409, add.text); assert.match(add.text, /locked/);
    const old = (await shifts()).find((s) => s.day < shift(-1));
    assert.ok(old, 'there is a past shift');
    const del = await call(admin, 'DELETE', `/scheduling/versions/${ctx.versionId}/shifts/${old.id}?reason=${encodeURIComponent('should not work')}`);
    assert.equal(del.status, 409, del.text);
    const act = await call(admin, 'PUT', `/scheduling/versions/${ctx.versionId}/shifts/${old.id}/activities`, { activities: [], reason: 'should not work' });
    assert.equal(act.status, 409, act.text);
    assert.ok((await shifts()).some((s) => s.id === old.id), 'the past shift is untouched');
  });

  it('still allows a reasoned correction to a day that has not happened yet', async () => {
    const day = shift(7);
    const add = await call(admin, 'POST', `/scheduling/versions/${ctx.versionId}/shifts`, addBody(day));
    assert.equal(add.status, 201, add.text);
    const del = await call(admin, 'DELETE', `/scheduling/versions/${ctx.versionId}/shifts/${add.json.id}?reason=${encodeURIComponent('undo')}`);
    assert.equal(del.status, 200, del.text);
  });

  it('leaves past days alone when meals and breaks are re-placed in a published schedule', async () => {
    const before = JSON.stringify((await shifts()).filter((s) => s.day < shift(-1)).map((s) => [s.id, s.activities]));
    const r = await call(admin, 'POST', `/scheduling/versions/${ctx.versionId}/optimize-breaks`, { reason: 'test re-place' });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.stringify((await shifts()).filter((s) => s.day < shift(-1)).map((s) => [s.id, s.activities])), before);
  });

  const row = (n: number, group: string) => `PS${RUN}-${n},Agent${n},Imp${n},${group}`;
  const head = 'employee_number,first_name,last_name,wfm_group';
  const people = async () => ((await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json as any[]).filter((e) => e.employeeNumber.startsWith(`PS${RUN}`));

  it('imports nothing when told to stop on any problem, and says which row', async () => {
    const csv = [head, row(1, `Lock ${RUN}`), row(2, `Lock ${RUN}`), row(3, 'Nowhere')].join('\n');
    const dry = await call(admin, 'POST', '/workforce/employees/import', { csv, dryRun: true, stopOnError: true });
    assert.equal(dry.status, 200, dry.text); assert.equal(dry.json.errorCount, 1); assert.equal(dry.json.stopOnError, true);
    const r = await call(admin, 'POST', '/workforce/employees/import', { csv, dryRun: false, stopOnError: true });
    assert.equal(r.status, 400, r.text); assert.match(r.text, /Nothing was imported/); assert.match(r.text, /line 4/);
    assert.equal((await people()).length, 0, 'not even the good rows');
  });

  it('by default imports the good rows and reports the one it left out', async () => {
    const csv = [head, row(1, `Lock ${RUN}`), row(2, `Lock ${RUN}`), row(3, 'Nowhere')].join('\n');
    const r = await call(admin, 'POST', '/workforce/employees/import', { csv, dryRun: false });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.committed, true); assert.equal(r.json.errorCount, 1);
    assert.equal((await people()).length, 2);
  });
});
