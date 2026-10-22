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
import { Router } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../../db.ts';
import { me, requires, type Principal } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { bad, conflict, notFound, parse } from '../../http.ts';
import { stageImport, Upload as StageUpload } from '../ingestionRoutes.ts';
import { ingestLive, LiveRows } from '../ingestionRoutes.ts';
import { ingestAgentEvents } from '../intradayRoutes.ts';
import { PRESETS, presetById, presetsByCategory, configSchemaFor, type Category } from './presets.ts';
import { mapFields, suggestEntityMatches, type FieldMap } from './mapping.ts';
import { startSubscription, stopSubscription } from './natsSubscriber.ts';

export const integrationsAdmin = Router();
export const integrationsPublic = Router();
const uuid = z.string().uuid();

const connectorDto = (c: any, memberCount?: number) => ({
  id: c.id, wfmGroupId: c.wfmGroupId, category: c.category, method: c.method, preset: c.preset, name: c.name, status: c.status,
  config: redactConfig(c.config), lastReceivedAt: c.lastReceivedAt, lastError: c.lastError, lastSample: c.lastSample ?? null, connectedAt: c.connectedAt ?? null,
  backfillStatus: c.backfillStatus, backfillThrough: c.backfillThrough, hasWebhookSecret: !!c.webhookSecret, createdBy: c.createdBy, createdAt: c.createdAt,
});
/** Secrets go into `config` (client secrets, DB creds where present) but never come back out once saved. */
function redactConfig(config: Record<string, any>) {
  const SECRET_KEYS = ['clientSecret', 'apiKey', 'password', 'isuPassword', 'secretAccessKey', 'privateKeyPem', 'refreshToken', 'userApiKey', 'customerApiKey', 'natsPass'];
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(config ?? {})) out[k] = SECRET_KEYS.includes(k) && v ? '••••••••' : v;
  return out;
}

// ---------------------------------------------------------------- catalogue

