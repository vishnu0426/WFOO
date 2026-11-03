import { tzFmt } from '../tzFormat.ts';
/** When a scheduled report next runs, and which dates "last week" or "next 7 days" mean. Pure: no database, so it can be tested on its own. */

export interface Timing { frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'; dayOfWeek?: number | null; dayOfMonth?: number | null; hour: number; timezone: string }

const parts = (d: Date, tz: string) => {
  const f = tzFmt('en-CA', tz, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d);
  const g = (t: string) => f.find((x) => x.type === t)!.value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')), minute: Number(g('minute')), dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday')), dom: Number(g('day')) };
};
export const localDay = (d: Date, tz: string) => parts(d, tz).day;
export const addDay = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The first moment after `after` at which the local clock in `timezone` reads `hour`:00 on a day that matches. Walks forward a quarter-hour at a time (some zones are 30 or 45 minutes off UTC), so a daylight-saving change cannot skip or repeat it. */
export function nextRun(after: Date, t: Timing): Date {
  const Q = 900_000, start = Math.floor(after.getTime() / Q) * Q + Q;                           // the next quarter-hour after `after`
  for (let k = 0; k < 4 * 24 * 62; k++) {
    const d = new Date(start + k * Q), p = parts(d, t.timezone);
    if (p.hour !== t.hour || p.minute !== 0) continue;
    if (t.frequency === 'DAILY') return d;
    if (t.frequency === 'WEEKLY' && p.dow === (t.dayOfWeek ?? 0)) return d;
    if (t.frequency === 'MONTHLY') {
      const [y, m] = p.day.split('-').map(Number);
      if (p.dom === Math.min(t.dayOfMonth ?? 1, lastDayOfMonth(y, m))) return d;                 // the 31st means the last day in a shorter month
    }
  }
  throw new Error('No run time found in the next two months');
}

export const RANGES = ['YESTERDAY', 'LAST_7_DAYS', 'LAST_WEEK', 'LAST_MONTH', 'THIS_WEEK', 'NEXT_7_DAYS', 'NEXT_WEEK', 'NEXT_14_DAYS'] as const;
export type Range = (typeof RANGES)[number];
/** The dates a named range means on the day it runs, in the report's time zone. Weeks are pay weeks: Monday to Sunday unless `weekStart` (Monday 0 ... Sunday 6) says another day. */
export function resolveRange(range: Range, now: Date, tz: string, weekStart = 0): { from: string; to: string } {
  const today = localDay(now, tz), mon = addDay(today, -((dowOf(today) - weekStart + 7) % 7));
  switch (range) {
    case 'YESTERDAY': return { from: addDay(today, -1), to: addDay(today, -1) };
    case 'LAST_7_DAYS': return { from: addDay(today, -7), to: addDay(today, -1) };
    case 'LAST_WEEK': return { from: addDay(mon, -7), to: addDay(mon, -1) };
    case 'THIS_WEEK': return { from: mon, to: addDay(mon, 6) };
    case 'NEXT_WEEK': return { from: addDay(mon, 7), to: addDay(mon, 13) };
    case 'NEXT_7_DAYS': return { from: addDay(today, 1), to: addDay(today, 7) };
    case 'NEXT_14_DAYS': return { from: addDay(today, 1), to: addDay(today, 14) };
    case 'LAST_MONTH': { const [y, m] = today.split('-').map(Number), first = new Date(Date.UTC(y, m - 2, 1)); const f = first.toISOString().slice(0, 10); return { from: f, to: addDay(`${today.slice(0, 7)}-01`, -1) }; }
  }
}
