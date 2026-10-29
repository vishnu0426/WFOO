/**
 * Can a person's contract hours be made up from the shifts they are offered? A 20 h part-timer offered only 8 h shifts can work 16 h or
 * 24 h but never 20 h, so they end up short or over. This works that out before the solver runs, so the report can say which people
 * and what to change (shorter shifts), rather than leaving it to look like a solver problem.
 */

/** Weekly cap for a person: full-timers keep their own maximum (planned overtime stays possible); part-time, contract and temporary
 *  staff with contracted hours are held to contract plus a tolerance. Staff with no contracted hours (on call) keep their own maximum. */
export function weeklyCapHours(p: { employmentType: string; contractHours: number; maxHours: number }, toleranceHours: number | null): number {
  if (toleranceHours === null || p.employmentType === 'FULL_TIME' || !(p.contractHours > 0)) return p.maxHours;
  return Math.min(p.maxHours, p.contractHours + toleranceHours);
}

/**
 * Whether some mix of at most `maxShifts` shifts, each one of the paid lengths offered (in slots), adds up to between `minSlots` and `maxSlots`.
 * Returns the closest total reachable at or above `minSlots`, and whether any total falls in range.
 */
export function contractFit(lengths: number[], maxShifts: number, minSlots: number, maxSlots: number): { ok: boolean; closest: number | null } {
  const lens = [...new Set(lengths.filter((l) => l > 0))].sort((a, b) => a - b);
  if (!lens.length || maxShifts <= 0) return { ok: minSlots <= 0, closest: null };
  const top = Math.max(maxSlots, minSlots) + Math.max(...lens);
  let reach = new Set<number>([0]);
  let best: number | null = null;
  for (let n = 0; n < maxShifts; n++) {
    const next = new Set<number>();
    for (const t of reach) for (const l of lens) { const v = t + l; if (v <= top) next.add(v); }
    for (const v of next) { if (v >= minSlots && (best === null || v < best)) best = v; }
    if (!next.size) break;
    reach = next;
  }
  const ok = best !== null && best <= maxSlots;
  return { ok, closest: best };
}

/** One plain-language line for the report, or null when everyone can reach their contract. */
export function contractFitNote(misfits: { name: string; contractHours: number; closestHours: number | null }[], toleranceHours: number | null): { level: 'WARNING' | 'INFO'; message: string } | null {
  if (!misfits.length) return null;
  const eg = misfits.slice(0, 3).map((m) => `${m.name} (${m.contractHours} h contract${m.closestHours === null ? ', no shift fits' : `, nearest week ${m.closestHours} h`})`).join('; ');
  const tol = toleranceHours === null ? '' : ` within ${toleranceHours} h of`;
  return { level: 'WARNING', message: `${misfits.length} ${misfits.length === 1 ? 'person cannot' : 'people cannot'} reach their contract hours${tol} with the shift lengths they are offered, so they will end up short or over: ${eg}. Add shorter shifts (for example 4 to 6 hours) to a template for part-time staff, or allow a larger tolerance.` };
}
