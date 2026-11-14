/**
 * Holiday calendar. An organisation's holidays are special events of the kind "holiday" (the same rows forecasting learns from and payroll pays at the
 * holiday rate). This module adds a starting point: public holidays for a country, taken from the open-source `date-holidays` data (ISC code, CC-BY-3.0
 * data), that an administrator previews and adds. Nothing is added without being asked, and anything can be removed or changed afterwards.
 */
import Holidays from 'date-holidays';
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, notFound, parse } from '../http.ts';

export const holidayCalendar = Router();

export interface HolidayRow { name: string; startDay: string; endDay: string }

const dayBefore = (iso: string) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);

export const countryNames = (): Record<string, string> => new Holidays().getCountries() as Record<string, string>;
export const hasCountry = (code: string) => Object.prototype.hasOwnProperty.call(countryNames(), code.toUpperCase());

/** The public holidays of a country for one year, one row each (a holiday that lasts several days is one row with an end day). Empty for an unknown country. */
export function publicHolidays(country: string, year: number): HolidayRow[] {
  if (!hasCountry(country)) return [];
  const hd = new Holidays(country.toUpperCase());
  hd.setLanguages('en');            // English names where the data has them (otherwise the country's own language)
  const seen = new Set<string>();
  const out: HolidayRow[] = [];
  for (const h of hd.getHolidays(year) as any[]) {
    if (h.type !== 'public') continue;
    const startDay = String(h.date).slice(0, 10);
    const lastDay = h.end ? dayBefore(new Date(h.end).toISOString().slice(0, 10)) : startDay;
    const endDay = lastDay > startDay && lastDay.slice(0, 4) === startDay.slice(0, 4) ? lastDay : startDay;
    const key = `${startDay}|${h.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: String(h.name).slice(0, 100), startDay, endDay });
  }
  return out.sort((a, b) => a.startDay.localeCompare(b.startDay));
}

/** Add holidays that are not already in the calendar (same name on the same day). For the whole organisation, or for one site's groups when `siteId` is given. Returns how many were added. */
export async function addHolidays(tx: Tx, rows: HolidayRow[], siteId: string | null = null): Promise<number> {
  let added = 0;
  for (const r of rows) {
    const done = await tx.one<{ id: string }>(
      `INSERT INTO special_events (tenant_id, wfm_group_id, site_id, queue_id, name, kind, start_day, end_day, uplift_pct, lead_days, lag_days)
       SELECT :t, NULL, $4::uuid, NULL, $1, 'holiday', $2::date, $3::date, 0, 0, 0
       WHERE NOT EXISTS (SELECT 1 FROM special_events WHERE tenant_id = :t AND kind = 'holiday' AND wfm_group_id IS NULL AND site_id IS NOT DISTINCT FROM $4::uuid AND start_day = $2::date AND lower(name) = lower($1))
       RETURNING id`,
      [r.name, r.startDay, r.endDay, siteId]);
    if (done) added++;
  }
  return added;
}

const Year = z.coerce.number().int().min(2000).max(2100);

holidayCalendar.get('/countries', requires('config:read'), (_req, res) => {
  res.json(Object.entries(countryNames()).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name)));
});

/** What a country's holidays are for a year, marked with the ones already in this organisation's calendar. Nothing is changed. */
holidayCalendar.get('/catalog', requires('config:read'), async (req, res) => {
  const country = String(req.query.country ?? '').toUpperCase();
  if (!hasCountry(country)) throw bad('Choose a country from the list.');
  const year = parse(Year, req.query.year);
  const siteId = req.query.siteId ? parse(z.string().uuid(), req.query.siteId) : null;
  const rows = publicHolidays(country, year);
  const have = await withTenant(me(req).tenantId, (tx) => tx.q<{ day: string; name: string }>(
    `SELECT start_day::text AS day, lower(name) AS name FROM special_events WHERE tenant_id = :t AND kind = 'holiday' AND wfm_group_id IS NULL AND site_id IS NOT DISTINCT FROM $3::uuid AND start_day >= $1::date AND start_day <= $2::date`,
    [`${year}-01-01`, `${year}-12-31`, siteId]));
  const set = new Set(have.map((h) => `${h.day}|${h.name}`));
  res.json(rows.map((r) => ({ ...r, exists: set.has(`${r.startDay}|${r.name.toLowerCase()}`) })));
});

/** Remove every holiday that starts in one year: the organisation's (and its groups') calendar, or, with `siteId`, only that site's. Only holidays: campaigns and outages are left alone. */
holidayCalendar.delete('/year/:year', requires('config:write'), async (req, res) => {
  const p = me(req);
  const year = parse(Year, req.params.year);
  const siteId = req.query.siteId ? parse(z.string().uuid(), req.query.siteId) : null;
  const removed = await withTenant(p.tenantId, async (tx) => {
    const gone = await tx.q<{ id: string }>(
      `DELETE FROM special_events WHERE tenant_id = :t AND kind = 'holiday' AND site_id IS NOT DISTINCT FROM $3::uuid AND start_day >= $1::date AND start_day <= $2::date RETURNING id`,
      [`${year}-01-01`, `${year}-12-31`, siteId]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'HOLIDAY_CALENDAR', entityId: String(year), entityName: `All holidays of ${year}${siteId ? ' (one site)' : ''}`, before: { removed: gone.length } });
    return gone.length;
  });
  res.json({ removed });
});

holidayCalendar.post('/import', requires('config:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ country: z.string().length(2), years: z.array(Year).min(1).max(3), siteId: z.string().uuid().nullable().optional() }), req.body);
  const country = b.country.toUpperCase();
  if (!hasCountry(country)) throw bad('Choose a country from the list.');
  const rows = b.years.flatMap((y) => publicHolidays(country, y));
  const added = await withTenant(p.tenantId, async (tx) => {
    if (b.siteId && !(await tx.one('SELECT 1 FROM sites WHERE tenant_id = :t AND id = $1', [b.siteId]))) throw notFound('Site');
    const n = await addHolidays(tx, rows, b.siteId ?? null);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'HOLIDAY_CALENDAR', entityId: country, entityName: `Public holidays: ${countryNames()[country]} ${b.years.join(', ')}`, after: { country, years: b.years, added: n, found: rows.length } });
    return n;
  });
  res.json({ added, skipped: rows.length - added, found: rows.length });
});
