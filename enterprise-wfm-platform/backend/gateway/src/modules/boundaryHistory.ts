/**
 * What people already worked just before a new schedule starts, taken from the previous published schedule.
 *
 * The solver only sees the days it is asked to plan. Without this it starts every schedule from a blank slate: nobody covers the first hours
 * of day 0 even if the last schedule has people on a night shift that runs past midnight, rest after that shift is not checked, days in a row
 * and the week's hours begin again at zero. Pure logic, no database: the caller fetches the earlier shifts.
 */
const SPD = 96;

export interface PriorShift { employeeId: string; day: string; startSlot: number; lengthSlots: number; paidSlots: number }
export interface PriorState {
  /** Days worked in a row, ending the day before the schedule starts. */
  run: number;
  /** End of the last earlier shift in slots counted from the start of day 0 (above 0: still on shift after midnight). Null when there is none. */
  endSlot: number | null;
  /** Paid slots and shifts already worked earlier in day 0's calendar week (Monday to Sunday). */
  weekSlots: number; weekDays: number;
  /** Calendar days of that week that came before day 0, when this person has any history; 0 otherwise. */
  leadDays: number;
}
export interface Boundary {
  byEmployee: Map<string, PriorState>;
  /** Earlier shifts that run past midnight into day 0, as [slot, people] pairs: they still cover the start of the new schedule. */
  carryOver: [number, number][];
  people: number; shifts: number; carriedPeople: number;
}

const utc = (day: string) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
/** Whole days from `from` to `day`: negative for earlier days. */
export const dayOffset = (day: string, from: string) => Math.round((utc(day) - utc(from)) / 86400000);

/**
 * @param shifts      earlier shifts, any dates; only those in the `lookBackDays` before `periodStart` are used
 * @param firstDow    weekday of the first day, Monday = 0
 * @param periodSlots length of the new schedule in slots, so carried-over cover is clipped to it
 */
export function boundaryFrom(shifts: PriorShift[], periodStart: string, firstDow: number, periodSlots: number, lookBackDays = 7): Boundary {
  const byEmployee = new Map<string, PriorState>();
  const spill = new Map<number, number>();
  const worked = new Map<string, Set<number>>();
  let used = 0, carriedPeople = 0;
  for (const s of shifts) {
    const off = dayOffset(s.day, periodStart);
    if (off >= 0 || off < -lookBackDays) continue;
    used++;
    const st = byEmployee.get(s.employeeId) ?? { run: 0, endSlot: null, weekSlots: 0, weekDays: 0, leadDays: firstDow };
    const end = off * SPD + s.startSlot + s.lengthSlots;
    st.endSlot = st.endSlot === null ? end : Math.max(st.endSlot, end);
    if (off >= -firstDow) { st.weekSlots += s.paidSlots; st.weekDays += 1; }
    byEmployee.set(s.employeeId, st);
    (worked.get(s.employeeId) ?? worked.set(s.employeeId, new Set()).get(s.employeeId)!).add(off);
    if (end > 0) {
      for (let g = 0; g < Math.min(end, periodSlots); g++) spill.set(g, (spill.get(g) ?? 0) + 1);
      carriedPeople++;
    }
  }
  for (const [id, days] of worked) {
    let run = 0;
    while (days.has(-1 - run)) run++;
    byEmployee.get(id)!.run = run;
  }
  return { byEmployee, carryOver: [...spill].sort((a, b) => a[0] - b[0]), people: byEmployee.size, shifts: used, carriedPeople };
}

/** The requirement the new schedule still has to cover once the earlier shifts that run into it are counted. Never below zero. */
export function netRequired(required: number[], carryOver: [number, number][] | null | undefined): number[] {
  if (!carryOver?.length) return required;
  const out = required.slice();
  for (const [g, n] of carryOver) if (g < out.length) out[g] = Math.max(0, out[g] - n);
  return out;
}

/** One line for the generation report, or null when there was nothing to carry in. */
export function historyNote(b: Boundary, previousName: string | null): string | null {
  if (!b.people) return null;
  const parts = [`${b.people} ${b.people === 1 ? 'person' : 'people'} had shifts in the 7 days before this schedule${previousName ? ` (${previousName})` : ''}: their rest, days in a row and the week's hours carry over`];
  if (b.carriedPeople) parts.push(`${b.carriedPeople} ${b.carriedPeople === 1 ? 'is' : 'are'} still on shift after midnight and count toward the first hours`);
  return parts.join('; ') + '.';
}

/** What a schedule's own last-day shifts leave running past its final midnight, as [slot, people] pairs from the start of day 0. Used when the week is assumed to repeat. */
export function spillOver(shifts: { dayIdx: number; startSlot: number; length: number }[], lastDayIdx: number, periodSlots: number): [number, number][] {
  const spill = new Map<number, number>();
  for (const s of shifts) {
    if (s.dayIdx !== lastDayIdx) continue;
    for (let g = 0; g < Math.min(s.startSlot + s.length - SPD, periodSlots); g++) spill.set(g, (spill.get(g) ?? 0) + 1);
  }
  return [...spill].sort((a, b) => a[0] - b[0]);
}

/** Adds two carry-over lists together slot by slot. */
export function mergeCarry(a: [number, number][], b: [number, number][]): [number, number][] {
  const m = new Map<number, number>();
  for (const [g, n] of [...a, ...b]) m.set(g, (m.get(g) ?? 0) + n);
  return [...m].sort((x, y) => x[0] - y[0]);
}
