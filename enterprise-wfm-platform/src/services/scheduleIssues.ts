/**
 * Rules behind the Schedule Timeline workspace, with no React and no browser so they are tested on their own: sorting people the way a person reads them (Agent 2 before Agent 10), fitting a day to the
 * width of the screen, which rows of a long list are on screen, the windows where cover is short, and the issues panel (what to list, in what order, and the words around it).
 */

// ---------------------------------------------------------------- sorting

/** "Agent 2" before "Agent 10", not after "Agent 1"; case and accents do not matter. */
export const naturalCompare = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------- fitting a day to the screen

/** Pixels per 15 minutes so that `slots` quarter-hours fit in the room left of the names; never so small it cannot be read, never so large it looks stretched. */
export function fitPx(width: number, labelWidth: number, slots: number, min = 4, max = 40): number {
  if (!Number.isFinite(width) || width <= 0 || slots <= 0) return 20;
  return Math.max(min, Math.min(max, Math.floor((width - labelWidth - 2) / slots)));
}
/** How often a time label is drawn, in 15-minute slots (every hour, 2 hours or 4 hours), so labels are never closer than about 52 px. */
export function labelEvery(px: number): 4 | 8 | 16 {
  if (px * 4 >= 52) return 4;
  if (px * 8 >= 52) return 8;
  return 16;
}

// ---------------------------------------------------------------- which rows are on screen

export interface Layout { tops: number[]; total: number }
/** The top of each row (and the whole height) for rows of different heights, such as people rows and team headings. */
export function layoutRows(heights: number[]): Layout {
  const tops: number[] = []; let y = 0;
  for (const h of heights) { tops.push(y); y += h; }
  return { tops, total: y };
}
/** The rows that touch the visible band [from, to), plus a few either side so scrolling never shows a gap. Returns [first, last+1). */
export function windowOf(layout: Layout, heights: number[], from: number, to: number, overscan = 6): [number, number] {
  const n = heights.length;
  if (!n) return [0, 0];
  let lo = 0, hi = n - 1, first = n;                           // the first row whose bottom is below `from`
  while (lo <= hi) { const m = (lo + hi) >> 1; if (layout.tops[m] + heights[m] > from) { first = m; hi = m - 1; } else lo = m + 1; }
  if (first === n) return [Math.max(0, n - overscan), n];
  let last = first;
  while (last < n && layout.tops[last] < to) last++;
  return [Math.max(0, first - overscan), Math.min(n, last + overscan)];
}

// ---------------------------------------------------------------- where cover is short

export interface Gap { from: number; to: number; need: number }
/** Stretches of 15-minute slots where fewer people are scheduled than needed, merged into windows; `need` is the biggest shortfall in the window. */
export function gapWindows(slots: { delta: number }[], lo = 0, hi = slots.length): Gap[] {
  const out: Gap[] = [];
  for (let q = lo; q < Math.min(hi, slots.length); q++) {
    const c = slots[q];
    if (!c || c.delta >= 0) continue;
    const last = out[out.length - 1];
    if (last && last.to === q) { last.to = q + 1; last.need = Math.max(last.need, -c.delta); } else out.push({ from: q, to: q + 1, need: -c.delta });
  }
  return out;
}
const hh = (slot: number) => `${String(Math.floor(slot / 4) % 24).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;
export const gapLabel = (g: Gap) => `${hh(g.from)}–${hh(g.to)}`;
export const gapMinutes = (g: Gap) => (g.to - g.from) * 15;

// ---------------------------------------------------------------- the issues panel

export interface IssueLike { type: string; employeeId: string; employeeName: string; day: string; message: string }
/** This day's issues first, then the rest in date order; people in natural order within a day. */
export function orderIssues<T extends IssueLike>(list: T[], day: string): T[] {
  return [...list].sort((a, b) => (Number(b.day === day) - Number(a.day === day)) || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || naturalCompare(a.employeeName, b.employeeName));
}
/** "law: weekly rest" from LAW_WEEKLY_REST, "max consecutive days" from MAX_CONSECUTIVE_DAYS. */
export const issueLabel = (type: string, law = true): string => (law && /^LAW_/.test(type) ? `law: ${type.slice(4)}` : type.replace(/^LAW_/, '')).replace(/_/g, ' ').toLowerCase();

export type ScheduleStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | string;
/** What the rule violations mean for this schedule: it is not "before publishing" when it is already published. */
export function violationsNote(status: ScheduleStatus, n: number): string {
  if (status === 'PUBLISHED') return n ? `${n} ${n === 1 ? 'rule is' : 'rules are'} broken in the published schedule. Fix ${n === 1 ? 'it' : 'them'}, then republish.` : '';
  if (status === 'ARCHIVED') return n ? 'This schedule is archived: shown for reference only.' : '';
  return n ? 'These must be fixed before this schedule can be published.' : '';
}
/** People in the schedule and the part of them on shift today, said so the two numbers cannot be mistaken for each other. */
export const peopleLine = (people: number, onDay: number): string => `${people.toLocaleString('en')} ${people === 1 ? 'person' : 'people'} in this schedule · ${onDay.toLocaleString('en')} on shift this day`;

// ---------------------------------------------------------------- the actual time

/** The date and the time of day (in 15-minute slots, with a fraction) right now in a time zone: the group's own clock, not the computer's. */
export function nowIn(timezone: string | null | undefined, at: number = Date.now()): { day: string; slot: number } {
  const read = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  let parts: Intl.DateTimeFormatPart[];
  try { parts = read(timezone || 'UTC'); } catch { parts = read('UTC'); }
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { day: `${String(n('year')).padStart(4, '0')}-${String(n('month')).padStart(2, '0')}-${String(n('day')).padStart(2, '0')}`, slot: (n('hour') % 24) * 4 + n('minute') / 15 };
}
/** "UTC+5:30" for the time zone, to say whose clock the axis is on. */
export function tzLabel(timezone: string | null | undefined, at: number = Date.now()): string {
  try { return new Intl.DateTimeFormat('en', { timeZone: timezone || 'UTC', timeZoneName: 'shortOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value.replace(/^GMT([+-]0)?$/, 'UTC').replace('GMT', 'UTC') ?? timezone ?? 'UTC'; } catch { return timezone || 'UTC'; }
}
/** The day a schedule opens on: the one asked for (a link from the year plan), else today if it is inside the schedule, else its first day. */
export function pickOpenDay(period: { start: string; end: string }, today: string, requested?: string | null): string {
  if (requested && requested >= period.start && requested <= period.end) return requested;
  return today >= period.start && today <= period.end ? today : period.start;
}
/** Which row to bring into view at a given time: the first person on shift then, else the first to start after it, else the top. Rows are in start order. */
export function nowRowIndex(rows: { startSlot: number; lengthSlots: number }[], slot: number): number {
  const on = rows.findIndex((r) => r.startSlot <= slot && slot < r.startSlot + r.lengthSlots);
  if (on >= 0) return on;
  const next = rows.findIndex((r) => r.startSlot > slot);
  return next >= 0 ? next : 0;
}
