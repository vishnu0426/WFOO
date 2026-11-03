import { tzFmt } from '../tzFormat.ts';
/**
 * Daylight saving. A schedule counts a day as 96 fifteen-minute slots, but on the day the clocks change the wall clock shows 92 or 100 of
 * them. A night shift that runs over the change is scheduled for, say, 8 hours and is really worked for 7 or 9. This works out how far each
 * shift is from its scheduled length so the planner can see it before it is published. Zones that move by half an hour are handled too.
 */
const SLOT_MIN = 15;

/** The zone's offset from UTC, in minutes, at an instant. */
export function offsetMinutes(tz: string, ms: number): number {
  const part = tzFmt('en-US', tz, { timeZoneName: 'longOffset' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(part);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant a wall-clock time on a calendar day happens in a zone. A time the clocks skip is taken as just after the gap; a time that happens twice, the first time. */
export function wallToUtcMs(day: string, wallMinutes: number, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d) + wallMinutes * 60_000;
  // the offsets in force a day either side say which two instants this wall time could be; the one whose own offset agrees is the answer
  const offs = [...new Set([offsetMinutes(tz, asUtc - 86_400_000), offsetMinutes(tz, asUtc + 86_400_000)])];
  const cands = offs.map((o) => ({ ms: asUtc - o * 60_000, o })).filter((c) => offsetMinutes(tz, c.ms) === c.o);
  if (cands.length === 1) return cands[0].ms;
  if (cands.length > 1) return Math.min(...cands.map((c) => c.ms));                          // the hour that happens twice: the first time
  return Math.max(...offs.map((o) => asUtc - o * 60_000));                                  // a time the clocks skip: the moment they jump
}

/** The slots really elapsed between a shift's wall-clock start and end, against the slots it is scheduled for. Negative: the shift is shorter than scheduled. */
export function shiftDelta(day: string, startSlot: number, lengthSlots: number, tz: string): { scheduledSlots: number; elapsedSlots: number; deltaMinutes: number } {
  const a = wallToUtcMs(day, startSlot * SLOT_MIN, tz), b = wallToUtcMs(day, (startSlot + lengthSlots) * SLOT_MIN, tz);
  const elapsed = Math.round((b - a) / 60_000 / SLOT_MIN);
  return { scheduledSlots: lengthSlots, elapsedSlots: elapsed, deltaMinutes: (elapsed - lengthSlots) * SLOT_MIN };
}

export interface ClockChange { day: string; deltaMinutes: number; atWall: string; kind: 'FORWARD' | 'BACK' }

const addDay = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** The change that happens on a calendar day in a zone, if any: how far the clocks move and the wall-clock time it happens at. */
export function clockChangeOn(day: string, tz: string): ClockChange | null {
  const start = wallToUtcMs(day, 0, tz), end = wallToUtcMs(addDay(day, 1), 0, tz);
  const real = Math.round((end - start) / 60_000), delta = real - 24 * 60;
  if (!delta) return null;
  // the wall time it happens at: the clock still agrees with elapsed time up to the change, so it is the first quarter hour whose offset differs
  const before = offsetMinutes(tz, start);
  let at = 0;
  for (let m = 0; m < 24 * 60; m += SLOT_MIN) { if (offsetMinutes(tz, start + m * 60_000) !== before) { at = m; break; } }
  return { day, deltaMinutes: delta, atWall: hhmm(at), kind: delta < 0 ? 'FORWARD' : 'BACK' };
}

/** Every change in a run of days. */
export function clockChanges(days: string[], tz: string): ClockChange[] {
  const out: ClockChange[] = [];
  for (const d of days) { const c = clockChangeOn(d, tz); if (c) out.push(c); }
  return out;
}
