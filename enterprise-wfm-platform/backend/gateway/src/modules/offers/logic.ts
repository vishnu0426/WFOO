/**
 * The two pure decisions behind VTO and overtime offers, kept apart from the database so they can be tested on their own:
 *   1. what an accepted offer does to a person's shift (trim it, extend it, remove it or add one), and
 *   2. who is asked first, according to the ordering the organisation chose.
 */
export interface Act { type: 'MEAL' | 'BREAK'; startSlot: number; slots: number }
export interface ShiftIn { startSlot: number; lengthSlots: number; activities: Act[] }
export type Change = { kind: 'DELETE' } | { kind: 'UPDATE'; startSlot: number; lengthSlots: number; activities: Act[] } | { kind: 'INSERT'; startSlot: number; lengthSlots: number };

const keepInside = (acts: Act[], from: number, to: number) => acts.filter((a) => a.startSlot >= from && a.startSlot + a.slots <= to);

/** Time off for the window [ws, we). It must reach the start or the end of the shift; the middle of a shift cannot be given back without splitting it. */
export function vtoChange(s: ShiftIn, ws: number, we: number): Change | null {
  const ss = s.startSlot, se = s.startSlot + s.lengthSlots;
  if (we <= ss || ws >= se) return null;                                   // the window does not touch this shift
  if (ws <= ss && we >= se) return { kind: 'DELETE' };
  if (ws <= ss) return { kind: 'UPDATE', startSlot: we, lengthSlots: se - we, activities: keepInside(s.activities, we, se) };          // start later
  if (we >= se) return { kind: 'UPDATE', startSlot: ss, lengthSlots: ws - ss, activities: keepInside(s.activities, ss, ws) };          // leave earlier
  return null;
}

/** Extra hours in [ws, we): added to the end or the start of the shift when they join up with it, or a new shift on a day off. */
export function overtimeChange(s: ShiftIn | null, ws: number, we: number): Change | null {
  if (!s) return we - ws >= 2 ? { kind: 'INSERT', startSlot: ws, lengthSlots: we - ws } : null;                                         // at least half an hour
  const ss = s.startSlot, se = s.startSlot + s.lengthSlots;
  if (ws <= se && ws >= ss && we > se) return { kind: 'UPDATE', startSlot: ss, lengthSlots: we - ss, activities: s.activities };        // stay later
  if (we >= ss && we <= se && ws < ss) return { kind: 'UPDATE', startSlot: ws, lengthSlots: se - ws, activities: s.activities };        // start earlier
  return null;
}

export type Ordering = 'SENIORITY' | 'FIRST_COME' | 'FEWEST_HOURS' | 'MOST_HOURS' | 'ROUND_ROBIN' | 'RANDOM';
export const ORDERINGS: Ordering[] = ['SENIORITY', 'FIRST_COME', 'FEWEST_HOURS', 'MOST_HOURS', 'ROUND_ROBIN', 'RANDOM'];
export interface Candidate { employeeId: string; employeeNumber: string; hireDate: string | null; weekHours: number; lastAcceptedAt: string | null }

/** A small repeatable hash, so RANDOM is fair but the same offer always gives the same order (useful for support and tests). */
const mix = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Best first. Ties fall back to the employee number, so the result never depends on the order the database returned. */
export function orderCandidates(list: Candidate[], ordering: Ordering, opts: { reverseSeniority?: boolean; seed?: string } = {}): Candidate[] {
  const tie = (a: Candidate, b: Candidate) => (a.employeeNumber < b.employeeNumber ? -1 : a.employeeNumber > b.employeeNumber ? 1 : 0);
  const cmp: Record<Ordering, (a: Candidate, b: Candidate) => number> = {
    SENIORITY: (a, b) => { const x = a.hireDate ?? '9999-12-31', y = b.hireDate ?? '9999-12-31'; return (x < y ? -1 : x > y ? 1 : 0) * (opts.reverseSeniority ? -1 : 1); },
    FEWEST_HOURS: (a, b) => a.weekHours - b.weekHours,
    MOST_HOURS: (a, b) => b.weekHours - a.weekHours,
    ROUND_ROBIN: (a, b) => { const x = a.lastAcceptedAt ?? '', y = b.lastAcceptedAt ?? ''; return x < y ? -1 : x > y ? 1 : 0; },        // never accepted, then longest ago
    RANDOM: (a, b) => mix((opts.seed ?? '') + a.employeeId) - mix((opts.seed ?? '') + b.employeeId),
    FIRST_COME: () => 0,
  };
  return [...list].sort((a, b) => cmp[ordering](a, b) || tie(a, b));
}

/** Contiguous stretches where scheduled minus required stays at or beyond `min` (positive = surplus, negative = shortage). */
export function runs(gap: number[], min: number, sign: 1 | -1, minSlots = 2): { start: number; end: number; spots: number }[] {
  const out: { start: number; end: number; spots: number }[] = [];
  let i = 0;
  while (i < gap.length) {
    if (sign * gap[i] >= min) {
      let j = i, lo = Infinity;
      while (j < gap.length && sign * gap[j] >= min) { lo = Math.min(lo, Math.floor(sign * gap[j])); j++; }
      if (j - i >= minSlots) out.push({ start: i, end: j, spots: Math.max(1, lo) });
      i = j;
    } else i++;
  }
  return out;
}
