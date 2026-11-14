import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEEKS, PERIOD_PRESETS, daysOf, readWeeks, weeksLabel } from '../../../src/services/periods.ts';

describe('the look-back periods', () => {
  it('are the same four everywhere: 8, 12, 26 and 52 weeks', () => assert.deepEqual(PERIOD_PRESETS.map((p) => [p.weeks, p.label]), [[8, '8 weeks'], [12, '12 weeks'], [26, '26 weeks'], [52, '52 weeks']]));
  it('default to 12 weeks', () => assert.equal(DEFAULT_WEEKS, 12));
  it('read back a remembered choice only if it is one of them', () => {
    assert.equal(readWeeks('26'), 26); assert.equal(readWeeks('52'), 52);
    assert.equal(readWeeks(null), 12); assert.equal(readWeeks(''), 12); assert.equal(readWeeks('30'), 12, 'an old "30 days" style value falls back'); assert.equal(readWeeks('abc'), 12);
  });
  it('turn into days for the screens that ask in days, within what the server accepts (7 to 730)', () => {
    for (const p of PERIOD_PRESETS) { const d = daysOf(p.weeks); assert.ok(d >= 7 && d <= 730, String(d)); }
    assert.equal(daysOf(26), 182);
  });
  it('say what they are', () => { assert.equal(weeksLabel(12), '12 weeks'); assert.equal(weeksLabel(5), '5 weeks'); });
});
