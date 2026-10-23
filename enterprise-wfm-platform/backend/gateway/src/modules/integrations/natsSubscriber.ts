/**
 * Runtime half of a STREAM_SUBSCRIBE connector: one live NATS connection per ACTIVE connector, pointed at that
 * connector's own cluster (never ours -- see infra.ts's `nc`, which is the gateway's own internal event bus).
 * Each message is run through the exact same field-map -> ingest path the HTTP /live endpoint already uses
 * (`mapFields`, then `ingestAgentEvents`/`ingestLive`), so nothing downstream needs to know a row arrived over
 * NATS instead of a relay script's HTTP POST. Started for every ACTIVE connector at boot (`startAllSubscriptions`,
 * called from index.ts) and kept in sync with connector create/status-change/delete from routes.ts.
 */
import { connect, StringCodec, type NatsConnection, type Subscription } from 'nats';
import { raw, withTenant } from '../../db.ts';
import { publish } from '../../infra.ts';
import { ingestAgentEvents } from '../intradayRoutes.ts';
import { ingestLive, LiveRows } from '../ingestionRoutes.ts';
import { presetById, type Preset } from './presets.ts';
import { mapFields, type FieldMap } from './mapping.ts';

const sc = StringCodec();
const live = new Map<string, { nc: NatsConnection; sub: Subscription }>();

async function loadFieldMaps(connectorId: string, tenantId: string): Promise<FieldMap[]> {
  const rows = await withTenant(tenantId, (tx) => tx.q<any>(
    'SELECT target_field, source_path, transform FROM integration_field_maps WHERE tenant_id = :t AND connector_id = $1', [connectorId]));
  return rows.map((r) => ({ targetField: r.targetField, sourcePath: r.sourcePath, transform: (r.transform || null) as FieldMap['transform'] }));
}

/** `sampleRaw`, when given, is kept in `last_sample` independently of success/failure -- it's what the drag-and-drop
 * field mapper in Integration Station builds its draggable source list from, so it has to survive the mapping
 * actually getting fixed (unlike `last_error`, which clears on the first success).
 *
 * Notifies on a genuine transition only (healthy -> broken, or broken -> healthy again) -- a connector stuck in
 * one state can process thousands of messages a day, and nobody needs to be told "still broken" that many times.
 * The RETURNING clause reads the row's PRE-update error on the same write, so detecting the transition costs
 * nothing extra. */
async function mark(connectorId: string, tenantId: string, ok: boolean, message?: string, sampleRaw?: unknown) {
  try {
    const rows = await withTenant(tenantId, (tx) => tx.q<any>(
      `WITH old AS (SELECT last_error, name FROM integration_connectors WHERE tenant_id = :t AND id = $1)
       UPDATE integration_connectors SET last_received_at = CASE WHEN $2 THEN now() ELSE last_received_at END, last_error = $3, last_sample = coalesce($4::jsonb, last_sample)
       WHERE tenant_id = :t AND id = $1
       RETURNING (SELECT last_error FROM old) AS previous_error, (SELECT name FROM old) AS connector_name`,
      [connectorId, ok, ok ? null : (message ?? null), sampleRaw !== undefined ? JSON.stringify(sampleRaw) : null]));
    const previousError = rows[0]?.previousError ?? null;
    const name = rows[0]?.connectorName ?? 'Connector';
    if (!ok && !previousError && message) publish(tenantId, ['integration', 'error'], { connectorId, name, message });
    else if (ok && previousError) publish(tenantId, ['integration', 'recovered'], { connectorId, name });
  } catch { /* bookkeeping is best effort, never blocks ingest */ }
}

/** `connected_at` answers a different question from `last_received_at`: "did the subscription open at all" vs "has
 * a message arrived since." Without it, "connected but idle" and "never connected" were indistinguishable -- both
 * just left every field null. Set once the NATS subscription itself is live, not once a message shows up. */
async function markConnected(connectorId: string, tenantId: string) {
  try { await withTenant(tenantId, (tx) => tx.exec('UPDATE integration_connectors SET connected_at = now(), last_error = NULL WHERE tenant_id = :t AND id = $1', [connectorId])); }
  catch { /* bookkeeping is best effort */ }
}

const sample = (subject: string) => `Message on '${subject}' did not map to a known field. See the sample payload below to build the field map.`;

