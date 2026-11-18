/**
 * Reading the values other tools put in an employee export: hours written as 46:15:00 (and plain 46.25), and dates written 29/10/2026 or 10/29/2026 as well as 2026-10-29.
 * A date such as 03/04/2026 can be read two ways; the order is decided from the whole column, and when the column cannot settle it the person is asked, never guessed.
 */

/** "46:15:00", "46:15" or "46.25" (a comma works as the decimal point) as hours; null when it is not a number of hours. Rounded to two decimals. */
export function parseHours(raw: string): number | null {
  const t = raw.trim();
  const m = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(t);
  const n = m ? Number(m[1]) + Number(m[2]) / 60 + (m[3] ? Number(m[3]) / 3600 : 0) : /^\d+([.,]\d+)?$/.test(t) ? Number(t.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export type DateOrder = 'DMY' | 'MDY';
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/;
const real = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Which way round the day and month are in the file's dates. Any first part above 12 means day first; any second part above 12 means month first.
 * 'NONE' when no date needs an order (all are 2026-10-29 style, or empty), 'UNCLEAR' when every one could be read either way, 'CONFLICT' when both appear.
 */
export function detectDateOrder(values: string[]): DateOrder | 'NONE' | 'UNCLEAR' | 'CONFLICT' {
  let dayFirst = false, monthFirst = false, any = false;
  for (const v of values) {
    const m = SLASH.exec(v.trim());
    if (!m) continue;
    any = true;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (!any) return 'NONE';
  if (dayFirst && monthFirst) return 'CONFLICT';
  return dayFirst ? 'DMY' : monthFirst ? 'MDY' : 'UNCLEAR';
}

/** The date as 2026-10-29, or null when it is not a real date in a form we read. `order` is needed for 29/10/2026 style values. */
export function parseDate(raw: string, order: DateOrder | null): string | null {
  const t = raw.trim();
  const i = ISO.exec(t);
  if (i) return real(+i[1], +i[2], +i[3]) ? t : null;
  const m = SLASH.exec(t);
  if (!m || !order) return null;
  const a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
  const [d, mo] = order === 'DMY' ? [a, b] : [b, a];
  return real(y, mo, d) ? iso(y, mo, d) : null;
}