integrationsAdmin.get('/catalog', requires('config:read'), async (_req, res) => {
  const byCategory: Record<string, unknown> = {};
  for (const cat of ['ACD', 'CRM', 'HRMS', 'DATABASE', 'ONPREM', 'SFTP'] as Category[]) {
    byCategory[cat] = presetsByCategory(cat).map((p) => ({ id: p.id, label: p.label, method: p.method, authType: p.authType, fields: p.fields, note: p.note ?? null, writesTo: p.writesTo }));
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

const CreateBody = z.object({
  category: z.enum(['ACD', 'CRM', 'HRMS', 'DATABASE', 'ONPREM', 'SFTP']), preset: z.string().min(1), name: z.string().trim().min(1).max(100),
  wfmGroupId: uuid.nullable().optional(), config: z.record(z.string(), z.string()).default({}),
});

integrationsAdmin.post('/', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(CreateBody, req.body);
  const preset = presetById(b.preset);
  if (!preset || preset.category !== b.category) throw bad(`Unknown preset '${b.preset}' for category ${b.category}`);
  parse(configSchemaFor(preset), b.config); // a readable 400 naming the missing required field, not a raw zod error

  // Every connector gets an API key, not just the relay family: for API_PULL/STREAM_SUBSCRIBE presets it is what a
  // manual test push (or, once a real vendor account exists, a scheduled poll job) authenticates the /backfill and
  // /live calls with -- the same two ingest endpoints a relay script uses, just called by us instead of them.
  const webhookSecret = preset.method === 'WEBHOOK' ? randomBytes(32).toString('hex') : null;
  const apiKey = preset.method === 'WEBHOOK' ? null : randomBytes(24).toString('base64url');

  const out = await withTenant(p.tenantId, async (tx) => {
    const c = await tx.one<any>(
      `INSERT INTO integration_connectors (tenant_id, wfm_group_id, category, method, preset, name, config, api_key_hash, webhook_secret, created_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, backfill_through::text AS backfill_through`,
      [b.wfmGroupId ?? null, b.category, preset.method, preset.id, b.name, JSON.stringify(b.config), apiKey ? await bcrypt.hash(apiKey, 10) : null, webhookSecret, p.name]);
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
  const b = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ERROR']).optional(), config: z.record(z.string(), z.string()).optional() }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM integration_connectors WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Connector');
    if (b.config) parse(configSchemaFor(presetById(before.preset)!), b.config);
    const c = await tx.one<any>(
      `UPDATE integration_connectors SET name = coalesce($2, name), status = coalesce($3, status), config = coalesce($4, config), updated_at = now()
       WHERE tenant_id = :t AND id = $1 RETURNING *, backfill_through::text AS backfill_through`,
      [id, b.name ?? null, b.status ?? null, b.config ? JSON.stringify(b.config) : null]);
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

async function loadFieldMaps(tx: Tx, connectorId: string): Promise<FieldMap[]> {
  const rows = await tx.q<any>('SELECT target_field, source_path, transform FROM integration_field_maps WHERE tenant_id = :t AND connector_id = $1', [connectorId]);
  return rows.map((r) => ({ targetField: r.targetField, sourcePath: r.sourcePath, transform: (r.transform || null) as FieldMap['transform'] }));
}

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

async function connectorByKey(id: string, presented: string) {
  const [c] = await raw<any>('SELECT * FROM integration_connectors WHERE id = $1', [id]);
  if (!c || !c.apiKeyHash) return null;
  return (await bcrypt.compare(presented, c.apiKeyHash)) ? c : null;
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
  const out = await withTenant(connector.tenantId, async (tx) => {
    const maps = await loadFieldMaps(tx, id);
    const entityMaps = await tx.q<any>('SELECT source_id, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [id, 'queue']);
    const queueBySource = new Map(entityMaps.filter((m) => m.targetId).map((m) => [m.sourceId, m.targetId as string]));
    const queues = await tx.q<any>('SELECT id, name, code, aht_default AS "ahtDefault" FROM queues WHERE tenant_id = :t');
    const queueById = new Map(queues.map((q) => [q.id, q]));

    if (connector.preset === undefined) throw bad('Unknown preset');
    const errors: string[] = [];
    const csvRows = ['queue,date,interval,volume,aht,abandoned'];
    b.rows.forEach((raw, i) => {
      const m = mapFields(raw, maps);
      const sourceQueueId = String((raw as any).queueId ?? (raw as any).queue ?? '');
      const queueId = queueBySource.get(sourceQueueId);
      const q = queueId ? queueById.get(queueId) : undefined;
      if (!q) return errors.push(`Row ${i}: no queue match for '${sourceQueueId}' -- set up queue matching first (POST .../entity-matches)`);
      const day = String(m.day ?? '').slice(0, 10), time = String(m.time ?? '00:00');
      if (!day) return errors.push(`Row ${i}: no day mapped`);
      csvRows.push([q.name, day, time, Number(m.volume ?? 0), Number(m.ahtSec ?? q.ahtDefault ?? 300), Number(m.abandoned ?? 0)].join(','));
    });
    if (csvRows.length === 1) throw bad(errors[0] ?? 'No rows could be mapped');

    const principal: Principal = { userId: connector.id, tenantId: connector.tenantId, role: 'WFM_ADMIN', name: `Connector: ${connector.name}`, username: `connector:${connector.id}`, jti: '' };
    const staged = await stageImport(principal, null, StageUpload.parse({ dataType: 'HISTORICAL_VOLUME', fileName: `${connector.name}-backfill-${b.through}.csv`, csv: csvRows.join('\n') }));
    await tx.exec('UPDATE integration_connectors SET backfill_status = $2, backfill_through = $3, last_received_at = now(), last_error = NULL WHERE tenant_id = :t AND id = $1', [id, csvRows.length > 1 ? 'IN_PROGRESS' : 'DONE', b.through]);
    return { staged, rowsMapped: csvRows.length - 1, mappingErrors: errors.slice(0, 50) };
  });
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

  const out = await withTenant(connector.tenantId, async (tx) => {
    const maps = await loadFieldMaps(tx, id);
    const mapped = b.rows.map((r) => mapFields(r, maps));

    if (preset.writesTo === 'agent_state') {
      // the vendor's own agent id (e.g. "1002@agnoshin.com") is never going to equal our employee_number by
      // coincidence -- same entity-match indirection queue matching already uses, just for employees here.
      const empMaps = await tx.q<any>('SELECT source_id, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [id, 'employee']);
      const employees = await tx.q<any>('SELECT id, employee_number FROM employees WHERE tenant_id = :t');
      const empNoById = new Map(employees.map((e) => [e.id, e.employeeNumber]));
      const empNoBySource = new Map(empMaps.filter((m) => m.targetId && empNoById.has(m.targetId)).map((m) => [m.sourceId, empNoById.get(m.targetId) as string]));
      const events = mapped.filter((m) => m.employeeNumber && m.state).map((m) => ({ employeeNumber: empNoBySource.get(String(m.employeeNumber)) ?? String(m.employeeNumber), state: String(m.state), reason: m.reason ? String(m.reason) : undefined, at: m.at ? String(m.at) : undefined }));
      if (!events.length) throw bad('No row mapped to employeeNumber + state');
      return { kind: 'agent_state', ...(await ingestAgentEvents(connector.tenantId, events)) };
    }
    if (preset.writesTo === 'interval_history') {
      const queues = await tx.q<any>('SELECT id, name, code FROM queues WHERE tenant_id = :t');
      const entityMaps = await tx.q<any>('SELECT source_id, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [id, 'queue']);
      const queueBySource = new Map(entityMaps.filter((m) => m.targetId).map((m) => [m.sourceId, m.targetId as string]));
      const rows = mapped.map((m, i) => {
        const sourceQueueId = String((b.rows[i] as any).queueId ?? (b.rows[i] as any).queue ?? '');
        const queueId = queueBySource.get(sourceQueueId) ?? queues.find((q) => q.id === sourceQueueId)?.id;
        return queueId ? { queueId, day: String(m.day ?? ''), time: m.time ? String(m.time) : undefined, slot: m.slot !== undefined ? Number(m.slot) : undefined, volume: Number(m.volume ?? 0), ahtSec: m.ahtSec !== undefined ? Number(m.ahtSec) : undefined, abandoned: m.abandoned !== undefined ? Number(m.abandoned) : undefined } : null;
      }).filter((r): r is NonNullable<typeof r> => !!r && !!r.day);
      if (!rows.length) throw bad('No row mapped to a known queue; set up queue matching first');
      return { kind: 'interval_history', ...(await ingestLive(connector.tenantId, LiveRows.parse({ rows }).rows)) };
    }
    throw bad(`Live sync for '${preset.writesTo}' connectors is not wired yet; use the backfill/upsert path for HRMS.`);
  });
  // kept for the drag-and-drop field mapper regardless of whether this row mapped cleanly -- a real sample beats a guess
  await withTenant(connector.tenantId, (tx) => tx.exec('UPDATE integration_connectors SET last_received_at = now(), last_error = NULL, last_sample = $2::jsonb WHERE tenant_id = :t AND id = $1', [id, JSON.stringify(b.rows[0])]));
  res.json(out);
});

/** Cloud-to-cloud webhook receiver: no connector-hosted machine, HMAC-signed by the sender against the stored secret. */
integrationsPublic.post('/:id/webhook', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const [connector] = await raw<any>('SELECT * FROM integration_connectors WHERE id = $1', [id]);
  if (!connector || !connector.webhookSecret) throw notFound('Connector');
  const signature = String(req.headers['x-signature'] || '');
  const rawBody = JSON.stringify(req.body ?? {});
  const expected = createHmac('sha256', connector.webhookSecret).update(rawBody, 'utf8').digest('hex');
  const sigBuf = Buffer.from(signature, 'hex'), expBuf = Buffer.from(expected, 'hex');
  if (signature.length !== expected.length || sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) throw bad('Invalid signature');

  const preset = presetById(connector.preset);
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
  await withTenant(connector.tenantId, (tx) => tx.exec('UPDATE integration_connectors SET last_received_at = now(), last_error = NULL, last_sample = $2::jsonb WHERE tenant_id = :t AND id = $1', [id, JSON.stringify(req.body ?? {})]));
  res.json(out);
});