/** A vendor's own agent/employee identifier (e.g. "1002@agnoshin.com") is never going to equal our employee_number
 * by coincidence -- this is the same "cannot be guessed, needs a human's one-time confirmation" entity match
 * already built for queues (mapping.ts), just not previously wired up for agent-state connectors. Falls back to
 * the raw value unmapped, so ingestAgentEvents's own "Unknown employee number" error still explains what's missing. */
async function resolveEmployeeNumber(connectorId: string, tenantId: string, sourceId: string): Promise<string> {
  try {
    const rows = await withTenant(tenantId, (tx) => tx.q<any>(
      `SELECT e.employee_number FROM integration_entity_maps m JOIN employees e ON e.id = m.target_id
       WHERE m.tenant_id = :t AND m.connector_id = $1 AND m.entity_type = 'employee' AND m.source_id = $2`, [connectorId, sourceId]));
    return rows[0]?.employeeNumber ?? sourceId;
  } catch { return sourceId; }
}

/** Counts every sighting of an event type and returns its rule, creating a PENDING rule the first time it appears.
 * `seen_count` defaults to 0 and is only bumped by the ON CONFLICT branch, so a result of 0 means this exact
 * INSERT just created the row -- the one moment worth telling someone about, not every later sighting while it
 * sits unresolved. */
async function recordEventType(connectorId: string, tenantId: string, connectorName: string, eventType: string) {
  const rows = await withTenant(tenantId, (tx) => tx.q<any>(
    `INSERT INTO integration_event_rules (tenant_id, connector_id, event_type) VALUES (:t, $1, $2)
     ON CONFLICT (connector_id, event_type) DO UPDATE SET seen_count = integration_event_rules.seen_count + 1, last_seen_at = now()
     RETURNING action, state, reason, seen_count`, [connectorId, eventType]));
  const r = rows[0];
  if (r.seenCount === 0 && r.action === 'PENDING') publish(tenantId, ['integration', 'event-type-pending'], { connectorId, name: connectorName, eventType });
  return { action: r.action as 'PENDING' | 'STATE' | 'SKIP', state: r.state as string | null, reason: r.reason as string | null };
}

async function handleOne(connector: any, preset: Preset, subject: string, data: Uint8Array) {
  let raw: unknown;
  try { raw = JSON.parse(sc.decode(data)); } catch { return mark(connector.id, connector.tenantId, false, `Message on '${subject}' is not JSON: ${sc.decode(data).slice(0, 300)}`); }
  const maps = await loadFieldMaps(connector.id, connector.tenantId);
  if (!maps.length) return mark(connector.id, connector.tenantId, false, sample(subject), raw); // no field map set up yet -- keep the real shape instead of guessing
  const m = mapFields(raw, maps);
  try {
    if (preset.writesTo === 'agent_state') {
      let state = m.state !== undefined ? String(m.state) : undefined;
      let reason = m.reason ? String(m.reason) : undefined;
      if (m.eventType !== undefined) {
        const rule = await recordEventType(connector.id, connector.tenantId, connector.name, String(m.eventType));
        // only the event type decides what happens when the message carries no state of its own (logins, logouts,
        // heartbeats); a message that already has a state (e.g. EVT_AGENT_READY with state=READY) goes straight
        // through on that, the event-type rule is just there to count it -- it must never block a real state change
        if (!state) {
          if (rule.action === 'SKIP') return mark(connector.id, connector.tenantId, true, undefined, raw);
          if (rule.action === 'PENDING') return mark(connector.id, connector.tenantId, false, `Event type '${m.eventType}' is waiting for a rule. Set it under RTA State Mapping.`, raw);
          if (rule.state) state = rule.state;
          if (rule.reason !== null && rule.reason !== undefined) reason = rule.reason;
        } else if (rule.action === 'SKIP') {
          return mark(connector.id, connector.tenantId, true, undefined, raw);
        }
      }
      if (!m.employeeNumber || !state) return mark(connector.id, connector.tenantId, false, sample(subject), raw);
      const employeeNumber = await resolveEmployeeNumber(connector.id, connector.tenantId, String(m.employeeNumber));
      const out = await ingestAgentEvents(connector.tenantId, [{ employeeNumber, state, reason, at: m.at ? String(m.at) : undefined }]);
      return mark(connector.id, connector.tenantId, out.errors.length === 0, out.errors[0]?.message, raw);
    }
    if (preset.writesTo === 'interval_history') {
      const parsed = LiveRows.safeParse({ rows: [{ queueId: m.queueId, queue: m.queue, day: String(m.day ?? ''), time: m.time ? String(m.time) : undefined, slot: m.slot !== undefined ? Number(m.slot) : undefined, volume: Number(m.volume ?? 0), ahtSec: m.ahtSec !== undefined ? Number(m.ahtSec) : undefined, abandoned: m.abandoned !== undefined ? Number(m.abandoned) : undefined }] });
      if (!parsed.success) return mark(connector.id, connector.tenantId, false, `${parsed.error.issues[0]?.message}. ${sample(subject)}`, raw);
      const out = await ingestLive(connector.tenantId, parsed.data.rows);
      return mark(connector.id, connector.tenantId, out.errors.length === 0, out.errors[0]?.message, raw);
    }
    return mark(connector.id, connector.tenantId, false, `STREAM_SUBSCRIBE for '${preset.writesTo}' is not wired up`, raw);
  } catch (e: any) { return mark(connector.id, connector.tenantId, false, e.message, raw); }
}

