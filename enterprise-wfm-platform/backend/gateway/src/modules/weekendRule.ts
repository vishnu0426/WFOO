/**
 * 'At least N full weekends off in each calendar month'. Pure date logic (no database), shared by the generator, the checker and the screens.
 *
 * A weekend is one run of the group's weekend days (Saturday and Sunday, or Friday and Saturday, or whatever the group sets) that lies wholly inside one calendar month.
 * A weekend that straddles two months (Saturday the 31st, Sunday the 1st) belongs to neither, so a month never counts a weekend it cannot see all of.
 * A weekend is OFF when the person works none of its days (for any group; leave counts as off).
 *
 * A schedule rarely covers a whole month, so the rule is judged on the part of the month the schedule holds:
 *   what the month needs = min(N, weekends in the month)
 *   weekends before the schedule starts are known (the published schedules say which were off)
 *   weekends after it ends are not known yet and are assumed off (the person is never asked for more than the month can still give)
 *   what the schedule itself must give = what the month needs - the weekends assumed off - the weekends already off, never more than the weekends the schedule holds.
 * With the whole month inside the schedule this is exactly 'N of the month's weekends'. When a long plan is built a few weeks at a time, the last piece of a month is
 * held to the rest of the rule, because by then the earlier pieces are published.
 */
const utc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(utc(d) + n * 864e5);
const dow = (d: string) => (new Date(utc(d)).getUTCDay() + 6) % 7;      // Monday = 0
const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 864e5);

export interface MonthWeekends {
  key: string;                    // 'YYYY-MM'
  /** the first and last day of the month that lie inside the schedule, and their position from the schedule's first day */
  first: string; last: string; firstIdx: number; lastIdx: number;
  /** every weekend of the month, wholly inside it */
  total: number;
  /** those wholly inside the schedule (each as its dates) and those wholly before it */
  inPeriod: string[][]; before: string[][];
}

/** The weekends of one calendar month (`monthStart` is its first day), each as its dates. */
export function weekendsOfMonth(monthStart: string, weekend: number[]): string[][] {
  const set = new Set(weekend);
  if (!set.size || set.size >= 7) return [];
  const [y, m] = monthStart.split('-').map(Number);
  const end = iso(Date.UTC(y, m, 0));                                     // last day of the month
  const out: string[][] = [];
  for (let d = monthStart; d <= end; d = addDays(d, 1)) {
    if (!set.has(dow(d)) || set.has((dow(d) + 6) % 7)) continue;          // not the first day of a run
    const run = [d];
    while (set.has(dow(addDays(run[run.length - 1], 1)))) run.push(addDays(run[run.length - 1], 1));
    if (run[run.length - 1] <= end) out.push(run);
  }
  return out;
}

/** The calendar months the schedule touches that hold at least one of its weekends, with the weekends inside it and the ones before it. */
export function weekendMonths(from: string, to: string, weekend: number[]): MonthWeekends[] {
  const out: MonthWeekends[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`, end = iso(Date.UTC(y, m, 0));
    const all = weekendsOfMonth(start, weekend);
    const inPeriod = all.filter((w) => w[0] >= from && w[w.length - 1] <= to);
    if (inPeriod.length) {
      const first = start > from ? start : from, last = end < to ? end : to;
      out.push({ key: start.slice(0, 7), first, last, firstIdx: daysBetween(from, first), lastIdx: daysBetween(from, last), total: all.length, inPeriod, before: all.filter((w) => w[w.length - 1] < from) });
    }
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** How many of this month's weekends inside the schedule the person must have fully off, given `n` (the rule) and `offBefore` (how many of the weekends before the schedule were off). */
export function weekendNeed(n: number, mo: MonthWeekends, offBefore: number): number {
  if (n <= 0 || !mo.total || !mo.inPeriod.length) return 0;
  const want = Math.min(n, mo.total);
  const assumedOff = mo.total - mo.inPeriod.length - mo.before.length;      // after the schedule, or straddling its edge: not known, assumed off
  return Math.max(0, Math.min(want - assumedOff - offBefore, mo.inPeriod.length));
}

/** How many of the weekends before the schedule (in each month) were off: `worked` holds every day the person works. */
export function weekendsOffBefore(months: MonthWeekends[], worked: Set<string>): number[] {
  return months.map((mo) => mo.before.filter((w) => !w.some((d) => worked.has(d))).length);
}

/** The engine's view of the months: day indexes from the schedule's first day. Only months some person has a need in are worth sending. */
export function engineMonths(months: MonthWeekends[], from: string) {
  return months.map((mo) => ({ first_day: mo.firstIdx, last_day: mo.lastIdx, weekends: mo.inPeriod.map((w) => ({ days: w.map((d) => daysBetween(from, d)) })) }));
}

/** Each person's need per month, as the engine takes it; null when nobody has a need (so the engine is sent nothing). */
export function weekendNeeds(n: number, months: MonthWeekends[], offBefore: number[]): number[] {
  return months.map((mo, i) => weekendNeed(n, mo, offBefore[i] ?? 0));
}

/** Words for a screen: 'every month', and what the rule asks. */
export const weekendRuleText = (n: number) => `at least ${n} full ${n === 1 ? 'weekend' : 'weekends'} off in each month`;

/** The weekends a request covers: every weekend of the group that touches the date range, whole (all its days, even those just outside the range), as dates. Used to turn an approved 'weekends off' request into days off. */
export function weekendDatesIn(from: string, to: string, weekend: number[]): string[] {
  const set = new Set(weekend);
  const out = new Set<string>();
  if (!set.size || set.size >= 7) return [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!set.has(dow(d)) || out.has(d)) continue;
    let a = d;
    while (set.has(dow(addDays(a, -1)))) a = addDays(a, -1);
    for (let x = a; set.has(dow(x)); x = addDays(x, 1)) out.add(x);
  }
  return [...out].sort();
}

/** The weekends (as their dates) a date range touches, one list per weekend. */
export function weekendRunsIn(from: string, to: string, weekend: number[]): string[][] {
  const days = weekendDatesIn(from, to, weekend);
  const out: string[][] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && addDays(last[last.length - 1], 1) === d) last.push(d); else out.push([d]);
  }
  return out;
}
