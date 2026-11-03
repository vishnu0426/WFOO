/**
 * Time-off rules beyond the everyday ones: blackout dates, daily limits for a date range, and balances that build up over the year.
 * Pure arithmetic first (tested on its own), then the lookups against the database.
 */
import type { Tx } from '../db.ts';

export interface OffRule { id: string; groupId: string | null; kind: 'BLACKOUT' | 'CAP'; startDay: string; endDay: string; maxOff: number | null; types: string[] | null; strict: boolean; reason: string }
export interface RuleHit { rule: OffRule; text: string; strict: boolean }

const overlap = (aStart: string, aEnd: string, bStart: string, bEnd: string) => aStart <= bEnd && aEnd >= bStart;
const daysBetween = (from: string, to: string) => { const out: string[] = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };

/** Blackouts that touch the request. Sick leave is never blocked. `groupId` is the person's group; rules with no group apply to everyone. */
export function blackoutHits(rules: OffRule[], groupId: string | null, type: string, start: string, end: string): RuleHit[] {
  if (type === 'SICK') return [];
  return rules.filter((r) => r.kind === 'BLACKOUT' && (!r.groupId || r.groupId === groupId) && (!r.types?.length || r.types.includes(type)) && overlap(r.startDay, r.endDay, start, end))
    .map((r) => ({ rule: r, strict: r.strict, text: `${r.reason ? `${r.reason}: ` : ''}${type.toLowerCase()} leave is not available from ${r.startDay} to ${r.endDay}.` }));
}

/** Days in the request where a daily limit would be exceeded. `offByDay` is how many of the group are already off on each day (not counting this person). */
export function capHits(rules: OffRule[], groupId: string | null, type: string, start: string, end: string, offByDay: Map<string, number>): RuleHit[] {
  if (type === 'SICK') return [];
  const out: RuleHit[] = [];
  for (const r of rules) {
    if (r.kind !== 'CAP' || r.maxOff === null || !(!r.groupId || r.groupId === groupId) || (r.types?.length && !r.types.includes(type)) || !overlap(r.startDay, r.endDay, start, end)) continue;
    const full = daysBetween(start < r.startDay ? r.startDay : start, end > r.endDay ? r.endDay : end).find((d) => (offByDay.get(d) ?? 0) + 1 > r.maxOff!);
    if (full) out.push({ rule: r, strict: r.strict, text: `${r.reason ? `${r.reason}: ` : ''}at most ${r.maxOff} ${r.maxOff === 1 ? 'person' : 'people'} may be off on ${full} and ${offByDay.get(full) ?? 0} already ${(offByDay.get(full) ?? 0) === 1 ? 'is' : 'are'}.` });
  }
  return out;
}

export interface BalanceInput { type: string; entitled: number; mode: 'UPFRONT' | 'MONTHLY'; asOfMonth: number; usedThisYear: number; lastYearEntitled: number; lastYearUsed: number; carryOverCap: number }
/**
 * What a person can still take. UPFRONT: the whole year from 1 January. MONTHLY: one twelfth for each month up to and including the one the leave starts in.
 * Unused days from last year carry over up to the cap. Returns the figures behind the answer so the screen can show them.
 */
export function balanceOf(b: BalanceInput) {
  const accrued = b.mode === 'MONTHLY' ? Math.round((b.entitled * Math.min(12, Math.max(1, b.asOfMonth)) / 12) * 100) / 100 : b.entitled;
  const carriedOver = Math.min(b.carryOverCap, Math.max(0, b.lastYearEntitled - b.lastYearUsed));
  const available = accrued + carriedOver;
  return { type: b.type, entitledDays: b.entitled, accruedDays: accrued, carriedOverDays: carriedOver, usedDays: b.usedThisYear, remainingDays: Math.max(0, Math.round((available - b.usedThisYear) * 100) / 100) };
}

export async function loadRules(tx: Tx, from: string, to: string): Promise<OffRule[]> {
  return tx.q<OffRule>(`SELECT id, wfm_group_id AS group_id, kind, start_day::text AS start_day, end_day::text AS end_day, max_off, types, strict, reason FROM time_off_rules WHERE tenant_id = :t AND end_day >= $1::date AND start_day <= $2::date ORDER BY start_day`, [from, to]);
}

/** Everything the rules say about a request: refusals, and reasons it needs a manager's decision. */
export async function ruleVerdict(tx: Tx, employeeId: string, groupId: string | null, type: string, start: string, end: string) {
  const rules = await loadRules(tx, start, end);
  if (!rules.length) return { blockers: [] as string[], reasons: [] as string[] };
  const caps = rules.filter((r) => r.kind === 'CAP');
  const offByDay = new Map<string, number>();
  if (caps.length && groupId) {
    const rows = await tx.q<{ day: string; n: number }>(
      `SELECT d::date::text AS day, count(DISTINCT o.employee_id)::int AS n FROM generate_series($2::date, $3::date, interval '1 day') d
       JOIN time_off o ON o.tenant_id = :t AND o.status = 'APPROVED' AND o.start_day <= d::date AND o.end_day >= d::date
       JOIN employees e ON e.id = o.employee_id AND e.primary_group_id = $1 AND e.id <> $4 GROUP BY d`, [groupId, start, end, employeeId]);
    for (const r of rows) offByDay.set(r.day, r.n);
  }
  const hits = [...blackoutHits(rules, groupId, type, start, end), ...capHits(rules, groupId, type, start, end, offByDay)];
  return { blockers: hits.filter((h) => h.strict).map((h) => h.text), reasons: hits.filter((h) => !h.strict).map((h) => h.text) };
}
