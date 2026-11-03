import { createHash } from 'node:crypto';
import { checkTarget, OutboundBlocked } from '../../netGuard.ts';
/**
 * Integration Station: connector CRUD (admin, authenticated) plus the ingest endpoints a relay-family script or a
 * webhook-sending vendor calls (public, authenticated by the connector's own key/secret instead of a user session --
 * an on-prem script or Salesforce itself has no user login here).
 *
 * Every connector's raw vendor rows pass through the mapping layer (`mapping.ts`) before reaching the same paths
 * the rest of the platform already uses: `stageImport` for a historical backfill (review before commit, exactly
 * like a manual CSV upload), `ingestLive` for the live interval feed, `ingestAgentEvents` for RTA state, or a
 * direct employee upsert for HRMS. Nothing here bypasses the review a human's own import already goes through.
 */
import { CONFIG_SECRET_KEYS, encrypt, lockFields, open } from '../../secrets.ts';
import { Router } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkPassword, hashPassword } from '../../passwordHash.ts';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../../db.ts';
import { me, requires, type Principal } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { HttpError, bad, conflict, notFound, parse } from '../../http.ts';
import { stageImport, Upload as StageUpload } from '../ingestionRoutes.ts';
import { ingestLive, LiveRows } from '../ingestionRoutes.ts';
import { ingestAgentEvents } from '../intradayRoutes.ts';
import { PRESETS, presetById, presetsByCategory, configSchemaFor, type Category } from './presets.ts';
import { mapFields, suggestEntityMatches, type FieldMap } from './mapping.ts';
import { startSubscription, stopSubscription } from './natsSubscriber.ts';
import { applyLiveRows, loadFieldMaps, pullSupport, recordRun, runConnector, stageBackfillRows, summariseLive, testDatabaseQuery } from './runner.ts';
import { checkPresetConfig } from './pullRules.ts';
import { checkSchedule, firstRunAt, type Schedule } from './schedule.ts';
import { openFields } from '../../secrets.ts';

export const integrationsAdmin = Router();
export const integrationsPublic = Router();
const uuid = z.string().uuid();

const connectorDto = (c: any, memberCount?: number) => ({
  id: c.id, wfmGroupId: c.wfmGroupId, category: c.category, method: c.method, preset: c.preset, name: c.name, status: c.status,
  config: redactConfig(c.config), lastReceivedAt: c.lastReceivedAt, lastError: c.lastError, lastSample: c.lastSample ?? null, connectedAt: c.connectedAt ?? null,
  backfillStatus: c.backfillStatus, backfillThrough: c.backfillThrough, hasWebhookSecret: !!c.webhookSecret, createdBy: c.createdBy, createdAt: c.createdAt,
  scheduleMin: c.scheduleMin ?? null, scheduleAt: c.scheduleAt ?? null, scheduleDays: c.scheduleDays ?? null, nextRunAt: c.nextRunAt ?? null, ...pullSupport(presetById(c.preset), c.config ?? {}),
});
/** Secrets go into `config` (client secrets, DB creds where present) but never come back out once saved. */
function redactConfig(config: Record<string, any>) {
  const SECRET_KEYS = CONFIG_SECRET_KEYS;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config ?? {})) out[k] = SECRET_KEYS.includes(k) && v ? '••••••••' : v;
  return out;
}

// ---------------------------------------------------------------- catalogue

integrationsAdmin.get('/catalog', requires('config:read'), async (_req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=600');   // defined by the code, changes only with a release
  const byCategory: Record<string, unknown> = {};
  for (const cat of ['ACD', 'CRM', 'HRMS', 'DATABASE', 'ONPREM', 'SFTP'] as Category[]) {
    byCategory[cat] = presetsByCategory(cat).map((p) => ({ id: p.id, label: p.label, method: p.method, authType: p.authType, fields: p.fields, note: p.note ?? null, writesTo: p.writesTo, canPull: pullSupport(p, {}).canPull }));
  }
  res.json(byCategory);
});

// ---------------------------------------------------------------- CRUD

