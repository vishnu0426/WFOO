/** Tying a phone system's agent id ("1001@agnoshin.com") to one employee by their Agent extension, and what may be stored as an extension. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bareNumber, extensionProblem, pickAgent } from '../src/modules/integrations/agentMatch.ts';

const hit = (employeeNumber: string, name: string, exact: boolean) => ({ employeeNumber, name, exact });

describe('the number before the @', () => {
  it('is taken from a SIP-style id and from nothing else', () => {
    assert.equal(bareNumber('1001@agnoshin.com'), '1001');
    assert.equal(bareNumber('1001'), null);
    assert.equal(bareNumber('@agnoshin.com'), null);
  });
});

describe('picking the employee for an agent id', () => {
  it('takes the one person whose extension matches', () => {
    assert.deepEqual(pickAgent([hit('EMP7', 'Sarvash K', true)]), { kind: 'one', employeeNumber: 'EMP7', name: 'Sarvash K' });
  });
  it('prefers an extension stored exactly as sent over one stored as the bare number', () => {
    assert.deepEqual(pickAgent([hit('EMP7', 'Sarvash K', true), hit('EMP9', 'Other', false)]), { kind: 'one', employeeNumber: 'EMP7', name: 'Sarvash K' });
  });
  it('uses the bare number when nobody has the full address', () => {
    assert.equal(pickAgent([hit('EMP9', 'Other', false)]).kind, 'one');
  });
  it('never guesses between two people who share the extension, and names them', () => {
    const m = pickAgent([hit('EMP7', 'Sarvash K', true), hit('EMP8', 'Asha R', true)]);
    assert.equal(m.kind, 'many');
    assert.deepEqual((m as any).names, ['Asha R (EMP8)', 'Sarvash K (EMP7)']);
  });
  it('counts the same person found twice once', () => {
    assert.equal(pickAgent([hit('EMP7', 'Sarvash K', true), hit('EMP7', 'Sarvash K', true)]).kind, 'one');
  });
  it('says none when nobody matches', () => {
    assert.deepEqual(pickAgent([]), { kind: 'none' });
  });
});

describe('what may be stored as an agent extension', () => {
  it('accepts a plain number and a number at the company domain', () => {
    for (const ok of ['1001', 'x2045', '1001@agnoshin.com', ' 1001@agnoshin.com ']) assert.equal(extensionProblem(ok), null, ok);
  });
  it('still refuses a person\'s email address', () => {
    for (const bad of ['silesh@agnoshin.com', 'someone@example.com', '1001@', '1001@bad domain', 'a1001@agnoshin.com']) assert.ok(extensionProblem(bad), bad);
  });
});
