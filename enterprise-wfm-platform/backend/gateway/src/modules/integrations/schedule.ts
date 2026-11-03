/**
 * When a pulled connector runs: every N minutes, or once a day at a set time, optionally only on chosen weekdays. All times are the
 * organisation's own clock (its time zone), so "02:00" means 02:00 where the contact centre is. Pure, so it is tested without a database.
 */
export interface Schedule { everyMin: number | null; at: string | null; days: number[] | null }   // days: ISO weekdays, 1 = Monday ... 7 = Sunday; null = every day

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** An error in plain words, or null when the schedule is usable. */
export function checkSchedule(s: Schedule): string | null {
  if (s.days !== null && (!s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) || new Set(s.days).size !== s.days.length)) return 'Choose at least one day, from Monday to Sunday.';
  if (s.at !== null) {
    if (!HHMM.test(s.at)) return 'The time must look like 02:00 (24-hour).';
    if (s.everyMin !== null && s.everyMin !== 1440) return 'A daily run at a set time cannot also repeat every few minutes.';
    return null;
  }
  if (s.everyMin !== null && (!Number.isInteger(s.everyMin) || s.everyMin < 5 || s.everyMin > 1440)) return 'Repeat between every 5 minutes and once a day.';
  return null;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function parts(t: Date, tz: string) {
  let f = formats.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formats.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(t).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute };
}
const isoDow = (y: number, m: number, d: number) => { const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; };
const addDay = (y: number, m: number, d: number, n: number) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };

/**
 * The instant at which the wall clock in `tz` reads the given date and time. When clocks go back that time happens twice (the first is used); when
 * they go forward it does not happen at all (the first moment after the gap is used, so a run is never early).
 */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (at: number) => { const l = parts(new Date(at), tz); return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi) - at; };
  const candidates = [...new Set([guess - offset(guess - 86_400_000), guess - offset(guess + 86_400_000)])].sort((a, b) => a - b);
  const reads = (t: number) => { const l = parts(new Date(t), tz); return l.y === y && l.m === m && l.d === d && l.h === h && l.mi === mi; };
  const valid = candidates.filter(reads);
  return new Date(valid.length ? valid[0] : candidates[candidates.length - 1]);
}

/** The next time to run strictly after `after`. */
export function nextRunAfter(s: Schedule, after: Date, tz: string): Date {
  if (s.at !== null) {
    const [h, mi] = s.at.split(':').map(Number);
    const l = parts(after, tz);
    for (let i = 0; i < 9; i++) {
      const day = addDay(l.y, l.m, l.d, i);
      if (s.days && !s.days.includes(isoDow(day.y, day.m, day.d))) continue;
      const t = zonedToUtc(day.y, day.m, day.d, h, mi, tz);
      if (t.getTime() > after.getTime()) return t;
    }
    return new Date(after.getTime() + 86_400_000);
  }
  const every = (s.everyMin ?? 15) * 60_000;
  return skipToAllowedDay(s, new Date(after.getTime() + every), tz);
}

/** The first run when a schedule is switched on: an interval starts now (if today is allowed), a daily run waits for its time. */
export function firstRunAt(s: Schedule, now: Date, tz: string): Date {
  return s.at !== null ? nextRunAfter(s, now, tz) : skipToAllowedDay(s, now, tz);
}

/** If `t` falls on a day the schedule excludes, the start of the next allowed day. */
function skipToAllowedDay(s: Schedule, t: Date, tz: string): Date {
  if (!s.days) return t;
  let cur = t;
  for (let i = 0; i < 8; i++) {
    const l = parts(cur, tz);
    if (s.days.includes(isoDow(l.y, l.m, l.d))) return cur;
    const n = addDay(l.y, l.m, l.d, 1);
    cur = zonedToUtc(n.y, n.m, n.d, 0, 0, tz);
  }
  return t;
}

/** The longest quiet stretch the schedule itself allows, in minutes, so a source is not called late over a weekend it was never meant to run. */
export function maxGapMin(s: Schedule): number {
  const base = s.at !== null ? 1440 : s.everyMin ?? 0;
  if (!s.days || s.days.length === 7) return base;
  const d = [...s.days].sort((a, b) => a - b);
  let gap = 0;
  for (let i = 0; i < d.length; i++) gap = Math.max(gap, ((d[(i + 1) % d.length] - d[i] + 7) % 7 || 7));
  return Math.max(base, gap * 1440);
}

export function describeSchedule(s: Schedule, tz?: string): string {
  const every = s.everyMin ?? 0;
  let days = '';
  if (s.days && s.days.length < 7) {
    const sorted = [...s.days].sort((a, b) => a - b);
    const key = sorted.join(',');
    days = key === '1,2,3,4,5' ? 'on weekdays' : key === '6,7' ? 'on weekends' : `on ${sorted.map((x) => DAY_NAMES[x - 1]).join(', ')}`;
  }
  const text = s.at !== null
    ? (days ? `At ${s.at} ${days}` : `Every day at ${s.at}`)
    : [every < 60 ? `Every ${every} minutes` : every === 60 ? 'Every hour' : every === 1440 ? 'Once a day' : `Every ${every / 60} hours`, days].filter(Boolean).join(' ');
  return tz ? `${text} (${tz})` : text;
}