integrationsAdmin.get('/', requires('config:read'), async (req, res) => {
  const p = me(req), groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT *, backfill_through::text AS backfill_through FROM integration_connectors WHERE tenant_id = :t AND ($1::uuid IS NULL OR wfm_group_id = $1 OR wfm_group_id IS NULL) ORDER BY name`, [groupId]));
  res.json(rows.map((r) => connectorDto(r)));
});

integrationsAdmin.get('/:id', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const c = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT *, backfill_through::text AS backfill_through FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]));
  if (!c) throw notFound('Connector');
  res.json(connectorDto(c));
});


const ScheduleFields = {
  scheduleMin: z.number().int().min(5).max(1440).nullable().optional(),
  scheduleAt: z.string().regex(/^\d{2}:\d{2}$/, 'The time must look like 02:00').nullable().optional(),
  scheduleDays: z.array(z.number().int().min(1).max(7)).max(7).nullable().optional(),
};
/** The whole schedule is sent together: an interval (scheduleMin) or a daily time (scheduleAt), and optionally weekdays. scheduleMin: null clears it. */
function scheduleFromBody(b: { scheduleMin?: number | null; scheduleAt?: string | null; scheduleDays?: number[] | null }): { touched: boolean; schedule: Schedule | null } {
  if (b.scheduleMin === undefined && b.scheduleAt === undefined && b.scheduleDays === undefined) return { touched: false, schedule: null };
  const at = b.scheduleAt ?? null;
  const everyMin = at ? 1440 : b.scheduleMin ?? null;
  if (everyMin === null) return { touched: true, schedule: null };
  const schedule: Schedule = { everyMin, at, days: b.scheduleDays && b.scheduleDays.length < 7 ? [...new Set(b.scheduleDays)].sort((x, y) => x - y) : null };
  const err = checkSchedule(schedule);
  if (err) throw bad(err);
  return { touched: true, schedule };
}
const tzOf = (tx: Tx) => tx.one<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = :t').then((r) => r?.timezone ?? 'UTC');

const CreateBody = z.object({
  category: z.enum(['ACD', 'CRM', 'HRMS', 'DATABASE', 'ONPREM', 'SFTP']), preset: z.string().min(1), name: z.string().trim().min(1).max(100),
  wfmGroupId: uuid.nullable().optional(), config: z.record(z.string(), z.string()).default({}), ...ScheduleFields,
});

integrationsAdmin.post('/', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(CreateBody, req.body);
  const preset = presetById(b.preset);
  if (!preset || preset.category !== b.category) throw bad(`Unknown preset '${b.preset}' for category ${b.category}`);
  parse(configSchemaFor(preset), b.config); // a readable 400 naming the missing required field, not a raw zod error
  try { checkPresetConfig(preset, b.config); } catch (e: any) { throw bad(e.message); }
  await checkConnectorTargets(b.config);

  // Every connector gets an API key, not just the relay family: for API_PULL/STREAM_SUBSCRIBE presets it is what a
  // manual test push (or, once a real vendor account exists, a scheduled poll job) authenticates the /backfill and
  // /live calls with -- the same two ingest endpoints a relay script uses, just called by us instead of them.
  const webhookSecret = preset.method === 'WEBHOOK' ? randomBytes(32).toString('hex') : null;
  const apiKey = preset.method === 'WEBHOOK' ? null : randomBytes(24).toString('base64url');

  const out = await withTenant(p.tenantId, async (tx) => {
    const c = await tx.one<any>(
      `INSERT INTO integration_connectors (tenant_id, wfm_group_id, category, method, preset, name, config, api_key_hash, webhook_secret, created_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, backfill_through::text AS backfill_through`,
      [b.wfmGroupId ?? null, b.category, preset.method, preset.id, b.name, JSON.stringify(lockFields(b.config, CONFIG_SECRET_KEYS)), apiKey ? await hashPassword(apiKey, 10) : null, webhookSecret ? encrypt(webhookSecret) : null, p.name]);
    const sched = scheduleFromBody(b);
    if (sched.schedule) {
      if (!pullSupport(preset, b.config).canPull) throw bad('This connector is not pulled by the server, so it cannot be scheduled. The source sends its data to us.');
      await tx.exec('UPDATE integration_connectors SET schedule_min = $2, schedule_at = $3, schedule_days = $4::smallint[], next_run_at = $5 WHERE tenant_id = :t AND id = $1',
        [c!.id, sched.schedule.everyMin, sched.schedule.at, sched.schedule.days, firstRunAt(sched.schedule, new Date(), await tzOf(tx))]);
      Object.assign(c!, { scheduleMin: sched.schedule.everyMin, scheduleAt: sched.schedule.at, scheduleDays: sched.schedule.days });
    }
    if (preset.defaultMaps?.length) await tx.exec(
      'INSERT INTO integration_field_maps (tenant_id, connector_id, target_field, source_path, transform) SELECT :t, $1, x.f, x.s, x.tr FROM unnest($2::text[], $3::text[], $4::text[]) AS x(f, s, tr)',
      [c!.id, preset.defaultMaps.map((m) => m.targetField), preset.defaultMaps.map((m) => m.sourcePath), preset.defaultMaps.map((m) => m.transform ?? '')]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'INTEGRATION_CONNECTOR', entityId: c!.id, entityName: b.name, after: { category: b.category, preset: preset.id } });
    return c;
  });
  res.status(201).json({ ...connectorDto(out), apiKey, webhookSecret, webhookUrl: webhookSecret ? `/api/v1/integrations/${out.id}/webhook` : null });
});

integrationsAdmin.put('/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ERROR']).optional(), config: z.record(z.string(), z.string()).optional(), ...ScheduleFields }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Connector');
    if (b.config) { parse(configSchemaFor(presetById(before.preset)!), b.config); try { checkPresetConfig(presetById(before.preset)!, b.config); } catch (e: any) { throw bad(e.message); } await checkConnectorTargets(b.config); }
    const sched = scheduleFromBody(b);
    if (sched.schedule && !pullSupport(presetById(before.preset), b.config ?? before.config ?? {}).canPull) throw bad('This connector is not pulled by the server, so it cannot be scheduled. The source sends its data to us.');
    const nextRun = sched.schedule ? firstRunAt(sched.schedule, new Date(), await tzOf(tx)) : null;
    const c = await tx.one<any>(
      `UPDATE integration_connectors SET name = coalesce($2, name), status = coalesce($3, status), config = coalesce($4, config), updated_at = now(),
         schedule_min = CASE WHEN $5 THEN $6::int ELSE schedule_min END, schedule_at = CASE WHEN $5 THEN $7 ELSE schedule_at END,
         schedule_days = CASE WHEN $5 THEN $8::smallint[] ELSE schedule_days END, next_run_at = CASE WHEN $5 THEN $9::timestamptz ELSE next_run_at END
       WHERE tenant_id = :t AND id = $1 RETURNING *, backfill_through::text AS backfill_through`,
      [id, b.name ?? null, b.status ?? null, b.config ? JSON.stringify(lockFields(b.config, CONFIG_SECRET_KEYS)) : null, sched.touched, sched.schedule?.everyMin ?? null, sched.schedule?.at ?? null, sched.schedule?.days ?? null, nextRun]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'INTEGRATION_CONNECTOR', entityId: id, entityName: c!.name, before: { status: before.status }, after: { status: c!.status } });
    return c;
  });
  if (out!.status === 'ACTIVE') await startSubscription(out); else await stopSubscription(id);
  res.json(connectorDto(out));
});

integrationsAdmin.delete('/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const c = await tx.one<any>('DELETE FROM integration_connectors WHERE tenant_id = :t AND id = $1 RETURNING id, name', [id]);
    if (!c) throw notFound('Connector');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'INTEGRATION_CONNECTOR', entityId: id, entityName: c.name });
  });
  await stopSubscription(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- run now, run history

/** Pulls from the source right now (a REST endpoint or an SFTP folder) and returns what happened. The result is also in the run history. */
integrationsAdmin.post('/:id/run', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const c = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT * FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]));
  if (!c) throw notFound('Connector');
  if (c.status === 'DRAFT') throw bad('Set the connector to Active before running it.');
  const mode = parse(z.object({ mode: z.enum(['incremental', 'backfill']).optional() }), req.body ?? {}).mode;
  const out = await runConnector(c, 'MANUAL', { backfill: mode === 'backfill' });
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'IMPORT', entityType: 'INTEGRATION_CONNECTOR', entityId: id, entityName: c.name, diffSummary: `${out.status}: ${out.message}` }));
  res.json(out);
});

/** Runs the connector's query for the last two days and shows what came back, without saving anything. */
integrationsAdmin.post('/:id/test-pull', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const c = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT * FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]));
  if (!c) throw notFound('Connector');
  if (c.preset !== 'DATABASE_POSTGRES_PULL') throw bad('Only a database connector has a query to test.');
  try { res.json(await testDatabaseQuery(c, openFields(c.config, CONFIG_SECRET_KEYS))); }
  catch (e: any) { throw bad(e.message); }
});

integrationsAdmin.get('/:id/runs', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  res.json(await withTenant(p.tenantId, async (tx) => ({
    runs: await tx.q<any>(`SELECT started_at, finished_at, trigger, kind, status, rows_in, rows_ok, rows_rejected, message FROM integration_runs WHERE tenant_id = :t AND connector_id = $1 ORDER BY started_at DESC LIMIT 30`, [id]),
    files: await tx.q<any>(`SELECT file_name, file_size, status, import_job_id, message, seen_at FROM integration_files WHERE tenant_id = :t AND connector_id = $1 ORDER BY seen_at DESC LIMIT 20`, [id]),
  })));
});

// ---------------------------------------------------------------- field maps

integrationsAdmin.get('/:id/field-maps', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  res.json(await withTenant(p.tenantId, (tx) => tx.q<any>('SELECT target_field, source_path, transform FROM integration_field_maps WHERE tenant_id = :t AND connector_id = $1 ORDER BY target_field', [id])));
});

integrationsAdmin.put('/:id/field-maps', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const maps = parse(z.array(z.object({ targetField: z.string().min(1), sourcePath: z.string().min(1), transform: z.string().nullable().optional() })).max(100), req.body);
  await withTenant(p.tenantId, async (tx) => {
    const c = await tx.one<any>('SELECT name FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!c) throw notFound('Connector');
    await tx.exec('DELETE FROM integration_field_maps WHERE tenant_id = :t AND connector_id = $1', [id]);
    if (maps.length) await tx.exec(
      'INSERT INTO integration_field_maps (tenant_id, connector_id, target_field, source_path, transform) SELECT :t, $1, x.f, x.s, x.tr FROM unnest($2::text[], $3::text[], $4::text[]) AS x(f, s, tr)',
      [id, maps.map((m) => m.targetField), maps.map((m) => m.sourcePath), maps.map((m) => m.transform ?? '')]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'INTEGRATION_CONNECTOR', entityId: id, entityName: c.name, diffSummary: `Field map set: ${maps.length} fields` });
  });
  res.json({ ok: true });
});

/** Dry run: the exact same mapping + resolution logic live ingest uses (natsSubscriber.ts's handleOne), against the
 * connector's last real sample, but entirely read-only -- no ingest, no write to integration_event_rules (a PENDING
 * rule is only ever created by a REAL message, never by testing one), no entity-match writes. Lets an admin see
 * whether a field map is right before it's saved and starts governing live traffic, the same way CSV import's own
 * dry run previews a commit before it happens. */
integrationsAdmin.post('/:id/field-maps/test', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ maps: z.array(z.object({ targetField: z.string().min(1), sourcePath: z.string().min(1), transform: z.string().nullable().optional() })).max(100) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const connector = await tx.one<any>('SELECT preset, last_sample FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!connector) throw notFound('Connector');
    if (connector.lastSample == null) throw bad("This connector hasn't received a real message yet -- there's nothing to test against.");
    const preset = presetById(connector.preset);
    if (!preset) throw bad('Unknown preset');

    const raw = connector.lastSample;
    const maps: FieldMap[] = b.maps.map((m) => ({ targetField: m.targetField, sourcePath: m.sourcePath, transform: (m.transform || null) as FieldMap['transform'] }));
    const mapped = mapFields(raw, maps);
    const issues: string[] = [];   // a real problem -- this message would be dropped or rejected
    const notes: string[] = [];    // informational -- the message would be accepted, just not the way someone might expect at a glance
    let resolved: Record<string, unknown> = mapped;

    if (preset.writesTo === 'agent_state') {
      let state = mapped.state !== undefined ? String(mapped.state) : undefined;
      let reason = mapped.reason ? String(mapped.reason) : undefined;
      let skipped = false;
      if (mapped.eventType !== undefined && !state) {
        const rule = await tx.one<any>('SELECT action, state, reason FROM integration_event_rules WHERE tenant_id = :t AND connector_id = $1 AND event_type = $2', [id, String(mapped.eventType)]);
        if (!rule) issues.push(`Event type '${mapped.eventType}' has never been seen by this connector -- a real message like this would start out PENDING and be dropped until a rule is set under "Event types".`);
        else if (rule.action === 'PENDING') issues.push(`Event type '${mapped.eventType}' is already PENDING -- messages like this are being dropped right now until a rule is set.`);
        else if (rule.action === 'SKIP') { skipped = true; notes.push(`Event type '${mapped.eventType}' is set to be ignored on purpose -- this message is correctly accepted and produces no state change.`); }
        else { state = rule.state ?? undefined; reason = rule.reason ?? reason; }
      }
      if (!mapped.employeeNumber) issues.push('Agent extension is not mapped, or nothing was found at that path in the sample.');
      if (!state && !skipped && !issues.length) issues.push('State is not mapped, and this event type carries no state of its own.');
      resolved = { employeeNumber: mapped.employeeNumber ?? null, state: state ?? null, reason: reason ?? null, at: mapped.at ?? null, eventType: mapped.eventType ?? null };
    } else if (preset.writesTo === 'interval_history') {
      const parsed = LiveRows.safeParse({ rows: [{ queueId: mapped.queueId, queue: mapped.queue, day: String(mapped.day ?? ''), time: mapped.time ? String(mapped.time) : undefined, slot: mapped.slot !== undefined ? Number(mapped.slot) : undefined, volume: Number(mapped.volume ?? 0), ahtSec: mapped.ahtSec !== undefined ? Number(mapped.ahtSec) : undefined, abandoned: mapped.abandoned !== undefined ? Number(mapped.abandoned) : undefined }] });
      if (!parsed.success) issues.push(parsed.error.issues[0]?.message ?? 'Does not match the shape interval history needs');
    }
    return { raw, mapped, resolved, issues, notes, ok: issues.length === 0 };
  });
  res.json(out);
});

integrationsAdmin.get('/:id/event-rules', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  res.json(await withTenant(p.tenantId, (tx) => tx.q<any>('SELECT event_type, action, state, reason, seen_count, last_seen_at FROM integration_event_rules WHERE tenant_id = :t AND connector_id = $1 ORDER BY last_seen_at DESC', [id])));
});

integrationsAdmin.put('/:id/event-rules/:eventType', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), eventType = String(req.params.eventType);
  const b = parse(z.object({ action: z.enum(['PENDING', 'STATE', 'SKIP']), state: z.string().trim().min(1).max(60).nullable().optional(), reason: z.string().trim().max(60).nullable().optional() })
    .refine((x) => x.action !== 'STATE' || !!x.state, { message: 'A state is required when an event type maps to one' }), req.body);
  await withTenant(p.tenantId, async (tx) => {
    const c = await tx.one<any>('SELECT name FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!c) throw notFound('Connector');
    await tx.exec(
      `INSERT INTO integration_event_rules (tenant_id, connector_id, event_type, action, state, reason) VALUES (:t, $1, $2, $3, $4, $5)
       ON CONFLICT (connector_id, event_type) DO UPDATE SET action = EXCLUDED.action, state = EXCLUDED.state, reason = EXCLUDED.reason`,
      [id, eventType, b.action, b.action === 'STATE' ? b.state : null, b.action === 'STATE' ? (b.reason ?? null) : null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'INTEGRATION_CONNECTOR', entityId: id, entityName: c.name, diffSummary: `Event type '${eventType}' set to ${b.action}${b.state ? ` (${b.state})` : ''}` });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- entity matching

integrationsAdmin.post('/:id/entity-matches/suggest', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ entityType: z.enum(['queue', 'employee', 'skill']), seen: z.array(z.object({ sourceId: z.string().min(1), sourceLabel: z.string().min(1) })).max(500) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const connector = await tx.one<any>('SELECT wfm_group_id FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!connector) throw notFound('Connector');
    const candidates = b.entityType === 'queue'
      ? await tx.q<any>('SELECT id, name, code FROM queues WHERE tenant_id = :t AND ($1::uuid IS NULL OR wfm_group_id = $1)', [connector.wfmGroupId])
      : b.entityType === 'employee'
        ? await tx.q<any>('SELECT id, (first_name || \' \' || last_name) AS name, employee_number AS code, extension AS alt_code FROM employees WHERE tenant_id = :t')
        : await tx.q<any>('SELECT id, name, code FROM skills WHERE tenant_id = :t');
    return suggestEntityMatches(b.seen, candidates);
  });
  res.json(out);
});

integrationsAdmin.get('/:id/entity-matches', requires('config:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), entityType = req.query.entityType as string | undefined;
  res.json(await withTenant(p.tenantId, (tx) => tx.q<any>(
    'SELECT entity_type, source_id, source_label, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND ($2::text IS NULL OR entity_type = $2) ORDER BY entity_type, source_label',
    [id, entityType ?? null])));
});

integrationsAdmin.put('/:id/entity-matches', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ entityType: z.enum(['queue', 'employee', 'skill']), matches: z.array(z.object({ sourceId: z.string().min(1), sourceLabel: z.string().min(1), targetId: uuid.nullable() })).max(500) }), req.body);
  await withTenant(p.tenantId, async (tx) => {
    const c = await tx.one<any>('SELECT name FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!c) throw notFound('Connector');
    await tx.exec('DELETE FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [id, b.entityType]);
    if (b.matches.length) await tx.exec(
      'INSERT INTO integration_entity_maps (tenant_id, connector_id, entity_type, source_id, source_label, target_id) SELECT :t, $1, $2, x.si, x.sl, x.ti FROM unnest($3::text[], $4::text[], $5::uuid[]) AS x(si, sl, ti)',
      [id, b.entityType, b.matches.map((m) => m.sourceId), b.matches.map((m) => m.sourceLabel), b.matches.map((m) => m.targetId)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'INTEGRATION_CONNECTOR', entityId: id, entityName: c.name, diffSummary: `${b.entityType} matches set: ${b.matches.length}` });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- key-authenticated ingest (relay-family + manual test pulls)
// Mounted public (before the JWT `authenticate` middleware) since an on-prem script or a webhook sender has no user session.

/** The address a connector will call may not be this server's own network, a metadata service, or (unless an administrator listed it) a private network: see netGuard.ts. Said when it is saved, so it is not first found out at 3 a.m. */
async function checkConnectorTargets(config: Record<string, string>) {
  try {
    if (config.baseUrl) await checkTarget(new URL(/^[a-z]+:\/\//i.test(config.baseUrl) ? config.baseUrl : `https://${config.baseUrl}`).hostname);
    if (config.host) await checkTarget(config.host.trim());
  } catch (e) {
    if (e instanceof OutboundBlocked) throw bad(`${e.message} (${config.baseUrl ? 'address' : 'host'}: ${config.baseUrl || config.host})`);
    if (!(e instanceof TypeError)) throw e;                // an address that does not parse is reported by the field checks, not here
  }
}

async function connectorByKey(id: string, presented: string) {
  const [c] = await raw<any>('SELECT * FROM integration_connectors WHERE id = $1', [id]);
  if (!c || !c.apiKeyHash) return null;
  return (await keyMatches(presented, c.apiKeyHash)) ? c : null;
}
/**
 * A connector sends its key with every request, and checking it against the stored bcrypt hash takes a quarter of a second of CPU. A key that has just been checked
 * is remembered for ten minutes (by a SHA-256 of the key together with the stored hash, so changing the key, or its hash, ends it at once) instead of being checked
 * again for every one of thousands of requests. A wrong key is never remembered.
 */
const keyChecked = new Map<string, number>();
async function keyMatches(presented: string, storedHash: string): Promise<boolean> {
  const k = createHash('sha256').update(presented).update('|').update(storedHash).digest('hex');
  const until = keyChecked.get(k);
  if (until && until > Date.now()) return true;
  if (!(await checkPassword(presented, storedHash))) return false;
  if (keyChecked.size > 5000) keyChecked.clear();
  keyChecked.set(k, Date.now() + 10 * 60_000);
  return true;
}

function requireBearer(req: any): string {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) throw bad('Missing Authorization: Bearer <connector API key>');
  return m[1];
}

