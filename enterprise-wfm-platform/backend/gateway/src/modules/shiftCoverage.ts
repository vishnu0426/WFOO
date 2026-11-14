/**
 * What a shift covers. A person on a meal is on shift but answers nothing, so the meal is not coverage: counting it made every schedule look better covered than it was.
 * (Breaks stay in: they are what the group's shrinkage percentage already allows for.) The solver is given the same meal window for each shift it can choose, so the number it
 * aimed for and the number shown afterwards are the same number.
 */
const SLOTS_PER_DAY = 96;

/** The kinds of activity during which the person covers nothing. */
export const AWAY_ACTIVITIES = new Set(['MEAL', 'SPLIT_GAP']);

export interface CoveringShift { startSlot: number; lengthSlots: number; activities?: { type: string; startSlot: number; slots: number }[] | null }

/**
 * Add one person to `cover` for every slot of the shift except its meal (or split-shift gap). `dayIdx` is the day's position in the period (-1 for the day before it, whose
 * night shifts run into the first hours); slots before the start or past the end of `cover` are ignored. The one place coverage is counted, so a meal, a split-shift gap
 * and an overnight shift are treated alike wherever coverage is shown, judged or filled.
 */
export function addShiftCoverage(cover: number[], dayIdx: number, s: CoveringShift, weight = 1): void {
  const base = dayIdx * SLOTS_PER_DAY;
  const away = (s.activities ?? []).filter((a) => AWAY_ACTIVITIES.has(a.type));
  const end = Math.min(cover.length - base, s.startSlot + s.lengthSlots);
  for (let k = s.startSlot; k < end; k++) {
    if (base + k < 0) continue;
    if (away.length && away.some((a) => k >= a.startSlot && k < a.startSlot + a.slots)) continue;
    cover[base + k] += weight;
  }
}

/** How many slots of the shift count as coverage. */
export function coveredSlots(s: CoveringShift): number {
  const away = (s.activities ?? []).filter((a) => AWAY_ACTIVITIES.has(a.type));
  let n = 0;
  for (let k = s.startSlot; k < s.startSlot + s.lengthSlots; k++) if (!away.some((a) => k >= a.startSlot && k < a.startSlot + a.slots)) n++;
  return n;
}

/**
 * Where in a shift one person's meal falls, as slots from the start of the shift. The template's meal anchor (or the middle of the shift) is spread by up to the template's flexibility
 * from person to person and day to day, so people on the same shift do not all eat at the same time. The same position is given to the solver as the shift's gap and used when the
 * activities are placed, so the coverage the solver aims for is the coverage the schedule has.
 */
export function mealOffset(t: { mealAnchorSlot?: number | null; flexSlots?: number | null; splitShift?: boolean }, length: number, mealSlots: number, who: number, day: number): number | null {
  if (mealSlots <= 0 || length <= mealSlots + 2) return null;
  const centre = t.mealAnchorSlot ?? Math.round((length - mealSlots) / 2);
  const flex = t.splitShift ? 0 : Math.max(0, t.flexSlots ?? 0);
  const spread = flex > 0 ? ((who * 7 + day * 3) % (2 * flex + 1)) - flex : 0;
  return Math.max(1, Math.min(length - mealSlots - 1, centre + spread));
}
