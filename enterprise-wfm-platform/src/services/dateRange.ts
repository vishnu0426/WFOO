/**
 * The rules behind a date-range picker: the weeks of a month, which days may be chosen, what a click does (first click starts a range, second ends it, in either order), and how dates are
 * written ("18 Nov 2026", "Mon 18 Nov"). Days are "YYYY-MM-DD" text, and all the arithmetic is in UTC so the time zone of the computer never moves a day. Pure functions, tested on their own.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const text = (t: number) => new Date(t).toISOString().slice(0, 10);
export const shiftDay = (d: string, n: number): string => text(ms(d) + n * 86_400_000);
export const daysIn = (from: string, to: string): number => Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
const dow = (d: string) => new Date(ms(d)).getUTCDay();                      // Sunday 0

/** "2026-11" shifted by n months. */
export function shiftMonth(ym: string, n: number): string {
  const t = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export const monthOf = (d: string): string => d.slice(0, 7);
export const monthTitle = (ym: string): string => `${MONTHS_LONG[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

/** "18 Nov 2026" */
export const fmtLong = (d: string): string => (d ? `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}` : '');
/** "Mon 18 Nov" */
export const fmtShortDay = (d: string): string => (d ? `${WEEKDAYS[dow(d)]} ${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}` : '');
/** Weekday headings starting from `weekStart` (Monday 1 ... Sunday 0). */
export const weekdayHeads = (weekStart = 1): string[] => Array.from({ length: 7 }, (_, i) => WEEKDAYS[(weekStart + i) % 7].slice(0, 2));

/** The weeks of a month, each seven days from the chosen first weekday, with the days of the next and earlier month filling the ends (marked so they can be left blank). Always full weeks. */
export function monthGrid(ym: string, weekStart = 1): { day: string; inMonth: boolean }[][] {
  const first = `${ym}-01`, lead = (dow(first) - weekStart + 7) % 7;
  const start = shiftDay(first, -lead), out: { day: string; inMonth: boolean }[][] = [];
  const last = shiftMonth(ym, 1) + '-01';
  for (let d = start; ms(d) < ms(last) || out.length === 0 || out[out.length - 1].length < 7; ) {
    const week: { day: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 7; i++, d = shiftDay(d, 1)) week.push({ day: d, inMonth: monthOf(d) === ym });
    out.push(week);
    if (ms(d) >= ms(last)) break;
  }
  return out;
}

export interface Limits { min?: string; max?: string; /** the longest range allowed, in days, counted from the first click */ maxDays?: number }

/** Whether a day may be chosen: inside min and max, and, once a first click is made, no further than maxDays from it. */
export function isDisabled(day: string, lim: Limits, anchor: string | null = null): boolean {
  if (lim.min && day < lim.min) return true;
  if (lim.max && day > lim.max) return true;
  if (anchor && lim.maxDays && Math.abs(ms(day) - ms(anchor)) / 86_400_000 + 1 > lim.maxDays) return true;
  return false;
}

/** What a click on `day` does. With no first click yet it starts a range (anchor = that day); with one it ends the range, in either order. */
export function click(anchor: string | null, day: string): { anchor: string | null; range: { from: string; to: string } | null } {
  if (!anchor) return { anchor: day, range: null };
  return { anchor: null, range: day < anchor ? { from: day, to: anchor } : { from: anchor, to: day } };
}

/** The range being shown while choosing: the first click to the day the pointer is over, in either order. */
export const preview = (anchor: string, hover: string | null): { from: string; to: string } => (hover && hover < anchor ? { from: hover, to: anchor } : { from: anchor, to: hover ?? anchor });

/** The month to show on the left when opening: the start of the range, else the month of today. */
export const openingMonth = (from: string | null, today: string): string => monthOf(from || today);

/** "6 weeks" for whole weeks (up to 26), else "45 days". */
export const lengthText = (from: string, to: string): string => { const n = daysIn(from, to); return n % 7 === 0 && n <= 182 ? `${n / 7} ${n === 7 ? 'week' : 'weeks'}` : `${n} ${n === 1 ? 'day' : 'days'}`; };
