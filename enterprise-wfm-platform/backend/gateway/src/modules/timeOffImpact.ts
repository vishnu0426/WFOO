/**
 * Time off, decided with the facts in front of you.
 *
 *   GET  /workforce/time-off/:id/impact   : the person's balance, the rules, the team's daily limit and what approving does to cover on each day
 *   POST /workforce/time-off/bulk-decide  : approve (or decline) many waiting requests at once; "only the ones that pass" leaves the rest for a person to look at
 *
 * The arithmetic is in timeOffMath.ts. Approving goes through the same decideTimeOff() as one-at-a-time approval, so every rule (double booking, who may decide, the schedule being
 * reconciled) is identical.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requiresAny, type Principal } from '../auth.ts';
import { bad, notFound, parse } from '../http.ts';
import { dropCache } from '../infra.ts';
import { teamLimit } from './approvals.ts';
import { TO_SQL, toDto, decideTimeOff } from './workforceRoutes.ts';
import { balances, loadSelfPolicy } from './selfService.ts';
import { ruleVerdict } from './timeOffRules.ts';
import { requirementFor, requirementForManual } from './scheduleRoutes.ts';
import { loadPolicy } from './policyRoutes.ts';
import { addDays } from './forecast/service.ts';
import { addShiftCoverage } from './shiftCoverage.ts';
import { SPD, dayImpact, headline, passes, clock, dayName } from './timeOffMath.ts';

export const timeOffImpact = Router();
const uuid = z.string().uuid();
const MAX_DAYS = 62;       // longer requests are judged for their first nine weeks

const daysBetween = (a: string, b: string) => { const out: string[] = []; for (let d = a; d <= b && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };

/** Rows of one request the caller is allowed to see (a supervisor limited to their teams sees only those). */
async function requestFor(tx: Tx, p: Principal, id: string) {
  const lim = await teamLimit(tx, p);
  const row = (await tx.q<any>(`${TO_SQL} AND o.id = $1 AND ($2::uuid[] IS NULL OR e.team_id = ANY($2::uuid[]) OR e.id = $3::uuid)`, [id, lim ? lim.teamIds : null, lim?.self ?? null]))[0];
  if (!row) throw notFound('Time-off request');
  return row;
}

interface GroupCover { name: string; others: number[]; mine: number[]; published: Set<string> }
interface Facts { req: any; primaryId: string | null; groups: Map<string, GroupCover>; days: string[]; clipped: boolean; balance: any; rules: { blockers: string[]; reasons: string[] }; cap: any; target: number }

/**
 * Everything that comes out of the database for one request, in one transaction. A person can be rostered in more than one group (primary plus the groups they are eligible for) but has
 * one shift a day, so each day is judged in the group whose schedule that day's shift belongs to; days they do not work are shown against their primary group.
 */
