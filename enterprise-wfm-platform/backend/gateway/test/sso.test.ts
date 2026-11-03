/**
 * Single sign-on (OpenID Connect with PKCE) against a mock identity provider that really signs tokens, and SCIM user provisioning.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown, root = '/api/v1') {
  const r = await fetch(`${BASE}${root}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

/** An identity provider good enough to test against: discovery, authorize, token (with PKCE), keys. */
function mockProvider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { challenge: string; nonce: string; user: Record<string, unknown> }>();
  const state = { next: { email: '', name: '', groups: [] as string[] } as Record<string, unknown>, tamper: '' as '' | 'audience' | 'nonce' | 'expired' | 'otherKey', secret: 's3cret' };
  let issuer = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', issuer || 'http://x');
    const json = (o: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks.json` });
    if (u.pathname === '/jwks.json') return json({ keys: [jwk] });
    if (u.pathname === '/authorize') {
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, user: { ...state.next } });
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state')!);
      res.statusCode = 302; res.setHeader('Location', back.toString()); return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const f = new URLSearchParams(body), c = codes.get(f.get('code') ?? '');
        res.setHeader('Content-Type', 'application/json');
        if (!c || f.get('client_secret') !== state.secret || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
        codes.delete(f.get('code')!);
        const other = state.tamper === 'otherKey' ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : privateKey;
        const idToken = jwt.sign({ ...c.user, sub: String(c.user.email), nonce: state.tamper === 'nonce' ? 'wrong' : c.nonce }, other, {
          algorithm: 'RS256', keyid: 'k1', issuer, audience: state.tamper === 'audience' ? 'somebody-else' : 'wfm-client', ...(state.tamper === 'expired' ? { expiresIn: -3600 } : { expiresIn: 300 }),
        });
        res.end(JSON.stringify({ id_token: idToken, access_token: 'x', token_type: 'Bearer' }));
      });
    }
    res.statusCode = 404; res.end();
  });
  return { state, start: async () => { await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok)); issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; return issuer; }, stop: () => server.close() };
}

/** Walk the whole browser flow without a browser, and say where the platform sent the person at the end. */
async function signInThroughProvider(tenantCode = '_', query = '') {
  const start = await fetch(`${BASE}/api/v1/auth/sso/${tenantCode}/start${query}`, { redirect: 'manual' });
  assert.equal(start.status, 302, `start answered ${start.status}`);
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const cb = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { cookie } });
  assert.equal(cb.status, 302);
  const where = new URL(cb.headers.get('location')!);
  const hash = new URLSearchParams(where.hash.slice(1));
  return { token: hash.get('sso_token'), error: hash.get('sso_error'), cookie, callback: authorize.headers.get('location')!, origin: where.origin };
}

/** "Try sign-in": walk the test window's redirects without a browser, then read what the settings screen would read. */
async function tryThroughProvider(admin: string, body: Record<string, unknown>) {
  const started = await call(admin, 'POST', '/sso/try', body);
  if (started.status !== 200) return { started, result: null as any, go: '' };
  const go = new URL(started.json.url).pathname;
  const first = await fetch(`${BASE}${go}`, { redirect: 'manual' });
  assert.equal(first.status, 302, `the test link answered ${first.status}`);
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
  const authorize = await fetch(first.headers.get('location')!, { redirect: 'manual' });
  const back = await fetch(authorize.headers.get('location')!, { redirect: 'manual', headers: { cookie } });
  assert.equal(back.status, 200, 'the test window ends on a page, nobody is redirected into the app');
  const page = await back.text();
  assert.ok(!/sso_token/.test(page), 'no sign-in token is handed out');
  return { started, result: (await call(admin, 'GET', `/sso/try/${started.json.id}`)).json, go, page };
}

describe('single sign-on', () => {
  let admin = '', idp: ReturnType<typeof mockProvider>, issuer = '';
  const cfg = (o: Record<string, unknown> = {}) => ({ name: 'Company login', issuer, clientId: 'wfm-client', clientSecret: 's3cret', scopes: 'openid profile email', usernameClaim: 'email', groupClaim: 'groups', groupRoles: {}, defaultRole: 'AGENT', jit: false, syncRole: false, passwordLogin: true, enabled: true, ...o });
  /** Switching on needs a tried sign-in: do one first, as the settings screen does. */
  const tryIt = async (o: Record<string, unknown> = {}) => {
    const keep = idp.state.next; idp.state.next = { email: email('sam'), name: 'Sam Existing', groups: [] };
    try { const t = await tryThroughProvider(admin, cfg(o)); assert.equal(t.result?.status, 'done', JSON.stringify(t.result ?? t.started.json)); return t; } finally { idp.state.next = keep; }
  };
  const put = async (o: Record<string, unknown> = {}) => { if (cfg(o).enabled || cfg(o).passwordLogin === false) await tryIt(o); const r = await call(admin, 'PUT', '/sso/config', cfg(o)); assert.equal(r.status, 200, r.text); return r.json; };
  const email = (tag: string) => `${tag}${RUN}@example.com`;

  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    idp = mockProvider(); issuer = await idp.start();
  });
  after(async () => { await call(admin, 'PUT', '/sso/config', cfg({ enabled: false, passwordLogin: true })); idp.stop(); });

  it('will not switch on a provider that cannot be reached, and shows the address to register', async () => {
    const dead = await call(admin, 'PUT', '/sso/config', cfg({ issuer: 'http://127.0.0.1:9/nothing' }));
    assert.equal(dead.status, 400, dead.text);
    assert.match(dead.text, /Cannot reach/);
    assert.equal((await call(admin, 'POST', '/sso/test', { issuer })).json.ok, true);
    const c = await put({ enabled: false });
    assert.match(c.redirectUri, /\/api\/v1\/auth\/sso\/callback$/);
    assert.equal(c.hasSecret, true);
    assert.ok(!JSON.stringify(c).includes('s3cret'), 'the client secret is never sent back');
    const info = await call(null, 'GET', `/auth/sso/${TENANT}/info`);
    assert.equal(info.json.enabled, false);
  });

  it('signs an existing user in, with the role they already have', async () => {
    const u = await call(admin, 'POST', '/users', { username: `sam${RUN}`, displayName: 'Sam Existing', email: email('sam'), role: 'ANALYST', password: 'Sam#Pass12345' });
    assert.equal(u.status, 201, u.text);
    await put();
    assert.equal((await call(null, 'GET', `/auth/sso/${TENANT}/info`)).json.enabled, true);
    idp.state.next = { email: email('sam'), name: 'Sam Existing', groups: [] };
    const r = await signInThroughProvider(TENANT);
    assert.ok(r.token, r.error ?? 'no token');
    const who = await call(r.token, 'GET', '/auth/me');
    assert.equal(who.status, 200, who.text);
    assert.equal(who.json.user?.role ?? who.json.role, 'ANALYST');
  });

  it('refuses someone who is not set up when creating accounts is off', async () => {
    idp.state.next = { email: email('stranger'), name: 'Stranger', groups: [] };
    const r = await signInThroughProvider(TENANT);
    assert.equal(r.token, null);
    assert.match(r.error!, /not set up/i);
  });

  it('creates the account on first sign-in when allowed, with the role their group maps to', async () => {
    await put({ jit: true, groupRoles: { 'WFM-Schedulers': 'SCHEDULER', 'WFM-All': 'AGENT' }, defaultRole: 'AGENT' });
    idp.state.next = { email: email('newhire'), name: 'New Hire', groups: ['WFM-All', 'WFM-Schedulers'] };
    const r = await signInThroughProvider(TENANT);
    assert.ok(r.token, r.error ?? '');
    const who = await call(r.token, 'GET', '/auth/me');
    assert.equal(who.json.user?.role ?? who.json.role, 'AGENT', 'the first group that matches wins');
    idp.state.next = { email: email('lead'), name: 'Team Lead', groups: ['WFM-Schedulers'] };
    const lead = await signInThroughProvider(TENANT);
    assert.equal((await call(lead.token, 'GET', '/auth/me')).json.user?.role ?? (await call(lead.token, 'GET', '/auth/me')).json.role, 'SCHEDULER');
    idp.state.next = { email: email('nogroup'), name: 'No Group', groups: [] };
    const plain = await signInThroughProvider(TENANT);
    assert.equal((await call(plain.token, 'GET', '/auth/me')).json.user?.role ?? (await call(plain.token, 'GET', '/auth/me')).json.role, 'AGENT', 'the default role');
  });

  it('keeps roles in step with the provider only when asked to', async () => {
    idp.state.next = { email: email('newhire'), name: 'New Hire', groups: ['WFM-Schedulers'] };
    const before = await signInThroughProvider(TENANT);
    const role = async (t: string) => { const m = await call(t, 'GET', '/auth/me'); return m.json.user?.role ?? m.json.role; };
    assert.equal(await role(before.token!), 'AGENT', 'not synced: the role stays');
    await put({ jit: true, syncRole: true, groupRoles: { 'WFM-Schedulers': 'SCHEDULER' } });
    const after = await signInThroughProvider(TENANT);
    assert.equal(await role(after.token!), 'SCHEDULER');
  });

  it('refuses a switched-off account', async () => {
    const list = (await call(admin, 'GET', '/users')).json as any[];
    const sam = list.find((x) => x.username === `sam${RUN}`);
    assert.equal((await call(admin, 'PATCH', `/users/${sam.id}`, { status: 'DISABLED' })).status, 200);
    idp.state.next = { email: email('sam'), name: 'Sam', groups: [] };
    const r = await signInThroughProvider(TENANT);
    assert.equal(r.token, null);
    assert.match(r.error!, /switched off/i);
  });

  it('rejects an id token that is for another application, has the wrong nonce, is expired or is signed with a key the provider does not publish', async () => {
    idp.state.next = { email: email('newhire'), name: 'New Hire', groups: [] };
    for (const t of ['audience', 'nonce', 'expired', 'otherKey'] as const) {
      idp.state.tamper = t;
      const r = await signInThroughProvider(TENANT);
      assert.equal(r.token, null, `${t} was accepted`);
      assert.ok(r.error, t);
    }
    idp.state.tamper = '';
  });

  it('rejects a callback that does not belong to this browser, or a reused code', async () => {
    idp.state.next = { email: email('newhire'), name: 'New Hire', groups: [] };
    const ok = await signInThroughProvider(TENANT);
    assert.ok(ok.token);
    const replay = await fetch(ok.callback, { redirect: 'manual', headers: { cookie: ok.cookie } });
    assert.match(decodeURIComponent(new URL(replay.headers.get('location')!).hash), /sso_error/);
    const noCookie = await fetch(ok.callback, { redirect: 'manual' });
    assert.match(decodeURIComponent(new URL(noCookie.headers.get('location')!).hash), /sso_error/);
  });

  it('can require single sign-on for everyone except the administrator', async () => {
    await put({ passwordLogin: false });
    const blocked = await call(null, 'POST', '/auth/login', { username: email('newhire'), password: 'whatever', tenant: TENANT });
    assert.equal(blocked.status, 403, blocked.text);
    assert.equal(blocked.json.error.code, 'SSO_REQUIRED');
    const adminStill = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(adminStill.status, 200, 'the administrator can always sign in with a password');
    await put({ passwordLogin: true });
  });

  it('will not switch single sign-on on, or passwords off, until a sign-in has been tried with that exact setup', async () => {
    const odd = { scopes: 'openid profile email phone' };          // a setup nobody has tried yet
    const on = await call(admin, 'PUT', '/sso/config', cfg({ ...odd, enabled: true }));
    assert.equal(on.status, 400, on.text); assert.match(on.text, /Try sign-in first/);
    const off = await call(admin, 'PUT', '/sso/config', cfg({ ...odd, enabled: true, passwordLogin: false }));
    assert.equal(off.status, 400);
    assert.equal((await call(admin, 'PUT', '/sso/config', cfg({ ...odd, enabled: false }))).status, 200, 'saving it switched off is always allowed');
    await tryIt(odd);
    assert.equal((await call(admin, 'PUT', '/sso/config', cfg({ ...odd, enabled: true }))).status, 200, 'tried: now it can be switched on');
    const wrongSecret = await call(admin, 'PUT', '/sso/config', cfg({ ...odd, clientSecret: 'changed', enabled: true }));
    assert.equal(wrongSecret.status, 400, 'changing the secret needs a new try');
    const saved = (await call(admin, 'GET', '/sso/config')).json;
    assert.equal(saved.tested?.ok, true);
    await put({ enabled: false });
  });

  it('shows what the provider sent and what would happen, and signs nobody in', async () => {
    const tina = await call(admin, 'POST', '/users', { username: `tina${RUN}`, displayName: 'Tina Active', email: email('tina'), role: 'ANALYST', password: 'Tina#Pass12345' });
    assert.equal(tina.status, 201, tina.text);
    idp.state.next = { email: email('tina'), name: 'Tina Active', groups: ['WFM-Schedulers', 'other'] };
    const t = await tryThroughProvider(admin, cfg({ groupRoles: { 'WFM-Schedulers': 'SCHEDULER' }, jit: false }));
    const r = t.result;
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.equal(r.login, email('tina')); assert.deepEqual(r.groups, ['WFM-Schedulers', 'other']); assert.equal(r.mappedRole, 'SCHEDULER');
    assert.equal(r.outcome.ok, true); assert.match(r.outcome.text, /would sign in as/);
    const names = r.claims.map((c: any) => c.name);
    assert.ok(names.includes('email') && names.includes('groups') && !names.includes('nonce') && !names.includes('exp'), names.join());
    assert.ok(!JSON.stringify(r).includes('id_token'));
    assert.equal(r.claims.find((c: any) => c.name === 'groups').list, true); assert.equal(r.claims.find((c: any) => c.name === 'email').list, false);
    // someone who is not set up, with creating people off: told plainly
    idp.state.next = { email: email('nobody'), name: 'Nobody', groups: [] };
    const n = (await tryThroughProvider(admin, cfg({ jit: false }))).result;
    assert.equal(n.outcome.ok, false); assert.match(n.outcome.text, /not set up/);
    const j = (await tryThroughProvider(admin, cfg({ jit: true, defaultRole: 'ANALYST' }))).result;
    assert.equal(j.outcome.ok, true); assert.match(j.outcome.text, /created as ANALYST/);
    // groups that are IDs get a hint; a missing claim is said
    idp.state.next = { email: email('sam'), name: 'Sam', groups: ['123e4567-e89b-12d3-a456-426614174000'] };
    assert.ok((await tryThroughProvider(admin, cfg())).result.hints.some((h: string) => /IDs/.test(h)));
    idp.state.next = { email: email('sam'), name: 'Sam' };
    assert.ok((await tryThroughProvider(admin, cfg())).result.hints.some((h: string) => /no "groups" claim/.test(h)));
    idp.state.next = { email: '', name: 'No email' };
    const none = (await tryThroughProvider(admin, cfg())).result;
    assert.equal(none.outcome.ok, false); assert.match(none.outcome.text, /did not send "email"/);
  });

  it('a test link works once, belongs to its organisation, and a wrong secret is explained and does not count', async () => {
    idp.state.next = { email: email('sam'), name: 'Sam', groups: [] };
    const t = await tryThroughProvider(admin, cfg());
    const again = await fetch(`${BASE}${t.go}`, { redirect: 'manual' });
    assert.equal(again.status, 200); assert.match(await again.text(), /expired or was already used/);
    assert.equal((await call(null, 'GET', `/sso/try/${t.started.json.id}`)).status, 401);
    assert.equal((await call(admin, 'GET', '/sso/try/not-an-id')).json.status, 'expired');
    const bad = await tryThroughProvider(admin, cfg({ clientSecret: 'wrong-secret', scopes: 'openid profile email address' }));
    assert.equal(bad.result.status, 'error'); assert.match(bad.result.error, /Client secret/);
    const refused = await call(admin, 'PUT', '/sso/config', cfg({ clientSecret: 'wrong-secret', scopes: 'openid profile email address', enabled: true }));
    assert.equal(refused.status, 400, 'a failed try does not allow switching on');
  });

  it('sends the person back to the employee portal when the sign-in began there, and to the admin app otherwise', async () => {
    const portal = process.env.PORTAL_URL || 'http://localhost:3001', app = process.env.APP_URL || 'http://localhost:3000';
    // the gateway under test must know these too; without PORTAL_URL it answers "?to=portal" with an error page and the walk below fails confusingly
    assert.equal((await call(null, 'GET', `/auth/sso/${TENANT}/info`)).json?.portal, true, 'start the gateway under test with PORTAL_URL (and APP_URL) set, the same as this test process: see test/README.md');
    await put({ jit: true, defaultRole: 'AGENT' });
    idp.state.next = { email: email('portalguy'), name: 'Portal Guy', groups: [] };
    const viaPortal = await signInThroughProvider(TENANT, '?to=portal');
    assert.ok(viaPortal.token, viaPortal.error ?? ''); assert.equal(viaPortal.origin, portal);
    const viaApp = await signInThroughProvider(TENANT);
    assert.equal(viaApp.origin, app);
    for (const evil of ['?to=https://evil.example', '?to=//evil.example', '?to=app', '?to=Portal']) {
      const r = await signInThroughProvider(TENANT, evil);
      assert.equal(r.origin, app, `${evil} must not choose an address`);
    }
    // a failure goes back to where the person started, with the reason
    idp.state.tamper = 'nonce';
    const failed = await signInThroughProvider(TENANT, '?to=portal');
    idp.state.tamper = '';
    assert.equal(failed.token, null); assert.ok(failed.error); assert.equal(failed.origin, portal);
    const info = (await call(null, 'GET', `/auth/sso/${TENANT}/info`)).json;
    assert.equal(info.portal, true);
    assert.match(info.start, new RegExp(`^${BASE.replace(/[.:/]/g, '\\$&')}/api/v1/auth/sso/${TENANT}/start\\?to=portal$`), 'an absolute start address on the public address');
  });

  it('links the new login to the employee record with the same email, so the portal has something to show', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `SsoLink ${RUN}` });
    assert.equal(g.status, 201, g.text);
    const mk = async (n: string, mail: string | null) => { const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SL${RUN}${n}`, firstName: 'Link', lastName: n, email: mail, primaryGroupId: g.json.id, weeklyContractHours: 40, maxWeeklyHours: 40 }); assert.equal(e.status, 201, e.text); return e.json; };
    const me = async (t: string) => (await call(t, 'GET', '/auth/me')).json;
    const emp = await mk('One', email('linkone'));
    await put({ jit: true });
    idp.state.next = { email: email('linkone'), name: 'Link One', groups: [] };
    const a = await signInThroughProvider(TENANT);
    assert.equal((await me(a.token!)).user?.employeeId ?? (await me(a.token!)).employeeId, emp.id, 'linked on first sign-in');
    // two employees with the same email: nobody is guessed
    await mk('Twin1', email('twin')); await mk('Twin2', email('twin'));
    idp.state.next = { email: email('twin'), name: 'Twin', groups: [] };
    const t = await signInThroughProvider(TENANT);
    assert.ok(t.token, t.error ?? '');
    assert.equal((await me(t.token!)).user?.employeeId ?? (await me(t.token!)).employeeId ?? null, null, 'ambiguous: not linked');
    // an account that existed without a link gets linked at its next sign-in
    const solo = await mk('Solo', email('solo'));
    const pre = await call(admin, 'POST', '/users', { username: `solo${RUN}`, displayName: 'Solo', email: email('solo'), role: 'AGENT', password: 'Solo#Pass123456' });
    assert.equal(pre.status, 201, pre.text);
    idp.state.next = { email: email('solo'), name: 'Solo', groups: [] };
    const s2 = await signInThroughProvider(TENANT);
    assert.equal((await me(s2.token!)).user?.employeeId ?? (await me(s2.token!)).employeeId, solo.id, 'an existing unlinked account is linked');
  });

  it('tells the administrator, in the sign-in test, whether the employee portal will have something to show', async () => {
    const g = (await call(admin, 'POST', '/config/groups', { name: `SsoTry ${RUN}` })).json;
    const mk = (n: string, mail: string) => call(admin, 'POST', '/workforce/employees', { employeeNumber: `ST${RUN}${n}`, firstName: 'Try', lastName: n, email: mail, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal((await mk('A', email('tryhas'))).status, 201);
    idp.state.next = { email: email('tryhas'), name: 'Try Has', groups: [] };
    const yes = (await tryThroughProvider(admin, cfg({ jit: true }))).result;
    assert.equal(yes.employee.ok, true); assert.match(yes.employee.text, /linked to employee Try A/i);
    idp.state.next = { email: email('trynone'), name: 'Try None', groups: [] };
    const none = (await tryThroughProvider(admin, cfg({ jit: true }))).result;
    assert.equal(none.employee.ok, false); assert.match(none.employee.text, /No employee record has the email/);
    assert.equal(none.outcome.ok, true, 'the admin app still works, only the portal is affected');
  });
});

