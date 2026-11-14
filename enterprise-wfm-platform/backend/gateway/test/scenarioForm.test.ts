import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, blank, deltaText, fromParams, headline, isBaseline, money, moneyDelta, problemWith, scenarioKey, toParams } from '../../../src/services/scenarioForm.ts';

describe('the starting points', () => {
  it('offer +10% volume, +15 s handle time, shrinkage 25% and a holiday week', () => {
    assert.deepEqual(PRESETS.map((p) => p.label), ['+10% volume', '+15 s handle time', 'Shrinkage 25%', 'Holiday week']);
  });
  it('each makes a scenario that changes something, with a name that says what', () => {
    for (const p of PRESETS) { const d = p.make(); assert.ok(d.name.length > 3); assert.equal(isBaseline(d), false, p.id); assert.equal(problemWith(d), '', p.id); }
    assert.deepEqual(toParams(PRESETS[0].make()), { volumePct: 10 });
    assert.deepEqual(toParams(PRESETS[1].make()), { ahtAddSec: 15 });
    assert.deepEqual(toParams(PRESETS[2].make()), { shrinkage: 0.25 });
    assert.deepEqual(toParams(PRESETS[3].make()), { volumePct: 25, shrinkage: 0.35 });
  });
});

describe('typed values and server parameters', () => {
  it('a blank target is left out, so the group setting stands', () => assert.deepEqual(toParams(blank('x')), {}));
  it('handle time is a share or seconds, by the unit chosen', () => {
    assert.deepEqual(toParams(blank('x', { aht: 15, ahtUnit: 'pct' })), { ahtPct: 15 });
    assert.deepEqual(toParams(blank('x', { aht: -20, ahtUnit: 'sec' })), { ahtAddSec: -20 });
  });
  it('percent targets become fractions and back again without drifting', () => {
    const d = blank('x', { shrinkage: '27.5', serviceLevel: '90', occupancyCap: '85' });
    assert.deepEqual(toParams(d), { shrinkage: 0.275, serviceLevel: 0.9, occupancyCap: 0.85 });
    const back = fromParams('x', toParams(d));
    assert.deepEqual([back.shrinkage, back.serviceLevel, back.occupancyCap], ['27.5', '90', '85']);
    assert.deepEqual(fromParams('y', { ahtAddSec: 15 }).ahtUnit, 'sec');
  });
  it('the key changes when the request would change, and not when it would not', () => {
    assert.equal(scenarioKey(blank('a', { volumePct: 10 })), scenarioKey(blank('a', { volumePct: 10, shrinkage: '  ' })));
    assert.notEqual(scenarioKey(blank('a', { volumePct: 10 })), scenarioKey(blank('a', { volumePct: 11 })));
    assert.notEqual(scenarioKey(blank('a')), scenarioKey(blank('b')));
  });
  it('says what is out of range instead of sending it', () => {
    assert.match(problemWith(blank('x', { volumePct: 900 })), /Volume/);
    assert.match(problemWith(blank('x', { shrinkage: '95' })), /Shrinkage/);
    assert.match(problemWith(blank('x', { serviceLevel: '100' })), /Service level/);
    assert.match(problemWith(blank('x', { occupancyCap: '20' })), /occupancy cap/);
    assert.match(problemWith(blank('x', { aht: 700, ahtUnit: 'sec' })), /600 seconds/);
    assert.equal(problemWith(blank('x', { shrinkage: '30' })), '');
  });
});

describe('the changes in words', () => {
  it('signs, units and "No change"', () => {
    assert.equal(deltaText(3.24, 'FTE'), '+3.2 FTE'); assert.equal(deltaText(-0.44, 'FTE'), '−0.4 FTE');
    assert.equal(deltaText(0.01, 'FTE'), 'No change'); assert.equal(deltaText(null, 'FTE'), '–'); assert.equal(deltaText(-2.5, 'pts'), '−2.5 pts');
  });
  it('money in the organisation currency, whole units', () => {
    assert.equal(money(12345.6, 'USD'), '$12,346'); assert.equal(money(null, 'USD'), '–');
    assert.equal(moneyDelta(1500, 'USD'), '+$1,500'); assert.equal(moneyDelta(-1500, 'USD'), '−$1,500'); assert.equal(moneyDelta(0.2, 'USD'), 'No change');
    assert.match(money(5000, 'XXX'), /5,000/);
  });
});

describe('the sentence for each scenario', () => {
  const r = (over: Partial<Parameters<typeof headline>[1]> = {}) => ({ fte: 18.3, impactRequiredFteDelta: 3.2, impactServiceLevelDelta: -4, impactCostDelta: 23918, ...over });
  it('says more agents with the share, the service level change and the cost', () => {
    assert.equal(headline('Holiday week', r(), 15.1, 'USD'), 'Holiday week needs 3.2 more agents (+21%); service level −4.0 pts; costs $23,918 more.');
  });
  it('says fewer, and leaves out what did not change or is not known', () => {
    assert.equal(headline('Less shrinkage', r({ impactRequiredFteDelta: -1.5, impactServiceLevelDelta: 0, impactCostDelta: null }), 15, 'USD'), 'Less shrinkage needs 1.5 fewer agents (−10%).');
    assert.equal(headline('Same', r({ impactRequiredFteDelta: 0.02, impactServiceLevelDelta: null, impactCostDelta: -5000 }), 15, 'USD'), 'Same needs the same number of agents; costs $5,000 less.');
  });
});