const RawRows = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) });

/** Historical backfill: raw vendor rows -> field map -> entity map -> staged for review, exactly like a manual CSV upload. */
integrationsPublic.post('/:id/backfill', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const key = requireBearer(req);
  const connector = await connectorByKey(id, key);
  if (!connector) throw notFound('Connector');
  const b = parse(RawRows.extend({ through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body);
  const started = new Date();
  const out = await stageBackfillRows(connector, b.rows, b.through).catch(async (e: any) => {
    await recordRun(connector, 'PUSH', 'BACKFILL', started, { rowsIn: b.rows.length, rowsOk: 0, rowsRejected: b.rows.length, message: e.message, failed: true }).catch(() => {});
    throw e;
  });
  await recordRun(connector, 'PUSH', 'BACKFILL', started, { rowsIn: b.rows.length, rowsOk: out.rowsMapped, rowsRejected: out.mappingErrors.length, message: `${out.rowsMapped} rows staged for review${out.mappingErrors.length ? `, ${out.mappingErrors.length} could not be mapped: ${out.mappingErrors[0]}` : ''}` }).catch(() => {});
  res.status(201).json(out);
});

/** Live/incremental sync: raw vendor rows routed to interval_history, agent state, or an employee upsert, by the preset's `writesTo`. */
integrationsPublic.post('/:id/live', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const key = requireBearer(req);
  const connector = await connectorByKey(id, key);
  if (!connector) throw notFound('Connector');
  const preset = presetById(connector.preset);
  if (!preset) throw bad('Unknown preset');
  const b = parse(RawRows, req.body);

  const started = new Date();
  const out = await applyLiveRows(connector, preset, b.rows).catch(async (e: any) => {
    await recordRun(connector, 'PUSH', 'LIVE', started, { rowsIn: b.rows.length, rowsOk: 0, rowsRejected: b.rows.length, message: e.message, failed: true }).catch(() => {});
    throw e;
  });
  await recordRun(connector, 'PUSH', 'LIVE', started, summariseLive(b.rows.length, out)).catch(() => {});
  // kept for the drag-and-drop field mapper regardless of whether this row mapped cleanly -- a real sample beats a guess
  await withTenant(connector.tenantId, (tx) => tx.exec('UPDATE integration_connectors SET last_received_at = now(), last_error = NULL, last_sample = $2::jsonb WHERE tenant_id = :t AND id = $1', [id, JSON.stringify(b.rows[0])]));
  res.json(out);
});

