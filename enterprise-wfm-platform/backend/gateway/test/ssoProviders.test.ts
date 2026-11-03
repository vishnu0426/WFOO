/**
 * The identity-provider list for single sign-on: what each provider asks for, the issuer built from it, and saving/testing through the API.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PRESETS, adminLinkFor, buildIssuer, catalogue, cleanHost, cleanValues, detect, domainAllowed, looksLikeIds, showClaims } from '../src/modules/ssoProviders.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const GUID = '123e4567-e89b-12d3-a456-426614174000';

describe('identity provider list (pure)', () => {
  it('builds each provider address from what was typed', () => {
    assert.equal(buildIssuer('entra', { tenant: GUID }), `https://login.microsoftonline.com/${GUID}/v2.0`);
    assert.equal(buildIssuer('entra', { tenant: 'Contoso.onmicrosoft.com' }), 'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0');
    assert.equal(buildIssuer('okta', { domain: 'https://Company.okta.com/' }), 'https://company.okta.com');
    assert.equal(buildIssuer('google', {}), 'https://accounts.google.com');
    assert.equal(buildIssuer('keycloak', { server: 'sso.company.com', realm: 'staff' }), 'https://sso.company.com/realms/staff');
    assert.equal(buildIssuer('keycloak', { server: 'https://sso.company.com/auth/', realm: 'staff' }), 'https://sso.company.com/auth/realms/staff');
    assert.equal(buildIssuer('auth0', { domain: 'company.eu.auth0.com' }), 'https://company.eu.auth0.com/');
    assert.equal(buildIssuer('onelogin', { subdomain: 'Company' }), 'https://company.onelogin.com/oidc/2');
    assert.equal(buildIssuer('pingone', { environment: GUID }), `https://auth.pingone.com/${GUID}/as`);
    assert.equal(buildIssuer('jumpcloud', {}), 'https://oauth.id.jumpcloud.com/');
    assert.equal(buildIssuer('generic', { issuer: 'https://login.company.com' }), 'https://login.company.com');
  });

  it('refuses wrong values with a plain reason', () => {
    assert.throws(() => buildIssuer('entra', { tenant: 'common' }), /own directory ID/);
    assert.throws(() => buildIssuer('entra', { tenant: 'not a tenant' }), /GUID/);
    assert.throws(() => buildIssuer('entra', {}), /required/);
    assert.throws(() => buildIssuer('okta', { domain: 'localhost' }), /company\.example\.com/);
    assert.throws(() => buildIssuer('okta', { domain: 'evil.com@internal' }), /company\.example\.com/);
    assert.throws(() => buildIssuer('keycloak', { server: 'sso.company.com', realm: '../admin' }), /realm/);
    assert.throws(() => buildIssuer('keycloak', { server: 'sso.company.com/a b', realm: 'x' }), /not allowed/);
    assert.throws(() => buildIssuer('pingone', { environment: 'x' }), /GUID/);
    assert.throws(() => buildIssuer('generic', { issuer: 'http://login.company.com' }), /https/);
    assert.throws(() => buildIssuer('generic', { issuer: 'nonsense' }), /https/);
    assert.throws(() => buildIssuer('nope', {}), /not in the list/);
  });

  it('every provider has steps that show the redirect address, and a catalogue without functions', () => {
    const ids = new Set<string>();
    for (const p of PRESETS) {
      assert.ok(!ids.has(p.id), `duplicate ${p.id}`); ids.add(p.id);
      assert.ok(p.steps.some((s) => s.includes('{redirect}')), `${p.id} never shows the redirect address`);
      assert.ok(p.defaults.scopes.startsWith('openid'));
    }
    assert.equal(PRESETS.at(-1)!.id, 'generic', 'the plain form stays last');
    assert.ok(!JSON.stringify(catalogue()).includes('=>'));
  });

  it('keeps only the values a provider asks for, and limits a domain', () => {
    assert.deepEqual(cleanValues('okta', { domain: ' x.okta.com ', junk: 'y' }), { domain: 'x.okta.com' });
    assert.deepEqual(cleanValues('google', { allowedDomain: ' https://Company.com/ ' }), { allowedDomain: 'company.com' });
    assert.equal(cleanHost('HTTPS://A.B.com/path'), 'a.b.com');
    assert.equal(domainAllowed('company.com', 'a@Company.com'), true);
    assert.equal(domainAllowed('company.com', 'a@evil.com'), false);
    assert.equal(domainAllowed('company.com', 'a@company.com.evil.com'), false);
    assert.equal(domainAllowed('company.com', 'nobody'), false);
    assert.equal(domainAllowed(undefined, 'a@anything.org'), true);
  });
});

describe('recognising a provider from a pasted address (pure)', () => {
  it('picks the provider and fills its boxes', () => {
    const g = '123e4567-e89b-12d3-a456-426614174000';
    assert.deepEqual(detect(`https://login.microsoftonline.com/${g}/v2.0`)?.preset, 'entra');
    assert.equal(detect(`https://login.microsoftonline.com/${g}/v2.0/.well-known/openid-configuration`)?.values.tenant, g);
    assert.equal(detect(`https://sts.windows.net/${g}/`)?.preset, 'entra');
    assert.deepEqual(detect('company.okta.com'), { preset: 'okta', values: { domain: 'company.okta.com' }, issuer: 'https://company.okta.com' });
    assert.equal(detect('https://accounts.google.com')?.preset, 'google');
    assert.deepEqual(detect('https://sso.company.com/auth/realms/staff')?.values, { server: 'sso.company.com/auth', realm: 'staff' });
    assert.equal(detect('https://company.eu.auth0.com/')?.preset, 'auth0');
    assert.equal(detect('https://company.onelogin.com/oidc/2')?.values.subdomain, 'company');
    assert.equal(detect(`https://auth.pingone.com/${g}/as`)?.preset, 'pingone');
    assert.equal(detect('https://oauth.id.jumpcloud.com/')?.preset, 'jumpcloud');
  });
  it('keeps anything else as "any provider", and refuses nonsense', () => {
    assert.deepEqual(detect('https://login.company.com'), { preset: 'generic', values: { issuer: 'https://login.company.com' }, issuer: 'https://login.company.com' });
    assert.equal(detect('https://company.okta.com/oauth2/default')?.preset, 'generic', 'a custom Okta server has its own issuer, kept exactly');
    assert.equal(detect('')?.preset, undefined);
    assert.equal(detect('not a url at all'), null);
    assert.equal(detect('http://login.company.com'), null, 'plain http is refused');
  });
  it('links to the provider\'s own admin screen', () => {
    assert.match(adminLinkFor('entra', {}, '')!, /entra\.microsoft\.com/);
    assert.equal(adminLinkFor('okta', { domain: 'company.okta.com' }, '')!, 'https://company.okta.com/admin');
    assert.equal(adminLinkFor('okta', {}, ''), null, 'no link until the domain is typed');
    assert.equal(adminLinkFor('keycloak', {}, 'https://sso.company.com/auth/realms/staff'), 'https://sso.company.com/auth/admin/master/console/#/staff/clients');
    assert.equal(adminLinkFor('generic', {}, 'https://x.com'), null);
  });
  it('shows what the provider sent without the technical fields, shortened', () => {
    const c = showClaims({ email: 'a@b.com', nonce: 'x', exp: 1, groups: Array.from({ length: 40 }, (_, i) => `g${i}`), long: 'x'.repeat(500) });
    assert.deepEqual(c.map((x) => x.name), ['email', 'groups', 'long']);
    assert.match(c[1].value, /40 in all/); assert.ok(c[2].value.length < 310);
    assert.equal(looksLikeIds(['123e4567-e89b-12d3-a456-426614174000']), true); assert.equal(looksLikeIds(['a']), false); assert.equal(looksLikeIds([]), false);
  });
});

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe('identity provider list (API)', () => {
  let admin = '', server: http.Server, port = 0, wrongIssuer = false;
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    // a Keycloak-shaped provider: everything lives under /realms/staff
    server = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${port}/realms/staff`;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/realms/staff/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: wrongIssuer ? 'http://127.0.0.1:1/other' : base, authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token`, jwks_uri: `${base}/certs` }));
      if (req.url === '/realms/staff/certs') return res.end(JSON.stringify({ keys: [] }));
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => { await call(admin, 'PUT', '/sso/config', { preset: 'generic', presetValues: { issuer: `http://127.0.0.1:${port}/realms/staff` }, clientId: 'x', enabled: false, passwordLogin: true }); server.close(); });

  it('lists the providers for the screen', async () => {
    const r = await call(admin, 'GET', '/sso/providers');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.length >= 9);
    assert.ok(r.json.find((p: any) => p.id === 'entra').fields[0].label.includes('tenant'));
    assert.equal((await call(null, 'GET', '/sso/providers')).status, 401);
  });

  it('refuses a wrong value for the chosen provider, and an unknown provider', async () => {
    const base = { clientId: 'c', clientSecret: 's', enabled: false };
    const a = await call(admin, 'PUT', '/sso/config', { ...base, preset: 'entra', presetValues: { tenant: 'common' } });
    assert.equal(a.status, 400); assert.match(a.text, /own directory ID/);
    assert.equal((await call(admin, 'PUT', '/sso/config', { ...base, preset: 'martian', presetValues: {} })).status, 400);
    assert.equal((await call(admin, 'PUT', '/sso/config', { ...base, preset: 'okta', presetValues: {} })).status, 400);
  });

  it('saves the chosen provider with its values, builds the issuer, and never returns the secret', async () => {
    const r = await call(admin, 'PUT', '/sso/config', { preset: 'keycloak', presetValues: { server: `127.0.0.1:${port}`, realm: 'staff', junk: 'dropped' }, clientId: 'wfm', clientSecret: 'kc-secret', enabled: false, name: 'Staff login' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.preset, 'keycloak');
    assert.equal(r.json.issuer, `http://127.0.0.1:${port}/realms/staff`);
    assert.deepEqual(r.json.presetValues, { server: `127.0.0.1:${port}`, realm: 'staff' });
    assert.equal(r.json.hasSecret, true);
    assert.ok(!r.text.includes('kc-secret'));
    const again = await call(admin, 'GET', '/sso/config');
    assert.equal(again.json.preset, 'keycloak');
  });

  it('tests the connection from the chosen provider and warns when the provider names itself differently', async () => {
    const values = { preset: 'keycloak', presetValues: { server: `127.0.0.1:${port}`, realm: 'staff' } };
    const ok = await call(admin, 'POST', '/sso/test', values);
    assert.equal(ok.json.ok, true, ok.text); assert.equal(ok.json.issuerMatches, true);
    wrongIssuer = true;
    const warn = await call(admin, 'POST', '/sso/test', values);
    wrongIssuer = false;
    assert.equal(warn.json.ok, true); assert.equal(warn.json.issuerMatches, false); assert.match(warn.json.warning, /refused/);
    const bad = await call(admin, 'POST', '/sso/test', { preset: 'entra', presetValues: { tenant: 'common' } });
    assert.equal(bad.json.ok, false); assert.match(bad.json.error, /directory ID/);
    const dead = await call(admin, 'POST', '/sso/test', { preset: 'keycloak', presetValues: { server: '127.0.0.1:9', realm: 'x' } });
    assert.equal(dead.json.ok, false);
  });

  it('previews the address and the admin link, and detects a provider from a pasted address', async () => {
    const ok = await call(admin, 'POST', '/sso/preview', { preset: 'keycloak', presetValues: { server: 'sso.company.com', realm: 'staff' } });
    assert.equal(ok.json.ok, true); assert.equal(ok.json.issuer, 'https://sso.company.com/realms/staff'); assert.match(ok.json.adminLink, /console\/#\/staff\/clients$/);
    const bad = await call(admin, 'POST', '/sso/preview', { preset: 'entra', presetValues: { tenant: 'common' } });
    assert.equal(bad.json.ok, false); assert.match(bad.json.error, /own directory ID/); assert.match(bad.json.adminLink, /entra/);
    const d = await call(admin, 'POST', '/sso/detect', { text: 'https://login.microsoftonline.com/123e4567-e89b-12d3-a456-426614174000/v2.0' });
    assert.equal(d.json.preset, 'entra'); assert.equal(d.json.label, 'Microsoft Entra ID (Azure AD)');
    assert.equal((await call(admin, 'POST', '/sso/detect', { text: 'nonsense words' })).json.ok, false);
  });

  it('tidies the scopes when saving, and refuses one that could never work', async () => {
    const v = { preset: 'keycloak', presetValues: { server: `127.0.0.1:${port}`, realm: 'staff' }, clientId: 'wfm', enabled: false };
    const ok = await call(admin, 'PUT', '/sso/config', { ...v, scopes: 'profile  email,groups profile' });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.scopes, 'openid profile email groups');
    const bad = await call(admin, 'PUT', '/sso/config', { ...v, scopes: 'openid bad"scope' });
    assert.equal(bad.status, 400); assert.match(bad.text, /not a valid scope/);
    const tryBad = await call(admin, 'POST', '/sso/try', { ...v, scopes: 'openid bad"scope' });
    assert.equal(tryBad.status, 400);
    const list = (await call(admin, 'GET', '/sso/providers')).json.find((x: any) => x.id === 'okta');
    assert.ok(list.scopeOptions.some((o: any) => o.id === 'groups') && list.claimHints.group.includes('groups'));
  });

  it('still accepts the old body that has only an issuer', async () => {
    const r = await call(admin, 'PUT', '/sso/config', { issuer: `http://127.0.0.1:${port}/realms/staff`, clientId: 'wfm', enabled: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.preset, 'generic');
  });
});
