/**
 * Leave balances from the year-by-year record (migration 089), and the admin side of it: closing a year, and adjusting a person's days by hand.
 * The pure rules are in leaveYear.ts. A year that has not been closed still works, on the old estimate, and says so (`estimated`).
 * Mounted at /self-service (next to the self-service rules).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, notFound, parse } from '../http.ts';
import { closeYear, estimatedCarry, expiryDay, leaveBalance, type CloseOut } from './leaveYear.ts';
import { loadSelfPolicy, type Policy } from './selfService.ts';

export const leaveAdmin = Router();
const uuid = z.string().uuid();
const TYPES = ['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER'] as const;
const STATUSES = `('REQUESTED','APPROVED')`;

/** Days of leave per type between two dates (inclusive), counting pending and approved requests: pending ones are held against the balance. */
export async function usedByType(tx: Tx, employeeId: string, from: string, to: string) {
  const rows = await tx.q<{ type: string; days: number }>(
    `SELECT type, sum(LEAST(end_day, $3::date) - GREATEST(start_day, $2::date) + 1)::int AS days FROM time_off
     WHERE tenant_id = :t AND employee_id = $1 AND status IN ${STATUSES} AND end_day >= $2::date AND start_day <= $3::date GROUP BY type`, [employeeId, from, to]);
  return new Map(rows.map((r) => [r.type, r.days]));
}

/** One person's balance per leave type for a year, from the closed record of the year before (or the estimate when that year is not closed). */
export async function ledgerBalances(tx: Tx, employeeId: string, pol: Policy, year: string, asOfMonth = 12, asOfDay?: string) {
  const y = Number(year);
  const used = await usedByType(tx, employeeId, `${year}-01-01`, `${year}-12-31`);
  const closed = new Map((await tx.q<{ type: string; carriedOut: number }>('SELECT type, carried_out::float8 AS carried_out FROM leave_year_balances WHERE tenant_id = :t AND employee_id = $1 AND year = $2', [employeeId, y - 1])).map((r) => [r.type, r.carriedOut]));
  const adj = new Map((await tx.q<{ type: string; days: number }>('SELECT type, sum(days)::float8 AS days FROM leave_adjustments WHERE tenant_id = :t AND employee_id = $1 AND year = $2 GROUP BY type', [employeeId, y])).map((r) => [r.type, r.days]));
  const needEstimate = Object.keys(pol.entitlements).some((t) => !closed.has(t) && (pol.carryOverDays?.[t] ?? 0) > 0);
  const prev = needEstimate ? await usedByType(tx, employeeId, `${y - 1}-01-01`, `${y - 1}-12-31`) : new Map<string, number>();
  const out = [];
  for (const [type, entitled] of Object.entries(pol.entitlements)) {
    const cap = pol.carryOverDays?.[type] ?? 0;
    const isClosed = closed.has(type);
    const carriedIn = isClosed ? closed.get(type)! : estimatedCarry(entitled, prev.get(type) ?? 0, cap);
    const expiry = expiryDay(y, pol.carryExpiry?.[type]);
    const usedByExpiry = expiry && asOfDay && asOfDay > expiry ? [...(await usedByType(tx, employeeId, `${year}-01-01`, expiry)).entries()].find(([k]) => k === type)?.[1] ?? 0 : 0;
    out.push({ type, ...leaveBalance({ entitled, mode: pol.accrualMode ?? 'UPFRONT', asOfMonth, asOf: asOfDay, usedThisYear: used.get(type) ?? 0, carriedIn, carryExpiry: expiry, usedByExpiry, adjusted: adj.get(type) ?? 0 }), estimated: !isClosed && cap > 0 });
  }
  return out;
}

// ---------------------------------------------------------------- closing a year

export interface ClosedRow extends CloseOut { employeeId: string; type: string }
export interface CloseSummary { year: number; people: number; rows: number; byType: { type: string; people: number; carriedOut: number; lapsed: number; expired: number; used: number }[] }

