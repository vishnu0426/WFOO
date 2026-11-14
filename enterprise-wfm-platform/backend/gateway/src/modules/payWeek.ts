/**
 * The weekday a pay week begins on (Monday = 0 ... Sunday = 6). Weekly hours, days per week and overtime are counted per pay week.
 * A WFM group can set its own; otherwise the company default in the scheduling policy applies; otherwise Monday.
 * A schedule remembers the pay week it was built with (settings.weekStart), so changing the setting later never re-counts an old schedule.
 */
import type { Tx } from '../db.ts';

export type PayWeek = { start: number; source: 'GROUP' | 'COMPANY' | 'DEFAULT'; companyStart: number };

export async function payWeekFor(tx: Tx, groupId: string | null | undefined): Promise<PayWeek> {
  const pol = await tx.one<any>('SELECT defaults FROM scheduling_policy WHERE tenant_id = :t');
  const raw = pol?.defaults?.payWeekStart;
  const companyStart = Number.isInteger(raw) && raw >= 0 && raw <= 6 ? (raw as number) : 0;
  const g = groupId ? await tx.one<any>('SELECT pay_week_start FROM wfm_groups WHERE tenant_id = :t AND id = $1', [groupId]) : null;
  const own = g?.payWeekStart;
  if (Number.isInteger(own)) return { start: own, source: 'GROUP', companyStart };
  return { start: companyStart, source: pol && Number.isInteger(raw) ? 'COMPANY' : 'DEFAULT', companyStart };
}

/** The weekdays that count as the weekend (Monday = 0 ... Sunday = 6). The company default in the scheduling policy; Saturday and Sunday when it was never set. */
export const DEFAULT_WEEKEND = [5, 6];
export const cleanWeekend = (v: unknown): number[] => {
  const days = Array.isArray(v) ? [...new Set(v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6))].sort((a, b) => a - b) : [];
  return days.length >= 1 && days.length <= 3 ? days : DEFAULT_WEEKEND;
};
export async function weekendDaysFor(tx: Tx): Promise<number[]> {
  const pol = await tx.one<any>('SELECT defaults FROM scheduling_policy WHERE tenant_id = :t');
  return cleanWeekend(pol?.defaults?.weekendDays);
}
/** Bit n set when weekday n (Monday = 0) is a weekend day. Sent to the scheduling engine. */
export const weekendMask = (days: number[]): number => days.reduce((m, d) => m | (1 << d), 0);

/** Weekday of a calendar day, Monday = 0 ... Sunday = 6. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** First day of the pay week that `day` (YYYY-MM-DD) falls in. */
export function payWeekFloor(day: string, weekStart: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - (((t.getUTCDay() + 6) % 7 - weekStart + 7) % 7));
  return t.toISOString().slice(0, 10);
}
