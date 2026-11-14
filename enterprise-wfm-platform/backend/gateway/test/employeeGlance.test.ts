/**
 * The arithmetic behind an employee's week at a glance, against figures worked out by hand. No database or engine needed:
 *   npx tsx --test --test-force-exit test/employeeGlance.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-00';
const { paidSlotsOf, weekView } = await import('../src/modules/employeeGlance.ts');

describe('paid time of a shift', () => {
  it('takes an unpaid meal out and leaves a paid one in', () => {
    // 9 hours (36 quarter hours) with a 1 hour (4 slot) meal: 8 paid hours when the meal is unpaid, 9 when it is paid
    assert.equal(paidSlotsOf(36, [{ type: 'MEAL', startSlot: 16, slots: 4 }], false), 32);
    assert.equal(paidSlotsOf(36, [{ type: 'MEAL', startSlot: 16, slots: 4 }], true), 36);
  });
  it('takes the gap of a split shift out whatever the meal setting, and leaves breaks in', () => {
    assert.equal(paidSlotsOf(40, [{ type: 'SPLIT_GAP', startSlot: 16, slots: 8 }, { type: 'BREAK', startSlot: 4, slots: 1 }], true), 32);
    assert.equal(paidSlotsOf(8, null, false), 8);
    assert.equal(paidSlotsOf(4, [{ type: 'MEAL', startSlot: 0, slots: 9 }], false), 0, 'never below nothing');
  });
});

describe('the week', () => {
  const shift = (day: string, startSlot: number, lengthSlots: number) => ({ day, startSlot, lengthSlots, activities: [{ type: 'MEAL', startSlot: startSlot + 16, slots: 4 }], mealPaid: false, scheduleName: 'Week 46', groupName: 'Support' });
  it('lists seven days from the first day of the pay week, with the shift, paid hours and any leave', () => {
    // Monday 2026-11-09: Mon, Tue and Wed 08:00-17:00 (8 paid hours each), Thursday on approved leave, nothing Friday to Sunday
    const w = weekView('2026-11-09', [shift('2026-11-09', 32, 36), shift('2026-11-10', 32, 36), shift('2026-11-11', 32, 36)], [{ type: 'ANNUAL', startDay: '2026-11-12', endDay: '2026-11-12', status: 'APPROVED' }], 40, 48);
    assert.deepEqual(w.days.map((d) => d.name), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.deepEqual([w.days[0].shift?.start, w.days[0].shift?.end, w.days[0].shift?.paidHours], ['08:00', '17:00', 8]);
    assert.equal(w.days[3].timeOff?.type, 'ANNUAL');
    assert.equal(w.days[4].shift, null);
    assert.equal(w.paidHours, 24);
    assert.equal(w.belowContract, true, '24 paid hours is below a 40 hour contract');
    assert.equal(w.overMax, false);
  });
  it('says when the week is over the person\'s maximum, and marks a night shift as overnight', () => {
    const w = weekView('2026-11-09', ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'].map((d) => ({ ...shift(d, 80, 40), activities: [] })), [], 40, 48);
    assert.equal(w.paidHours, 60);
    assert.equal(w.overMax, true);
    assert.equal(w.days[0].shift?.overnight, true, '20:00 for 10 hours runs past midnight');
    assert.equal(w.days[0].shift?.end, '06:00');
  });
});
