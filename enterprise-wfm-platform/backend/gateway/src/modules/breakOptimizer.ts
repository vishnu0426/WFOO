/**
 * Pure logic for dynamic break/meal re-optimization: given today's published shifts and the forecast's required
 * headcount per 15-minute slot, suggest moving only activities that have not started yet, never a shift's own
 * start/end time or paid hours, to slots where the person is less needed elsewhere right now.
 */
export const SPD = 96;
export interface Activity { type: 'MEAL' | 'BREAK'; startSlot: number; slots: number }
export interface ShiftActs { id: string; employeeId: string; name: string; startSlot: number; lengthSlots: number; activities: Activity[] }
export interface Suggestion { shiftId: string; employeeName: string; type: 'MEAL' | 'BREAK'; fromSlot: number; toSlot: number; deficitReduction: number }

/** How many people are on shift and NOT on a break/meal, per slot. */
export function availableSeries(shifts: ShiftActs[]): number[] {
  const avail = new Array(SPD).fill(0);
  for (const s of shifts) {
    const end = Math.min(SPD, s.startSlot + s.lengthSlots);
    for (let g = s.startSlot; g < end; g++) {
      const onBreak = s.activities.some((a) => g >= a.startSlot && g < a.startSlot + a.slots);
      if (!onBreak) avail[g]++;
    }
  }
  return avail;
}

const windowCost = (avail: number[], required: number[], start: number, len: number) => {
  let cost = 0;
  for (let k = 0; k < len; k++) cost += Math.max(0, (required[start + k] ?? 0) - avail[start + k]);
  return cost;
};

/**
 * Suggested moves, best improvement first. `required` is per-slot headcount needed (length SPD). Only activities
 * starting after `nowSlot` are considered; a move must stay inside its own shift and not collide with a sibling
 * activity of the same shift.
 */
export function suggestBreakMoves(shifts: ShiftActs[], required: number[], nowSlot: number, maxShiftSlots = 8): Suggestion[] {
  const baseline = availableSeries(shifts);
  const suggestions: Suggestion[] = [];
  for (const s of shifts) {
    for (const act of s.activities) {
      if (act.startSlot <= nowSlot) continue; // already started or past: leave it
      const currentCost = windowCost(baseline, required, act.startSlot, act.slots);
      if (currentCost <= 0) continue; // this person is not needed more anywhere nearby right now
      let best: { start: number; cost: number } | null = null;
      for (let o = -maxShiftSlots; o <= maxShiftSlots; o++) {
        if (o === 0) continue;
        const start = act.startSlot + o;
        if (start <= Math.max(nowSlot, s.startSlot)) continue;
        if (start + act.slots >= s.startSlot + s.lengthSlots) continue;
        if (s.activities.some((other) => other !== act && start < other.startSlot + other.slots && start + act.slots > other.startSlot)) continue;
        const cost = windowCost(baseline, required, start, act.slots);
        if (!best || cost < best.cost) best = { start, cost };
      }
      if (best && best.cost < currentCost - 0.999) {
        suggestions.push({ shiftId: s.id, employeeName: s.name, type: act.type, fromSlot: act.startSlot, toSlot: best.start, deficitReduction: Math.round((currentCost - best.cost) * 10) / 10 });
        // simulate the move so later suggestions in this pass are not all drawn to the same slack
        for (let k = 0; k < act.slots; k++) { baseline[act.startSlot + k]++; baseline[best.start + k]--; }
      }
    }
  }
  return suggestions.sort((a, b) => b.deficitReduction - a.deficitReduction);
}
