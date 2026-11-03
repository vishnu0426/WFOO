/** The arithmetic behind payroll hours, kept free of the database so it can be tested on its own. */
const r2 = (n: number) => Math.round(n * 100) / 100;
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };

export interface DayHours { day: string; hours: number; nightHours: number; weekend: boolean; holiday: boolean }
export type Category = 'REGULAR' | 'OVERTIME' | 'NIGHT' | 'WEEKEND' | 'HOLIDAY';
export interface Split { totals: Record<Category, number>; supplements: Record<'NIGHT' | 'WEEKEND', number>; daily: { day: string; category: Category; hours: number }[] }

/** Minutes of [start, end) (minutes from midnight of the day the work starts; end may pass midnight) that fall in the night window, which may itself cross midnight. */
export function nightMinutes(start: number, end: number, from: string, to: string): number {
  const a = mins(from), b = mins(to), windows: [number, number][] = a === b ? [] : a < b ? [[a, b], [a + 1440, b + 1440]] : [[0, b], [a, 1440 + b], [1440 + a, 2880]];
  return windows.reduce((n, [x, y]) => n + Math.max(0, Math.min(end, y) - Math.max(start, x)), 0);
}

/**
 * Split one person's worked days into pay categories for a pay week. Each hour gets one category, in this order: holiday, overtime, night, weekend, regular.
 * Daily overtime (hours beyond a daily limit) comes first; weekly overtime (hours beyond the week's limit) is then taken from the end of the week, from regular
 * hours, then weekend, then night. With STACKED pay, night and weekend hours stay in regular pay and are also reported as supplements for the premium.
 */
export function splitPay(days: DayHours[], weeklyLimit: number, dailyLimit: number | null, stacking: 'EXCLUSIVE' | 'STACKED'): Split {
  const sorted = [...days].sort((a, b) => (a.day < b.day ? -1 : 1));
  const per = sorted.map((d) => {
    const ot = dailyLimit === null ? 0 : Math.max(0, d.hours - dailyLimit), rest = d.hours - ot;
    const c: Record<Category, number> = { REGULAR: 0, OVERTIME: ot, NIGHT: 0, WEEKEND: 0, HOLIDAY: 0 };
    if (d.holiday) c.HOLIDAY = rest;
    else { const n = Math.min(d.nightHours, rest); c.NIGHT = n; if (d.weekend) c.WEEKEND = rest - n; else c.REGULAR = rest - n; }
    return { d, c };
  });
  const total = sorted.reduce((n, d) => n + d.hours, 0), dailyOt = per.reduce((n, x) => n + x.c.OVERTIME, 0);
  let weekly = Math.max(0, total - dailyOt - weeklyLimit);
  for (const cat of ['REGULAR', 'WEEKEND', 'NIGHT'] as const) for (let i = per.length - 1; i >= 0 && weekly > 1e-9; i--) { const take = Math.min(per[i].c[cat], weekly); per[i].c[cat] -= take; per[i].c.OVERTIME += take; weekly -= take; }
  const totals: Record<Category, number> = { REGULAR: 0, OVERTIME: 0, NIGHT: 0, WEEKEND: 0, HOLIDAY: 0 };
  const supplements = { NIGHT: 0, WEEKEND: 0 };
  const daily: Split['daily'] = [];
  for (const { d, c } of per) {
    if (stacking === 'STACKED') { supplements.NIGHT += c.NIGHT; supplements.WEEKEND += c.WEEKEND; c.REGULAR += c.NIGHT + c.WEEKEND; c.NIGHT = 0; c.WEEKEND = 0; }
    for (const k of Object.keys(c) as Category[]) { totals[k] += c[k]; if (c[k] > 1e-9) daily.push({ day: d.day, category: k, hours: r2(c[k]) }); }
  }
  return { totals, supplements, daily };
}
export const roundHours = (h: number, mode: 'NONE' | 'TENTH' | 'QUARTER') => (mode === 'QUARTER' ? Math.round(h * 4) / 4 : mode === 'TENTH' ? Math.round(h * 10) / 10 : r2(h));

