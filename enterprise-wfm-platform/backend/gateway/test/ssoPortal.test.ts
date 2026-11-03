/**
 * Single sign-on for the employee portal, the parts that need no server: where people are sent back to, and what the portal's sign-in screen offers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, parseTo, returnBase } from '../src/modules/ssoReturn.ts';
import { infoUrl, loginMode, readSsoReturn, returningFromSso, startUrl } from '../../../employee-portal/src/sso.ts';

describe('where people are sent back after single sign-on', () => {
  it('only ever names a target, never an address', () => {
    assert.equal(parseTo('portal'), 'portal');
    for (const v of ['app', '', undefined, null, 'https://evil.example', '//evil.example', ['portal'], { to: 'portal' }, 'PORTAL', 'portal ']) assert.equal(parseTo(v), 'app', String(v));
  });
  it('takes addresses from the server settings only, and refuses unusable ones', () => {
    assert.equal(cleanUrl('http://localhost:3001/'), 'http://localhost:3001');
    assert.equal(cleanUrl(' https://portal.company.com/my '), 'https://portal.company.com/my');
    for (const v of [undefined, '', '   ', 'javascript:alert(1)', 'ftp://x.com', 'portal.company.com', 'https://user:pw@x.com', 'not a url']) assert.equal(cleanUrl(v as string), undefined, String(v));
  });
  it('sends the portal to the portal, and everything else to the app', () => {
    const urls = { app: 'https://wfm.company.com', portal: 'https://me.company.com' };
    assert.equal(returnBase('portal', urls), 'https://me.company.com');
    assert.equal(returnBase('app', urls), 'https://wfm.company.com');
    assert.equal(returnBase('portal', { app: urls.app }), 'https://wfm.company.com', 'no portal set: the caller reports it, this never invents an address');
  });
});

describe('employee portal sign-in screen', () => {
  const on = { enabled: true, name: 'Microsoft', passwordLogin: true, portal: true };
  it('offers what the organisation has set up, and never a dead end when the server does not answer', () => {
    assert.equal(loginMode(null), 'password');
    assert.equal(loginMode({ ...on, enabled: false }), 'password');
    assert.equal(loginMode(on), 'both');
    assert.equal(loginMode({ ...on, passwordLogin: false }), 'sso-only');
    assert.equal(loginMode({ ...on, portal: false }), 'password', 'passwords still work, the button could not return here');
    assert.equal(loginMode({ ...on, portal: false, passwordLogin: false }), 'blocked');
  });
  it('builds the button address and the question asked of the server', () => {
    assert.equal(startUrl('', null), '/api/v1/auth/sso/_/start?to=portal');
    assert.equal(startUrl(' ORG ', null), '/api/v1/auth/sso/ORG/start?to=portal');
    assert.equal(startUrl('ORG', { ...on, start: 'https://wfm.company.com/api/v1/auth/sso/ORG/start?to=portal' }), 'https://wfm.company.com/api/v1/auth/sso/ORG/start?to=portal');
    assert.equal(infoUrl(''), '/auth/sso/_/info'); assert.equal(infoUrl('a/b'), '/auth/sso/a%2Fb/info');
  });
  it('reads what comes back after the company page', () => {
    assert.deepEqual(readSsoReturn('#sso_token=abc.def.ghi'), { token: 'abc.def.ghi' });
    assert.deepEqual(readSsoReturn('#sso_error=The%20sign-in%20took%20too%20long'), { error: 'The sign-in took too long' });
    assert.deepEqual(readSsoReturn('#something_else=1'), {}); assert.deepEqual(readSsoReturn(''), {});
    assert.equal(readSsoReturn(`#sso_error=${'x'.repeat(900)}`).error!.length, 300, 'a long message is cut, not trusted');
    assert.equal(returningFromSso('#sso_token=abc'), true); assert.equal(returningFromSso('#sso_error=x'), false); assert.equal(returningFromSso(''), false);
  });
});
