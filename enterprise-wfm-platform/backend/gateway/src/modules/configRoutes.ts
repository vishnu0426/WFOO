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
import { ensureMarked, hhmm, slotOf } from './workforceRoutes.ts';
import { cleanAliases, impactChanges } from './groupRules.ts';

export const config = Router();

const code = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'GROUP';
const CH = ['VOICE', 'CHAT', 'EMAIL', 'BACKOFFICE'] as const;

const GroupBody = z.object({
  name: z.string().min(1).max(80), code: z.string().min(1).max(30).optional(), description: z.string().max(500).optional(),
  timezone: z.string().min(1).max(60).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  serviceLevelGoal: z.number().gt(0).lt(100).optional(), serviceLevelThresholdSec: z.number().int().positive().max(600).optional(),
  targetOccupancy: z.number().gt(30).lte(100).optional(), shrinkagePercent: z.number().min(0).max(90).optional(),
  method: z.enum(['erlang_c', 'erlang_a']).optional(), patienceSec: z.number().int().min(10).max(3600).optional(),
  blended: z.boolean().optional(), model: z.enum(['auto', 'snaive', 'wavg', 'ets', 'gbm', 'combo', 'croston', 'sarima', 'arima']).optional(),
  fteHoursWeek: z.number().min(10).max(60).optional(),
  payWeekStart: z.number().int().min(0).max(6).nullable().optional(),   // null = use the company default
  siteId: z.string().uuid().nullable().optional(),                      // the site this group's people work at
  managerId: z.string().uuid().nullable().optional(),                   // who manages the group: gets what is escalated above the team supervisors
  reason: z.string().trim().max(300).optional(),                        // why, when the change moves staffing or pay numbers
  acknowledge: z.boolean().optional(),                                  // yes, switch it off although a published schedule is still running
});
const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const QueueBody = z.object({
  name: z.string().min(1).max(80), code: z.string().min(1).max(30).optional(), channel: z.enum(CH),
  wfmGroupId: z.string().uuid().nullable().optional(), ahtDefault: z.number().int().positive().max(7200).optional(),
  concurrency: z.number().min(1).max(10).optional(), openSlot: z.number().int().min(0).max(96).optional(), closeSlot: z.number().int().min(0).max(96).optional(),
  slaTargetSeconds: z.number().int().positive().optional(), slaTargetPercent: z.number().int().min(1).max(99).optional(),
  turnaroundHours: z.number().int().min(0).max(720).optional(),
  aliases: z.array(z.string().trim().min(1).max(80)).max(20).optional(),   // other names this queue has in the phone system or in files; an import row naming one lands here
  skillId: z.string().uuid().nullable().optional(),    // the skill this queue's contacts need; queues of one group with different skills are staffed skill by skill
  volumeBasis: z.enum(['OFFERED', 'ANSWERED']).optional(),   // whether history volume counts every call that arrived, or only the answered ones (abandoned callers are then added back)
  shapeFromQueueId: z.string().uuid().nullable().optional(),   // a new queue borrows this queue's pattern through the day until it has enough history of its own
  abandonRepeatPct: z.number().int().min(0).max(100).optional(),   // share of abandoned callers who ring again, so are already counted
});

export const groupDto = (g: any, queues: any[]) => ({
  id: g.id, tenantId: g.tenantId, name: g.name, code: g.code, description: g.description, timezone: g.timezone, status: g.status, siteId: g.siteId ?? null, managerId: g.managerId ?? null, managerName: g.managerName ?? null,
  queueIds: queues.map((q) => q.id), queueNames: queues.map((q) => q.name), channels: [...new Set(queues.map((q) => q.channel))], agentCount: 0,
  serviceLevelGoal: Math.round(g.serviceLevel * 100), serviceLevelThresholdSec: g.answerSec, targetOccupancy: Math.round(g.occupancyCap * 100),
  shrinkagePercent: Math.round(g.shrinkage * 100), method: g.method, patienceSec: g.patienceSec, blended: g.blended, model: g.model, fteHoursWeek: g.fteHoursWeek, payWeekStart: (g.payWeekStart ?? null) as number | null,
  createdAt: g.createdAt, updatedAt: g.updatedAt,
});
export const queueDto = (q: any) => ({
  id: q.id, name: q.name, code: q.code, channel: q.channel, wfmGroupId: q.wfmGroupId, slaTargetSeconds: q.slaTargetSeconds, slaTargetPercent: q.slaTargetPercent,
  ahtDefault: q.ahtDefault, concurrency: q.concurrency, openSlot: q.openSlot, closeSlot: q.closeSlot, turnaroundHours: q.turnaroundHours ?? null, skillId: q.skillId ?? null,
  volumeBasis: q.volumeBasis ?? 'OFFERED', abandonRepeatPct: q.abandonRepeatPct ?? 0, shapeFromQueueId: q.shapeFromQueueId ?? null, aliases: (q.aliases ?? []) as string[],
});