describe('SCIM provisioning', () => {
  let admin = '', token = '';
  const scim = (method: string, path: string, body?: unknown, tok = token) => call(tok, method, path, body, '/scim/v2');
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    admin = r.json.token;
    const t = await call(admin, 'POST', '/developer/scim-token', {});
    assert.equal(t.status, 201, t.text);
    token = t.json.key;
  });

  it('needs its own token: nothing else gets in, and it opens nothing else', async () => {
    assert.equal((await scim('GET', '/Users', undefined, '')).status, 401);
    assert.equal((await scim('GET', '/Users', undefined, admin)).status, 401, 'a person’s session is not a SCIM token');
    const normal = await call(admin, 'POST', '/developer/keys', { name: `plain ${RUN}`, scopes: ['schedule:read'] });
    assert.equal((await scim('GET', '/Users', undefined, normal.json.key)).status, 403, 'an ordinary key is not a SCIM token');
    assert.equal((await call(token, 'GET', '/scheduling/versions')).status, 403, 'a SCIM token reads nothing else');
    assert.equal((await scim('GET', '/ServiceProviderConfig')).json.patch.supported, true);
  });

  let id = '';
  it('creates, finds, updates, switches off and re-enables a user the way an identity provider does', async () => {
    const name = `scim.${RUN}@example.com`;
    const c = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: name, displayName: 'Scim Person', emails: [{ value: name, primary: true }], roles: [{ value: 'SCHEDULER' }], active: true });
    assert.equal(c.status, 201, c.text);
    id = c.json.id;
    assert.equal(c.json.roles[0].value, 'SCHEDULER');
    assert.equal(c.json.active, true);
    assert.equal((await scim('POST', '/Users', { userName: name })).status, 409, 'userName must be unique');
    const found = await scim('GET', `/Users?filter=${encodeURIComponent(`userName eq "${name}"`)}`);
    assert.equal(found.json.totalResults, 1);
    assert.equal(found.json.Resources[0].id, id);
    assert.equal((await scim('GET', `/Users?filter=${encodeURIComponent('displayName co "x"')}`)).status, 400);
    const off = await scim('PATCH', `/Users/${id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: false }] });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.active, false);
    const login = await call(null, 'POST', '/auth/login', { username: name, password: 'x', tenant: TENANT });
    assert.equal(login.status, 401);
    const on = await scim('PATCH', `/Users/${id}`, { Operations: [{ op: 'replace', value: { active: true, displayName: 'Renamed Person' } }] });
    assert.equal(on.json.active, true);
    assert.equal(on.json.displayName, 'Renamed Person');
    assert.equal(on.json.roles[0].value, 'SCHEDULER', 'a patch leaves what it does not mention');
    const put = await scim('PUT', `/Users/${id}`, { userName: name, displayName: 'Replaced', emails: [{ value: name }], roles: [{ value: 'ANALYST' }], active: true });
    assert.equal(put.json.displayName, 'Replaced');
    assert.equal(put.json.roles[0].value, 'ANALYST');
  });

  it('links a user to their employee record and deletes by switching off', async () => {
    await call(admin, 'POST', '/config/groups', { name: `Scim grp ${RUN}` });
    await call(admin, 'POST', '/workforce/teams', { name: `Scim team ${RUN}` });
    await call(admin, 'POST', '/workforce/employees/import', { csv: `employee_number,first_name,last_name,team,wfm_group\nSC${RUN},Link,Me,Scim team ${RUN},Scim grp ${RUN}`, dryRun: false });
    const ext = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
    const c = await scim('POST', '/Users', { userName: `link.${RUN}@example.com`, displayName: 'Link Me', [ext]: { employeeNumber: `SC${RUN}` } });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.json[ext].employeeNumber, `SC${RUN}`);
    assert.equal((await scim('DELETE', `/Users/${c.json.id}`)).status, 204);
    const after = await scim('GET', `/Users/${c.json.id}`);
    assert.equal(after.json.active, false, 'the account stays, switched off, so the audit trail is whole');
    assert.equal((await scim('GET', '/Users/00000000-0000-0000-0000-000000000000')).status, 404);
  });

  it('is recorded in the audit log', async () => {
    const log = await call(admin, 'GET', '/audit?entityType=USER&limit=50');
    assert.equal(log.status, 200, log.text);
    const rows = log.json.items ?? log.json;
    assert.ok(JSON.stringify(rows).includes('SCIM'), 'provisioning changes are audited');
  });
});
