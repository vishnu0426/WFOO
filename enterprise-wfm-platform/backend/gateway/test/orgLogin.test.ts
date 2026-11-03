import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryOn, signInLink, validOrgCode, welcomeMessage } from '../src/modules/orgLogin.ts';
import { orgFromAddress } from '../../../employee-portal/src/orgAddress.ts';
import { orgFromAddress as orgFromAddressApp } from '../../../src/services/orgAddress.ts';

describe('the link an administrator hands to a new employee', () => {
  it('puts the organisation in the link, so nobody types it', () => {
    assert.equal(signInLink('ACME', { PORTAL_URL: 'https://portal.example.com/' }), 'https://portal.example.com/?org=ACME');
  });
  it('uses one address per organisation when a template is set', () => {
    assert.equal(signInLink('ACME', { PORTAL_URL_TEMPLATE: 'https://{org}.example.com', PORTAL_URL: 'https://portal.example.com' }), 'https://acme.example.com');
  });
  it('is empty when no address is configured, so the screen can say so', () => {
    assert.equal(signInLink('ACME', {}), null);
    assert.equal(signInLink('ACME', { PORTAL_URL_TEMPLATE: 'https://no-placeholder.example.com' }), null);
  });
  it('writes a message to paste, with the code kept in it even when the link has it', () => {
    const m = welcomeMessage({ organisation: 'Acme Corp', code: 'ACME', link: 'https://p.example.com/?org=ACME', username: 'sam', password: 'Temp-1234' });
    assert.match(m, /Acme Corp/); assert.match(m, /https:\/\/p\.example\.com\/\?org=ACME/); assert.match(m, /Organisation code, if you are asked for it: ACME/);
    assert.match(m, /Username: sam/); assert.match(m, /Temporary password: Temp-1234/); assert.match(m, /choose your own password/);
    const noLink = welcomeMessage({ organisation: 'Acme Corp', code: 'ACME', link: null, username: 'sam', password: 'x' });
    assert.match(noLink, /Organisation code: ACME/);
  });
});

describe('organisation codes and the email lookup switch', () => {
  it('accepts only what can safely sit in an address', () => {
    for (const ok of ['ORG', 'acme', 'Acme-2', 'a_b', '9lives']) assert.equal(validOrgCode(ok), true, ok);
    for (const bad of ['', ' ', 'a b', '../x', '-x', 'a'.repeat(41), 'acme/evil', null, 3]) assert.equal(validOrgCode(bad as any), false, String(bad));
  });
  it('email lookup is on unless switched off', () => {
    assert.equal(discoveryOn({}), true);
    assert.equal(discoveryOn({ LOGIN_DISCOVERY: 'true' }), true);
    for (const off of ['false', 'FALSE', '0', 'off', 'no']) assert.equal(discoveryOn({ LOGIN_DISCOVERY: off }), false, off);
  });
});

// the portal and the admin app carry the same file; this keeps them from drifting apart
for (const [name, fn] of [['employee portal', orgFromAddress], ['admin app', orgFromAddressApp]] as const) {
  describe(`the organisation named by the web address (${name})`, () => {
    const at = (hostname: string, pathname = '/', search = '') => ({ hostname, pathname, search });
    it('reads a link with ?org= first, over everything else', () => {
      assert.deepEqual(fn(at('portal.example.com', '/org/other', '?org=ACME'), 'LAST', { subdomain: true }), { code: 'ACME', source: 'link' });
    });
    it('reads /org/<code> in the path', () => {
      assert.deepEqual(fn(at('localhost', '/org/acme/home'), null), { code: 'acme', source: 'path' });
    });
    it('reads the first part of the host name only when that is switched on, and never for plain or generic hosts', () => {
      assert.equal(fn(at('acme.example.com'), null), null, 'off by default');
      assert.deepEqual(fn(at('acme.example.com'), null, { subdomain: true }), { code: 'acme', source: 'subdomain' });
      assert.deepEqual(fn(at('acme.localhost'), null, { subdomain: true }), { code: 'acme', source: 'subdomain' });
      for (const h of ['localhost', 'example.com', 'www.example.com', 'portal.example.com', '192.168.1.5', '10.0.0.2']) assert.equal(fn(at(h), null, { subdomain: true }), null, h);
    });
    it('falls back to the organisation used last on this device', () => {
      assert.deepEqual(fn(at('localhost'), 'ORG'), { code: 'ORG', source: 'remembered' });
      assert.equal(fn(at('localhost'), 'bad code!'), null);
      assert.equal(fn(at('localhost'), ''), null);
    });
    it('ignores a code that could not be one', () => {
      assert.equal(fn(at('localhost', '/', '?org=a%20b%3Cscript%3E'), null), null);
      assert.equal(fn(at('localhost', '/org/..%2Fetc'), null), null);
    });
  });
}
