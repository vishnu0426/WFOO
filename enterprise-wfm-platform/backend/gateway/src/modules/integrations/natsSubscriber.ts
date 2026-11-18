/**
 * Runtime half of a STREAM_SUBSCRIBE connector: one live NATS connection per ACTIVE connector, pointed at that
 * connector's own cluster (never ours -- see infra.ts's `nc`, which is the gateway's own internal event bus).
 * Each message is run through the exact same field-map -> ingest path the HTTP /live endpoint already uses
 * (`mapFields`, then `ingestAgentEvents`/`ingestLive`), so nothing downstream needs to know a row arrived over
 * NATS instead of a relay script's HTTP POST. Started for every ACTIVE connector at boot (`startAllSubscriptions`,
 * called from index.ts) and kept in sync with connector create/status-change/delete from routes.ts.
 */
import { CONFIG_SECRET_KEYS, openFields } from '../../secrets.ts';
import { connect, StringCodec, type NatsConnection, type Subscription } from 'nats';
import { raw, withScope, withTenant } from '../../db.ts';
import { publish } from '../../infra.ts';
import { ingestAgentEvents } from '../intradayRoutes.ts';
import { ingestLive, LiveRows } from '../ingestionRoutes.ts';
import { presetById, type Preset } from './presets.ts';
import { mapFields, type FieldMap } from './mapping.ts';
import { decideAgentMessage, type EventRule } from './agentMessage.ts';
import { bareNumber, pickAgent } from './agentMatch.ts';
import { recordFeedEvent, type FeedEvent, type FeedOutcome } from './feedLog.ts';
import { forgetAllConnectors, forgetConnector, worthRecording } from './recordThrottle.ts';
import { CA_KEY, inspectCa, natsTlsOptions } from './natsTls.ts';

const sc = StringCodec();
const live = new Map<string, { nc: NatsConnection; sub: Subscription }>();

/** A live feed sends many messages a second; the settings that decide what each one means change rarely, so they are read once in a while, not per message. */
const SETTINGS_TTL_MS = 15_000;
const mapCache = new Map<string, { at: number; maps: FieldMap[] }>();
const ruleCache = new Map<string, { at: number; rule: EventRule; unflushed: number }>();
/** Test-only: forget what has been cached, and what was last written about each connector. */
export const _resetSubscriberCachesForTests = () => { mapCache.clear(); ruleCache.clear(); forgetAllConnectors(); };

