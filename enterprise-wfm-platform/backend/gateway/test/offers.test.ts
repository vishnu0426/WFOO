/**
 * VTO and overtime offers, the parts that need no server: what an accepted offer does to a shift, who is asked first, and how
 * the forecast's surplus and shortage turn into suggested windows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orderCandidates, overtimeChange, runs, vtoChange, type Candidate } from '../src/modules/offers/logic.ts';

const shift = { startSlot: 32, lengthSlots: 34, activities: [{ type: 'BREAK' as const, startSlot: 40, slots: 1 }, { type: 'MEAL' as const, startSlot: 48, slots: 2 }, { type: 'BREAK' as const, startSlot: 60, slots: 1 }] };   // 08:00 to 16:30

describe('what an accepted offer does to a shift', () => {
  it('lets someone leave early or start late, and drops the breaks that fall in the removed time', () => {
    assert.deepEqual(vtoChange(shift, 56, 66), { kind: 'UPDATE', startSlot: 32, lengthSlots: 24, activities: shift.activities.slice(0, 2) });     // off from 14:00
    const late = vtoChange(shift, 32, 44)!;
    assert.deepEqual(late, { kind: 'UPDATE', startSlot: 44, lengthSlots: 22, activities: shift.activities.slice(1) });                               // start at 11:00
  });
  it('removes the whole shift when the window covers it, and refuses the middle of a shift or another time', () => {
    assert.deepEqual(vtoChange(shift, 30, 70), { kind: 'DELETE' });
    assert.equal(vtoChange(shift, 44, 52), null);          // would split the shift
    assert.equal(vtoChange(shift, 70, 80), null);          // after the shift
  });
  it('extends a shift at either end, or adds a shift on a day off', () => {
    assert.deepEqual(overtimeChange(shift, 66, 72), { kind: 'UPDATE', startSlot: 32, lengthSlots: 40, activities: shift.activities });
    assert.deepEqual(overtimeChange(shift, 28, 32), { kind: 'UPDATE', startSlot: 28, lengthSlots: 38, activities: shift.activities });
    assert.deepEqual(overtimeChange(null, 60, 68), { kind: 'INSERT', startSlot: 60, lengthSlots: 8 });
    assert.equal(overtimeChange(null, 60, 61), null);      // too short to be worth a shift
    assert.equal(overtimeChange(shift, 72, 80), null);     // a gap after the shift: that would be two shifts
  });
});

const c = (n: string, over: Partial<Candidate> = {}): Candidate => ({ employeeId: `id-${n}`, employeeNumber: n, hireDate: null, weekHours: 30, lastAcceptedAt: null, ...over });
const numbers = (l: Candidate[]) => l.map((x) => x.employeeNumber);

describe('who is asked first', () => {
  const pool = [c('E3', { hireDate: '2019-01-01', weekHours: 40, lastAcceptedAt: '2026-09-01T00:00:00Z' }), c('E1', { hireDate: '2024-06-01', weekHours: 24, lastAcceptedAt: '2026-08-01T00:00:00Z' }), c('E2', { hireDate: '2021-03-01', weekHours: 32 }), c('E4', { weekHours: 32 })];
  it('by seniority: earliest hire first, people without a hire date last, or the other way round', () => {
    assert.deepEqual(numbers(orderCandidates(pool, 'SENIORITY')), ['E3', 'E2', 'E1', 'E4']);
    assert.deepEqual(numbers(orderCandidates(pool, 'SENIORITY', { reverseSeniority: true })), ['E4', 'E1', 'E2', 'E3']);
  });
  it('by hours worked in the week, fewest or most first, ties by employee number', () => {
    assert.deepEqual(numbers(orderCandidates(pool, 'FEWEST_HOURS')), ['E1', 'E2', 'E4', 'E3']);
    assert.deepEqual(numbers(orderCandidates(pool, 'MOST_HOURS')), ['E3', 'E2', 'E4', 'E1']);
  });
  it('round robin: nobody who ever accepted goes before someone who has not, then longest ago first', () => {
    assert.deepEqual(numbers(orderCandidates(pool, 'ROUND_ROBIN')), ['E2', 'E4', 'E1', 'E3']);
  });
  it('random is repeatable for one offer and differs between offers', () => {
    const a = numbers(orderCandidates(pool, 'RANDOM', { seed: 'offer-1' })), again = numbers(orderCandidates(pool, 'RANDOM', { seed: 'offer-1' }));
    assert.deepEqual(a, again);
    const many = new Set(Array.from({ length: 12 }, (_, i) => numbers(orderCandidates(pool, 'RANDOM', { seed: `offer-${i}` })).join()));
    assert.ok(many.size > 1);
  });
  it('first come keeps a stable order and does not mutate its input', () => {
    const before = numbers(pool);
    assert.deepEqual(numbers(orderCandidates(pool, 'FIRST_COME')), ['E1', 'E2', 'E3', 'E4']);
    assert.deepEqual(numbers(pool), before);
  });
});

describe('suggestions from the forecast', () => {
  it('finds stretches of surplus or shortage of at least half an hour, with the number of people', () => {
    const gap = [0, 0, 2, 3, 2, 1, 0, -1, -2, -2, -1, 0];
    assert.deepEqual(runs(gap, 1, 1), [{ start: 2, end: 6, spots: 1 }]);
    assert.deepEqual(runs(gap, 1, -1), [{ start: 7, end: 11, spots: 1 }]);
    assert.deepEqual(runs([0, 1, 0, 0, 1, 1, 0], 1, 1), [{ start: 4, end: 6, spots: 1 }]);        // a single quarter hour is too short
  });
});
