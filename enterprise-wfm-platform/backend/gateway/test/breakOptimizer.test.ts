/**
 * Pure logic: dynamic break/meal re-optimization. No database, no server -- just the slot arithmetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { availableSeries, suggestBreakMoves, type ShiftActs } from '../src/modules/breakOptimizer.ts';

const req = (spec: { from: number; to: number; n: number }[]) => {
  const r = new Array(96).fill(0);
  for (const s of spec) for (let g = s.from; g < s.to; g++) r[g] = s.n;
  return r;
};

describe('availableSeries', () => {
  it('counts people on shift and not on a break as available', () => {
    const shifts: ShiftActs[] = [{ id: 'a', employeeId: 'e1', name: 'A', startSlot: 32, lengthSlots: 32, activities: [{ type: 'MEAL', startSlot: 48, slots: 2 }] }];
    const avail = availableSeries(shifts);
    assert.equal(avail[40], 1);   // working
    assert.equal(avail[48], 0);   // on the meal
    assert.equal(avail[49], 0);
    assert.equal(avail[50], 1);   // back from the meal
    assert.equal(avail[20], 0);   // before the shift starts
  });
});

describe('suggestBreakMoves', () => {
  it('proposes nothing when there is no deficit anywhere', () => {
    const shifts: ShiftActs[] = [{ id: 'a', employeeId: 'e1', name: 'A', startSlot: 32, lengthSlots: 32, activities: [{ type: 'BREAK', startSlot: 44, slots: 2 }] }];
    const out = suggestBreakMoves(shifts, req([]), 30);
    assert.deepEqual(out, []);
  });

  it('never touches an activity that already started or is in the past', () => {
    const shifts: ShiftActs[] = [{ id: 'a', employeeId: 'e1', name: 'A', startSlot: 20, lengthSlots: 40, activities: [{ type: 'BREAK', startSlot: 30, slots: 2 }] }];
    const out = suggestBreakMoves(shifts, req([{ from: 30, to: 32, n: 5 }]), 35); // now is slot 35, after the break started
    assert.deepEqual(out, []);
  });

  it('moves a not-yet-started break away from a slot with a big deficit, into slack', () => {
    // one person on shift 40..72 (10:00-18:00), a break placed at 50..52 where a deficit is forecast; 60..62 is slack (no one else needed).
    const shifts: ShiftActs[] = [{ id: 'a', employeeId: 'e1', name: 'A', startSlot: 40, lengthSlots: 32, activities: [{ type: 'BREAK', startSlot: 50, slots: 2 }] }];
    const required = req([{ from: 50, to: 52, n: 2 }]); // 2 needed, only this 1 person on shift there once the break is factored out -> deficit 2
    const out = suggestBreakMoves(shifts, required, 45);
    assert.equal(out.length, 1);
    assert.equal(out[0].fromSlot, 50);
    assert.ok(out[0].toSlot !== 50);
    assert.ok(out[0].deficitReduction > 0);
  });

  it('proposes nothing when the shift is too short for any legal alternative slot', () => {
    // shift is 40..43 (45 min); the only slot strictly inside it and not touching the boundary is 41 itself, so no move is legal even though the deficit there is large.
    const shifts: ShiftActs[] = [{ id: 'a', employeeId: 'e1', name: 'A', startSlot: 40, lengthSlots: 3, activities: [{ type: 'BREAK', startSlot: 41, slots: 1 }] }];
    const required = req([{ from: 41, to: 42, n: 5 }]);
    const out = suggestBreakMoves(shifts, required, 35);
    assert.deepEqual(out, []);
  });

  it('keeps a move inside its own shift and never overlapping a sibling activity', () => {
    const shift: ShiftActs = {
      id: 'a', employeeId: 'e1', name: 'A', startSlot: 32, lengthSlots: 24, // 08:00-14:00
      activities: [{ type: 'MEAL', startSlot: 44, slots: 2 }, { type: 'BREAK', startSlot: 38, slots: 1 }],
    };
    const required = req([{ from: 44, to: 46, n: 3 }]);
    const out = suggestBreakMoves([shift], required, 30, 8);
    assert.ok(out.length >= 1);
    for (const s of out) {
      const act = shift.activities.find((a) => a.type === s.type && a.startSlot === s.fromSlot)!;
      assert.ok(s.toSlot > shift.startSlot && s.toSlot + act.slots < shift.startSlot + shift.lengthSlots, 'stays strictly inside the shift');
      const sibling = shift.activities.find((a) => a !== act)!;
      const overlapsSibling = s.toSlot < sibling.startSlot + sibling.slots && s.toSlot + act.slots > sibling.startSlot;
      assert.equal(overlapsSibling, false, 'does not land on the sibling activity');
    }
  });

  it('reduces the biggest deficit first when two activities could both move', () => {
    const shifts: ShiftActs[] = [
      { id: 'a', employeeId: 'e1', name: 'A', startSlot: 32, lengthSlots: 40, activities: [{ type: 'BREAK', startSlot: 50, slots: 2 }] },
      { id: 'b', employeeId: 'e2', name: 'B', startSlot: 32, lengthSlots: 40, activities: [{ type: 'BREAK', startSlot: 60, slots: 2 }] },
    ];
    const required = req([{ from: 50, to: 52, n: 4 }, { from: 60, to: 62, n: 2 }]);
    const out = suggestBreakMoves(shifts, required, 40);
    assert.ok(out.length >= 1);
    assert.ok(out[0].deficitReduction >= (out[1]?.deficitReduction ?? 0), 'sorted best first');
  });
});
