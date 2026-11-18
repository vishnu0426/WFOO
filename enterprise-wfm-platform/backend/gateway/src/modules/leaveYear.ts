/**
 * Leave balances as a year-by-year record. Pure rules (no database), so each one is tested on its own.
 *   A year starts with what the person is entitled to (all at once, or building up monthly) plus what carried in from the year before.
 *   Carried-in days are used first. If a carry expiry date is set, carried-in days not used by that date lapse.
 *   Hand adjustments (a grant, a correction, a payout) are added or taken off.
 *   When a year is closed, what is left carries forward up to the cap for the leave type; the rest lapses. The next year starts from that record.
 */
export type AccrualMode = 'UPFRONT' | 'MONTHLY';
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface BalanceIn {
  entitled: number; mode: AccrualMode; asOfMonth: number;
  /** The day the balance is asked for (YYYY-MM-DD), to know whether the carry expiry has passed. Omitted: the expiry is taken as not yet reached. */
  asOf?: string;
  usedThisYear: number;
  /** Days brought in from last year: the closed record's carried_out, or an estimate when last year has not been closed. */
  carriedIn: number;
  /** YYYY-MM-DD in this year: carried-in days not used by then lapse. null: they never lapse. */
  carryExpiry?: string | null;
  /** Days used on or before the carry expiry date (only needed once that date has passed). */
  usedByExpiry?: number;
  adjusted?: number;
}
export interface BalanceOut {
  entitledDays: number; accruedDays: number; carriedOverDays: number; expiredDays: number; adjustedDays: number; usedDays: number; remainingDays: number; carryExpiresOn: string | null;
}

export function leaveBalance(b: BalanceIn): BalanceOut {
  const accrued = b.mode === 'MONTHLY' ? r2((b.entitled * Math.min(12, Math.max(1, b.asOfMonth))) / 12) : b.entitled;
  const carriedIn = Math.max(0, b.carriedIn);
  const passed = !!b.carryExpiry && !!b.asOf && b.asOf > b.carryExpiry;
  // used days eat the carried-in days first; whatever of them is still unused when the expiry date passes is gone
  const keptCarried = passed ? Math.min(carriedIn, Math.max(0, b.usedByExpiry ?? 0)) : carriedIn;
  const expired = r2(carriedIn - keptCarried);
  const adjusted = b.adjusted ?? 0;
  const remaining = Math.max(0, r2(accrued + keptCarried + adjusted - b.usedThisYear));
  return { entitledDays: b.entitled, accruedDays: accrued, carriedOverDays: carriedIn, expiredDays: expired, adjustedDays: adjusted, usedDays: b.usedThisYear, remainingDays: remaining, carryExpiresOn: b.carryExpiry ?? null };
}

/** The old estimate, for a year that has not been closed: last year's unused days (this year's entitlement taken as last year's), up to the cap. */
export const estimatedCarry = (entitled: number, usedLastYear: number, cap: number) => Math.min(cap, Math.max(0, entitled - usedLastYear));

export const expiryDay = (year: number, monthDay: string | undefined | null): string | null => (monthDay && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(monthDay) ? `${year}-${monthDay}` : null);

export interface CloseIn {
  entitled: number; usedThisYear: number; carriedIn: number; adjusted: number;
  carryExpiry: string | null; usedByExpiry: number;
  /** The most that may carry into next year. */
  cap: number;
}
export interface CloseOut { entitled: number; carriedIn: number; adjusted: number; used: number; expired: number; lapsed: number; carriedOut: number }

/** One person's year end: what is left after the year (the whole entitlement counts, whatever the accrual mode), carried up to the cap, the rest lapsing. */
export function closeYear(c: CloseIn): CloseOut {
  const b = leaveBalance({ entitled: c.entitled, mode: 'UPFRONT', asOfMonth: 12, asOf: c.carryExpiry ? '9999-12-31' : undefined, usedThisYear: c.usedThisYear, carriedIn: c.carriedIn, carryExpiry: c.carryExpiry, usedByExpiry: c.usedByExpiry, adjusted: c.adjusted });
  const left = b.remainingDays;
  const carriedOut = Math.min(Math.max(0, c.cap), left);
  return { entitled: c.entitled, carriedIn: c.carriedIn, adjusted: c.adjusted, used: c.usedThisYear, expired: b.expiredDays, lapsed: r2(left - carriedOut), carriedOut: r2(carriedOut) };
}
