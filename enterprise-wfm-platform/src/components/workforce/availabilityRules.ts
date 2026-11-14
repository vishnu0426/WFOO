/**
 * The rules of the team-week availability grid, as plain functions (no React, so they are tested on their own): what a day looks like for a person, and what painting a day does.
 *
 * Windows are the recurring weekly ones: a day of the week, a start and an end (HH:MM, "24:00" for midnight) and a meaning. With no window a person can work any time a shift template
 * allows. "AVAILABLE" narrows the day to those hours, "UNAVAILABLE" removes hours, "PREFERRED" is a wish the scheduler tries to honour.
 */
export type Kind = 'AVAILABLE' | 'UNAVAILABLE' | 'PREFERRED';
export interface Win { dayOfWeek: number; startTime: string; endTime: string; kind: Kind }
export type Brush = { type: 'ANY' } | { type: 'OFF' } | { type: 'AVAILABLE'; from: string; to: string } | { type: 'PREFERRED'; from: string; to: string };
export type DayState = 'ANY' | 'OFF' | 'AVAILABLE' | 'PREFERRED' | 'BLOCKED' | 'MIXED';

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const toMinutes = (t: string): number => { if (t === '24:00') return 1440; const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const pad = (n: number) => String(n).padStart(2, '0');
export const fromMinutes = (m: number): string => (m >= 1440 ? '24:00' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const short = (t: string) => t.replace(/^0/, '').replace(/:00$/, '');         // 09:00 reads 9, 17:30 reads 17:30
const range = (w: Win) => `${short(w.startTime)}–${short(w.endTime)}`;

export const windowsOf = (all: Win[], day: number) => all.filter((w) => w.dayOfWeek === day).sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

/** What one day looks like: its state (for colour) and a short label. */
export function daySummary(all: Win[], day: number): { state: DayState; label: string } {
  const ws = windowsOf(all, day);
  if (ws.length === 0) return { state: 'ANY', label: 'Any time' };
  const full = (w: Win) => toMinutes(w.startTime) <= 0 && toMinutes(w.endTime) >= 1440;
  if (ws.every((w) => w.kind === 'UNAVAILABLE')) return ws.some(full) ? { state: 'OFF', label: 'Off' } : { state: 'BLOCKED', label: `Not ${ws.map(range).join(', ')}` };
  if (ws.every((w) => w.kind === 'AVAILABLE')) return ws.some(full) ? { state: 'ANY', label: 'Any time' } : { state: 'AVAILABLE', label: ws.map(range).join(', ') };
  if (ws.every((w) => w.kind === 'PREFERRED')) return { state: 'PREFERRED', label: ws.some(full) ? 'Prefers' : `Prefers ${ws.map(range).join(', ')}` };
  return { state: 'MIXED', label: `${ws.length} rules` };
}

/** Why a brush cannot be used, or null. */
export function brushProblem(b: Brush): string | null {
  if (b.type === 'AVAILABLE' || b.type === 'PREFERRED') {
    const s = toMinutes(b.from), e = toMinutes(b.to);
    if (Number.isNaN(s) || Number.isNaN(e)) return 'Choose a start and an end time';
    if (e <= s) return 'The end must be after the start';
  }
  return null;
}

/** The windows that painting `days` with `brush` leaves: those days are replaced, every other day is kept as it was. */
export function applyBrush(all: Win[], days: number[], brush: Brush): Win[] {
  const set = new Set(days);
  const kept = all.filter((w) => !set.has(w.dayOfWeek));
  const added: Win[] = [];
  for (const d of [...set].sort((a, b) => a - b)) {
    if (brush.type === 'OFF') added.push({ dayOfWeek: d, startTime: '00:00', endTime: '24:00', kind: 'UNAVAILABLE' });
    else if (brush.type === 'AVAILABLE' || brush.type === 'PREFERRED') added.push({ dayOfWeek: d, startTime: brush.from, endTime: brush.to, kind: brush.type });
  }
  return [...kept, ...added].sort((a, b) => a.dayOfWeek - b.dayOfWeek || toMinutes(a.startTime) - toMinutes(b.startTime));
}

/** The same week, as a copy that can be given to someone else. */
export const copyWeek = (source: Win[]): Win[] => source.map((w) => ({ ...w }));

const canon = (ws: Win[]) => JSON.stringify([...ws].sort((a, b) => a.dayOfWeek - b.dayOfWeek || toMinutes(a.startTime) - toMinutes(b.startTime) || a.kind.localeCompare(b.kind)).map((w) => [w.dayOfWeek, w.startTime, w.endTime, w.kind]));
export const sameWeek = (a: Win[], b: Win[]) => canon(a) === canon(b);

/** Cells between two corners of a drag, inclusive, as (row, day) pairs. */
export function rectangle(a: { row: number; day: number }, b: { row: number; day: number }): { row: number; day: number }[] {
  const r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row), d0 = Math.min(a.day, b.day), d1 = Math.max(a.day, b.day);
  const out: { row: number; day: number }[] = [];
  for (let r = r0; r <= r1; r++) for (let d = d0; d <= d1; d++) out.push({ row: r, day: d });
  return out;
}

export function describeBrush(b: Brush): string {
  return b.type === 'ANY' ? 'any time' : b.type === 'OFF' ? 'off all day' : b.type === 'AVAILABLE' ? `only ${short(b.from)}–${short(b.to)}` : `prefers ${short(b.from)}–${short(b.to)}`;
}
