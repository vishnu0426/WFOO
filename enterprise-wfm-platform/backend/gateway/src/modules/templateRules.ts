/**
 * Shift template rules, pure logic: what a template offers on a given day, for a given person, and what a shift of a given length gets for meal
 * and breaks. Everything that needs "how long is the unpaid meal" or "which start times does this template offer" goes through here, so
 * a variable-length template behaves the same in generation, validation, pay and reports.
 *
 * Slots are 15 minutes. A template always has a longest length (`lengthSlots`); with `minLengthSlots` set it offers every length from the
 * shortest to the longest in steps of `lengthStep`.
 */
export interface LengthRule { fromSlots: number; mealSlots: number; breakCount: number; breakSlots: number }
export interface DayWindow { earliest: number; latest: number }
export interface TemplateLike {
  id?: string; status?: string; workDays: number[];
  earliestStart: number; latestStart: number; startStep: number;
  lengthSlots: number; minLengthSlots?: number | null; lengthStep?: number | null;
  mealSlots: number; breakCount: number; breakSlots: number; flexSlots?: number;
  mealPaid?: boolean | null;
  dayWindows?: Record<string, DayWindow> | null;
  lengthRules?: LengthRule[] | null;
  groupIds?: string[] | null; employmentTypes?: string[] | null; skillIds?: string[] | null;
  effectiveFrom?: string | null; effectiveTo?: string | null;
}

/** Every shift length (in slots) the template offers, shortest first. */
export function lengthsOf(t: Pick<TemplateLike, 'lengthSlots' | 'minLengthSlots' | 'lengthStep'>): number[] {
  const max = t.lengthSlots, min = Math.min(t.minLengthSlots ?? max, max), step = Math.max(1, t.lengthStep ?? 2);
  if (min >= max) return [max];
  const out: number[] = [];
  for (let l = min; l < max; l += step) out.push(l);
  out.push(max);
  return out;
}

export const isVariable = (t: Pick<TemplateLike, 'lengthSlots' | 'minLengthSlots'>) => (t.minLengthSlots ?? t.lengthSlots) < t.lengthSlots;

/**
 * Meal and breaks for a shift of `len` slots.
 * - With explicit length rules: the rule with the largest `fromSlots` not above `len`; a shorter shift gets neither meal nor breaks.
 * - A fixed-length template without rules keeps its own meal and breaks, as before.
 * - A variable-length template without rules scales: a meal from 5 hours, one break for every 4 hours up to its configured count.
 * A meal never takes more than the shift leaves room for.
 */
export function rulesFor(t: TemplateLike, len: number): { mealSlots: number; breakCount: number; breakSlots: number } {
  let r: { mealSlots: number; breakCount: number; breakSlots: number };
  if (t.lengthRules?.length) {
    const hit = [...t.lengthRules].sort((a, b) => b.fromSlots - a.fromSlots).find((x) => x.fromSlots <= len);
    r = hit ? { mealSlots: hit.mealSlots, breakCount: hit.breakCount, breakSlots: hit.breakSlots } : { mealSlots: 0, breakCount: 0, breakSlots: t.breakSlots };
  } else if (isVariable(t)) {
    r = { mealSlots: len >= 20 ? t.mealSlots : 0, breakCount: Math.min(t.breakCount, Math.floor(len / 16)), breakSlots: t.breakSlots };
  } else {
    r = { mealSlots: t.mealSlots, breakCount: t.breakCount, breakSlots: t.breakSlots };
  }
  if (r.mealSlots >= len - 2) r = { ...r, mealSlots: 0 };
  return r;
}

/** Slots of a shift that are not paid: the meal, unless the template pays for it. */
export const unpaidMeal = (t: TemplateLike | null | undefined, len: number): number => (!t || t.mealPaid ? 0 : rulesFor(t, len).mealSlots);
export const paidSlots = (t: TemplateLike | null | undefined, len: number): number => len - unpaidMeal(t, len);

/** The start window a template offers on a weekday (Monday = 0): its own for that day, else the general one. */
export function windowFor(t: TemplateLike, dow: number): DayWindow {
  const w = t.dayWindows?.[String(dow)];
  return w ? { earliest: w.earliest, latest: Math.max(w.earliest, w.latest) } : { earliest: t.earliestStart, latest: t.latestStart };
}

