/**
 * Forced password change at first sign-in. Needs a gateway running WITH the feature on (FORCE_PASSWORD_CHANGE unset or true) and a fresh database,
 * because the bootstrap administrator is the first account that has to change a temporary password.
 *   BASE_URL=http://localhost:4002 ADMIN_PASSWORD=<the bootstrap password> TENANT=ORG npx tsx --test test/passwordChange.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const BOOTSTRAP = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, code: json?.error?.code as string | undefined };
}
const login = (username: string, password: string) => call(null, 'POST', '/auth/login', { username, password, tenant: TENANT });
const ADMIN_NEW = `Harbour-Lights-${RUN}-7`;
let adminToken = '';

describe('forced password change', () => {
  before(() => assert.ok(BOOTSTRAP, 'set ADMIN_PASSWORD to the bootstrap password of a fresh database'));

  describe('the bootstrap administrator', () => {
    let temp = '';
    it('is told to choose a new password and can do nothing else meanwhile', async () => {
      const r = await login('admin', BOOTSTRAP);
      assert.equal(r.status, 200, r.text); assert.equal(r.json.mustChangePassword, true); temp = r.json.token;
      const me = await call(temp, 'GET', '/auth/me');
      assert.equal(me.status, 200); assert.equal(me.json.mustChangePassword, true);
      for (const path of ['/workforce/employees', '/config/groups', '/users', '/scheduling/versions']) {
        const blocked = await call(temp, 'GET', path);
        assert.equal(blocked.status, 403, `${path}: ${blocked.text}`); assert.equal(blocked.code, 'PASSWORD_CHANGE_REQUIRED');
      }
      assert.equal((await call(temp, 'POST', '/workforce/teams', { name: 'nope' })).code, 'PASSWORD_CHANGE_REQUIRED', 'writes are blocked too');
    });
    it('cannot choose a password that is too weak, the same, or one of the usual guesses', async () => {
      const bad = async (next: string, match: RegExp) => { const r = await call(temp, 'POST', '/auth/change-password', { currentPassword: BOOTSTRAP, newPassword: next }); assert.equal(r.status, 400, `${next}: ${r.text}`); assert.match(r.json.error.message, match); };
      await bad('Short1!', /at least 8/);
      await bad(BOOTSTRAP, /different|too easy|at least/);
      await bad('Admin@123456', /too easy|username/);   // contains both the username and a usual guess
      await bad('admin-Harbour-1234', /username/);
      await bad('onlyletterspassword', /too easy|Mix letters/);
      assert.equal((await call(temp, 'GET', '/auth/me')).json.mustChangePassword, true, 'still on a temporary password');
    });
    it('needs the right current password', async () => {
      const r = await call(temp, 'POST', '/auth/change-password', { currentPassword: 'not-the-password', newPassword: ADMIN_NEW });
      assert.equal(r.status, 400); assert.match(r.json.error.message, /Current password is incorrect/);
    });
    it('gets a normal session once a good password is chosen, and the temporary one stops working', async () => {
      const r = await call(temp, 'POST', '/auth/change-password', { currentPassword: BOOTSTRAP, newPassword: ADMIN_NEW });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.mustChangePassword, false); assert.ok(r.json.token); adminToken = r.json.token;
      assert.equal((await call(adminToken, 'GET', '/workforce/employees')).status, 200, 'the new session works');
      assert.equal((await call(temp, 'GET', '/auth/me')).status, 401, 'the temporary session has ended');
      assert.equal((await login('admin', BOOTSTRAP)).status, 401, 'the old password no longer works');
      const again = await login('admin', ADMIN_NEW);
      assert.equal(again.status, 200); assert.equal(again.json.mustChangePassword, false);
    });
    it('is recorded in the audit trail without the password', async () => {
      const a = await call(adminToken, 'GET', '/audit?entityType=USER');
      if (a.status === 200) {
        const text = JSON.stringify(a.json);
        assert.match(text, /Replaced a temporary password/); assert.ok(!text.includes(ADMIN_NEW) && !text.includes(BOOTSTRAP));
      }
    });
  });

  describe('accounts an administrator creates or resets', () => {
    const USER = `temp${RUN}`, TEMP = 'Temporary#Pass-001';
    let userId = '';
    it('start on a temporary password', async () => {
      const c = await call(adminToken, 'POST', '/users', { username: USER, displayName: 'Temp User', role: 'ANALYST', password: TEMP });
      assert.equal(c.status, 201, c.text); userId = c.json.id;
      const r = await login(USER, TEMP);
      assert.equal(r.json.mustChangePassword, true);
      assert.equal((await call(r.json.token, 'GET', '/workforce/employees')).code, 'PASSWORD_CHANGE_REQUIRED');
      const done = await call(r.json.token, 'POST', '/auth/change-password', { currentPassword: TEMP, newPassword: 'Quiet-River-Stone-5' });
      assert.equal(done.status, 200, done.text);
      assert.equal((await call(done.json.token, 'GET', '/workforce/employees')).status, 200);
    });
    it('are asked again after an administrator resets the password, but not when someone sets their own through the user screen', async () => {
      assert.equal((await call(adminToken, 'PATCH', `/users/${userId}`, { password: 'Another#Temp-002' })).status, 200);
      assert.equal((await login(USER, 'Another#Temp-002')).json.mustChangePassword, true);
      const meId = (await call(adminToken, 'GET', '/auth/me')).json.user.id;
      assert.equal((await call(adminToken, 'PATCH', `/users/${meId}`, { password: `Own-Choice-${RUN}-9` })).status, 200);
      assert.equal((await login('admin', `Own-Choice-${RUN}-9`)).json.mustChangePassword, false, 'your own choice is not temporary');
    });
    it('stop after repeated wrong guesses of the current password', async () => {
      const r = await login(USER, 'Another#Temp-002');
      let last = 0;
      for (let i = 0; i < 6; i++) last = (await call(r.json.token, 'POST', '/auth/change-password', { currentPassword: `wrong-guess-${i}`, newPassword: 'Quiet-River-Stone-6' })).status;
      assert.equal(last, 429);
    });
  });

  describe('employees with an app login', () => {
    let login1: { username: string; password: string }, empId = '';
    it('get a temporary password that must be replaced before the app works', async () => {
      const g = await call(adminToken, 'POST', '/config/groups', { name: `Pw ${RUN}` });
      const e = await call(adminToken, 'POST', '/workforce/employees', { employeeNumber: `PW${RUN}`, firstName: 'Pia', lastName: 'Walker', primaryGroupId: g.json.id });
      assert.equal(e.status, 201, e.text); empId = e.json.id;
      const l = await call(adminToken, 'POST', '/self-service/logins', { employeeId: empId });
      assert.equal(l.status, 201, l.text); login1 = l.json;
      const s = await login(login1.username, login1.password);
      assert.equal(s.json.mustChangePassword, true);
      assert.equal((await call(s.json.token, 'GET', '/me/home')).code, 'PASSWORD_CHANGE_REQUIRED');
      assert.equal((await call(s.json.token, 'PUT', '/me/change-password', { currentPassword: login1.password, newPassword: 'Sunny-Meadow-Path-3' })).code, 'PASSWORD_CHANGE_REQUIRED', 'only /auth/change-password is open to a temporary session');
      const done = await call(s.json.token, 'POST', '/auth/change-password', { currentPassword: login1.password, newPassword: 'Sunny-Meadow-Path-3' });
      assert.equal(done.status, 200, done.text);
      assert.equal((await call(done.json.token, 'GET', '/me/home')).status, 200);
    });
    it('can change it again later without ending their session, under the same rules', async () => {
      const s = await login(login1.username, 'Sunny-Meadow-Path-3');
      assert.equal(s.json.mustChangePassword, false);
      assert.equal((await call(s.json.token, 'PUT', '/me/change-password', { currentPassword: 'Sunny-Meadow-Path-3', newPassword: 'short' })).status, 400);
      const ok = await call(s.json.token, 'PUT', '/me/change-password', { currentPassword: 'Sunny-Meadow-Path-3', newPassword: 'Silver-Lake-Morning-8' });
      assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.ok, true);
      assert.equal((await call(s.json.token, 'GET', '/me/home')).status, 200, 'the session they were using carries on');
    });
    it('are asked again after the administrator resets their password', async () => {
      const logins = (await call(adminToken, 'GET', '/self-service/logins')).json as { userId: string; employeeId: string }[];
      const mine = logins.find((x) => x.employeeId === empId)!;
      const reset = await call(adminToken, 'PUT', `/self-service/logins/${mine.userId}/reset-password`, {});
      assert.equal(reset.status, 200, reset.text);
      assert.equal((await login(reset.json.username, reset.json.password)).json.mustChangePassword, true);
    });
  });

  it('keeps a temporary session out of the live feed', async () => {
    const WebSocket = (globalThis as any).WebSocket;
    if (!WebSocket) return;
    const USER = `ws${RUN}`, TEMP = 'Temporary#Pass-003';
    await call(adminToken, 'POST', '/users', { username: USER, displayName: 'Ws', role: 'ANALYST', password: TEMP });
    const t = (await login(USER, TEMP)).json.token;
    const closed = await new Promise<number>((resolve) => { const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${t}`); ws.onclose = (e: any) => resolve(e.code); ws.onerror = () => resolve(-1); setTimeout(() => resolve(0), 4000); });
    assert.ok(closed === 4401 || closed === -1, `socket closed with ${closed}`);
  });
});
