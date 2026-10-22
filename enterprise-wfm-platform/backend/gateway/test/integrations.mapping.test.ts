/**
 * The mapping layer: pure logic, no database. Field mapping (any vendor's payload -> our shape) and entity
 * matching (their queue/employee identifiers -> ours, the part that cannot be guessed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTransform, getByPath, mapFields, suggestEntityMatches } from '../src/modules/integrations/mapping.ts';

describe('getByPath', () => {
  it('reads a dotted path through nested objects', () => {
    assert.equal(getByPath({ data: { stats: { nOffered: 42 } } }, 'data.stats.nOffered'), 42);
  });
  it('returns undefined for a missing path instead of throwing', () => {
    assert.equal(getByPath({ data: {} }, 'data.stats.nOffered'), undefined);
    assert.equal(getByPath(null, 'a.b'), undefined);
  });
});

describe('applyTransform', () => {
  it('converts milliseconds to seconds', () => { assert.equal(applyTransform(4500, 'ms_to_s'), 4.5); });
  it('converts minutes to seconds', () => { assert.equal(applyTransform(2, 'minutes_to_s'), 120); });
  it('passes the value through unchanged with no transform', () => { assert.equal(applyTransform('Available', null), 'Available'); });
  it('leaves null/undefined alone rather than producing NaN', () => { assert.equal(applyTransform(undefined, 'ms_to_s'), undefined); });
});

describe('mapFields', () => {
  it('builds a normalized record from a vendor-shaped payload using a connector\'s field maps', () => {
    const raw = { nOffered: 87, tHandle: 305000, mediaType: 'voice' };
    const out = mapFields(raw, [
      { targetField: 'volume', sourcePath: 'nOffered' },
      { targetField: 'ahtSec', sourcePath: 'tHandle', transform: 'ms_to_s' },
      { targetField: 'channel', sourcePath: 'mediaType' },
    ]);
    assert.deepEqual(out, { volume: 87, ahtSec: 305, channel: 'voice' });
  });
});

describe('suggestEntityMatches', () => {
  const queues = [{ id: 'q1', name: 'Support Voice', code: 'SUP-V' }, { id: 'q2', name: 'Billing Chat', code: 'BIL-C' }];

  it('matches an exact name regardless of case and punctuation', () => {
    const [s] = suggestEntityMatches([{ sourceId: '8892', sourceLabel: 'support voice' }], queues);
    assert.equal(s.targetId, 'q1');
  });

  it('matches a vendor code style name to our queue code', () => {
    const [s] = suggestEntityMatches([{ sourceId: 'x', sourceLabel: 'SUP-V' }], queues);
    assert.equal(s.targetId, 'q1');
  });

  it('matches a partial/decorated label ("Support Voice Queue (Genesys)")', () => {
    const [s] = suggestEntityMatches([{ sourceId: 'x', sourceLabel: 'Support Voice Queue (Genesys)' }], queues);
    assert.equal(s.targetId, 'q1');
  });

  it('leaves no suggestion when nothing is close enough, rather than forcing a bad guess', () => {
    const [s] = suggestEntityMatches([{ sourceId: 'x', sourceLabel: 'Totally Unrelated Thing' }], queues);
    assert.equal(s.targetId, null);
  });

  it('does not confuse two different queues with each other', () => {
    const [a, b] = suggestEntityMatches([{ sourceId: 'a', sourceLabel: 'billing chat' }, { sourceId: 'b', sourceLabel: 'support voice' }], queues);
    assert.equal(a.targetId, 'q2'); assert.equal(b.targetId, 'q1');
  });
});