/** What closing the year would write, for everyone who is active: set-based reads, then the pure rule per person and type. */
export async function planClose(tx: Tx, pol: Policy, year: number): Promise<{ rows: ClosedRow[]; summary: CloseSummary }> {
  const types = Object.entries(pol.entitlements);
  const people = await tx.q<{ id: string }>(`SELECT id FROM employees WHERE tenant_id = :t AND status IN ('ACTIVE', 'LEAVE')`);
  const usedIn = async (from: string, to: string) => {
    const rows = await tx.q<{ employeeId: string; type: string; days: number }>(
      `SELECT employee_id, type, sum(LEAST(end_day, $2::date) - GREATEST(start_day, $1::date) + 1)::int AS days FROM time_off
       WHERE tenant_id = :t AND status IN ${STATUSES} AND end_day >= $1::date AND start_day <= $2::date GROUP BY employee_id, type`, [from, to]);
    return new Map(rows.map((r) => [`${r.employeeId}|${r.type}`, r.days]));
  };
  const used = await usedIn(`${year}-01-01`, `${year}-12-31`);
  const prevClosed = new Map((await tx.q<{ employeeId: string; type: string; carriedOut: number }>('SELECT employee_id, type, carried_out::float8 AS carried_out FROM leave_year_balances WHERE tenant_id = :t AND year = $1', [year - 1])).map((r) => [`${r.employeeId}|${r.type}`, r.carriedOut]));
  const prevUsed = types.some(([t]) => (pol.carryOverDays?.[t] ?? 0) > 0) ? await usedIn(`${year - 1}-01-01`, `${year - 1}-12-31`) : new Map<string, number>();
  const adj = new Map((await tx.q<{ employeeId: string; type: string; days: number }>('SELECT employee_id, type, sum(days)::float8 AS days FROM leave_adjustments WHERE tenant_id = :t AND year = $1 GROUP BY employee_id, type', [year])).map((r) => [`${r.employeeId}|${r.type}`, r.days]));
  const byExpiry = new Map<string, Map<string, number>>();
  for (const [type] of types) { const e = expiryDay(year, pol.carryExpiry?.[type]); if (e) byExpiry.set(type, await usedIn(`${year}-01-01`, e)); }

  const rows: ClosedRow[] = [];
  const sums = new Map<string, { people: number; carriedOut: number; lapsed: number; expired: number; used: number }>();
  for (const e of people) {
    for (const [type, entitled] of types) {
      const key = `${e.id}|${type}`, cap = pol.carryOverDays?.[type] ?? 0, expiry = expiryDay(year, pol.carryExpiry?.[type]);
      const carriedIn = prevClosed.has(key) ? prevClosed.get(key)! : estimatedCarry(entitled, prevUsed.get(key) ?? 0, cap);
      const r = closeYear({ entitled, usedThisYear: used.get(key) ?? 0, carriedIn, adjusted: adj.get(key) ?? 0, carryExpiry: expiry, usedByExpiry: byExpiry.get(type)?.get(key) ?? 0, cap });
      rows.push({ employeeId: e.id, type, ...r });
      const s = sums.get(type) ?? { people: 0, carriedOut: 0, lapsed: 0, expired: 0, used: 0 };
      s.people += 1; s.carriedOut += r.carriedOut; s.lapsed += r.lapsed; s.expired += r.expired; s.used += r.used; sums.set(type, s);
    }
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { rows, summary: { year, people: people.length, rows: rows.length, byType: [...sums.entries()].map(([type, s]) => ({ type, people: s.people, carriedOut: r2(s.carriedOut), lapsed: r2(s.lapsed), expired: r2(s.expired), used: r2(s.used) })) } };
}

async function writeClose(tx: Tx, rows: ClosedRow[], year: number, by: string) {
  for (let i = 0; i < rows.length; i += 2000) {
    const c = rows.slice(i, i + 2000);
    await tx.exec(
      `INSERT INTO leave_year_balances (tenant_id, employee_id, type, year, entitled, carried_in, adjusted, used, expired, lapsed, carried_out, closed_by)
       SELECT :t, e, t, $3::int, en, ci, ad, us, ex, la, co, $11::text
         FROM unnest($1::uuid[], $2::text[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[]) AS x(e, t, en, ci, ad, us, ex, la, co)
       ON CONFLICT (tenant_id, employee_id, type, year) DO UPDATE SET entitled = EXCLUDED.entitled, carried_in = EXCLUDED.carried_in, adjusted = EXCLUDED.adjusted, used = EXCLUDED.used,
         expired = EXCLUDED.expired, lapsed = EXCLUDED.lapsed, carried_out = EXCLUDED.carried_out, closed_at = now(), closed_by = EXCLUDED.closed_by`,
      [c.map((r) => r.employeeId), c.map((r) => r.type), year, c.map((r) => r.entitled), c.map((r) => r.carriedIn), c.map((r) => r.adjusted), c.map((r) => r.used), c.map((r) => r.expired), c.map((r) => r.lapsed), c.map((r) => r.carriedOut), by]);
  }
}

const thisYear = () => new Date().getFullYear();

leaveAdmin.get('/leave/year-close', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(thisYear() - 1) }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const pol = await loadSelfPolicy(tx);
    const closed = await tx.one<{ people: number; closedAt: string; closedBy: string }>('SELECT count(DISTINCT employee_id)::int AS people, max(closed_at) AS closed_at, max(closed_by) AS closed_by FROM leave_year_balances WHERE tenant_id = :t AND year = $1', [q.year]);
    const plan = await planClose(tx, pol, q.year);
    return { year: q.year, canClose: q.year < thisYear(), closed: closed && closed.people > 0 ? closed : null, preview: plan.summary };
  }));
});

