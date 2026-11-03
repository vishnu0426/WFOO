/**
 * Signing in when the employee does not know the organisation code: what the server says, finding an organisation by email, and the code and link
 * an administrator gets with a new login. The cases with two organisations need a second one in the database, which the test adds directly
 * (TEST_DATABASE_URL, a throwaway database). Without it only the single-organisation cases run.
 *   BASE_URL=http://localhost:4003 ADMIN_PASSWORD=... TENANT=ORG TEST_DATABASE_URL=postgres://... PORTAL_URL=http://localhost:3001 npx tsx --test test/orgLoginApi.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB = process.env.TEST_DATABASE_URL || '';
const PORTAL = (process.env.PORTAL_URL || '').replace(/\/+$/, '');
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, code: json?.error?.code as string | undefined, message: json?.error?.message as string | undefined };
}
const login = (body: Record<string, unknown>) => call(null, 'POST', '/auth/login', body);

let admin = '';
let two = false;        // the server has more than one organisation (this test added one, or an earlier test file left one behind)
let seeded = false;     // this test added a second organisation with people in it
const SAM = `sam.${RUN}@globex.test`, SHARED = `pat.${RUN}@both.test`;

describe('signing in without knowing the organisation code', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    if (DB) {   // a second organisation, with a person of its own and one who works for both
      const c = new pg.Client({ connectionString: DB }); await c.connect();
      try {
        await c.query('SET search_path TO wfm');
        let t = (await c.query(`SELECT id FROM tenants WHERE code = 'GLOBEX'`)).rows[0];
        if (!t) t = (await c.query(`INSERT INTO tenants (name, code, timezone) VALUES ('Globex Corp', 'GLOBEX', 'UTC') RETURNING id`)).rows[0];
        const hash = await bcrypt.hash('Passw0rd!Passw0rd', 4);
        const org = (await c.query(`SELECT id FROM tenants WHERE code = $1`, [TENANT])).rows[0];
        for (const [tid, user, email] of [[t.id, `sam${RUN}`, SAM], [t.id, `pat${RUN}`, SHARED], [org.id, `pat${RUN}`, SHARED]]) {
          await c.query(`INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, status) VALUES ($1, $2, $2, $3, 'AGENT', $4, 'ACTIVE') ON CONFLICT DO NOTHING`, [tid, user, email, hash]);
        }
        seeded = true;
      } finally { await c.end(); }
    }
    const r = await login({ username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token;
    two = (await call(null, 'GET', '/auth/login-options')).json?.singleOrganisation === null;     // ask the server: api.test.ts leaves an organisation of its own behind
  });

  it('tells the sign-in screen whether one organisation is enough', async () => {
    const o = await call(null, 'GET', '/auth/login-options');
    assert.equal(o.status, 200, o.text); assert.equal(o.json.discovery, true);
    if (two) assert.equal(o.json.singleOrganisation, null, 'two organisations, so the screen has to ask which');
    else assert.equal(o.json.singleOrganisation.code.toLowerCase(), TENANT.toLowerCase());
  });

  it('says in plain words what to do when the code is missing or wrong', async (t) => {
    if (!two) return t.skip('needs a second organisation');
    const blank = await login({ username: 'admin', password: PASSWORD });
    assert.equal(blank.status, 400, blank.text); assert.equal(blank.code, 'ORG_REQUIRED');
    assert.match(blank.message!, /organisation code from your welcome message/); assert.match(blank.message!, /Find my organisation/);
    const wrong = await login({ username: 'admin', password: PASSWORD, tenant: 'NOPE' });
    assert.equal(wrong.status, 400, wrong.text); assert.equal(wrong.code, 'ORG_UNKNOWN');
    assert.equal(wrong.message, "We couldn't find that organisation. Check the code on your welcome message, or ask your manager.");
    assert.equal((await login({ username: 'admin', password: PASSWORD, tenant: TENANT.toLowerCase() })).status, 200, 'the code is not case sensitive');
  });

  it('a blank code still works when there is only one organisation', async (t) => {
    if (two) return t.skip('there are two organisations');
    assert.equal((await login({ username: 'admin', password: PASSWORD })).status, 200);
  });

  it('checks a code that came from a link, an address or the last sign-in on the device', async () => {
    const ok = await call(null, 'GET', `/auth/org/${TENANT.toLowerCase()}`);
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.code.toLowerCase(), TENANT.toLowerCase()); assert.ok(ok.json.name);
    assert.deepEqual(Object.keys(ok.json).sort(), ['code', 'name'], 'nothing else about the organisation is given away');
    for (const bad of ['NOPE', 'a%20b', '..%2Fx', 'x'.repeat(41)]) {
      const r = await call(null, 'GET', `/auth/org/${bad}`);
      assert.equal(r.status, 404, `${bad}: ${r.text}`); assert.equal(r.code, 'ORG_UNKNOWN');
    }
  });

  it('finds the organisation from an email, and lets someone who works for two choose', async (t) => {
    if (!seeded) return t.skip('needs a second organisation with people in it (TEST_DATABASE_URL)');
    const one = await call(null, 'POST', '/auth/discover', { identifier: SAM.toUpperCase() });
    assert.equal(one.status, 200, one.text); assert.deepEqual(one.json.organisations, [{ code: 'GLOBEX', name: 'Globex Corp' }]);
    const both = await call(null, 'POST', '/auth/discover', { identifier: SHARED });
    assert.deepEqual(both.json.organisations.map((o: any) => o.code).sort(), ['GLOBEX', TENANT.toUpperCase()].sort());
    const byName = await call(null, 'POST', '/auth/discover', { identifier: `sam${RUN}` });
    assert.equal(byName.json.organisations.length, 1, 'a username works as well as an email');
    assert.deepEqual((await call(null, 'POST', '/auth/discover', { identifier: `nobody.${RUN}@nowhere.test` })).json.organisations, []);
    assert.equal((await call(null, 'POST', '/auth/discover', { identifier: 'ab' })).status, 400, 'too short to mean anything');
  });

  it('the code found that way signs the person in', async (t) => {
    if (!seeded) return t.skip('needs a second organisation with people in it (TEST_DATABASE_URL)');
    const r = await login({ username: SAM, password: 'Passw0rd!Passw0rd', tenant: 'GLOBEX' });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.tenant.code, 'GLOBEX');
    assert.equal((await login({ username: `sam${RUN}`, password: 'Passw0rd!Passw0rd', tenant: 'GLOBEX' })).status, 200, 'the username still works');
    assert.equal((await login({ username: SAM, password: 'wrong-password', tenant: 'GLOBEX' })).status, 401);
  });

  it('hands the administrator the code, the sign-in link and a message to paste, when a login is made', async () => {
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `OL${RUN}`, firstName: 'Olive', lastName: 'Login', weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e.status, 201, e.text);
    const made = await call(admin, 'POST', '/self-service/logins', { employeeId: e.json.id });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.organisation.code.toLowerCase(), TENANT.toLowerCase()); assert.ok(made.json.organisation.name);
    assert.match(made.json.welcomeMessage, new RegExp(made.json.username)); assert.ok(made.json.welcomeMessage.includes(made.json.password));
    assert.ok(made.json.welcomeMessage.includes(made.json.organisation.code));
    if (PORTAL) { assert.equal(made.json.signInUrl, `${PORTAL}/?org=${encodeURIComponent(made.json.organisation.code)}`); assert.ok(made.json.welcomeMessage.includes(made.json.signInUrl)); }
    else assert.equal(made.json.signInUrl, null);
    const reset = await call(admin, 'PUT', `/self-service/logins/${made.json.userId}/reset-password`, {});
    assert.equal(reset.status, 200, reset.text); assert.ok(reset.json.welcomeMessage.includes(reset.json.password)); assert.notEqual(reset.json.password, made.json.password);
  });
});
