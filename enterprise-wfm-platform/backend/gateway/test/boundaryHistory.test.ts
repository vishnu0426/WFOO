/** What people worked just before a schedule starts: days in a row, the week's hours, rest and shifts that run past midnight. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryFrom, dayOffset, historyNote, mergeCarry, netRequired, spillOver, type PriorShift } from '../src/modules/boundaryHistory.ts';

const sh = (employeeId: string, day: string, startSlot: number, lengthSlots = 34, paidSlots = 32): PriorShift => ({ employeeId, day, startSlot, lengthSlots, paidSlots });
const START = '2026-11-02';        // a Monday
const PERIOD = 7 * 96;

describe('boundaryHistory', () => {
  it('counts whole days between dates, negative before the start', () => {
    assert.equal(dayOffset('2026-11-01', START), -1);
    assert.equal(dayOffset('2026-10-26', START), -7);
    assert.equal(dayOffset('2026-11-02', START), 0);
  });

  it('counts the days in a row that end the day before the start, and stops at a gap', () => {
    const b = boundaryFrom([sh('a', '2026-11-01', 24), sh('a', '2026-10-31', 24), sh('a', '2026-10-29', 24), sh('b', '2026-10-30', 24)], START, 0, PERIOD);
    assert.equal(b.byEmployee.get('a')!.run, 2);       // 1 Nov and 31 Oct; 30 Oct is a day off
    assert.equal(b.byEmployee.get('b')!.run, 0);       // last worked two days before the gap
  });

  it('ignores shifts older than a week or on or after the start', () => {
    const b = boundaryFrom([sh('a', '2026-10-20', 24), sh('a', '2026-11-02', 24)], START, 0, PERIOD);
    assert.equal(b.people, 0);
  });

  it('puts the end of a night shift in slots from the start of day 0 and carries it over', () => {
    // Sunday 21:00 (slot 84), 34 slots long -> ends at slot 118 of Sunday = 22 slots into Monday (05:30)
    const b = boundaryFrom([sh('n', '2026-11-01', 84)], START, 0, PERIOD);
    assert.equal(b.byEmployee.get('n')!.endSlot, -96 + 84 + 34);
    assert.equal(b.carriedPeople, 1);
    assert.deepEqual(b.carryOver[0], [0, 1]);
    assert.deepEqual(b.carryOver[b.carryOver.length - 1], [21, 1]);
    assert.equal(b.carryOver.length, 22);
  });

  it('a shift that ended the evening before carries nothing over but still sets the rest', () => {
    const b = boundaryFrom([sh('d', '2026-11-01', 24)], START, 0, PERIOD);            // 06:00 to 14:30 on Sunday
    assert.equal(b.carriedPeople, 0);
    assert.equal(b.carryOver.length, 0);
    assert.equal(b.byEmployee.get('d')!.endSlot, -96 + 24 + 34);
  });

  it('keeps the last end when there are several earlier shifts', () => {
    const b = boundaryFrom([sh('a', '2026-10-30', 84), sh('a', '2026-11-01', 24)], START, 0, PERIOD);
    assert.equal(b.byEmployee.get('a')!.endSlot, -96 + 24 + 34);
  });

  it('counts only the same calendar week for the hours already worked', () => {
    // starts on Thursday 5 Nov: Monday to Wednesday (2 to 4 Nov) are the week's earlier days
    const b = boundaryFrom([sh('a', '2026-11-02', 24), sh('a', '2026-11-03', 24), sh('a', '2026-11-04', 24), sh('a', '2026-11-01', 24)], '2026-11-05', 3, PERIOD);
    const a = b.byEmployee.get('a')!;
    assert.equal(a.weekSlots, 3 * 32);
    assert.equal(a.weekDays, 3);                       // Sunday 1 Nov belongs to the previous week
    assert.equal(a.leadDays, 3);
    assert.equal(a.run, 4);                            // but it still counts toward days in a row
  });

  it('a Monday start has no part week to carry', () => {
    const a = boundaryFrom([sh('a', '2026-11-01', 24)], START, 0, PERIOD).byEmployee.get('a')!;
    assert.equal(a.weekSlots, 0);
    assert.equal(a.leadDays, 0);
  });

  it('clips carried-over cover to the length of the new schedule', () => {
    const b = boundaryFrom([sh('n', '2026-11-01', 84, 200)], START, 0, 10);
    assert.equal(b.carryOver.length, 10);
  });

  it('subtracts carried-over cover from the requirement without going below zero', () => {
    const net = netRequired([3, 3, 0, 5], [[0, 2], [1, 5], [2, 1], [9, 1]]);
    assert.deepEqual(net, [1, 0, 0, 5]);
  });

  it('leaves the requirement alone when there is nothing to carry', () => {
    const req = [1, 2, 3];
    assert.equal(netRequired(req, []), req);
    assert.equal(netRequired(req, null), req);
  });

  it('describes what was carried, or nothing', () => {
    assert.equal(historyNote(boundaryFrom([], START, 0, PERIOD), null), null);
    const note = historyNote(boundaryFrom([sh('n', '2026-11-01', 84), sh('d', '2026-11-01', 24)], START, 0, PERIOD), 'Schedule v1')!;
    assert.match(note, /2 people/);
    assert.match(note, /Schedule v1/);
    assert.match(note, /1 is still on shift after midnight/);
  });
  describe('a week that repeats', () => {
    it('the last day shifts past midnight cover the first hours, and nothing else does', () => {
      const spill = spillOver([{ dayIdx: 6, startSlot: 84, length: 34 }, { dayIdx: 6, startSlot: 90, length: 34 }, { dayIdx: 5, startSlot: 84, length: 34 }, { dayIdx: 6, startSlot: 24, length: 34 }], 6, 7 * 96);
      assert.equal(spill.length, 28);                                 // the later shift runs 28 slots past midnight
      assert.deepEqual(spill[0], [0, 2]);                             // both overnight shifts cover the first slot
      assert.deepEqual(spill[27], [27, 1]);                           // only the later one reaches slot 27
    });
    it('adds carry-over lists slot by slot', () => {
      assert.deepEqual(mergeCarry([[0, 2], [1, 1]], [[1, 3], [5, 1]]), [[0, 2], [1, 4], [5, 1]]);
      assert.deepEqual(mergeCarry([], []), []);
    });
  });
});
