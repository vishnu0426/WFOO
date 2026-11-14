/** AgnoShin agent-state feed: how a message becomes a state event, what the preset ships with, and what is not written twice. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideAgentMessage, parseEventTime, type EventRule } from '../src/modules/integrations/agentMessage.ts';
import { forgetAllConnectors, worthRecording } from '../src/modules/integrations/recordThrottle.ts';
import { mapFields } from '../src/modules/integrations/mapping.ts';
import { presetById } from '../src/modules/integrations/presets.ts';

const rule = (action: EventRule['action'], state: string | null = null, reason: string | null = null): EventRule => ({ action, state, reason });

// the shapes seen on the live AgnoShin cluster (agent_id, event_type, org/tenant/workspace); state and reason ride on ready / not-ready
const HEARTBEAT = { org: 1, tenant: 1, agent_id: '1002@agnoshin.com', workspace: 1, event_type: 'EVT_AGENT_HEARTBEAT' };
const LOGOUT = { org: 1, tenant: 1, agent_id: '1002@agnoshin.com', workspace: 1, event_type: 'EVT_AGENT_LOGOUT' };
const READY = { ...HEARTBEAT, event_type: 'EVT_AGENT_READY', state: 'READY', reason: 'IDLE' };
const NOT_READY = { ...HEARTBEAT, event_type: 'EVT_AGENT_NOT_READY', state: 'NOT_READY', reason: 'Lunch' };

const preset = presetById('AGNOSHIN_NATS_RTA')!;
const mapped = (raw: object) => mapFields(raw, preset.defaultMaps!.map((m) => ({ targetField: m.targetField, sourcePath: m.sourcePath })));

describe('AgnoShin preset ships a working setup', () => {
  it('maps the four fields the cluster sends, without anyone building a field map', () => {
    assert.deepEqual(mapped(READY), { employeeNumber: '1002@agnoshin.com', eventType: 'EVT_AGENT_READY', state: 'READY', reason: 'IDLE' });
  });
  it('ignores heartbeats from the first message, and leaves every other event type for a person', () => {
    assert.deepEqual(preset.defaultEventRules, [{ eventType: 'EVT_AGENT_HEARTBEAT', action: 'SKIP' }]);
  });
  it('no longer claims the payload shape is unknown', () => {
    assert.doesNotMatch(preset.note!, /unconfirmed|Not guessed/);
    assert.match(preset.note!, /agent_id/);
  });
});

describe('decideAgentMessage', () => {
  it('turns a ready message into a state event', () => {
    assert.deepEqual(decideAgentMessage(mapped(READY), rule('PENDING')), { kind: 'ingest', employeeNumber: '1002@agnoshin.com', state: 'READY', reason: 'IDLE' });
  });
  it('a message with its own state is never held back by a rule still waiting for a decision', () => {
    assert.equal(decideAgentMessage(mapped(NOT_READY), rule('PENDING')).kind, 'ingest');
  });
  it('a heartbeat is skipped without being an error', () => {
    assert.deepEqual(decideAgentMessage(mapped(HEARTBEAT), rule('SKIP')), { kind: 'skip' });
  });
  it('an administrator can skip an event type even if it carries a state', () => {
    assert.deepEqual(decideAgentMessage(mapped(READY), rule('SKIP')), { kind: 'skip' });
  });
  it('a new event type with no state waits for a rule', () => {
    assert.deepEqual(decideAgentMessage(mapped(LOGOUT), rule('PENDING')), { kind: 'pending', eventType: 'EVT_AGENT_LOGOUT' });
  });
  it('takes the state and reason from the rule once someone has set it', () => {
    assert.deepEqual(decideAgentMessage(mapped(LOGOUT), rule('STATE', 'LOGGED_OUT', 'LoggedOut')), { kind: 'ingest', employeeNumber: '1002@agnoshin.com', state: 'LOGGED_OUT', reason: 'LoggedOut' });
  });
  it('a rule that sets a state but no reason leaves the message reason alone', () => {
    const d = decideAgentMessage({ employeeNumber: 'e1', eventType: 'X', reason: 'Own' }, rule('STATE', 'AWAY'));
    assert.deepEqual(d, { kind: 'ingest', employeeNumber: 'e1', state: 'AWAY', reason: 'Own' });
  });
  it('says what is missing when there is no agent or no state', () => {
    assert.deepEqual(decideAgentMessage({ state: 'READY' }, null), { kind: 'unmapped', missing: 'employeeNumber' });
    assert.deepEqual(decideAgentMessage({ employeeNumber: 'e1' }, null), { kind: 'unmapped', missing: 'state' });
    assert.deepEqual(decideAgentMessage({ employeeNumber: '  ', state: 'READY' }, null), { kind: 'unmapped', missing: 'employeeNumber' });
  });
  it('works with no event type at all', () => {
    assert.equal(decideAgentMessage({ employeeNumber: 'e1', state: 'READY' }, null).kind, 'ingest');
  });
  it('keeps a valid time and drops one that would break the batch', () => {
    assert.equal((decideAgentMessage({ employeeNumber: 'e1', state: 'READY', at: '2026-11-03T10:00:00Z' }, null) as any).at, '2026-11-03T10:00:00.000Z');
    assert.equal((decideAgentMessage({ employeeNumber: 'e1', state: 'READY', at: 'garbage' }, null) as any).at, undefined);
  });
});

describe('parseEventTime', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  it('reads ISO text, epoch seconds and epoch milliseconds, as numbers or text', () => {
    const want = '2026-11-03T10:00:00.000Z', ms = Date.parse(want);
    assert.equal(parseEventTime(want, now), want);
    assert.equal(parseEventTime(ms, now), want);
    assert.equal(parseEventTime(String(ms), now), want);
    assert.equal(parseEventTime(ms / 1000, now), want);
    assert.equal(parseEventTime(String(ms / 1000), now), want);
  });
  it('drops what is not a real time', () => {
    for (const v of [undefined, null, '', 'soon', NaN, {}, [], 0, '12', true]) assert.equal(parseEventTime(v as any, now), undefined, String(v));
  });
  it('drops times in the far past or more than a day ahead, which are clock faults, not events', () => {
    assert.equal(parseEventTime('1970-01-01T00:00:00Z', now), undefined);
    assert.equal(parseEventTime('2027-01-01T00:00:00Z', now), undefined);
  });
});

describe('worthRecording', () => {
  it('writes the first outcome, then not every identical one after it', () => {
    forgetAllConnectors();
    assert.equal(worthRecording('c1', true, undefined, 0), true);
    for (let t = 1; t < 5_000; t += 500) assert.equal(worthRecording('c1', true, undefined, t), false);
    assert.equal(worthRecording('c1', true, undefined, 5_000), true);
  });
  it('always writes a change from working to broken, and back', () => {
    forgetAllConnectors();
    worthRecording('c2', true, undefined, 0);
    assert.equal(worthRecording('c2', false, 'No rule', 1), true);
    assert.equal(worthRecording('c2', true, undefined, 2), true);
  });
  it('writes a different error at once, and the same one only every 30 seconds', () => {
    forgetAllConnectors();
    assert.equal(worthRecording('c3', false, 'A', 0), true);
    assert.equal(worthRecording('c3', false, 'A', 100), false);
    assert.equal(worthRecording('c3', false, 'B', 200), true);
    assert.equal(worthRecording('c3', false, 'B', 29_000), false);
    assert.equal(worthRecording('c3', false, 'B', 30_200), true);
  });
  it('keeps connectors apart', () => {
    forgetAllConnectors();
    worthRecording('a', true, undefined, 0);
    assert.equal(worthRecording('b', true, undefined, 1), true);
  });
});
