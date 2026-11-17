/** The rules behind "forgot my password": channels, codes, and what is said. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BAD_CODE, CODE_DIGITS, REQUEST_ANSWER, codeMatches, hashCode, makeCode, messageFor, pickChannel, usableChannels } from '../src/modules/passwordResetLogic.ts';

describe('which channels a reset can use', () => {
  it('follows the organisation\'s choice and only counts channels that are switched on', () => {
    assert.deepEqual(usableChannels('OFF', true, true), []);
    assert.deepEqual(usableChannels('EMAIL', true, true), ['EMAIL']);
    assert.deepEqual(usableChannels('SMS', true, true), ['SMS']);
    assert.deepEqual(usableChannels('EITHER', true, true), ['EMAIL', 'SMS']);
    assert.deepEqual(usableChannels('EITHER', false, true), ['SMS']);
    assert.deepEqual(usableChannels('SMS', true, false), [], 'a method that needs SMS does nothing while SMS is off');
  });
  it('uses the only channel there is, asks to choose when there are two, and refuses one that is not allowed', () => {
    assert.equal(pickChannel(['EMAIL']), 'EMAIL');
    assert.equal(pickChannel(['EMAIL', 'SMS']), null);
    assert.equal(pickChannel(['EMAIL', 'SMS'], 'SMS'), 'SMS');
    assert.equal(pickChannel(['EMAIL'], 'SMS'), null);
    assert.equal(pickChannel([], undefined), null);
  });
});

describe('the code', () => {
  it('is six digits, leading zeros kept, and not the same every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) { const c = makeCode(); assert.match(c, /^[0-9]{6}$/); assert.equal(c.length, CODE_DIGITS); seen.add(c); }
    assert.ok(seen.size > 150);
  });
  it('matches only the right code for the right person, ignoring spaces, and is never stored as plain digits', () => {
    const h = hashCode('012345', 'user-1', 'secret-secret-secret');
    assert.doesNotMatch(h, /012345/);
    assert.equal(codeMatches('012345', h, 'user-1', 'secret-secret-secret'), true);
    assert.equal(codeMatches('012 345', h, 'user-1', 'secret-secret-secret'), true);
    assert.equal(codeMatches('012346', h, 'user-1', 'secret-secret-secret'), false);
    assert.equal(codeMatches('012345', h, 'user-2', 'secret-secret-secret'), false, 'another person\'s code does not open this one');
    assert.equal(codeMatches('012345', h, 'user-1', 'another-secret-value'), false);
  });
});

describe('what is said', () => {
  it('puts the code and the expiry in the message and says it can be ignored', () => {
    const e = messageFor('EMAIL', 'AgnoShin', '123456'), s = messageFor('SMS', 'AgnoShin', '123456');
    assert.match(e.body, /123456/); assert.match(e.body, /10 minutes/); assert.match(e.body, /ignore/i);
    assert.match(s.body, /123456/); assert.ok(s.body.length <= 160, 'one text message');
  });
  it('answers a request the same way whoever asked, and never says whether an account exists', () => {
    assert.doesNotMatch(REQUEST_ANSWER, /no (such )?(account|user)|not found|does not exist/i);
    assert.doesNotMatch(BAD_CODE, /no (such )?(account|user)|not found/i);
  });
});