/** Opens (or re-opens) one connector's live subscription. A no-op for anything that isn't an ACD STREAM_SUBSCRIBE preset. */
export async function startSubscription(connector: any): Promise<void> {
  const preset = presetById(connector.preset);
  if (!preset || preset.method !== 'STREAM_SUBSCRIBE') return;
  await stopSubscription(connector.id);

  const cfg = connector.config ?? {};
  const servers = String(cfg.natsServers ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const subject = String(cfg.subject ?? '');
  if (!servers.length || !subject) return mark(connector.id, connector.tenantId, false, 'natsServers and subject must be set before this connector can run');

  let nc: NatsConnection;
  try {
    nc = await connect({
      servers, user: cfg.natsUser || undefined, pass: cfg.natsPass || undefined,
      tls: { rejectUnauthorized: cfg.tlsRejectUnauthorized !== 'false' } as any,
      name: `wfm-connector-${connector.id}`, maxReconnectAttempts: -1,
    });
  } catch (e: any) { return mark(connector.id, connector.tenantId, false, `Could not connect to ${servers.join(',')}: ${e.message}`); }

  const sub = nc.subscribe(subject);
  live.set(connector.id, { nc, sub });
  await markConnected(connector.id, connector.tenantId);
  (async () => { for await (const m of sub) await handleOne(connector, preset, m.subject, m.data); })()
    .catch((e) => mark(connector.id, connector.tenantId, false, e.message));
  // background: reflects genuine drops/reconnects in last_error without disturbing connected_at (that stays the
  // last time the subscription was known good) or last_received_at (unaffected by connection noise).
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect') await mark(connector.id, connector.tenantId, false, 'Disconnected from NATS, reconnecting…');
      else if (s.type === 'reconnect') await markConnected(connector.id, connector.tenantId);
      else if (s.type === 'error') {
        // this is how a permissions violation surfaces -- the connection itself stays up (connected_at doesn't lie),
        // but the server silently refuses the subscription, which otherwise looks identical to "just no traffic yet"
        const ctx = s.permissionContext;
        await mark(connector.id, connector.tenantId, false, ctx ? `NATS denied ${ctx.operation} on '${ctx.subject}' for this user -- ask whoever manages the cluster to grant it` : `NATS error: ${s.data}`);
      }
    }
  })().catch(() => {});
  console.log(`[integrations] connector ${connector.id} (${connector.preset}) subscribed to '${subject}' on ${servers.join(',')}`);
}

export async function stopSubscription(connectorId: string): Promise<void> {
  const s = live.get(connectorId);
  if (!s) return;
  live.delete(connectorId);
  try { await s.sub.unsubscribe(); await s.nc.close(); } catch { /* already closing */ }
}

/** Opens every ACTIVE STREAM_SUBSCRIBE connector's subscription, across every tenant. Call once at boot. */
export async function startAllSubscriptions(): Promise<void> {
  const rows = await raw<any>('SELECT * FROM integration_connectors WHERE status = $1', ['ACTIVE']);
  for (const c of rows) await startSubscription(c);
}

export async function stopAllSubscriptions(): Promise<void> {
  for (const id of [...live.keys()]) await stopSubscription(id);
}
