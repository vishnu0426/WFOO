/** Weekend days are a setting: Saturday and Sunday unless the organisation says otherwise. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWeekend, DEFAULT_WEEKEND, weekendMask } from '../src/modules/payWeek.ts';
import { analysePattern, type TemplateLite } from '../src/modules/rotationPlan.ts';

describe('weekend setting', () => {
  it('falls back to Saturday and Sunday when nothing valid is saved', () => {
    for (const bad of [undefined, null, [], [9], 'x', [1, 2, 3, 4]]) assert.deepEqual(cleanWeekend(bad), DEFAULT_WEEKEND);
  });
  it('keeps a valid choice, sorted and without repeats', () => {
    assert.deepEqual(cleanWeekend([5, 4, 4]), [4, 5]);          // Friday and Saturday
    assert.deepEqual(cleanWeekend([6]), [6]);                    // Sunday only
  });
  it('turns days into the bit mask the engine reads', () => {
    assert.equal(weekendMask([5, 6]), 0b1100000);
    assert.equal(weekendMask([4, 5]), 0b0110000);
  });
});

describe('rotation analysis follows the weekend', () => {
  const T = new Map<string, TemplateLite>([['d', { id: 'd', name: 'Day', startSlot: 32, lengthSlots: 32, paidSlots: 32, active: true }]]);
  // Works Monday to Friday, off Saturday and Sunday, on a seven-day cycle starting Monday
  const base = { cycleDays: 7, sequence: ['d', 'd', 'd', 'd', 'd', null, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: T, limits: {}, contractHours: null };
  it('counts no weekend work for a Monday to Friday pattern with the usual weekend', () => {
    const c = analysePattern(base).crews[0];
    assert.equal(c.weekendDaysPerWeek, 0);
    assert.equal(c.weekendsFullyOff, 1);
  });
  it('counts Friday as a weekend day when the weekend is Friday and Saturday', () => {
    const c = analysePattern({ ...base, weekend: [4, 5] }).crews[0];
    assert.equal(c.weekendDaysPerWeek, 1);                       // works Friday
    assert.equal(c.weekendsFullyOff, 0);                         // so the weekend is never fully off
  });
});