export async function loadGroups(tx: Tx, id?: string) {
  const groups = await tx.q<any>(`SELECT g.*, e.first_name || ' ' || e.last_name AS manager_name FROM wfm_groups g LEFT JOIN employees e ON e.id = g.manager_id WHERE g.tenant_id = :t ${id ? 'AND g.id = $1' : ''} ORDER BY g.name`, id ? [id] : []);
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

/** Names a new group or queue must not collide with, said in plain words instead of a database error. */
async function ensureFreeName(tx: Tx, table: 'wfm_groups' | 'queues', name: string, selfId: string | null, what: string) {
  const hit = await tx.one<{ name: string }>(`SELECT name FROM ${table} WHERE tenant_id = :t AND lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`, [name, selfId]);
  if (hit) throw conflict(`A ${what} named "${hit.name}" already exists. Choose another name.`);
}
async function ensureSite(tx: Tx, siteId: string | null | undefined) {
  if (siteId && !(await tx.one('SELECT 1 FROM sites WHERE tenant_id = :t AND id = $1', [siteId]))) throw bad('That site does not exist.');
}

config.post('/groups', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(GroupBody, req.body);
  if (b.timezone && !validZone(b.timezone)) throw bad(`'${b.timezone}' is not a time zone (for example Asia/Kolkata or Europe/London).`);
  const out = await withTenant(p.tenantId, async (tx) => {
    await ensureFreeName(tx, 'wfm_groups', b.name.trim(), null, 'WFM group');
    await ensureSite(tx, b.siteId);
    await ensureMarked(tx, b.managerId, 'is_manager', 'group manager');
    const tz = (await tx.one<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = :t'))?.timezone ?? 'UTC';
    const g = await tx.one<any>(
      `INSERT INTO wfm_groups (tenant_id, name, code, description, timezone, service_level, answer_sec, shrinkage, occupancy_cap, method, patience_sec, blended, model, fte_hours_week, pay_week_start, site_id, manager_id)
       VALUES (:t, $1, $2, $3, $4, coalesce($5, 80)/100.0, coalesce($6, 20), coalesce($7, 30)/100.0, coalesce($8, 85)/100.0, coalesce($9, 'erlang_c'), coalesce($10, 120), coalesce($11, false), coalesce($12, 'auto'), coalesce($13, 40), $14, $15::uuid, $16::uuid)
       RETURNING id`,
      [b.name.trim(), b.code ?? code(b.name), b.description ?? '', b.timezone ?? tz, b.serviceLevelGoal ?? null, b.serviceLevelThresholdSec ?? null, b.shrinkagePercent ?? null,
        b.targetOccupancy ?? null, b.method ?? null, b.patienceSec ?? null, b.blended ?? null, b.model ?? null, b.fteHoursWeek ?? null, b.payWeekStart ?? null, b.siteId ?? null, b.managerId ?? null]);
    const [dto] = await loadGroups(tx, g!.id);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'WFM_GROUP', entityId: g!.id, entityName: b.name, after: dto, reason: b.reason });
    return dto;
  });
  res.status(201).json(out);
});

