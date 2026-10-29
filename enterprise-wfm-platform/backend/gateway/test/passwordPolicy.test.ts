/** The rules for a password someone chooses for themselves. Pure logic, no server needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkNewPassword, MIN_PASSWORD_LENGTH } from '../src/passwordPolicy.ts';

describe('checkNewPassword', () => {
  it('accepts a sensible password', () => {
    assert.equal(checkNewPassword('Blue-Harbour-42', { current: 'x', username: 'asha.rao' }), null);
    assert.equal(checkNewPassword('correct horse 9 battery'), null);
  });
  it('needs the minimum length', () => {
    assert.match(checkNewPassword('Ab1!xyz')!, /at least 8/);
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.equal(checkNewPassword('Ab1!xyzq'), null);
  });
  it('must differ from the current password', () => assert.match(checkNewPassword('Blue-Harbour-42', { current: 'Blue-Harbour-42' })!, /different/));
  it('cannot contain the username, in any case', () => assert.match(checkNewPassword('xx-ASHA.rao-99', { username: 'asha.rao' })!, /username/));
  it('rejects the examples everyone tries first, including the one in the setup notes', () => {
    for (const p of ['Admin@123456', 'MyPassword!2026', 'Welcome-2026!x', 'qwerty-12345-Z', 'Abcd1234567890']) assert.match(checkNewPassword(p)!, /too easy/, p);
  });
  it('wants a mix of letters and other characters', () => {
    assert.match(checkNewPassword('onlylettersherenow')!, /Mix letters/);
    assert.match(checkNewPassword('93847562910384')!, /Mix letters/);
  });
  it('rejects a long run of the same few characters', () => assert.match(checkNewPassword('aaaa1111aaaa1111')!, /wider mix/));
  it('has an upper limit', () => assert.match(checkNewPassword('A1!' + 'x'.repeat(100))!, /at most 100/));
});