/** Start times (slots) the template offers on a weekday; none when it does not run that day. */
export function startsFor(t: TemplateLike, dow: number): number[] {
  if (!t.workDays.includes(dow)) return [];
  const { earliest, latest } = windowFor(t, dow), out: number[] = [];
  for (let s = earliest; s <= latest; s += Math.max(1, t.startStep)) out.push(s);
  return out;
}

export interface Person { groupIds: string[]; employmentType: string; skillIds: string[] }

/** Why a template is not offered to this person on this day, or null when it is. The words fit into "…, a shift template that …". */
export function whyNotOffered(t: TemplateLike, p: Person, day: string): string | null {
  if (t.effectiveFrom && day < t.effectiveFrom) return 'shift templates that have not started yet';
  if (t.effectiveTo && day > t.effectiveTo) return 'shift templates that have ended';
  if (t.groupIds?.length && !p.groupIds.some((g) => t.groupIds!.includes(g))) return 'shift templates for other groups';
  if (t.employmentTypes?.length && !t.employmentTypes.includes(p.employmentType)) return 'shift templates for other contract types';
  if (t.skillIds?.length && !p.skillIds.some((s) => t.skillIds!.includes(s))) return 'shift templates that need a skill they do not have';
  return null;
}

/** A template with the same fields the database row has, from whatever shape the caller holds (database row or API body). Throws on nonsense. */
export function checkTemplate(t: TemplateLike): string | null {
  if (t.minLengthSlots != null && t.minLengthSlots > t.lengthSlots) return 'The shortest length cannot be longer than the longest';
  for (const [d, w] of Object.entries(t.dayWindows ?? {})) {
    if (!/^[0-6]$/.test(d)) return `"${d}" is not a weekday`;
    if (w.latest < w.earliest) return 'A day\'s latest start cannot be before its earliest start';
  }
  const rules = t.lengthRules ?? [];
  const seen = new Set<number>();
  for (const r of rules) {
    if (seen.has(r.fromSlots)) return 'Two meal and break rules start at the same length';
    seen.add(r.fromSlots);
    if (r.mealSlots >= Math.max(r.fromSlots, 4) - 2 && r.mealSlots > 0) return 'A meal is too long for the shortest shift its rule covers';
  }
  if (t.effectiveFrom && t.effectiveTo && t.effectiveTo < t.effectiveFrom) return 'The template cannot end before it starts';
  return null;
}

/**
 * The lengths worth offering the solver. Every length is a separate candidate shift for every person and day, so a template that spans many
 * lengths is thinned to at most `max`, evenly spread and always keeping the shortest and the longest.
 */
export function offeredLengths(t: Pick<TemplateLike, 'lengthSlots' | 'minLengthSlots' | 'lengthStep'>, max = 5): number[] {
  const all = lengthsOf(t);
  if (all.length <= max) return all;
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) picked.add(all[Math.round((i * (all.length - 1)) / (max - 1))]);
  return [...picked].sort((a, b) => a - b);
}

/** Template columns to select next to a shift (`LEFT JOIN shift_templates t`), for code that needs the shift's own unpaid meal in SQL results. */
export const TPL_JOIN_COLS = `t.length_slots AS t_length_slots, t.min_length_slots AS t_min_length_slots, t.length_step AS t_length_step, t.meal_slots AS t_meal_slots,
  t.break_count AS t_break_count, t.break_slots AS t_break_slots, t.meal_paid AS t_meal_paid, t.length_rules AS t_length_rules`;

/** The unpaid meal (slots) of a shift of `len` slots, from a row that selected TPL_JOIN_COLS. Zero when the shift has no template. */
export function joinedUnpaidMeal(row: any, len: number): number {
  if (row.tLengthSlots == null) return 0;
  return unpaidMeal({ workDays: [], earliestStart: 0, latestStart: 0, startStep: 1, lengthSlots: row.tLengthSlots, minLengthSlots: row.tMinLengthSlots, lengthStep: row.tLengthStep,
    mealSlots: row.tMealSlots, breakCount: row.tBreakCount, breakSlots: row.tBreakSlots, mealPaid: row.tMealPaid, lengthRules: row.tLengthRules }, len);
}
