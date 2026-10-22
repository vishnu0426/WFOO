/**
 * Configuration: WFM groups (queues that share one pool of agents, with their service targets) and queues.
 * JSON matches the front-end types (percentages as whole numbers, e.g. serviceLevelGoal = 80).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, notFound, parse, conflict } from '../http.ts';
import { dropCache } from '../infra.ts';
import { hhmm, slotOf } from './workforceRoutes.ts';

export const config = Router();

const code = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'GROUP';
const CH = ['VOICE', 'CHAT', 'EMAIL', 'BACKOFFICE'] as const;

const GroupBody = z.object({
  name: z.string().min(1).max(80), code: z.string().min(1).max(30).optional(), description: z.string().max(500).optional(),
  timezone: z.string().min(1).max(60).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  serviceLevelGoal: z.number().gt(0).lt(100).optional(), serviceLevelThresholdSec: z.number().int().positive().max(600).optional(),
  targetOccupancy: z.number().gt(30).lte(100).optional(), shrinkagePercent: z.number().min(0).max(90).optional(),
  method: z.enum(['erlang_c', 'erlang_a']).optional(), patienceSec: z.number().int().min(10).max(3600).optional(),
  blended: z.boolean().optional(), model: z.enum(['auto', 'snaive', 'wavg', 'ets', 'gbm', 'combo', 'croston']).optional(),
  fteHoursWeek: z.number().min(10).max(60).optional(),
});
const QueueBody = z.object({
  name: z.string().min(1).max(80), code: z.string().min(1).max(30).optional(), channel: z.enum(CH),
  wfmGroupId: z.string().uuid().nullable().optional(), ahtDefault: z.number().int().positive().max(7200).optional(),
  concurrency: z.number().min(1).max(10).optional(), openSlot: z.number().int().min(0).max(96).optional(), closeSlot: z.number().int().min(0).max(96).optional(),
  slaTargetSeconds: z.number().int().positive().optional(), slaTargetPercent: z.number().int().min(1).max(99).optional(),
  turnaroundHours: z.number().int().min(0).max(720).optional(),
});

export const groupDto = (g: any, queues: any[]) => ({
  id: g.id, tenantId: g.tenantId, name: g.name, code: g.code, description: g.description, timezone: g.timezone, status: g.status, siteId: g.siteId ?? null,
  queueIds: queues.map((q) => q.id), queueNames: queues.map((q) => q.name), channels: [...new Set(queues.map((q) => q.channel))], agentCount: 0,
  serviceLevelGoal: Math.round(g.serviceLevel * 100), serviceLevelThresholdSec: g.answerSec, targetOccupancy: Math.round(g.occupancyCap * 100),
  shrinkagePercent: Math.round(g.shrinkage * 100), method: g.method, patienceSec: g.patienceSec, blended: g.blended, model: g.model, fteHoursWeek: g.fteHoursWeek,
  createdAt: g.createdAt, updatedAt: g.updatedAt,
});
export const queueDto = (q: any) => ({
  id: q.id, name: q.name, code: q.code, channel: q.channel, wfmGroupId: q.wfmGroupId, slaTargetSeconds: q.slaTargetSeconds, slaTargetPercent: q.slaTargetPercent,
  ahtDefault: q.ahtDefault, concurrency: q.concurrency, openSlot: q.openSlot, closeSlot: q.closeSlot, turnaroundHours: q.turnaroundHours ?? null,
});

export async function loadGroups(tx: Tx, id?: string) {
  const groups = await tx.q<any>(`SELECT * FROM wfm_groups WHERE tenant_id = :t ${id ? 'AND id = $1' : ''} ORDER BY name`, id ? [id] : []);
  const queues = await tx.q<any>('SELECT * FROM queues WHERE tenant_id = :t ORDER BY name');
  return groups.map((g) => groupDto(g, queues.filter((q) => q.wfmGroupId === g.id)));
}

config.get('/groups', requires('config:read'), async (req, res) => {
  res.json(await withTenant(me(req).tenantId, (tx) => loadGroups(tx)));
});
config.get('/groups/:id', requires('config:read'), async (req, res) => {
  const [g] = await withTenant(me(req).tenantId, (tx) => loadGroups(tx, String(req.params.id)));
  if (!g) throw notFound('WFM group');
  res.json(g);
});

config.post('/groups', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(GroupBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const tz = (await tx.one<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = :t'))?.timezone ?? 'UTC';
    const g = await tx.one<any>(
      `INSERT INTO wfm_groups (tenant_id, name, code, description, timezone, service_level, answer_sec, shrinkage, occupancy_cap, method, patience_sec, blended, model, fte_hours_week)
       VALUES (:t, $1, $2, $3, $4, coalesce($5, 80)/100.0, coalesce($6, 20), coalesce($7, 30)/100.0, coalesce($8, 85)/100.0, coalesce($9, 'erlang_c'), coalesce($10, 120), coalesce($11, false), coalesce($12, 'auto'), coalesce($13, 40))
       RETURNING id`,
      [b.name, b.code ?? code(b.name), b.description ?? '', b.timezone ?? tz, b.serviceLevelGoal ?? null, b.serviceLevelThresholdSec ?? null, b.shrinkagePercent ?? null,
        b.targetOccupancy ?? null, b.method ?? null, b.patienceSec ?? null, b.blended ?? null, b.model ?? null, b.fteHoursWeek ?? null]);
    const [dto] = await loadGroups(tx, g!.id);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'WFM_GROUP', entityId: g!.id, entityName: b.name, after: dto });
    return dto;
  });
  res.status(201).json(out);
});

config.put('/groups/:id', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(GroupBody.partial(), req.body), id = String(req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [before] = await loadGroups(tx, id);
    if (!before) throw notFound('WFM group');
    await tx.exec(
      `UPDATE wfm_groups SET name = coalesce($2, name), description = coalesce($3, description), timezone = coalesce($4, timezone), status = coalesce($5, status),
         service_level = coalesce($6::numeric / 100, service_level), answer_sec = coalesce($7, answer_sec), shrinkage = coalesce($8::numeric / 100, shrinkage),
         occupancy_cap = coalesce($9::numeric / 100, occupancy_cap), method = coalesce($10, method), patience_sec = coalesce($11, patience_sec),
         blended = coalesce($12, blended), model = coalesce($13, model), fte_hours_week = coalesce($14, fte_hours_week), updated_at = now()
       WHERE tenant_id = :t AND id = $1`,
      [id, b.name ?? null, b.description ?? null, b.timezone ?? null, b.status ?? null, b.serviceLevelGoal ?? null, b.serviceLevelThresholdSec ?? null, b.shrinkagePercent ?? null,
        b.targetOccupancy ?? null, b.method ?? null, b.patienceSec ?? null, b.blended ?? null, b.model ?? null, b.fteHoursWeek ?? null]);
    const [after] = await loadGroups(tx, id);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: id, entityName: after.name, before, after });
    return after;
  });
  await dropCache(p.tenantId, 'fv:*'); // staffing depends on the group's targets
  res.json(out);
});

// ---------------------------------------------------------------- shrinkage categories (breaks, training, absence, ...)

const ShrinkageCategoryBody = z.object({ name: z.string().min(1).max(60), pct: z.number().min(0).max(90) });
const shrinkageCategoryDto = (c: any) => ({ id: c.id, name: c.name, pct: +c.pct, sort: c.sort });

async function shrinkageTotal(tx: Tx, groupId: string, excludeId?: string): Promise<number> {
  const rows = await tx.q<{ id: string; pct: number }>('SELECT id, pct::float8 AS pct FROM shrinkage_categories WHERE tenant_id = :t AND wfm_group_id = $1', [groupId]);
  return rows.filter((r) => r.id !== excludeId).reduce((s, r) => s + r.pct, 0);
}

config.get('/groups/:id/shrinkage-categories', requires('config:read'), async (req, res) => {
  const id = String(req.params.id);
  res.json(await withTenant(me(req).tenantId, async (tx) => {
    const [g] = await loadGroups(tx, id); if (!g) throw notFound('WFM group');
    return (await tx.q<any>('SELECT * FROM shrinkage_categories WHERE tenant_id = :t AND wfm_group_id = $1 ORDER BY sort, name', [id])).map(shrinkageCategoryDto);
  }));
});
config.post('/groups/:id/shrinkage-categories', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), b = parse(ShrinkageCategoryBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [g] = await loadGroups(tx, id); if (!g) throw notFound('WFM group');
    const total = await shrinkageTotal(tx, id);
    if (total + b.pct > 90) throw bad(`Categories would total ${Math.round(total + b.pct)}% -- the same 90% cap as the flat shrinkage field applies to the sum.`);
    const sort = (await tx.one<{ n: number }>('SELECT coalesce(max(sort), -1) + 1 AS n FROM shrinkage_categories WHERE tenant_id = :t AND wfm_group_id = $1', [id]))!.n;
    const c = await tx.one<any>('INSERT INTO shrinkage_categories (tenant_id, wfm_group_id, name, pct, sort) VALUES (:t, $1, $2, $3, $4) RETURNING *', [id, b.name, b.pct, sort]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SHRINKAGE_CATEGORY', entityId: c!.id, entityName: b.name, after: b });
    return shrinkageCategoryDto(c);
  });
  await dropCache(p.tenantId, 'fv:*'); // staffing depends on effective shrinkage
  res.status(201).json(out);
});
config.put('/groups/:id/shrinkage-categories/:catId', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), catId = String(req.params.catId), b = parse(ShrinkageCategoryBody.partial(), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM shrinkage_categories WHERE tenant_id = :t AND id = $1 AND wfm_group_id = $2', [catId, id]);
    if (!before) throw notFound('Shrinkage category');
    if (b.pct !== undefined) {
      const total = await shrinkageTotal(tx, id, catId);
      if (total + b.pct > 90) throw bad(`Categories would total ${Math.round(total + b.pct)}% -- the same 90% cap as the flat shrinkage field applies to the sum.`);
    }
    const c = await tx.one<any>('UPDATE shrinkage_categories SET name = coalesce($3, name), pct = coalesce($4, pct) WHERE tenant_id = :t AND id = $1 AND wfm_group_id = $2 RETURNING *', [catId, id, b.name ?? null, b.pct ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SHRINKAGE_CATEGORY', entityId: catId, entityName: c.name, before, after: c });
    return shrinkageCategoryDto(c);
  });
  await dropCache(p.tenantId, 'fv:*');
  res.json(out);
});
config.delete('/groups/:id/shrinkage-categories/:catId', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), catId = String(req.params.catId);
  await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM shrinkage_categories WHERE tenant_id = :t AND id = $1 AND wfm_group_id = $2', [catId, id]);
    if (!before) throw notFound('Shrinkage category');
    await tx.exec('DELETE FROM shrinkage_categories WHERE tenant_id = :t AND id = $1', [catId]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'SHRINKAGE_CATEGORY', entityId: catId, entityName: before.name, before });
  });
  await dropCache(p.tenantId, 'fv:*');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- manual coverage windows (schedule generation without a forecast)

const CoverageWindowBody = z.object({ dayOfWeek: z.number().int().min(0).max(6), startTime: z.string(), endTime: z.string(), headcount: z.number().int().min(0).max(500) });
const coverageWindowDto = (w: any) => ({ id: w.id, dayOfWeek: w.dayOfWeek, startTime: hhmm(w.startSlot), endTime: w.endSlot >= 96 ? '24:00' : hhmm(w.endSlot), headcount: w.headcount });

config.get('/groups/:id/coverage-windows', requires('config:read'), async (req, res) => {
  const id = String(req.params.id);
  res.json(await withTenant(me(req).tenantId, async (tx) => {
    const [g] = await loadGroups(tx, id); if (!g) throw notFound('WFM group');
    return (await tx.q<any>('SELECT * FROM coverage_windows WHERE tenant_id = :t AND wfm_group_id = $1 ORDER BY day_of_week, start_slot', [id])).map(coverageWindowDto);
  }));
});
config.post('/groups/:id/coverage-windows', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), b = parse(CoverageWindowBody, req.body);
  const startSlot = slotOf(b.startTime), endSlot = b.endTime === '24:00' ? 96 : slotOf(b.endTime);
  if (Number.isNaN(startSlot) || Number.isNaN(endSlot) || endSlot <= startSlot) throw bad(`Window ${b.startTime}-${b.endTime}: the end must be after the start (HH:MM)`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [g] = await loadGroups(tx, id); if (!g) throw notFound('WFM group');
    const w = await tx.one<any>('INSERT INTO coverage_windows (tenant_id, wfm_group_id, day_of_week, start_slot, end_slot, headcount) VALUES (:t, $1, $2, $3, $4, $5) RETURNING *',
      [id, b.dayOfWeek, startSlot, endSlot, b.headcount]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'COVERAGE_WINDOW', entityId: w!.id, entityName: `${g.name}: ${b.startTime}-${b.endTime}`, after: b });
    return coverageWindowDto(w);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.status(201).json(out);
});
config.delete('/groups/:id/coverage-windows/:windowId', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), windowId = String(req.params.windowId);
  await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM coverage_windows WHERE tenant_id = :t AND id = $1 AND wfm_group_id = $2', [windowId, id]);
    if (!before) throw notFound('Coverage window');
    await tx.exec('DELETE FROM coverage_windows WHERE tenant_id = :t AND id = $1', [windowId]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'COVERAGE_WINDOW', entityId: windowId, entityName: `${hhmm(before.startSlot)}-${before.endSlot >= 96 ? '24:00' : hhmm(before.endSlot)}`, before: coverageWindowDto(before) });
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- queues

config.get('/queues', requires('config:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM queues WHERE tenant_id = :t ORDER BY name'))).map(queueDto));
});

config.post('/queues', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(QueueBody, req.body);
  if (b.openSlot !== undefined && b.closeSlot !== undefined && b.closeSlot <= b.openSlot) throw bad('closeSlot must be after openSlot');
  const out = await withTenant(p.tenantId, async (tx) => {
    const q = await tx.one<any>(
      `INSERT INTO queues (tenant_id, wfm_group_id, name, code, channel, aht_default, concurrency, open_slot, close_slot, sla_target_seconds, sla_target_percent, turnaround_hours)
       VALUES (:t, $1::uuid, $2, $3, $4, coalesce($5::int, 300), coalesce($6::numeric, $7::numeric), coalesce($8::int, 0), coalesce($9::int, 96), coalesce($10::int, 20), coalesce($11::int, 80), $12::int) RETURNING *`,
      [b.wfmGroupId ?? null, b.name, b.code ?? code(b.name), b.channel, b.ahtDefault ?? null, b.concurrency ?? null, b.channel === 'CHAT' ? 2 : 1,
        b.openSlot ?? null, b.closeSlot ?? null, b.slaTargetSeconds ?? null, b.slaTargetPercent ?? null, b.turnaroundHours ?? null]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'QUEUE', entityId: q!.id, entityName: b.name, after: queueDto(q) });
    return queueDto(q);
  });
  res.status(201).json(out);
});

config.put('/queues/:id', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(QueueBody.partial(), req.body), id = String(req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM queues WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Queue');
    const q = await tx.one<any>(
      `UPDATE queues SET name = coalesce($2, name), channel = coalesce($3, channel), wfm_group_id = CASE WHEN $4::boolean THEN $5::uuid ELSE wfm_group_id END,
         aht_default = coalesce($6, aht_default), concurrency = coalesce($7, concurrency), open_slot = coalesce($8, open_slot), close_slot = coalesce($9, close_slot),
         sla_target_seconds = coalesce($10, sla_target_seconds), sla_target_percent = coalesce($11, sla_target_percent), turnaround_hours = coalesce($12::int, turnaround_hours)
       WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name ?? null, b.channel ?? null, b.wfmGroupId !== undefined, b.wfmGroupId ?? null, b.ahtDefault ?? null, b.concurrency ?? null, b.openSlot ?? null, b.closeSlot ?? null,
        b.slaTargetSeconds ?? null, b.slaTargetPercent ?? null, b.turnaroundHours ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'QUEUE', entityId: id, entityName: q!.name, before: queueDto(before), after: queueDto(q) });
    return queueDto(q);
  });
  await dropCache(p.tenantId, 'fv:*');
  res.json(out);
});

config.delete('/queues/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), force = req.query.force === 'true';
  await withTenant(p.tenantId, async (tx) => {
    const q = await tx.one<any>('SELECT * FROM queues WHERE tenant_id = :t AND id = $1', [id]);
    if (!q) throw notFound('Queue');
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM interval_history WHERE tenant_id = :t AND queue_id = $1', [id]);
    if (n > 0 && !force) throw conflict(`This queue has ${n.toLocaleString()} intervals of history. Deleting it deletes that history too; repeat with ?force=true to confirm.`);
    await tx.exec('DELETE FROM queues WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'QUEUE', entityId: id, entityName: q.name, before: queueDto(q), diffSummary: `${n} history intervals removed` });
  });
  res.json({ ok: true });
});