async function gather(tx: Tx, req: any): Promise<Facts> {
  const emp = (await tx.one<any>('SELECT id, primary_group_id, eligible_group_ids FROM employees WHERE tenant_id = :t AND id = $1', [req.employeeId]))!;
  const primaryId: string | null = emp.primaryGroupId ?? null;
  const groupIds = [...new Set([primaryId, ...((emp.eligibleGroupIds ?? []) as string[])].filter((x): x is string => !!x))];
  const all = daysBetween(req.startDay, req.endDay), days = all.slice(0, MAX_DAYS);
  const pol = await loadSelfPolicy(tx), sched = await loadPolicy(tx);
  const n = all.length;

  let balance: any = null;
  if (pol.entitlements[req.type] !== undefined) {
    const b = (await balances(tx, req.employeeId, pol, req.startDay.slice(0, 4), Number(req.startDay.slice(5, 7)), req.startDay)).find((x) => x.type === req.type);
    // a request that is already approved is already inside "used"; do not take its days off twice
    if (b) balance = { type: b.type, entitledDays: b.entitledDays, remainingDays: b.remainingDays, usedDays: b.usedDays, asksFor: n, afterDays: Math.round((b.remainingDays - (req.status === 'APPROVED' ? 0 : n)) * 100) / 100, mode: pol.accrualMode };
  }

  const names = new Map((await tx.q<any>('SELECT id, name FROM wfm_groups WHERE tenant_id = :t AND id = ANY($1::uuid[])', [groupIds])).map((r) => [r.id as string, r.name as string]));
  const groups = new Map<string, GroupCover>();
  const cover = (gid: string) => { let c = groups.get(gid); if (!c) { c = { name: names.get(gid) ?? 'Group', others: new Array(days.length * SPD).fill(0), mine: new Array(days.length * SPD).fill(0), published: new Set() }; groups.set(gid, c); } return c; };
  if (primaryId) cover(primaryId);
  if (groupIds.length) {
    const shifts = await tx.q<any>(
      `SELECT v.wfm_group_id AS group_id, s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, s.activities FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
       WHERE s.tenant_id = :t AND v.wfm_group_id = ANY($1::uuid[]) AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.day >= $2::date AND s.day <= $3::date`,
      [groupIds, addDays(days[0], -1), days.at(-1)]);
    const away = await tx.q<any>(
      `SELECT employee_id, start_day::text AS s, end_day::text AS e FROM time_off WHERE tenant_id = :t AND status = 'APPROVED' AND employee_id <> $1 AND end_day >= $2::date AND start_day <= $3::date`,
      [req.employeeId, addDays(days[0], -1), days.at(-1)]);
    const isAway = (who: string, day: string) => away.some((a) => a.employeeId === who && a.s <= day && a.e >= day);
    for (const s of shifts) {
      const c = cover(s.groupId);
      c.published.add(s.day);
      const prev = s.day === addDays(days[0], -1), idx = prev ? -1 : days.indexOf(s.day);
      if (!prev && idx < 0) continue;
      // the person's own shift the day before the leave still runs on past midnight: it stays, so it counts as cover; their shifts on the leave days are what approving removes
      if (s.employeeId === req.employeeId && !prev) { addShiftCoverage(c.mine, idx, s); continue; }
      if (isAway(s.employeeId, s.day)) continue;     // someone already off that day is not there to cover, whatever the published schedule still says
      addShiftCoverage(c.others, idx, s);
    }
  }

  // blackout dates and daily limits of every group they are rostered in on these days (and their primary one)
  const rosteredIn = [...groups.entries()].filter(([gid, c]) => gid === primaryId || c.mine.some((v) => v > 0)).map(([gid]) => gid);
  const rules = { blockers: [] as string[], reasons: [] as string[] };
  for (const gid of rosteredIn.length ? rosteredIn : [primaryId]) {
    const v = await ruleVerdict(tx, req.employeeId, gid, req.type, req.startDay, req.endDay);
    for (const t of v.blockers) if (!rules.blockers.includes(t)) rules.blockers.push(t);
    for (const t of v.reasons) if (!rules.reasons.includes(t)) rules.reasons.push(t);
  }

  // the team's daily limit on people off, counted in their primary group: how many are already off each day against what the policy allows
  let cap: any = null;
  if (primaryId && req.type !== 'SICK' && n <= MAX_DAYS) {
    const size = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND status = 'ACTIVE' AND primary_group_id = $1`, [primaryId]))!.n;
    const limit = Math.max(1, Math.floor((size * pol.timeOffMaxOffPercent) / 100));
    const off = await tx.q<any>(
      `SELECT d::date::text AS day, count(DISTINCT o.employee_id)::int AS n FROM generate_series($2::date, $3::date, interval '1 day') d
       JOIN time_off o ON o.tenant_id = :t AND o.status = 'APPROVED' AND o.start_day <= d::date AND o.end_day >= d::date
       JOIN employees e ON e.id = o.employee_id AND e.primary_group_id = $1 AND e.id <> $4 GROUP BY d`, [primaryId, req.startDay, req.endDay, req.employeeId]);
    const worst = off.sort((a, b) => b.n - a.n)[0];
    const breach = off.filter((r) => r.n + 1 > limit).sort((a, b) => (a.day < b.day ? -1 : 1))[0] ?? null;
    cap = { percent: pol.timeOffMaxOffPercent, limit, groupSize: size, busiest: worst ?? null, breach: breach ? { day: breach.day, off: breach.n, cap: limit } : null };
  }
  return { req, primaryId, groups, days, clipped: all.length > days.length, balance, rules, cap, target: sched.scheduling.targetCoverage };
}

/** What the group needs, from the published forecast, else from its weekly coverage template; null when it has neither. */
async function requirementOrNull(tenantId: string, groupId: string | null, days: string[]): Promise<{ required: number[]; source: 'forecast' | 'template'; projected: string[] } | null> {
  if (!groupId) return null;
  try { const r = await requirementFor(tenantId, groupId, days); return { required: r.required, source: 'forecast', projected: r.projected }; } catch { /* no forecast reaches these days */ }
  try { const r = await requirementForManual(tenantId, groupId, days); return { required: r.required, source: 'template', projected: [] }; } catch { return null; }
}

export async function impactOf(p: Principal, id: string) {
  const f = await withTenant(p.tenantId, async (tx) => gather(tx, await requestFor(tx, p, id)));
  // the group each day is judged in: the one whose schedule holds their shift that day, else their primary group
  const dayGroup = f.days.map((_, i) => { for (const [gid, c] of f.groups) if (c.mine.slice(i * SPD, (i + 1) * SPD).some((v) => v > 0)) return gid; return f.primaryId; });
  const needed = [...new Set(dayGroup.filter((x): x is string => !!x))];
  const needs = new Map(await Promise.all(needed.map(async (gid) => [gid, await requirementOrNull(p.tenantId, gid, f.days)] as const)));
  const multi = needed.length > 1;
  const impacts = f.days.map((day, i) => {
    const gid = dayGroup[i], c = gid ? f.groups.get(gid) : undefined, need = gid ? needs.get(gid) ?? null : null;
    const slice = (a: number[]) => a.slice(i * SPD, (i + 1) * SPD);
    const req = need ? slice(need.required) : null;
    // days a forecast does not reach have all-zero requirement; treat those as unjudged rather than "nothing needed"
    const known = req && req.some((v) => v > 0) ? req : null;
    const zero = new Array(SPD).fill(0);
    return { ...dayImpact({ day, required: known, others: c ? slice(c.others) : zero, mine: c ? slice(c.mine) : zero, published: !!c && c.published.has(day) }), groupName: multi && c ? c.name : null };
  });
  const sources = [...needs.values()].filter((x) => x);
  const pass = passes({ blockers: f.rules.blockers, reasons: f.rules.reasons, balanceAfter: f.balance ? f.balance.afterDays : null, capBreach: f.cap?.breach ?? null, days: impacts, target: f.target, status: f.req.status });
  const head = headline(impacts, f.target);
  return {
    request: toDto(f.req), balance: f.balance, rules: f.rules, cap: f.cap, target: f.target,
    coverage: { source: sources.length && sources.every((x) => x!.source === 'forecast') ? 'forecast' : sources.length ? 'template' : null, projectedDays: [...new Set(sources.flatMap((x) => x!.projected))], judgedDays: f.days.length, clipped: f.clipped, headline: head.text, tone: head.tone,
      groups: multi ? needed.map((gid) => f.groups.get(gid)!.name) : [],
      days: impacts.map((d) => ({ ...d, dayName: dayName(d.day), worst: d.worst ? { ...d.worst, from: clock(d.worst.startSlot), to: clock(d.worst.endSlot) } : null })) },
    passes: pass,
  };
}

timeOffImpact.get('/time-off/:id/impact', requiresAny('workforce:read', 'requests:approve'), async (req, res) => {
  res.json(await impactOf(me(req), parse(uuid, req.params.id)));
});

const BulkBody = z.object({ ids: z.array(uuid).min(1).max(50), status: z.enum(['APPROVED', 'REJECTED']), reason: z.string().max(300).optional(), onlyIfPasses: z.boolean().default(true) });

timeOffImpact.post('/time-off/bulk-decide', requiresAny('workforce:write', 'requests:approve'), async (req, res) => {
  const p = me(req), b = parse(BulkBody, req.body);
  if (b.status === 'REJECTED' && (b.reason ?? '').trim().length < 3) throw bad('Give a reason when declining requests');
  const ids = [...new Set(b.ids)];
  const done: any[] = [], skipped: { id: string; employeeName?: string; why: string[] }[] = [];
  for (const id of ids) {
    try {
      if (b.status === 'APPROVED' && b.onlyIfPasses) {
        const imp = await impactOf(p, id);
        if (!imp.passes.ok) { skipped.push({ id, employeeName: imp.request.employeeName, why: imp.passes.why }); continue; }
      }
      // each request is its own transaction: one that cannot be decided does not undo the others
      const out = await withTenant(p.tenantId, async (tx) => {
        const cur = await requestFor(tx, p, id);
        if (cur.status !== 'REQUESTED') return { skip: ['No longer waiting for a decision.'], name: cur.employeeName };
        return { dto: await decideTimeOff(tx, p, req, id, b.status, b.reason) };
      });
      if ('skip' in out) skipped.push({ id, employeeName: out.name, why: out.skip as string[] });
      else done.push(out.dto);
    } catch (e: any) {
      skipped.push({ id, why: [String(e?.message ?? 'Could not be decided.')] });
    }
  }
  if (done.length) await dropCache(p.tenantId, 'sched:*');
  res.json({ decided: done.length, skipped: skipped.length, requests: done, left: skipped });
});