leaveAdmin.post('/leave/year-close', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ year: z.number().int().min(2000).max(2100), reason: z.string().trim().min(3).max(300) }), req.body);
  if (b.year >= thisYear()) throw conflict('A year can be closed once it has ended.');
  res.json(await withTenant(p.tenantId, async (tx) => {
    const pol = await loadSelfPolicy(tx);
    const plan = await planClose(tx, pol, b.year);
    await writeClose(tx, plan.rows, b.year, p.name);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'LEAVE_YEAR', entityId: String(b.year), entityName: `Leave year ${b.year} closed`, reason: b.reason, after: plan.summary });
    return plan.summary;
  }));
});

// ---------------------------------------------------------------- adjustments

const AdjustBody = z.object({
  employeeId: uuid, type: z.enum(TYPES), year: z.number().int().min(2000).max(2100),
  kind: z.enum(['GRANT', 'DEDUCT', 'PAYOUT', 'CORRECTION']), days: z.number().min(-366).max(366).refine((d) => d !== 0, 'Enter a number of days'),
  reason: z.string().trim().min(3).max(300),
});

leaveAdmin.get('/leave/balances', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ employeeId: uuid, year: z.coerce.number().int().min(2000).max(2100).default(thisYear()) }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const e = await tx.one<{ id: string }>('SELECT id FROM employees WHERE tenant_id = :t AND id = $1', [q.employeeId]);
    if (!e) throw notFound('Employee');
    const pol = await loadSelfPolicy(tx), today = new Date().toISOString().slice(0, 10);
    const adjustments = await tx.q<any>('SELECT id, type, year, days::float8 AS days, kind, reason, created_by, created_at FROM leave_adjustments WHERE tenant_id = :t AND employee_id = $1 AND year = $2 ORDER BY created_at DESC LIMIT 100', [q.employeeId, q.year]);
    return { year: q.year, balances: await ledgerBalances(tx, q.employeeId, pol, String(q.year), q.year === thisYear() ? Number(today.slice(5, 7)) : 12, q.year === thisYear() ? today : `${q.year}-12-31`), adjustments };
  }));
});

leaveAdmin.post('/leave/adjustments', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(AdjustBody, req.body);
  // the three named kinds take a plain number of days; only a correction can go either way
  if (b.kind !== 'CORRECTION' && b.days < 0) throw bad(`Enter a positive number of days for a ${b.kind.toLowerCase()}.`);
  const signed = b.kind === 'DEDUCT' || b.kind === 'PAYOUT' ? -Math.abs(b.days) : b.days;
  res.status(201).json(await withTenant(p.tenantId, async (tx) => {
    const e = await tx.one<{ id: string; firstName: string; lastName: string }>('SELECT id, first_name, last_name FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!e) throw notFound('Employee');
    const pol = await loadSelfPolicy(tx);
    if (pol.entitlements[b.type] === undefined) throw bad(`There is no ${b.type.toLowerCase()} allowance set up, so there is nothing to adjust.`);
    if (b.year > thisYear() + 1) throw bad('Adjustments can only be made for this year or next.');
    const closed = await tx.one('SELECT 1 FROM leave_year_balances WHERE tenant_id = :t AND employee_id = $1 AND type = $2 AND year = $3', [b.employeeId, b.type, b.year]);
    if (closed) throw conflict(`${b.year} is already closed for this person, so an adjustment would not carry forward. Adjust ${b.year + 1} instead.`);
    const row = await tx.one<any>('INSERT INTO leave_adjustments (tenant_id, employee_id, type, year, days, kind, reason, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6, $7) RETURNING id, type, year, days::float8 AS days, kind, reason, created_by, created_at',
      [b.employeeId, b.type, b.year, signed, b.kind, b.reason, p.name]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'LEAVE_ADJUSTMENT', entityId: row.id, entityName: `${e.firstName} ${e.lastName}: ${b.type.toLowerCase()} ${signed > 0 ? '+' : ''}${signed} days (${b.kind.toLowerCase()})`, reason: b.reason, after: row });
    return row;
  }));
});
