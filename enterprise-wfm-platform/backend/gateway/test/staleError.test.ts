import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { currentError, WAITING_RULE, WAITING_RULE_SQL } from '../src/modules/integrations/staleError.ts';

const waiting = "Event type 'EVT_AGENT_LOGOUT' is waiting for a rule. Set it under RTA State Mapping.";

describe('a connector\'s "waiting for a rule" error', () => {
  it('is shown while an event type is still waiting', () => assert.equal(currentError(waiting, 1), waiting));
  it('goes away once no event type is waiting, even if the feed has been quiet since', () => assert.equal(currentError(waiting, 0), null));
  it('leaves every other error alone, whatever the rules say', () => {
    const other = "Message on 'cc.acd' is not JSON: hello";
    assert.equal(currentError(other, 0), other);
    assert.equal(currentError('Disconnected from NATS, reconnecting…', 0), 'Disconnected from NATS, reconnecting…');
  });
  it('has nothing to show when there is no error', () => { assert.equal(currentError(null, 0), null); assert.equal(currentError(undefined, 3), null); assert.equal(currentError('', 0), null); });
  it('recognises the exact message the subscriber writes, and the same text in SQL', () => {
    assert.match(waiting, WAITING_RULE);
    assert.ok(WAITING_RULE_SQL.includes('is waiting for a rule'));
  });
});