/** Cloud-to-cloud webhook receiver: no connector-hosted machine, HMAC-signed by the sender against the stored secret. */
integrationsPublic.post('/:id/webhook', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const [connector] = await raw<any>('SELECT * FROM integration_connectors WHERE id = $1', [id]);
  if (!connector || !connector.webhookSecret) throw notFound('Connector');
  const signingKey = open(connector.webhookSecret);
  if (!signingKey) throw new HttpError(500, 'SECRET_UNREADABLE', 'This connector\'s signing secret cannot be read with the current key. Make the connector again or restore the key.');
  const signature = String(req.headers['x-signature'] || '');
  const rawBody = JSON.stringify(req.body ?? {});
  const expected = createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('hex');
  const sigBuf = Buffer.from(signature, 'hex'), expBuf = Buffer.from(expected, 'hex');
  if (signature.length !== expected.length || sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) throw bad('Invalid signature');

  const preset = presetById(connector.preset);
  const started = new Date();
  const out = await withTenant(connector.tenantId, async (tx) => {
    const maps = await loadFieldMaps(tx, id);
    const m = mapFields(req.body, maps);
    if (preset?.writesTo === 'agent_state' && m.employeeNumber && m.state) {
      const [match] = await tx.q<any>(
        `SELECT e.employee_number FROM integration_entity_maps map JOIN employees e ON e.id = map.target_id
         WHERE map.tenant_id = :t AND map.connector_id = $1 AND map.entity_type = 'employee' AND map.source_id = $2`, [id, String(m.employeeNumber)]);
      return ingestAgentEvents(connector.tenantId, [{ employeeNumber: match?.employeeNumber ?? String(m.employeeNumber), state: String(m.state), reason: m.reason ? String(m.reason) : undefined, at: m.at ? String(m.at) : undefined }]);
    }
    return { accepted: 0, errors: [{ index: 0, message: 'Payload did not map to a known destination' }] };
  });
  await recordRun(connector, 'PUSH', 'WEBHOOK', started, summariseLive(1, out)).catch(() => {});
  await withTenant(connector.tenantId, (tx) => tx.exec('UPDATE integration_connectors SET last_received_at = now(), last_error = NULL, last_sample = $2::jsonb WHERE tenant_id = :t AND id = $1', [id, JSON.stringify(req.body ?? {})]));
  res.json(out);
});
