/** Fixes from the 50,000-person scale test that can be checked without a running stack. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { underContractNote } from '../src/modules/scheduleQuality.ts';

const ft = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, employmentType: 'FULL_TIME', weeklyContractHours: 40 }));

describe('full-time people below contract hours', () => {
  it('says nothing when everyone is at or near their contract', () => {
    const paid = new Map(ft(10).map((e) => [e.id, 160]));          // 40 h a week for one week
    assert.equal(underContractNote({ people: ft(10), paidSlotsByPerson: paid, weeks: 1, crewIsLarge: false }), null);
  });
  it('warns, with numbers and a reason, when a quarter or more are well below', () => {
    const people = ft(8), paid = new Map(people.map((e, i) => [e.id, i < 4 ? 160 : 128]));      // half get 32 h
    const n = underContractNote({ people, paidSlotsByPerson: paid, weeks: 1, crewIsLarge: true })!;
    assert.equal(n.level, 'WARNING');
    assert.match(n.message, /4 of 8 full-time people \(50%\)/);
    assert.match(n.message, /36 hours against 40/);
    assert.match(n.message, /larger than the forecast needs/);
  });
  it('a few below is information only, and part-timers are not counted', () => {
    const people = [...ft(20), { id: 'pt', employmentType: 'PART_TIME', weeklyContractHours: 20 }];
    const paid = new Map(people.map((e) => [e.id, e.id === 'e0' || e.id === 'e1' ? 100 : e.employmentType === 'PART_TIME' ? 0 : 160]));
    const n = underContractNote({ people, paidSlotsByPerson: paid, weeks: 1, crewIsLarge: false })!;
    assert.equal(n.level, 'INFO');
    assert.match(n.message, /2 of 20 full-time people/);
  });
});
