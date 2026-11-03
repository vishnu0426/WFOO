/**
 * The single sign-on pickers: which scopes are ticked, and which details are offered for "who they are" and "their groups". Pure, no server needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addScopes, claimChoices, customScopes, joinScopes, removeScope, splitScopes, toggleScope, type Seen } from '../../../src/components/admin/ssoLogic.ts';
import { catalogue, normaliseScopes, showClaims } from '../src/modules/ssoProviders.ts';

describe('scope picker logic', () => {
  it('always keeps openid first, once, and never loses the order of the rest', () => {
    assert.equal(joinScopes([]), 'openid');
    assert.equal(joinScopes(['email', 'openid', 'profile', 'email']), 'openid email profile');
    assert.deepEqual(splitScopes(' openid,profile   email '), ['openid', 'profile', 'email']);
  });
  it('ticks and unticks', () => {
    let v = 'openid profile email';
    v = toggleScope(v, 'groups'); assert.equal(v, 'openid profile email groups');
    v = toggleScope(v, 'profile'); assert.equal(v, 'openid email groups');
    assert.equal(toggleScope('openid email', 'openid'), 'openid email', 'openid cannot be unticked');
  });
  it('adds other scopes, several at once, without duplicates, and removes them again', () => {
    let v = addScopes('openid profile email', 'api://x/.default  offline_access, email');
    assert.equal(v, 'openid profile email api://x/.default offline_access');
    assert.deepEqual(customScopes(v, ['openid', 'profile', 'email', 'groups']), ['api://x/.default', 'offline_access']);
    v = removeScope(v, 'api://x/.default'); assert.equal(v, 'openid profile email offline_access');
    assert.equal(addScopes('openid', '   '), 'openid');
  });
  it('every provider offers openid locked on, and only scopes it can use', () => {
    for (const p of catalogue()) {
      assert.equal(p.scopeOptions[0].id, 'openid'); assert.equal(p.scopeOptions[0].locked, true);
      assert.ok(p.scopeOptions.slice(1).every((o) => !o.locked && o.hint));
      assert.ok(p.scopeOptions.some((o) => o.id === 'email'), `${p.id} cannot ask for email`);
      for (const s of splitScopes(p.defaults.scopes)) assert.ok(p.scopeOptions.some((o) => o.id === s), `${p.id} default scope ${s} is not in its own list`);
    }
    assert.ok(!catalogue().find((p) => p.id === 'entra')!.scopeOptions.some((o) => o.id === 'groups'), 'Entra sends groups through the app, not a scope');
  });
});

describe('claim dropdown logic', () => {
  const seen: Seen[] = [
    { name: 'email', value: 'priya@company.com', list: false }, { name: 'sub', value: 'abc123', list: false }, { name: 'name', value: 'A really long display name that needs shortening', list: false },
    { name: 'groups', value: 'a, b, c', list: true }, { name: 'roles', value: 'admin', list: true },
  ];
  it('after a sign-in, offers what the provider really sent, with examples', () => {
    const u = claimChoices('username', seen, ['email'], 'email');
    assert.deepEqual(u.map((o) => o.name), ['email', 'sub', 'name']);
    assert.equal(u[0].note, 'priya@company.com'); assert.match(u[1].note!, /not readable/); assert.ok(u[2].note!.endsWith('…'));
    const g = claimChoices('group', seen, ['groups'], 'groups');
    assert.deepEqual(g.map((o) => [o.name, o.note]), [['groups', '3 groups'], ['roles', '1 group']]);
  });
  it('before any sign-in, offers what that provider usually sends, and keeps a saved custom value', () => {
    assert.deepEqual(claimChoices('username', [], ['email', 'preferred_username'], 'email').map((o) => o.name), ['email', 'preferred_username']);
    assert.deepEqual(claimChoices('group', [], ['groups'], 'https://company.com/groups').map((o) => o.name), ['groups', 'https://company.com/groups']);
    assert.equal(claimChoices('username', [], ['sub'], 'sub')[0].note, 'an ID, not readable by people');
  });
  it('says which details are lists, from the real sign-in claims', () => {
    const c = showClaims({ email: 'a@b.com', groups: ['x', 'y'], n: 3 });
    assert.deepEqual(c.map((x) => [x.name, x.list]), [['email', false], ['groups', true], ['n', false]]);
  });
  it('every provider has hints for both dropdowns', () => {
    for (const p of catalogue()) { assert.ok(p.claimHints.username.length && p.claimHints.group.length, p.id); }
    assert.ok(catalogue().find((p) => p.id === 'entra')!.claimHints.username.includes('upn'));
  });
});

describe('scope validation on the server side', () => {
  it('tidies a typed list', () => {
    assert.equal(normaliseScopes('profile  email,groups'), 'openid profile email groups');
    assert.equal(normaliseScopes('openid openid email'), 'openid email');
    assert.equal(normaliseScopes('api://x/.default'), 'openid api://x/.default');
    assert.equal(normaliseScopes(''), 'openid');
  });
  it('names the bad word', () => {
    assert.throws(() => normaliseScopes('profile bad"scope'), /"bad"scope" is not a valid scope/);
    assert.throws(() => normaliseScopes('back\\slash'), /not a valid scope/);
    assert.throws(() => normaliseScopes(Array.from({ length: 31 }, (_, i) => `s${i}`).join(' ')), /more than 30/);
  });
});
