import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { click, daysIn, fmtLong, fmtShortDay, isDisabled, lengthText, monthGrid, openingMonth, preview, shiftDay, shiftMonth, weekdayHeads } from '../../../src/services/dateRange.ts';

describe('date range rules', () => {
  it('moves days and months, across month and year ends', () => {
    assert.equal(shiftDay('2026-11-30', 1), '2026-12-01'); assert.equal(shiftDay('2026-03-01', -1), '2026-02-28'); assert.equal(shiftDay('2028-02-28', 1), '2028-02-29');
    assert.equal(shiftMonth('2026-11', 1), '2026-12'); assert.equal(shiftMonth('2026-12', 1), '2027-01'); assert.equal(shiftMonth('2026-01', -1), '2025-12'); assert.equal(shiftMonth('2026-11', -23), '2024-12');
    assert.equal(daysIn('2026-11-18', '2026-12-29'), 42);
  });
  it('writes dates without any day-month confusion', () => {
    assert.equal(fmtLong('2026-11-18'), '18 Nov 2026'); assert.equal(fmtShortDay('2026-11-18'), 'Wed 18 Nov'); assert.equal(fmtLong(''), '');
    assert.deepEqual(weekdayHeads(1), ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']); assert.deepEqual(weekdayHeads(0)[0], 'Su');
  });
  it('lays a month out in whole weeks starting on the chosen weekday', () => {
    const g = monthGrid('2026-11', 1);                      // 1 Nov 2026 is a Sunday
    assert.ok(g.every((w) => w.length === 7));
    assert.equal(g[0][0].day, '2026-10-26'); assert.equal(g[0][0].inMonth, false); assert.equal(g[0][6].day, '2026-11-01'); assert.equal(g[0][6].inMonth, true);
    const flat = g.flat().filter((d) => d.inMonth).map((d) => d.day);
    assert.equal(flat.length, 30); assert.equal(flat[0], '2026-11-01'); assert.equal(flat.at(-1), '2026-11-30');
    assert.equal(monthGrid('2026-11', 0)[0][0].day, '2026-11-01');   // a Sunday-first week starts on the 1st
    assert.equal(monthGrid('2026-02', 1).length, 5);           // February 2026 fits five weeks
  });
  it('limits what can be chosen: before min, after max, and too far from the first click', () => {
    assert.equal(isDisabled('2026-11-17', { min: '2026-11-18' }), true); assert.equal(isDisabled('2026-11-18', { min: '2026-11-18' }), false);
    assert.equal(isDisabled('2026-12-01', { max: '2026-11-30' }), true);
    const lim = { maxDays: 126 };
    assert.equal(isDisabled('2027-03-23', lim, '2026-11-18'), false);   // exactly 126 days
    assert.equal(isDisabled('2027-03-24', lim, '2026-11-18'), true);
    assert.equal(isDisabled('2026-07-16', lim, '2026-11-18'), false);   // 126 days counting both ends: counted backwards as well
    assert.equal(isDisabled('2026-07-15', lim, '2026-11-18'), true);
  });
  it('starts a range on the first click and ends it on the second, in either order', () => {
    const a = click(null, '2026-11-18'); assert.deepEqual(a, { anchor: '2026-11-18', range: null });
    assert.deepEqual(click(a.anchor, '2026-12-29'), { anchor: null, range: { from: '2026-11-18', to: '2026-12-29' } });
    assert.deepEqual(click(a.anchor, '2026-11-01'), { anchor: null, range: { from: '2026-11-01', to: '2026-11-18' } });
    assert.deepEqual(click(a.anchor, '2026-11-18'), { anchor: null, range: { from: '2026-11-18', to: '2026-11-18' } });
  });
  it('previews the range while the pointer moves, and opens on the right month', () => {
    assert.deepEqual(preview('2026-11-18', '2026-11-25'), { from: '2026-11-18', to: '2026-11-25' });
    assert.deepEqual(preview('2026-11-18', '2026-11-10'), { from: '2026-11-10', to: '2026-11-18' });
    assert.deepEqual(preview('2026-11-18', null), { from: '2026-11-18', to: '2026-11-18' });
    assert.equal(openingMonth('2026-03-05', '2026-11-18'), '2026-03'); assert.equal(openingMonth(null, '2026-11-18'), '2026-11');
  });
  it('says how long a range is', () => {
    assert.equal(lengthText('2026-11-18', '2026-12-29'), '6 weeks'); assert.equal(lengthText('2026-11-18', '2026-11-24'), '1 week');
    assert.equal(lengthText('2026-11-18', '2026-12-31'), '44 days'); assert.equal(lengthText('2026-11-18', '2026-11-18'), '1 day');
  });
});
