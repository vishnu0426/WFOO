/**
 * Supervisors and managers: marking a person on their employee record, a team's supervisor and deputy, a WFM group's manager, the guards that keep
 * those consistent, and the people list the pickers read (filters and paging).
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/supervisors.test.ts
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
  return { status: r.status, json, text, message: json?.error?.message as string | undefined };
}
let admin = '';
const ctx: Record<string, any> = {};
const person = async (n: string, extra: Record<string, unknown> = {}) => {
  const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SUP${RUN}-${n}`, firstName: `Sup${n}`, lastName: `Person${RUN}`, ...extra });
  assert.equal(r.status, 201, r.text); return r.json;
};

describe('supervisors and managers', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token; });

  describe('marking people', () => {
    it('keeps who is a supervisor or a manager on the employee record, and reads it back', async () => {
      ctx.a = await person('A', { isSupervisor: true }); ctx.b = await person('B', { isManager: true }); ctx.c = await person('C'); ctx.d = await person('D', { isSupervisor: true, isManager: true });
      assert.deepEqual([ctx.a.isSupervisor, ctx.a.isManager], [true, false]); assert.deepEqual([ctx.c.isSupervisor, ctx.c.isManager], [false, false]);
      const back = (await call(admin, 'GET', `/workforce/employees/${ctx.d.id}`)).json;
      assert.deepEqual([back.isSupervisor, back.isManager], [true, true]);
    });

    it('lists only supervisors or only managers, and pages through them', async () => {
      const sup = (await call(admin, 'GET', `/workforce/employees?isSupervisor=true&q=Person${RUN}`)).json;
      assert.deepEqual(sup.map((e: any) => e.firstName).sort(), ['SupA', 'SupD']);
      const man = (await call(admin, 'GET', `/workforce/employees?isManager=true&q=Person${RUN}`)).json;
      assert.deepEqual(man.map((e: any) => e.firstName).sort(), ['SupB', 'SupD']);
      assert.equal((await call(admin, 'GET', `/workforce/employees?isSupervisor=false&q=Person${RUN}`)).json.length, 2);
      const p1 = (await call(admin, 'GET', `/workforce/employees?q=Person${RUN}&limit=2&offset=0`)).json, p2 = (await call(admin, 'GET', `/workforce/employees?q=Person${RUN}&limit=2&offset=2`)).json;
      assert.equal(p1.length, 2); assert.equal(p2.length, 2);
      assert.equal(new Set([...p1, ...p2].map((e: any) => e.id)).size, 4, 'pages do not overlap');
      assert.equal((await call(admin, 'GET', `/workforce/employees?q=Person${RUN}&limit=2&offset=4`)).json.length, 0, 'and then run out');
      assert.equal((await call(admin, 'GET', '/workforce/employees?isSupervisor=maybe')).status, 400);
    });

    it('bulk edit cannot change who is a supervisor', async () => {
      const r = await call(admin, 'POST', '/workforce/employees/bulk', { ids: [ctx.c.id], changes: { location: 'Chennai', isSupervisor: true }, reason: 'Moving them' });
      assert.equal(r.status, 200, r.text);
      assert.equal((await call(admin, 'GET', `/workforce/employees/${ctx.c.id}`)).json.isSupervisor, false);
    });
  });

  describe('a team\'s supervisor and deputy', () => {
    it('only a person marked as a supervisor can be chosen, with a message that says what to do', async () => {
      const bad = await call(admin, 'POST', '/workforce/teams', { name: `Team ${RUN}`, managerId: ctx.c.id });
      assert.equal(bad.status, 400, bad.text); assert.match(bad.message!, /SupC Person.* is not marked as a supervisor/); assert.match(bad.message!, /Tick "Is a supervisor"/);
      const ok = await call(admin, 'POST', '/workforce/teams', { name: `Team ${RUN}`, managerId: ctx.a.id });
      assert.equal(ok.status, 201, ok.text); ctx.team = ok.json;
      assert.equal(ok.json.managerName, `SupA Person${RUN}`); assert.equal(ok.json.deputyId, null);
    });

    it('has a deputy, who is someone else and also marked', async () => {
      const same = await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { deputyId: ctx.a.id });
      assert.equal(same.status, 400, same.text); assert.match(same.message!, /different person/);
      assert.equal((await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { deputyId: ctx.b.id })).status, 400, 'a manager who is not a supervisor is not enough');
      const ok = await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { deputyId: ctx.d.id });
      assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.deputyName, `SupD Person${RUN}`);
      const list = (await call(admin, 'GET', `/workforce/teams?q=Team%20${RUN}`)).json.find((t: any) => t.id === ctx.team.id);
      assert.equal(list.deputyId, ctx.d.id); assert.equal(list.managerId, ctx.a.id);
      assert.equal((await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { name: `Team ${RUN} renamed` })).json.deputyId, ctx.d.id, 'editing something else keeps them');
      assert.equal((await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { deputyId: null })).json.deputyId, null);
      await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { deputyId: ctx.d.id });
    });

    it('will not take the mark from someone who still leads a team, and says which', async () => {
      const r = await call(admin, 'PUT', `/workforce/employees/${ctx.a.id}`, { reason: 'Test change', isSupervisor: false });
      assert.equal(r.status, 409, r.text); assert.match(r.message!, new RegExp(`supervisor or deputy of Team ${RUN}`));
      const dep = await call(admin, 'PUT', `/workforce/employees/${ctx.d.id}`, { reason: 'Test change', isSupervisor: false });
      assert.equal(dep.status, 409, 'a deputy counts too');
      await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { managerId: ctx.d.id, deputyId: null });
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${ctx.a.id}`, { reason: 'Test change', isSupervisor: false })).status, 200, 'free once nobody depends on it');
      assert.equal((await call(admin, 'GET', `/workforce/employees/${ctx.a.id}`)).json.isSupervisor, false);
    });

    it('will not choose someone who has left', async () => {
      const x = await person('X', { isSupervisor: true, status: 'TERMINATED' });
      const r = await call(admin, 'PUT', `/workforce/teams/${ctx.team.id}`, { managerId: x.id });
      assert.equal(r.status, 400, r.text); assert.match(r.message!, /has left/);
    });
  });

  describe('a WFM group\'s manager', () => {
    it('only a person marked as a manager can be chosen', async () => {
      const bad = await call(admin, 'POST', '/config/groups', { name: `Mgr group ${RUN}`, managerId: ctx.c.id });
      assert.equal(bad.status, 400, bad.text); assert.match(bad.message!, /is not marked as a manager/);
      const ok = await call(admin, 'POST', '/config/groups', { name: `Mgr group ${RUN}`, managerId: ctx.b.id });
      assert.equal(ok.status, 201, ok.text); ctx.g = ok.json;
      assert.equal(ok.json.managerId, ctx.b.id); assert.equal(ok.json.managerName, `SupB Person${RUN}`);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.g.id}`)).json.managerName, `SupB Person${RUN}`);
    });

    it('can be changed or cleared, and the change is in the history', async () => {
      assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { managerId: ctx.a.id })).status, 400, 'a supervisor is not a manager');
      const moved = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { managerId: ctx.d.id });
      assert.equal(moved.status, 200, moved.text); assert.equal(moved.json.managerName, `SupD Person${RUN}`);
      assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { description: 'edited' })).json.managerId, ctx.d.id, 'editing something else keeps it');
      const h = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/history`)).json;
      assert.ok(h.some((x: any) => x.changes.some((c: any) => c.field === 'managerName' && c.to === `SupD Person${RUN}`)), JSON.stringify(h.map((x: any) => x.changes)));
    });

    it('a manager who still runs a group keeps the mark', async () => {
      const r = await call(admin, 'PUT', `/workforce/employees/${ctx.d.id}`, { reason: 'Test change', isManager: false });
      assert.equal(r.status, 409, r.text); assert.match(r.message!, new RegExp(`manages Mgr group ${RUN}`));
      assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { managerId: null })).json.managerId, null);
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${ctx.d.id}`, { reason: 'Test change', isManager: false })).status, 200);
    });

    it('a copy of a group keeps its manager', async () => {
      await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { managerId: ctx.b.id });
      const c = await call(admin, 'POST', `/config/groups/${ctx.g.id}/clone`, { name: `Mgr copy ${RUN}` });
      assert.equal(c.status, 201, c.text); assert.equal(c.json.managerId, ctx.b.id);
    });
  });
});