async function loadFieldMaps(connectorId: string, tenantId: string, preset?: Preset): Promise<FieldMap[]> {
  const hit = mapCache.get(connectorId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.maps;
  const rows = await withTenant(tenantId, (tx) => tx.q<any>(
    'SELECT target_field, source_path, transform FROM integration_field_maps WHERE tenant_id = :t AND connector_id = $1', [connectorId]));
  let maps: FieldMap[] = rows.map((r) => ({ targetField: r.targetField, sourcePath: r.sourcePath, transform: (r.transform || null) as FieldMap['transform'] }));
  // a connector made before its preset shipped a field map starts from the preset's, instead of rejecting every message until someone maps by hand
  if (!maps.length && preset?.defaultMaps?.length) maps = preset.defaultMaps.map((m) => ({ targetField: m.targetField, sourcePath: m.sourcePath, transform: (m.transform || null) as FieldMap['transform'] }));
  mapCache.set(connectorId, { at: Date.now(), maps });
  return maps;
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
  if (!worthRecording(connectorId, ok, message)) return;
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

type Agent = { employeeNumber: string; name?: string; via: 'saved' | 'extension' | 'direct' } | { problem: string };

/** A vendor's own agent identifier (e.g. "1002@agnoshin.com") is not our employee number. In order: a match an administrator saved for it
 * (the same one-time confirmation queues use, mapping.ts); then the one employee whose Agent extension is that identifier (or its number
 * before the @); otherwise the raw value, so ingestAgentEvents can still try it as an employee number. Two people sharing the extension
 * is never guessed. */
async function resolveAgent(connectorId: string, tenantId: string, sourceId: string): Promise<Agent> {
  try {
    const saved = await withTenant(tenantId, (tx) => tx.q<any>(
      `SELECT e.employee_number FROM integration_entity_maps m JOIN employees e ON e.id = m.target_id
       WHERE m.tenant_id = :t AND m.connector_id = $1 AND m.entity_type = 'employee' AND m.source_id = $2`, [connectorId, sourceId]));
    if (saved[0]?.employeeNumber) return { employeeNumber: saved[0].employeeNumber, via: 'saved' };
    const hits = await withTenant(tenantId, (tx) => tx.q<any>(
      `SELECT employee_number, first_name || ' ' || last_name AS name, (lower(extension) = lower($1)) AS exact FROM employees
        WHERE tenant_id = :t AND status <> 'TERMINATED' AND extension IS NOT NULL AND (lower(extension) = lower($1) OR lower(extension) = lower($2))`, [sourceId, bareNumber(sourceId) ?? sourceId]));
    const m = pickAgent(hits.map((h) => ({ employeeNumber: h.employeeNumber, name: h.name, exact: !!h.exact })));
    if (m.kind === 'one') return { employeeNumber: m.employeeNumber, name: m.name, via: 'extension' };
    if (m.kind === 'many') return { problem: `The agent extension '${sourceId}' belongs to ${m.names.join(' and ')}, so these events cannot be matched to one person. Give each person their own extension.` };
  } catch { /* fall back to the raw value */ }
  return { employeeNumber: sourceId, via: 'direct' };
}

/** Counts every sighting of an event type and returns its rule, creating a PENDING rule the first time it appears.
 * `seen_count` defaults to 0 and is only bumped by the ON CONFLICT branch, so a result of 0 means this exact
 * INSERT just created the row -- the one moment worth telling someone about, not every later sighting while it
 * sits unresolved. */
async function recordEventType(connectorId: string, tenantId: string, connectorName: string, eventType: string): Promise<EventRule> {
  const key = `${connectorId}|${eventType}`;
  const hit = ruleCache.get(key);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) { hit.unflushed++; return hit.rule; }       // counted now, written with the next refresh
  const add = hit?.unflushed ?? 0;
  const rows = await withTenant(tenantId, (tx) => tx.q<any>(
    `INSERT INTO integration_event_rules (tenant_id, connector_id, event_type) VALUES (:t, $1, $2)
     ON CONFLICT (connector_id, event_type) DO UPDATE SET seen_count = integration_event_rules.seen_count + 1 + $3::int, last_seen_at = now()
     RETURNING action, state, reason, seen_count`, [connectorId, eventType, add]));
  const r = rows[0];
  if (r.seenCount === 0 && r.action === 'PENDING') publish(tenantId, ['integration', 'event-type-pending'], { connectorId, name: connectorName, eventType });
  const rule: EventRule = { action: r.action, state: r.state, reason: r.reason };
  ruleCache.set(key, { at: Date.now(), rule, unflushed: 0 });
  return rule;
}

async function handleOne(connector: any, preset: Preset, subject: string, data: Uint8Array) {
  let raw: unknown;
  const seen = (outcome: FeedOutcome, message: string | null, more: Partial<Omit<FeedEvent, 'at' | 'outcome' | 'message' | 'raw'>> = {}) =>
    recordFeedEvent(connector.tenantId, connector.id, { eventType: null, sourceId: null, state: null, reason: null, ...more, outcome, message, raw: raw ?? sc.decode(data).slice(0, 500) });
  try { raw = JSON.parse(sc.decode(data)); } catch { void seen('REJECTED', `Not JSON on '${subject}'`); return mark(connector.id, connector.tenantId, false, `Message on '${subject}' is not JSON: ${sc.decode(data).slice(0, 300)}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { void seen('REJECTED', `Not a JSON object on '${subject}'`); return mark(connector.id, connector.tenantId, false, `Message on '${subject}' is not a JSON object: ${sc.decode(data).slice(0, 300)}`); }
  const maps = await loadFieldMaps(connector.id, connector.tenantId, preset);
  if (!maps.length) { void seen('REJECTED', 'No field mapping is set up yet'); return mark(connector.id, connector.tenantId, false, sample(subject), raw); } // no field map set up yet -- keep the real shape instead of guessing
  const m = mapFields(raw, maps);
  const who = { eventType: m.eventType !== undefined && String(m.eventType).trim() ? String(m.eventType).trim() : null, sourceId: m.employeeNumber !== undefined && String(m.employeeNumber).trim() ? String(m.employeeNumber).trim() : null };
  try {
    if (preset.writesTo === 'agent_state') {
      const rule = m.eventType !== undefined && String(m.eventType).trim() ? await recordEventType(connector.id, connector.tenantId, connector.name, String(m.eventType).trim()) : null;
      const d = decideAgentMessage(m, rule);
      if (d.kind === 'skip') { void seen('IGNORED', 'Ignored on purpose (event type rule)', who); return mark(connector.id, connector.tenantId, true, undefined, raw); }
      if (d.kind === 'pending') { void seen('WAITING', `Event type '${d.eventType}' is waiting for a rule`, who); return mark(connector.id, connector.tenantId, false, `Event type '${d.eventType}' is waiting for a rule. Set it under RTA State Mapping.`, raw); }
      if (d.kind === 'unmapped') { void seen('REJECTED', `No ${d.missing === 'employeeNumber' ? 'agent id' : 'state'} found in the message`, who); return mark(connector.id, connector.tenantId, false, `${sample(subject)} (no ${d.missing} found)`, raw); }
      const agent = await resolveAgent(connector.id, connector.tenantId, d.employeeNumber);
      const shown = { ...who, state: d.state, reason: d.reason ?? null };
      if ('problem' in agent) { void seen('REJECTED', agent.problem, shown); return mark(connector.id, connector.tenantId, false, agent.problem, raw); }
      const out = await ingestAgentEvents(connector.tenantId, [{ employeeNumber: agent.employeeNumber, state: d.state, reason: d.reason, at: d.at }]);
      const ok = out.errors.length === 0;
      // "Unknown employee number '1001@agnoshin.com'" does not say what to do; for an id we could not match at all, say it
      const why = ok ? null : agent.via === 'direct' ? `No employee has the agent extension or employee number '${d.employeeNumber}'. Enter it as that person's Agent extension, or match it under Event types and agents.` : out.errors[0]?.message ?? null;
      void seen(ok ? 'ACCEPTED' : 'REJECTED', ok ? (agent.name ? `Matched ${agent.name}` : agent.via === 'saved' ? 'Matched by a saved match' : null) : why, shown);
      return mark(connector.id, connector.tenantId, ok, why ?? undefined, raw);
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

  const cfg = openFields(connector.config ?? {}, CONFIG_SECRET_KEYS);
  const servers = String(cfg.natsServers ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  const subject = String(cfg.subject ?? '');
  if (!servers.length || !subject) return mark(connector.id, connector.tenantId, false, 'natsServers and subject must be set before this connector can run');

  let nc: NatsConnection;
  try {
    nc = await connect({
      servers, user: cfg.natsUser || undefined, pass: cfg.natsPass || undefined,
      tls: natsTlsOptions(cfg) as any,
      name: `wfm-connector-${connector.id}`, maxReconnectAttempts: -1,
    });
  } catch (e: any) { return mark(connector.id, connector.tenantId, false, `Could not connect to ${servers.join(',')}: ${e.message}`); }

  // one queue group per connector: when several gateway processes run, NATS hands each message to only one of them, so an event is stored once, not once per process
  const sub = nc.subscribe(subject, { queue: `wfm-connector-${connector.id}` });
  live.set(connector.id, { nc, sub });
  const scoped = <T>(fn: () => Promise<T>) => withScope(connector.tenantId, connector.workspaceId, fn);
  await scoped(() => markConnected(connector.id, connector.tenantId));
  (async () => { for await (const m of sub) await scoped(() => handleOne(connector, preset, m.subject, m.data)); })()
    .catch((e) => scoped(() => mark(connector.id, connector.tenantId, false, e.message)));
  // background: reflects genuine drops/reconnects in last_error without disturbing connected_at (that stays the
  // last time the subscription was known good) or last_received_at (unaffected by connection noise).
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === 'disconnect') await scoped(() => mark(connector.id, connector.tenantId, false, 'Disconnected from NATS, reconnecting…'));
      else if (s.type === 'reconnect') await scoped(() => markConnected(connector.id, connector.tenantId));
      else if (s.type === 'error') {
        // this is how a permissions violation surfaces -- the connection itself stays up (connected_at doesn't lie),
        // but the server silently refuses the subscription, which otherwise looks identical to "just no traffic yet"
        const ctx = s.permissionContext;
        await scoped(() => mark(connector.id, connector.tenantId, false, ctx ? `NATS denied ${ctx.operation} on '${ctx.subject}' for this user -- ask whoever manages the cluster to grant it` : `NATS error: ${s.data}`));
      }
    }
  })().catch(() => {});
  console.log(`[integrations] connector ${connector.id} (${connector.preset}) subscribed to '${subject}' on ${servers.join(',')}`);
}

