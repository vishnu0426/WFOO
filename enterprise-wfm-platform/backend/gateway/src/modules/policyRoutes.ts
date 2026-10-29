/**
 * Configuration: activity definitions (what counts as work, shrinkage and paid time) and the company-wide scheduling policy
 * (rules every schedule must respect, plus the default optimisation weights). The scheduler applies the policy in loadCtx:
 * the stricter of the policy and an employee's own contract wins.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, notFound, parse } from '../http.ts';

export const policy = Router();

const CATS = ['WORK', 'BREAK', 'MEAL', 'TRAINING', 'MEETING', 'COACHING', 'ABSENCE', 'OTHER'] as const;
const codeOf = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'ACTIVITY';

const ActBody = z.object({
  name: z.string().trim().min(1).max(80), code: z.string().trim().min(1).max(30).optional(), shortCode: z.string().trim().max(4).optional(),
  category: z.enum(CATS), countsAsWork: z.boolean(), paid: z.boolean(), shrinkage: z.boolean(), ignoreAdherence: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
const actDto = (a: any) => ({ id: a.id, name: a.name, code: a.code, shortCode: a.shortCode, category: a.category, countsAsWork: a.countsAsWork, paid: a.paid, shrinkage: a.shrinkage, ignoreAdherence: a.ignoreAdherence, color: a.color, textColor: a.textColor ?? null, status: a.status, version: a.version });

policy.get('/activities', requires('config:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM activities WHERE tenant_id = :t ORDER BY name'))).map(actDto));
});
policy.post('/activities', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(ActBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const a = await tx.one<any>(
      `INSERT INTO activities (tenant_id, name, code, short_code, category, counts_as_work, paid, shrinkage, color, text_color, status, ignore_adherence)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10, 'ACTIVE'), $11) RETURNING *`,
      [b.name, b.code ?? codeOf(b.name), b.shortCode || b.name.slice(0, 2).toUpperCase(), b.category, b.countsAsWork, b.paid, b.shrinkage, b.color, b.textColor ?? null, b.status ?? null, b.ignoreAdherence ?? false]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'ACTIVITY', entityId: a!.id, entityName: b.name, after: actDto(a) });
    return actDto(a);
  });
  res.status(201).json(out);
});
policy.put('/activities/:id', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(ActBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM activities WHERE tenant_id = :t AND id = $1', [req.params.id]);
    if (!before) throw notFound('Activity');
    const a = await tx.one<any>(
      `UPDATE activities SET name = $2, code = $3, short_code = $4, category = $5, counts_as_work = $6, paid = $7, shrinkage = $8, color = $9, text_color = $10,
         status = coalesce($11, status), ignore_adherence = coalesce($12, ignore_adherence), version = version + 1, updated_at = now() WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [req.params.id, b.name, b.code ?? before.code, b.shortCode || before.shortCode, b.category, b.countsAsWork, b.paid, b.shrinkage, b.color, b.textColor ?? null, b.status ?? null, b.ignoreAdherence ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'ACTIVITY', entityId: a!.id, entityName: b.name, before: actDto(before), after: actDto(a) });
    return actDto(a);
  });
  res.json(out);
});
policy.delete('/activities/:id', requires('config:write'), async (req, res) => {
  const p = me(req);
  await withTenant(p.tenantId, async (tx) => {
    const a = await tx.one<any>('DELETE FROM activities WHERE tenant_id = :t AND id = $1 RETURNING *', [req.params.id]);
    if (!a) throw notFound('Activity');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'ACTIVITY', entityId: a.id, entityName: a.name, before: actDto(a) });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- per-group settings for the shared activity list

const GroupAct = z.object({ enabled: z.boolean(), shrinkage: z.boolean().nullable(), paid: z.boolean().nullable() });
const effective = (a: any, o: any) => ({
  ...actDto(a), companyShrinkage: a.shrinkage, companyPaid: a.paid,
  enabled: o ? o.enabled : true, shrinkage: o?.shrinkage ?? a.shrinkage, paid: o?.paid ?? a.paid, overridden: !!o,
});

policy.get('/groups/:gid/activities', requires('config:read'), async (req, res) => {
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const acts = await tx.q<any>('SELECT * FROM activities WHERE tenant_id = :t ORDER BY name');
    const ov = await tx.q<any>('SELECT * FROM group_activities WHERE tenant_id = :t AND wfm_group_id = $1', [req.params.gid]);
    return acts.map((a) => effective(a, ov.find((o) => o.activityId === a.id)));
  });
  res.json(out);
});
policy.put('/groups/:gid/activities/:aid', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(GroupAct, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const g = await tx.one<any>('SELECT name FROM wfm_groups WHERE tenant_id = :t AND id = $1', [req.params.gid]);
    const a = await tx.one<any>('SELECT * FROM activities WHERE tenant_id = :t AND id = $1', [req.params.aid]);
    if (!g) throw notFound('WFM group'); if (!a) throw notFound('Activity');
    const o = await tx.one<any>(
      `INSERT INTO group_activities (tenant_id, wfm_group_id, activity_id, enabled, shrinkage, paid) VALUES (:t, $1, $2, $3, $4, $5)
       ON CONFLICT (wfm_group_id, activity_id) DO UPDATE SET enabled = $3, shrinkage = $4, paid = $5, updated_at = now() RETURNING *`,
      [req.params.gid, req.params.aid, b.enabled, b.shrinkage, b.paid]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'GROUP_ACTIVITY', entityId: a.id, entityName: `${a.name} for ${g.name}`, after: b });
    return effective(a, o);
  });
  res.json(out);
});
policy.delete('/groups/:gid/activities/:aid', requires('config:write'), async (req, res) => {
  const p = me(req);
  await withTenant(p.tenantId, async (tx) => {
    const n = await tx.exec('DELETE FROM group_activities WHERE tenant_id = :t AND wfm_group_id = $1 AND activity_id = $2', [req.params.gid, req.params.aid]);
    if (n) await audit(tx, p, req, { action: 'DELETE', entityType: 'GROUP_ACTIVITY', entityId: String(req.params.aid), entityName: 'Reset to company setting' });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- scheduling policy

export const DEFAULT_WEIGHTS = { understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 20, fairness: 30 };
const W = z.number().int().min(0).max(100);
const Weights = z.object({ understaffing: W, overstaffing: W, contractHours: W, preferences: W, fairness: W });
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const DEFAULT_TIMELINE_COLORS = { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' };
/** Company defaults the Generate screen starts from, and the publish checks. */
export const DEFAULT_SCHEDULING = {
  consistentTimes: { mode: 'OFF' as 'OFF' | 'PREFER' | 'REQUIRE', startToleranceMin: 0, endToleranceMin: 0 },
  targetCoverage: 90,            // % of the requirement a schedule should cover
  enforcePublishChecks: false,   // when true, publishing below target coverage or on a stale forecast needs an acknowledged reason
  breakSlackMin: 60,             // how far a meal or break may move from its default place to improve coverage
  payWeekStart: 0,               // weekday a pay week begins on, Monday 0 ... Sunday 6. A WFM group can override it
  partTimeToleranceHours: 1 as number | null,   // part-time, contract and temporary staff may be scheduled at most this many hours past their contract (null: only their own weekly maximum applies)
};
const Tol = z.number().int().min(0).max(240);
const SchedDefaults = z.object({
  consistentTimes: z.object({ mode: z.enum(['OFF', 'PREFER', 'REQUIRE']), startToleranceMin: Tol, endToleranceMin: Tol }),
  targetCoverage: z.number().int().min(50).max(100), enforcePublishChecks: z.boolean(), breakSlackMin: z.number().int().min(0).max(240),
  payWeekStart: z.number().int().min(0).max(6).optional(),   // omitted by older clients: the saved value stays
  partTimeToleranceHours: z.number().min(0).max(24).nullable().optional(),
});
const PolBody = z.object({
  minRestHours: z.number().min(0).max(24).nullable(), maxWeeklyHours: z.number().min(1).max(100).nullable(),
  maxConsecutiveDays: z.number().int().min(1).max(14).nullable(), maxDaysPerWeek: z.number().int().min(1).max(7).nullable(), adherenceGraceSeconds: z.number().int().min(0).max(3600), weights: Weights,
  timelineColors: z.object({ shift: Hex, manual: Hex, violation: Hex }),
  scheduling: SchedDefaults.optional(),     // omitted by older clients: the saved defaults stay as they are
});
const polDto = (r: any) => ({
  minRestHours: r?.minRestHours == null ? null : Number(r.minRestHours), maxWeeklyHours: r?.maxWeeklyHours == null ? null : Number(r.maxWeeklyHours),
  maxConsecutiveDays: (r?.maxConsecutiveDays ?? null) as number | null, maxDaysPerWeek: (r?.maxDaysPerWeek ?? null) as number | null,
  adherenceGraceSeconds: (r?.adherenceGraceSeconds ?? 300) as number,
  timelineColors: { ...DEFAULT_TIMELINE_COLORS, ...(r?.timelineColors ?? {}) } as typeof DEFAULT_TIMELINE_COLORS,
  weights: { ...DEFAULT_WEIGHTS, ...(r?.weights ?? {}) } as typeof DEFAULT_WEIGHTS,
  scheduling: { ...DEFAULT_SCHEDULING, ...(r?.defaults ?? {}), consistentTimes: { ...DEFAULT_SCHEDULING.consistentTimes, ...(r?.defaults?.consistentTimes ?? {}) } } as typeof DEFAULT_SCHEDULING,
  updatedBy: (r?.updatedBy ?? null) as string | null, updatedAt: (r?.updatedAt ?? null) as string | null,
});
export type Policy = ReturnType<typeof polDto>;
export async function loadPolicy(tx: Tx): Promise<Policy> {
  return polDto(await tx.one<any>('SELECT * FROM scheduling_policy WHERE tenant_id = :t'));
}

