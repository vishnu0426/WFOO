/**
 * What a team lead can approve from the employee portal: /me/approvals and /me/approvals/count.
 * A supervisor sees their own teams' waiting time off (with how many teammates are already off), a manager sees everyone's, nobody sees their own request,
 * and a colleague with no one to approve has no Approvals section.
 *   BASE_URL=http://localhost:4011 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test-force-exit --test test/approvalsMeApi.test.ts
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
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (offset: number) => { const x = new Date(); x.setDate(x.getDate() + offset); return iso(x); };

let admin = '';
const ctx: Record<string, any> = {};
const emp = async (n: string, extra: Record<string, unknown> = {}) => {
  const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `AM${RUN}-${n}`, firstName: `Am${n}`, lastName: `Run${RUN}`, primaryGroupId: ctx.group.id, ...extra });
  assert.equal(r.status, 201, r.text); return r.json;
};
const login = async (employeeId: string, role: 'AGENT' | 'SUPERVISOR_RTA') => {
  const c = await call(admin, 'POST', '/self-service/logins', { employeeId, role }); assert.equal(c.status, 201, c.text);
  const t = await call(null, 'POST', '/auth/login', { username: c.json.username, password: c.json.password, tenant: TENANT }); assert.equal(t.status, 200, t.text);
  return t.json.token as string;
};
const request = async (token: string, from: number, to = from) => {
  const r = await call(token, 'POST', '/me/time-off', { type: 'VACATION', startDate: day(from), endDate: day(to), reason: 'Family' });
  assert.equal(r.status, 201, r.text); assert.equal(r.json.request.status, 'REQUESTED'); return r.json.request.id as string;
};
const setPolicy = async (patch: Record<string, unknown>) => { const cur = (await call(admin, 'GET', '/self-service/policy')).json; const r = await call(admin, 'PUT', '/self-service/policy', { ...cur, ...patch }); assert.equal(r.status, 200, r.text); };
const mine = async (tok: string) => (await call(tok, 'GET', '/me/approvals')).json;

describe('approvals from the employee portal', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token;
    ctx.group = (await call(admin, 'POST', '/config/groups', { name: `Portal approvals ${RUN}` })).json;
    await setPolicy({ timeOffAutoApprove: false, supervisorFirst: true, escalateHours: 24, limitSupervisorsToTeams: false });
    ctx.sup1 = await emp('S1', { isSupervisor: true }); ctx.sup2 = await emp('S2', { isSupervisor: true });
    ctx.t1 = (await call(admin, 'POST', '/workforce/teams', { name: `Alpha ${RUN}`, managerId: ctx.sup1.id })).json;
    ctx.t2 = (await call(admin, 'POST', '/workforce/teams', { name: `Bravo ${RUN}`, managerId: ctx.sup2.id })).json;
    ctx.a1 = await emp('A1', { teamId: ctx.t1.id }); ctx.a2 = await emp('A2', { teamId: ctx.t1.id }); ctx.b1 = await emp('B1', { teamId: ctx.t2.id });
    ctx.sup1Tok = await login(ctx.sup1.id, 'SUPERVISOR_RTA'); ctx.sup2Tok = await login(ctx.sup2.id, 'SUPERVISOR_RTA');
    ctx.a1Tok = await login(ctx.a1.id, 'AGENT'); ctx.a2Tok = await login(ctx.a2.id, 'AGENT'); ctx.b1Tok = await login(ctx.b1.id, 'AGENT');
  });

  it('a colleague with nobody to approve has no Approvals section', async () => {
    assert.deepEqual((await call(ctx.a1Tok, 'GET', '/me/approvals/count')).json, { access: false, count: 0 });
    const r = await mine(ctx.a1Tok); assert.equal(r.access, false); assert.deepEqual(r.timeOff, []);
  });

  it('a supervisor sees their own team\'s waiting requests, with how many teammates are already off, and not the other team\'s', async () => {
    const a2Id = await request(ctx.a2Tok, 70);                       // a teammate who is off in the same days
    assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${a2Id}/decide`, { status: 'APPROVED' })).status, 200);
    const a1Id = await request(ctx.a1Tok, 70, 71);
    const bId = await request(ctx.b1Tok, 70);
    const r = await mine(ctx.sup1Tok);
    assert.equal(r.access, true);
    const row = r.timeOff.find((x: any) => x.id === a1Id);
    assert.ok(row, 'their own team\'s request is listed');
    assert.equal(row.employeeName, `AmA1 Run${RUN}`); assert.equal(row.team, `Alpha ${RUN}`);
    assert.equal(row.days, 2); assert.equal(row.reason, 'Family'); assert.equal(row.escalated, false);
    assert.equal(row.teamSize, 1, 'one other person is in the team'); assert.equal(row.teamOff, 1, 'and they are already off in these days');
    assert.ok(!r.timeOff.some((x: any) => x.id === bId), 'the other team\'s request is not listed');
    assert.ok(!r.timeOff.some((x: any) => x.id === a2Id), 'a request already decided is not listed');
    assert.ok(Array.isArray(r.swaps));
    ctx.a1Id = a1Id; ctx.bId = bId;
  });

  it('the count and the list agree, and it drops when a request is decided', async () => {
    const before = (await call(ctx.sup1Tok, 'GET', '/me/approvals/count')).json;
    assert.equal(before.access, true); assert.equal(before.count, (await mine(ctx.sup1Tok)).timeOff.length + (await mine(ctx.sup1Tok)).swaps.length);
    const decide = await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${ctx.a1Id}/decide`, { status: 'REJECTED', reason: 'Too many off that week' });
    assert.equal(decide.status, 200, decide.text);
    assert.equal((await call(ctx.sup1Tok, 'GET', '/me/approvals/count')).json.count, before.count - 1);
    assert.ok(!(await mine(ctx.sup1Tok)).timeOff.some((x: any) => x.id === ctx.a1Id));
  });

  it('nobody sees their own request here', async () => {
    const own = await request(ctx.sup1Tok, 75);
    assert.ok(!(await mine(ctx.sup1Tok)).timeOff.some((x: any) => x.id === own), 'a supervisor\'s own request is not in their list');
    const all = (await mine(admin)).timeOff;
    assert.ok(all.some((x: any) => x.id === own), 'a manager sees it');
    assert.ok(all.some((x: any) => x.id === ctx.bId), 'and sees every team\'s waiting requests');
  });

  it('with first-line approval switched off, a supervisor has nothing to approve here', async () => {
    await setPolicy({ supervisorFirst: false });
    try { assert.deepEqual((await call(ctx.sup1Tok, 'GET', '/me/approvals/count')).json, { access: false, count: 0 }); }
    finally { await setPolicy({ supervisorFirst: true }); }
  });

  it('a request can be approved from the list, and then it is gone', async () => {
    const id = await request(ctx.b1Tok, 80);
    assert.ok((await mine(ctx.sup2Tok)).timeOff.some((x: any) => x.id === id));
    assert.equal((await call(ctx.sup2Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 200);
    assert.ok(!(await mine(ctx.sup2Tok)).timeOff.some((x: any) => x.id === id));
  });
});
