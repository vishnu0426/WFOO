/** A new queue borrowing the daily pattern of a similar queue: its own volume stays its own, and the borrowing stops once it has enough history. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { borrowSlots, MIN_OWN_DAYS, shareByslot, shouldBorrow, slotDays } from '../src/modules/forecast/borrowShape.ts';

const donor = (days: string[]) => days.flatMap((day) => [{ day, slot: 36, volume: 60, aht_sec: 300 }, { day, slot: 40, volume: 30, aht_sec: 300 }, { day, slot: 44, volume: 10, aht_sec: 300 }]);

describe('borrowing a pattern', () => {
  it('spreads a day total the way the other queue spread the same day, keeping its own volume', () => {
    const { slots, borrowedDays } = borrowSlots([{ day: '2027-03-01', volume: 50, aht_sec: 420 }], [], donor(['2027-03-01']));
    assert.equal(borrowedDays, 1);
    assert.deepEqual(slots.map((s) => [s.slot, s.volume]), [[36, 30], [40, 15], [44, 5]]);
    assert.equal(slots.reduce((n, s) => n + s.volume, 0), 50, 'the total is the new queue\'s own');
    assert.ok(slots.every((s) => s.aht_sec === 420), 'and so is its handle time');
  });
  it('replaces its own few noisy intervals with the other queue\'s pattern, and keeps its own on days the other queue has none for', () => {
    const own = [{ day: '2027-03-02', slot: 10, volume: 7, aht_sec: 300 }, { day: '2027-03-03', slot: 12, volume: 9, aht_sec: 300 }];
    const { slots, borrowedDays } = borrowSlots(
      [{ day: '2027-03-01', volume: 50, aht_sec: 300 }, { day: '2027-03-02', volume: 70, aht_sec: 300 }, { day: '2027-03-03', volume: 40, aht_sec: 300 }], own, donor(['2027-03-01', '2027-03-02']));
    assert.equal(borrowedDays, 2);
    assert.deepEqual(slots.filter((s) => s.day === '2027-03-02').map((s) => s.slot), [36, 40, 44], 'replaced by the other queue\'s shape');
    assert.deepEqual(slots.filter((s) => s.day === '2027-03-03').map((s) => s.slot), [12], 'no pattern to borrow for that day, so its own stays');
  });
  it('does nothing for a day with no volume', () => assert.equal(borrowSlots([{ day: '2027-03-01', volume: 0, aht_sec: 300 }], [], donor(['2027-03-01'])).slots.length, 0));
  it('borrows only while the queue has fewer than the needed days of its own, and only from a queue with more', () => {
    const days = (n: number) => Array.from({ length: n }, (_, i) => `2027-01-${String(i + 1).padStart(2, '0')}`);
    const mk = (n: number) => donor(days(n));
    assert.equal(shouldBorrow(mk(5), mk(60)), true);
    assert.equal(shouldBorrow(mk(MIN_OWN_DAYS), mk(60)), false, 'enough of its own');
    assert.equal(shouldBorrow(mk(5), mk(5)), false, 'the other queue has nothing more to give');
    assert.equal(slotDays(mk(3)), 3);
  });
  it('shares a weekday of history out over the slots', () => {
    const s = shareByslot([{ slot: 1, volume: 3 }, { slot: 2, volume: 1 }])!;
    assert.equal(s[1], 0.75); assert.equal(s[2], 0.25); assert.equal(shareByslot([]), null);
  });
});