export interface TestStep { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }

/** What a person should read for a connection error, not the library's wording. */
export function friendlyNatsError(message: string): string {
  if (/authorization|authentication|user authentication/i.test(message)) return 'The server refused the user name or password.';
  if (/ECONNREFUSED|CONNECTION_REFUSED/i.test(message)) return 'Nothing is listening at that address and port. Check the server address, the port and that the server is running.';
  if (/ETIMEDOUT|timeout|timed out|CONNECTION_TIMEOUT/i.test(message)) return 'No answer in time. Check the address and port, and that no firewall is blocking this server.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return 'That host name could not be found. Check the spelling of the server address.';
  if (/does not match|altnames|hostname/i.test(message)) return 'The certificate is not issued for the address you typed (for example you used an IP address and it names a host). Use the host name from the certificate, or ask for a certificate that includes this address.';
  if (/expired/i.test(message)) return 'The server\'s certificate has expired. Ask whoever runs the NATS server to renew it.';
  if (/certificate|self.signed|CERT_|TLS|SSL|unable to verify/i.test(message)) return 'The server\'s certificate was not trusted. Upload the CA certificate that signed it, or, on a private network, turn certificate checking off.';
  return message;
}

/**
 * Checks a NATS connector's settings on a connection of its own, so the live subscription and the messages it is taking are not disturbed: reach
 * the server and log in, have permission to listen on the subject, and see whether anything arrives. Nothing is stored.
 */