config.put('/groups/:id', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(GroupBody.partial(), req.body), id = String(req.params.id);
  if (b.timezone && !validZone(b.timezone)) throw bad(`'${b.timezone}' is not a time zone (for example Asia/Kolkata or Europe/London).`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [before] = await loadGroups(tx, id);
    if (!before) throw notFound('WFM group');
    // a change that moves staffing numbers, weekly hour counts or what existing schedules mean needs a reason on record
    const moved = impactChanges(before, b as Record<string, unknown>);
    if (moved.length && (b.reason ?? '').length < 3) throw bad(`Say why you are changing the ${moved.join(', ')}: staffing numbers and weekly hours depend on it.`);
    if (b.name && b.name.trim().toLowerCase() !== before.name.toLowerCase()) await ensureFreeName(tx, 'wfm_groups', b.name.trim(), id, 'WFM group');
    if (b.siteId !== undefined) await ensureSite(tx, b.siteId);
    if (b.managerId !== undefined && b.managerId !== before.managerId) await ensureMarked(tx, b.managerId, 'is_manager', 'group manager');
    if (b.status === 'INACTIVE' && before.status !== 'INACTIVE' && !b.acknowledge) {
      const live = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND period_end >= current_date`, [id]);
      if (live && live.n > 0) throw conflict(`${before.name} still has ${live.n} published schedule${live.n === 1 ? '' : 's'} running now or in the future. Switching the group off keeps them but stops new forecasts and schedules; confirm to go on.`);
    }
    await tx.exec(
      `UPDATE wfm_groups SET name = coalesce($2, name), description = coalesce($3, description), timezone = coalesce($4, timezone), status = coalesce($5, status),
         service_level = coalesce($6::numeric / 100, service_level), answer_sec = coalesce($7, answer_sec), shrinkage = coalesce($8::numeric / 100, shrinkage),
         occupancy_cap = coalesce($9::numeric / 100, occupancy_cap), method = coalesce($10, method), patience_sec = coalesce($11, patience_sec),
         blended = coalesce($12, blended), model = coalesce($13, model), fte_hours_week = coalesce($14, fte_hours_week), pay_week_start = CASE WHEN $15::boolean THEN $16::smallint ELSE pay_week_start END,
         site_id = CASE WHEN $17::boolean THEN $18::uuid ELSE site_id END, manager_id = CASE WHEN $19::boolean THEN $20::uuid ELSE manager_id END, updated_at = now()
       WHERE tenant_id = :t AND id = $1`,
      [id, b.name?.trim() ?? null, b.description ?? null, b.timezone ?? null, b.status ?? null, b.serviceLevelGoal ?? null, b.serviceLevelThresholdSec ?? null, b.shrinkagePercent ?? null,
        b.targetOccupancy ?? null, b.method ?? null, b.patienceSec ?? null, b.blended ?? null, b.model ?? null, b.fteHoursWeek ?? null, 'payWeekStart' in b, b.payWeekStart ?? null,
        b.siteId !== undefined, b.siteId ?? null, b.managerId !== undefined, b.managerId ?? null]);
    const [after] = await loadGroups(tx, id);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: id, entityName: after.name, before, after, reason: b.reason || undefined, diffSummary: moved.length ? `Changed ${moved.join(', ')}` : undefined });
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
  await dropCache(p.tenantId, 'holdout:*');   // the history check reads queue settings
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

/** An alias may not already be the name, code or alias of another queue: an import row has to land on exactly one. */
export async function ensureFreeAliases(tx: Tx, aliases: string[], selfId: string | null) {
  if (!aliases.length) return;
  const low = aliases.map((a) => a.toLowerCase());
  const hit = await tx.one<{ name: string; alias: string }>(
    `SELECT q.name, a AS alias FROM queues q, LATERAL unnest(ARRAY[q.name, q.code] || q.aliases) AS a
     WHERE q.tenant_id = :t AND ($2::uuid IS NULL OR q.id <> $2) AND lower(a) = ANY($1::text[]) LIMIT 1`, [low, selfId]);
  if (hit) throw conflict(`"${hit.alias}" already belongs to the queue "${hit.name}". A file row has to match one queue only.`);
}

config.get('/queues', requires('config:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM queues WHERE tenant_id = :t ORDER BY name'))).map(queueDto));
});

config.post('/queues', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(QueueBody, req.body);
  if (b.openSlot !== undefined && b.closeSlot !== undefined && b.closeSlot <= b.openSlot) throw bad('closeSlot must be after openSlot');
  const out = await withTenant(p.tenantId, async (tx) => {
    await ensureFreeName(tx, 'queues', b.name.trim(), null, 'queue');
    const aliases = cleanAliases(b.aliases);
    await ensureFreeAliases(tx, [b.name.trim(), ...aliases], null);
    const q = await tx.one<any>(
      `INSERT INTO queues (tenant_id, wfm_group_id, name, code, channel, aht_default, concurrency, open_slot, close_slot, sla_target_seconds, sla_target_percent, turnaround_hours, skill_id, volume_basis, abandon_repeat_pct, aliases)
       VALUES (:t, $1::uuid, $2, $3, $4, coalesce($5::int, 300), coalesce($6::numeric, $7::numeric), coalesce($8::int, 0), coalesce($9::int, 96), coalesce($10::int, 20), coalesce($11::int, 80), $12::int, $13::uuid, coalesce($14::text, 'OFFERED'), coalesce($15::int, 0), $16::text[]) RETURNING *`,
      [b.wfmGroupId ?? null, b.name.trim(), b.code ?? code(b.name), b.channel, b.ahtDefault ?? null, b.concurrency ?? null, b.channel === 'CHAT' ? 2 : 1,
        b.openSlot ?? null, b.closeSlot ?? null, b.slaTargetSeconds ?? null, b.slaTargetPercent ?? null, b.turnaroundHours ?? null, b.skillId ?? null, b.volumeBasis ?? null, b.abandonRepeatPct ?? null, aliases]);
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
    if (b.name && b.name.trim().toLowerCase() !== before.name.toLowerCase()) { await ensureFreeName(tx, 'queues', b.name.trim(), id, 'queue'); await ensureFreeAliases(tx, [b.name.trim()], id); }
    const aliases = b.aliases === undefined ? null : cleanAliases(b.aliases);
    if (aliases) await ensureFreeAliases(tx, aliases, id);
    if (b.shapeFromQueueId) {
      if (b.shapeFromQueueId === id) throw bad('A queue cannot borrow its own pattern.');
      const donor = await tx.one<any>('SELECT name, channel, shape_from_queue_id FROM queues WHERE tenant_id = :t AND id = $1', [b.shapeFromQueueId]);
      if (!donor) throw notFound('The queue to borrow from');
      if (donor.shapeFromQueueId) throw bad(`${donor.name} borrows its pattern from another queue, so it cannot be the one borrowed from. Pick a queue with its own history.`);
      if (await tx.one('SELECT 1 FROM queues WHERE tenant_id = :t AND shape_from_queue_id = $1 LIMIT 1', [id])) throw bad('Another queue borrows from this one, so this one cannot borrow as well.');
      if (donor.channel !== before.channel) throw bad(`${donor.name} is a ${String(donor.channel).toLowerCase()} queue and this is a ${String(before.channel).toLowerCase()} queue; a day's pattern differs by channel. Pick a queue of the same channel.`);
    }
    const q = await tx.one<any>(
      `UPDATE queues SET aliases = coalesce($17::text[], aliases), name = coalesce($2, name), channel = coalesce($3, channel), wfm_group_id = CASE WHEN $4::boolean THEN $5::uuid ELSE wfm_group_id END,
         aht_default = coalesce($6, aht_default), concurrency = coalesce($7, concurrency), open_slot = coalesce($8, open_slot), close_slot = coalesce($9, close_slot),
         sla_target_seconds = coalesce($10, sla_target_seconds), sla_target_percent = coalesce($11, sla_target_percent), turnaround_hours = coalesce($12::int, turnaround_hours), skill_id = CASE WHEN $13::boolean THEN $14::uuid ELSE skill_id END,
         volume_basis = coalesce($15::text, volume_basis), abandon_repeat_pct = coalesce($16::int, abandon_repeat_pct),
         shape_from_queue_id = CASE WHEN $18::boolean THEN $19::uuid ELSE shape_from_queue_id END
       WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name ?? null, b.channel ?? null, b.wfmGroupId !== undefined, b.wfmGroupId ?? null, b.ahtDefault ?? null, b.concurrency ?? null, b.openSlot ?? null, b.closeSlot ?? null,
        b.slaTargetSeconds ?? null, b.slaTargetPercent ?? null, b.turnaroundHours ?? null, b.skillId !== undefined, b.skillId ?? null, b.volumeBasis ?? null, b.abandonRepeatPct ?? null, aliases,
        b.shapeFromQueueId !== undefined, b.shapeFromQueueId ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'QUEUE', entityId: id, entityName: q!.name, before: queueDto(before), after: queueDto(q) });
    return queueDto(q);
  });
  await dropCache(p.tenantId, 'fv:*');
  await dropCache(p.tenantId, 'holdout:*');   // the history check reads queue settings
  res.json(out);
});

config.delete('/queues/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = String(req.params.id), force = req.query.force === 'true';
  await withTenant(p.tenantId, async (tx) => {
    const q = await tx.one<any>('SELECT * FROM queues WHERE tenant_id = :t AND id = $1', [id]);
    if (!q) throw notFound('Queue');
    const [{ n }] = await tx.q<{ n: number }>('SELECT coalesce(sum(intervals), 0)::int AS n FROM interval_daily WHERE tenant_id = :t AND queue_id = $1', [id]);
    if (n > 0 && !force) throw conflict(`This queue has ${n.toLocaleString()} intervals of history. Deleting it deletes that history too; repeat with ?force=true to confirm.`);
    await tx.exec('DELETE FROM queues WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'QUEUE', entityId: id, entityName: q.name, before: queueDto(q), diffSummary: `${n} history intervals removed` });
  });
  res.json({ ok: true });
});
