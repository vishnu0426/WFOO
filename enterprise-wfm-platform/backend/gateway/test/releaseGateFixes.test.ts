/**
 * Fixes from the production-readiness run: a disabled user's session, token in the URL, sign-in timing and audit, double-booked time off,
 * impossible dates, malformed JSON, spreadsheet formulas in the audit export, hire date bounds.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/releaseGateFixes.test.ts
 * Needs FORCE_PASSWORD_CHANGE=false on the gateway under test (users created here sign in directly).
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, raw?: unknown, rawBody?: string) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: rawBody ?? (raw === undefined ? undefined : JSON.stringify(raw)) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

let admin = '';
const ctx: Record<string, any> = {};

describe('release gate fixes', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('a disabled user is cut off at once, and a role change applies to the session they already have', async () => {
    const u = await call(admin, 'POST', '/users', { username: `gate${RUN}`, displayName: 'Gate User', role: 'ANALYST', password: 'Gate-Test-91x!' });
    assert.equal(u.status, 201, u.text);
    const login = await call(null, 'POST', '/auth/login', { username: `gate${RUN}`, password: 'Gate-Test-91x!', tenant: TENANT });
    assert.equal(login.status, 200, login.text);
    const t = login.json.token;
    assert.equal((await call(t, 'GET', '/workforce/employees?limit=1')).status, 200);
    assert.equal((await call(admin, 'PATCH', `/users/${u.json.id}`, { role: 'AGENT' })).status, 200);
    assert.equal((await call(t, 'GET', '/workforce/employees?limit=1')).status, 403, 'the new role applies to the old token');
    assert.equal((await call(admin, 'PATCH', `/users/${u.json.id}`, { status: 'DISABLED' })).status, 200);
    assert.equal((await call(t, 'GET', '/auth/me')).status, 401, 'old session still works after disabling');
  });

  it('a token in the URL is not accepted on REST routes', async () => {
    const r = await fetch(api(`/users?token=${encodeURIComponent(admin)}`));
    assert.equal(r.status, 401);
  });

  it('failed sign-ins are recorded in the audit log', async () => {
    const bad = await call(null, 'POST', '/auth/login', { username: 'admin', password: 'definitely-wrong', tenant: TENANT });
    assert.equal(bad.status, 401);
    const a = await call(admin, 'GET', '/audit?search=admin&limit=50');
    assert.equal(a.status, 200, a.text);
    const rows: any[] = a.json.rows ?? a.json.items ?? a.json;
    assert.ok(rows.some((x) => x.action === 'LOGIN_FAILED'), 'no LOGIN_FAILED entry');
  });

  it('a wrong password for an unknown user takes about as long as for a real one', async () => {
    const time = async (username: string) => { const t0 = performance.now(); await call(null, 'POST', '/auth/login', { username, password: 'wrong-pass-1', tenant: TENANT }); return performance.now() - t0; };
    const unknown = Math.min(await time(`nobody${RUN}a`), await time(`nobody${RUN}b`));
    assert.ok(unknown > 60, `unknown user answered in ${Math.round(unknown)} ms: no hashing happened`);
  });

  it('time off cannot be booked twice for the same person', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Gate ${RUN}` });
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `GT${RUN}`, firstName: 'Gate', lastName: 'Person', primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
    assert.equal(e.status, 201, e.text); ctx.emp = e.json;
    const first = await call(admin, 'POST', '/workforce/time-off', { employeeId: ctx.emp.id, type: 'VACATION', startDate: day(40), endDate: day(41), approve: true });
    assert.equal(first.status, 201, first.text);
    const overlap = await call(admin, 'POST', '/workforce/time-off', { employeeId: ctx.emp.id, type: 'VACATION', startDate: day(41), endDate: day(42), approve: true });
    assert.equal(overlap.status, 409, overlap.text);
    const apart = await call(admin, 'POST', '/workforce/time-off', { employeeId: ctx.emp.id, type: 'VACATION', startDate: day(43), endDate: day(43) });
    assert.equal(apart.status, 201, apart.text);
  });

  it('an impossible date is a 400, not a 500 with database text', async () => {
    const r = await call(admin, 'GET', '/workforce/time-off?from=2026-02-30');
    assert.equal(r.status, 400, r.text);
    assert.ok(!/date\/time field/i.test(r.text));
  });

  it('malformed JSON is a 400 with a clear code', async () => {
    const r = await call(admin, 'POST', '/config/groups', undefined, '{"name":');
    assert.equal(r.status, 400);
    assert.equal(r.json?.error?.code, 'BAD_JSON');
  });

  it('a hire date far in the future is refused', async () => {
    const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `HD${RUN}`, firstName: 'Far', lastName: 'Future', hireDate: '2099-01-01' });
    assert.equal(r.status, 400, r.text);
  });

  it('the audit export defuses names that start with =', async () => {
    const name = `=HYPERLINK("http://evil.example/","x")${RUN}`;
    await call(admin, 'POST', '/workforce/teams', { name });
    const r = await fetch(api('/audit/export.csv'), { headers: { Authorization: `Bearer ${admin}` } });
    const text = await r.text();
    assert.ok(!new RegExp(`(^|,)"?=HYPERLINK`).test(text), 'formula written raw');
    assert.ok(text.includes(`'=HYPERLINK`), 'neutralised cell not found');
  });

  it('a list that names nobody comes back a page at a time, says so, and can be narrowed by skill or answered with ids only', async () => {
    const all = await fetch(api('/workforce/employees'), { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(all.headers.get('x-page-limit'), '500', 'the whole company is never returned by accident');
    assert.ok(Number(all.headers.get('x-total-count')) >= 0);
    const g = await call(admin, 'POST', '/config/groups', { name: `Skillful ${RUN}` });
    const sk = await call(admin, 'POST', '/workforce/skills', { name: `Rare ${RUN}`, category: 'PRODUCTS' });
    assert.equal(sk.status, 201, sk.text);
    const made: string[] = [];
    for (let n = 0; n < 3; n++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SK${RUN}_${n}`, firstName: `Sk${n}`, lastName: `Skill${RUN}`, primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
      assert.equal(e.status, 201, e.text); made.push(e.json.id);
    }
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${made[0]}/skills`, { skills: [{ skillId: sk.json.id, proficiency: 3 }] })).status, 200);
    const inGroup = await fetch(api(`/workforce/employees?groupId=${g.json.id}`), { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(inGroup.headers.get('x-page-limit'), null, 'a group is a narrow enough list to come back whole');
    assert.equal(((await inGroup.json()) as any[]).length, 3);
    const skilled = await call(admin, 'GET', `/workforce/employees?groupId=${g.json.id}&skillIds=${sk.json.id}`);
    assert.deepEqual(skilled.json.map((e: any) => e.id), [made[0]], 'only the person who has the skill');
    const ids = await call(admin, 'GET', `/workforce/employees?groupId=${g.json.id}&fields=ids`);
    assert.deepEqual(ids.json.map((e: any) => Object.keys(e)), [['id'], ['id'], ['id']], 'ids and nothing else');
    assert.equal((await call(admin, 'GET', '/workforce/employees?skillIds=not-a-uuid')).status, 400);
  });

  it('employees are paged in the database: the true total, any offset, no overlap between pages', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Page ${RUN}` });
    for (let n = 0; n < 7; n++) assert.equal((await call(admin, 'POST', '/workforce/employees', { employeeNumber: `PG${RUN}-${n}`, firstName: `Pg${n}`, lastName: `Page${RUN}`, primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).status, 201);
    const get = async (qs: string) => { const r = await fetch(api(`/workforce/employees?q=${RUN}-&${qs}`), { headers: { Authorization: `Bearer ${admin}` } }); return { total: Number(r.headers.get('x-total-count')), rows: (await r.json()) as any[] }; };
    const all = (await get('')).rows;
    assert.equal(all.length, 7);
    const p1 = await get('limit=3&offset=0'), p2 = await get('limit=3&offset=3'), p3 = await get('limit=3&offset=6'), past = await get('limit=3&offset=40000');
    assert.deepEqual([p1.total, p2.total, p3.total, past.total], [7, 7, 7, 7]);
    assert.deepEqual([p1.rows.length, p2.rows.length, p3.rows.length, past.rows.length], [3, 3, 1, 0]);
    assert.deepEqual([...p1.rows, ...p2.rows, ...p3.rows].map((e) => e.id), all.map((e) => e.id), 'pages join up to the full list in the same order');
  });
});
