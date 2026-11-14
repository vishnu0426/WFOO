/** Avaya AACC preset: what the form asks for, how the source is described, and the interval length a relay's rows are read with. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configSchemaFor, presetById, PRESETS } from '../src/modules/integrations/presets.ts';
import { pullSupport, relayIntervalMinutes } from '../src/modules/integrations/pullRules.ts';
import { sourceKind } from '../src/modules/feedHealth.ts';

describe('Avaya AACC preset', () => {
  const p = presetById('AVAYA_AACC')!;
  it('exists beside, and separate from, Avaya CMS', () => {
    assert.ok(p); assert.notEqual(p.id, 'AVAYA_CMS');
    assert.equal(p.category, 'ACD'); assert.equal(p.method, 'ONPREM_RELAY'); assert.equal(p.writesTo, 'interval_history');
    assert.equal(PRESETS.filter((x) => x.id === 'AVAYA_AACC').length, 1);
  });
  it('maps the rows the reader sends without any further setup', () => {
    assert.deepEqual(p.defaultMaps!.map((m) => m.targetField).sort(), ['abandoned', 'ahtSec', 'day', 'time', 'volume']);
    assert.ok(p.defaultMaps!.every((m) => m.targetField === m.sourcePath));
  });
  it('stores no database password and needs nothing before it can be created', () => {
    assert.ok(!p.fields.some((f) => f.kind === 'password'));
    assert.equal(configSchemaFor(p).safeParse({}).success, true);
  });
  it('is sent to us by the on-site reader, never pulled by the server', () => {
    assert.equal(sourceKind('AVAYA_AACC'), 'PUSH');
    assert.equal(pullSupport(p, {}).canPull, false);
  });
  it('says plainly that live agent state and the exact columns are not covered', () => {
    assert.match(p.note!, /have not been checked against a live AACC/);
    assert.match(p.note!, /agent state/);
  });
});

describe('relay interval length', () => {
  it('follows the connector setting and falls back to 15', () => {
    assert.equal(relayIntervalMinutes({ intervalMinutes: '30' }), 30);
    assert.equal(relayIntervalMinutes({ intervalMinutes: '60' }), 60);
    assert.equal(relayIntervalMinutes({ intervalMinutes: '15' }), 15);
    assert.equal(relayIntervalMinutes({ intervalMinutes: '7' }), 15);
    assert.equal(relayIntervalMinutes({}), 15);
    assert.equal(relayIntervalMinutes(null), 15);
  });
});