export async function testNatsConnection(cfg: Record<string, string>, listenMs = 8000): Promise<{ ok: boolean; steps: TestStep[]; messages: number; sample: { subject: string; bytes: number } | null }> {
  const servers = String(cfg.natsServers ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const subject = String(cfg.subject ?? '').trim();
  if (!servers.length || !subject) return { ok: false, steps: [{ name: 'Settings', status: 'fail', detail: 'The server address and the subject must both be set.' }], messages: 0, sample: null };
  const checked = cfg.tlsRejectUnauthorized !== 'false';
  const pem = (cfg[CA_KEY] ?? '').trim();
  const certStep = (outcome: 'ok' | 'fail', detail?: string): TestStep =>
    !checked ? { name: 'Server certificate', status: 'warn', detail: 'Not checked, as set. The connection is encrypted but the server\'s identity is not verified: fine on a private network, not over the internet.' }
      : outcome === 'ok' ? { name: 'Server certificate', status: 'ok', detail: pem ? 'Trusted through the CA certificate you uploaded.' : 'Trusted by the public certificate authorities.' }
      : { name: 'Server certificate', status: 'fail', detail: detail! };
  if (checked && pem) { try { inspectCa(pem); } catch (e: any) { return { ok: false, steps: [certStep('fail', e.message)], messages: 0, sample: null }; } }
  let nc: NatsConnection;
  try {
    nc = await connect({ servers, user: cfg.natsUser || undefined, pass: cfg.natsPass || undefined, tls: natsTlsOptions(cfg) as any, name: 'wfm-connection-test', timeout: 6000, reconnect: false });
  } catch (e: any) {
    const why = friendlyNatsError(String(e?.message ?? e));
    const certProblem = /certificate|self.signed|CERT_|altnames|hostname|unable to verify|expired/i.test(String(e?.message ?? e));
    return { ok: false, steps: certProblem ? [certStep('fail', why)] : [...(checked && /authorization|authentication/i.test(String(e?.message ?? e)) ? [certStep('ok')] : []), { name: 'Reach the server and log in', status: 'fail', detail: why }], messages: 0, sample: null };
  }
  const steps: TestStep[] = [certStep('ok'), { name: 'Reach the server and log in', status: 'ok', detail: `Connected to ${nc.getServer()}` }];
  let denied: string | null = null, messages = 0, sample: { subject: string; bytes: number } | null = null;
  try {
    const sub = nc.subscribe(subject);                          // no queue group: it sees the same messages as the live subscription and takes none of them
    void (async () => { for await (const s of nc.status()) if (s.type === 'error') denied = s.permissionContext ? `NATS refused ${s.permissionContext.operation} on '${s.permissionContext.subject}' for this user.` : `NATS error: ${s.data}`; })().catch(() => {});
    void (async () => { for await (const m of sub) { messages++; sample ??= { subject: m.subject, bytes: m.data.length }; } })().catch(() => {});
    await nc.flush();
    await new Promise((r) => setTimeout(r, listenMs));
    steps.push(denied ? { name: `Permission to listen on ${subject}`, status: 'fail', detail: `${denied} Ask whoever manages the NATS server to allow this user to subscribe.` } : { name: `Permission to listen on ${subject}`, status: 'ok', detail: 'The server accepted the subscription.' });
    steps.push(messages > 0
      ? { name: 'Messages arriving', status: 'ok', detail: `${messages} message${messages === 1 ? '' : 's'} in ${listenMs / 1000} seconds, for example on ${sample!.subject}.` }
      : { name: 'Messages arriving', status: denied ? 'fail' : 'warn', detail: `Nothing arrived in ${listenMs / 1000} seconds. That can be normal when the phone system is quiet: change an agent's state on a softphone and test again.` });
  } finally { await nc.close().catch(() => {}); }
  return { ok: steps.every((s) => s.status !== 'fail'), steps, messages, sample };
}

export async function stopSubscription(connectorId: string): Promise<void> {
  mapCache.delete(connectorId); forgetConnector(connectorId);
  for (const k of ruleCache.keys()) if (k.startsWith(`${connectorId}|`)) ruleCache.delete(k);
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
