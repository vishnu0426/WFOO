/**
 * The rules of the availability grid (what a day shows, what painting does), checked without a browser or a database:
 *   npx tsx --test --test-force-exit test/availabilityGrid.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrush, brushProblem, copyWeek, daySummary, rectangle, sameWeek, type Win } from '../../../src/components/workforce/availabilityRules.ts';

const w = (dayOfWeek: number, startTime: string, endTime: string, kind: Win['kind']): Win => ({ dayOfWeek, startTime, endTime, kind });

describe('what a day shows', () => {
  it('is "any time" with no rule, and for an all-day availability (which restricts nothing)', () => {
    assert.deepEqual(daySummary([], 0), { state: 'ANY', label: 'Any time' });
    assert.equal(daySummary([w(0, '00:00', '24:00', 'AVAILABLE')], 0).state, 'ANY');
  });
  it('is off for an all-day unavailable, and says which hours when only part of the day is blocked', () => {
    assert.deepEqual(daySummary([w(5, '00:00', '24:00', 'UNAVAILABLE')], 5), { state: 'OFF', label: 'Off' });
    assert.deepEqual(daySummary([w(2, '12:00', '14:30', 'UNAVAILABLE')], 2), { state: 'BLOCKED', label: 'Not 12–14:30' });
  });
  it('shows the hours a person is limited to, and what they prefer', () => {
    assert.deepEqual(daySummary([w(1, '09:00', '17:00', 'AVAILABLE')], 1), { state: 'AVAILABLE', label: '9–17' });
    assert.deepEqual(daySummary([w(1, '06:00', '10:00', 'PREFERRED')], 1), { state: 'PREFERRED', label: 'Prefers 6–10' });
  });
  it('says so when a day mixes meanings, and looks only at its own day', () => {
    const all = [w(3, '09:00', '17:00', 'AVAILABLE'), w(3, '12:00', '13:00', 'UNAVAILABLE'), w(4, '00:00', '24:00', 'UNAVAILABLE')];
    assert.deepEqual(daySummary(all, 3), { state: 'MIXED', label: '2 rules' });
    assert.equal(daySummary(all, 4).state, 'OFF');
    assert.equal(daySummary(all, 0).state, 'ANY');
  });
});

describe('painting', () => {
  const week = [w(0, '09:00', '17:00', 'AVAILABLE'), w(1, '09:00', '17:00', 'AVAILABLE'), w(5, '00:00', '24:00', 'UNAVAILABLE')];

  it('replaces only the painted days and keeps the others exactly as they were', () => {
    const next = applyBrush(week, [0, 1], { type: 'OFF' });
    assert.deepEqual(next.map((x) => [x.dayOfWeek, x.kind]), [[0, 'UNAVAILABLE'], [1, 'UNAVAILABLE'], [5, 'UNAVAILABLE']]);
    assert.deepEqual(next.filter((x) => x.dayOfWeek === 5), [week[2]]);
  });
  it('clears a day with "any time"', () => {
    assert.deepEqual(applyBrush(week, [0, 1, 5], { type: 'ANY' }), []);
  });
  it('paints hours, one window per day, in day order', () => {
    const next = applyBrush([], [4, 2, 3], { type: 'AVAILABLE', from: '08:00', to: '16:00' });
    assert.deepEqual(next.map((x) => [x.dayOfWeek, x.startTime, x.endTime, x.kind]), [[2, '08:00', '16:00', 'AVAILABLE'], [3, '08:00', '16:00', 'AVAILABLE'], [4, '08:00', '16:00', 'AVAILABLE']]);
    assert.equal(applyBrush([], [6], { type: 'PREFERRED', from: '10:00', to: '14:00' })[0].kind, 'PREFERRED');
  });
  it('painting the same thing again changes nothing', () => {
    const once = applyBrush(week, [2, 3], { type: 'OFF' });
    assert.ok(sameWeek(once, applyBrush(once, [2, 3], { type: 'OFF' })));
  });
  it('refuses hours that end before they start, and missing times', () => {
    assert.equal(brushProblem({ type: 'AVAILABLE', from: '17:00', to: '09:00' }), 'The end must be after the start');
    assert.equal(brushProblem({ type: 'PREFERRED', from: '', to: '09:00' }), 'Choose a start and an end time');
    assert.equal(brushProblem({ type: 'AVAILABLE', from: '08:00', to: '24:00' }), null);
    assert.equal(brushProblem({ type: 'OFF' }), null);
  });
});

describe('copying a week and selecting cells', () => {
  it('gives someone else the same week as an independent copy', () => {
    const src = [w(0, '09:00', '17:00', 'AVAILABLE')];
    const dup = copyWeek(src);
    assert.ok(sameWeek(src, dup));
    dup[0].startTime = '10:00';
    assert.equal(src[0].startTime, '09:00', 'changing the copy does not change the original');
    assert.ok(!sameWeek(src, dup));
  });
  it('compares weeks whatever order the windows are in', () => {
    const a = [w(1, '09:00', '12:00', 'AVAILABLE'), w(0, '09:00', '17:00', 'AVAILABLE')];
    assert.ok(sameWeek(a, [a[1], a[0]]));
  });
  it('selects the cells between two corners of a drag, whichever way it was dragged', () => {
    const cells = rectangle({ row: 3, day: 4 }, { row: 1, day: 2 });
    assert.equal(cells.length, 9);
    assert.deepEqual(cells[0], { row: 1, day: 2 });
    assert.deepEqual(cells[8], { row: 3, day: 4 });
  });
});