policy.get('/scheduling-policy', requires('config:read'), async (req, res) => {
  res.json(await withTenant(me(req).tenantId, loadPolicy));
});
policy.put('/scheduling-policy', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(PolBody, req.body);
  if (b.maxWeeklyHours !== null && b.maxDaysPerWeek !== null && b.maxDaysPerWeek * 24 < b.maxWeeklyHours) throw bad('Days per week and weekly hours do not fit together');
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await loadPolicy(tx);
    const r = await tx.one<any>(
      `INSERT INTO scheduling_policy (tenant_id, min_rest_hours, max_weekly_hours, max_consecutive_days, max_days_per_week, weights, updated_by, adherence_grace_seconds, timeline_colors, defaults)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::jsonb, '{}'::jsonb))
       ON CONFLICT (tenant_id) DO UPDATE SET min_rest_hours = $1, max_weekly_hours = $2, max_consecutive_days = $3, max_days_per_week = $4, weights = $5, updated_by = $6, adherence_grace_seconds = $7, timeline_colors = $8,
         defaults = coalesce($9::jsonb, scheduling_policy.defaults), updated_at = now()
       RETURNING *`,
      [b.minRestHours, b.maxWeeklyHours, b.maxConsecutiveDays, b.maxDaysPerWeek, JSON.stringify(b.weights), p.name, b.adherenceGraceSeconds, JSON.stringify(b.timelineColors), b.scheduling ? JSON.stringify({ ...before.scheduling, ...b.scheduling }) : null]);
    const after = polDto(r);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULING_POLICY', entityId: p.tenantId, entityName: 'Scheduling policy', before, after });
    return after;
  });
  res.json(out);
});
