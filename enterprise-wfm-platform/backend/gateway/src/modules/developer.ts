/**
 * Public API and webhooks.
 *
 *  - API keys: another system reads from the platform with `Authorization: Bearer wfm_<id>_<secret>`. A key carries read-only scopes, can be revoked or
 *    expire, and is rate limited. Only a hash of the secret is stored. It reaches the same endpoints as a signed-in user, limited to its scopes.
 *  - Webhooks: the platform tells another system when something happens. Each event is written to a durable outbox, sent signed (HMAC-SHA256 over
 *    timestamp.body), retried with a growing delay when the receiver is down, and the endpoint is switched off after too many failures in a row.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OutboundBlocked, resolveSafe, safeFetch } from '../netGuard.ts';
import net from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, conflict, notFound, parse } from '../http.ts';
import { consume, redis } from '../infra.ts';
import { encrypt, open } from '../secrets.ts';

export const developer = Router();
const uuid = z.string().uuid();

// ---------------------------------------------------------------- API keys

/** What a key may be allowed to read. Writing and administration stay with signed-in people. */
export const KEY_SCOPES = [
  { id: 'schedule:read', label: 'Schedules, shifts, plans and coverage' },
  { id: 'workforce:read', label: 'Employees, teams, skills, availability and time off' },
  { id: 'forecast:read', label: 'Forecasts and staffing requirements' },
  { id: 'intraday:read', label: 'Live coverage and adherence' },
  { id: 'data:read', label: 'Imported history and data quality' },
  { id: 'config:read', label: 'Groups, queues and rules' },
] as const;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const makeKey = () => { const prefix = randomBytes(5).toString('hex'), secret = randomBytes(24).toString('hex'); return { prefix, secret, full: `wfm_${prefix}_${secret}` }; };
const lastUsed = new Map<string, number>();

/** Sign in with an API key. Throws a 401/429 the caller turns into a response. */
export async function principalFromApiKey(token: string): Promise<Principal> {
  const m = /^wfm_([0-9a-f]{10})_([0-9a-f]{48})$/.exec(token);
  if (!m) throw new HttpError(401, 'UNAUTHENTICATED', 'That API key is not valid');
  const [k] = await raw<any>('SELECT * FROM api_keys WHERE prefix = $1', [m[1]]);
  const a = Buffer.from(sha(m[2])), b = Buffer.from(k?.secretHash ?? '0'.repeat(64));
  if (!k || a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'UNAUTHENTICATED', 'That API key is not valid');
  if (k.status !== 'ACTIVE') throw new HttpError(401, 'KEY_REVOKED', 'That API key has been revoked');
  if (k.expiresAt && new Date(k.expiresAt) < new Date()) throw new HttpError(401, 'KEY_EXPIRED', 'That API key has expired');
  const minute = Math.floor(Date.now() / 60_000), rk = `wfm:rl:${k.id}:${minute}`;
  const n = await redis.incr(rk).catch(() => 0);
  if (n === 1) await redis.expire(rk, 90).catch(() => {});
  if (n > k.rateLimit) throw new HttpError(429, 'RATE_LIMITED', `This key is limited to ${k.rateLimit} requests a minute. Try again in a moment.`);
  if (Date.now() - (lastUsed.get(k.id) ?? 0) > 60_000) { lastUsed.set(k.id, Date.now()); void raw('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]).catch(() => {}); }
  return { userId: k.id, tenantId: k.orgId, role: 'ANALYST', name: `API key: ${k.name}`, username: `apikey:${k.prefix}`, jti: `apikey:${k.id}`, scopes: k.scopes, apiKey: true };
}

const keyDto = (k: any) => ({ id: k.id, name: k.name, prefix: `wfm_${k.prefix}_…`, scopes: k.scopes, status: k.status, rateLimit: k.rateLimit, expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt, createdBy: k.createdBy, createdAt: k.createdAt, revokedAt: k.revokedAt });
const adminOnly = (req: any) => { if (me(req).scopes) throw new HttpError(403, 'FORBIDDEN', 'An API key cannot manage keys or webhooks.'); };

developer.get('/scopes', requires('users:read'), (_req, res) => { res.json(KEY_SCOPES); });

developer.get('/keys', requires('users:read'), async (req, res) => {
  adminOnly(req);
  res.json((await raw<any>('SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC', [me(req).tenantId])).map(keyDto));
});

developer.post('/keys', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req);
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), scopes: z.array(z.enum(KEY_SCOPES.map((s) => s.id) as [string, ...string[]])).min(1), expiresInDays: z.number().int().min(1).max(3650).nullable().default(null), rateLimit: z.number().int().min(1).max(100000).default(600) }), req.body);
  const k = makeKey();
  const [row] = await raw<any>(
    `INSERT INTO api_keys (org_id, name, prefix, secret_hash, scopes, rate_limit, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE now() + ($7::int || ' days')::interval END, $8) RETURNING *`,
    [p.tenantId, b.name, k.prefix, sha(k.secret), b.scopes, b.rateLimit, b.expiresInDays, p.name]);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'CREATE', entityType: 'API_KEY', entityId: row.id, entityName: b.name, after: { scopes: b.scopes, rateLimit: b.rateLimit, expiresInDays: b.expiresInDays } }));
  res.status(201).json({ ...keyDto(row), key: k.full, notice: 'Copy this key now. It is not shown again.' });
});

/** A token for an identity provider to provision users (SCIM). It holds one scope that no ordinary key can hold, and reads nothing else. */
developer.post('/scim-token', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), k = makeKey();
  const [row] = await raw<any>(`INSERT INTO api_keys (org_id, name, prefix, secret_hash, scopes, rate_limit, created_by) VALUES ($1, 'SCIM provisioning', $2, $3, ARRAY['scim:provision'], 600, $4) RETURNING *`, [p.tenantId, k.prefix, sha(k.secret), p.name]);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'CREATE', entityType: 'API_KEY', entityId: row.id, entityName: 'SCIM provisioning' }));
  res.status(201).json({ ...keyDto(row), key: k.full, notice: 'Copy this token now. It is not shown again.' });
});

developer.delete('/keys/:id', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id);
  const [row] = await raw<any>(`UPDATE api_keys SET status = 'REVOKED', revoked_at = now() WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE' RETURNING *`, [id, p.tenantId]);
  if (!row) throw notFound('Active API key');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'DELETE', entityType: 'API_KEY', entityId: id, entityName: row.name, diffSummary: 'Revoked' }));
  res.json(keyDto(row));
});

// ---------------------------------------------------------------- events

/** The events a webhook can listen for. The first column is what the platform publishes internally; the second is the name a receiver sees. */
const EVENT_MAP: Record<string, string> = {
  'schedule.publish': 'schedule.published', 'schedule.generated': 'schedule.generated', 'schedule.swap': 'swap.updated', 'schedule.offer': 'offer.updated',
  'forecast.created': 'forecast.created', 'forecast.publish': 'forecast.published', 'forecast.approve': 'forecast.approved', 'forecast.submit': 'forecast.submitted', 'forecast.relearned': 'forecast.relearned',
  'timeoff.requested': 'timeoff.requested', 'timeoff.decided': 'timeoff.decided', 'report.ready': 'report.ready', 'integration.error': 'integration.error', 'integration.recovered': 'integration.recovered',
};
export const EVENTS = [
  { id: 'schedule.published', label: 'A schedule was published (or a window of it)' }, { id: 'schedule.generated', label: 'A schedule or long plan finished building' },
  { id: 'swap.updated', label: 'A shift swap changed' }, { id: 'offer.updated', label: 'A time-off or overtime offer changed' },
  { id: 'report.ready', label: 'A scheduled report was produced' }, { id: 'timeoff.requested', label: 'Someone asked for time off' }, { id: 'timeoff.decided', label: 'A time-off request was approved or declined' },
  { id: 'forecast.created', label: 'A forecast was created' }, { id: 'forecast.published', label: 'A forecast was published' }, { id: 'forecast.approved', label: 'A forecast was approved' },
  { id: 'adherence.out', label: 'People have been out of adherence for too long' }, { id: 'integration.error', label: 'A data connector failed' }, { id: 'integration.recovered', label: 'A data connector recovered' }, { id: 'webhook.ping', label: 'A test message' },
];
const eventName = (tokens: string[]) => { const raw = tokens.slice(2).join('.'); return EVENT_MAP[raw] ?? raw; };
developer.get('/events', requires('users:read'), (_req, res) => { res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=600'); res.json(EVENTS); });

// ---------------------------------------------------------------- webhook endpoints

const HOST_BLOCK = /^(169\.254\.|metadata\.google\.internal$|fd00:ec2::)/;
const isPrivate = (ip: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
/** Reject addresses that would turn a webhook into a way to reach the server's own network. Cloud metadata is always refused; private ranges only when WEBHOOK_BLOCK_PRIVATE=true. */
export async function assertSafeUrl(u: string) {
  let url: URL;
  try { url = new URL(u); } catch { throw bad('That is not a valid address. It should look like https://example.com/hook'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw bad('Webhook addresses must start with http:// or https://');
  if (url.username || url.password) throw bad('Put credentials in the secret, not in the address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (HOST_BLOCK.test(host)) throw bad('That address is not allowed.');
  // the same rule for every address an administrator can make this server call (netGuard.ts): never metadata or "this host"; not loopback, link-local or a private network unless OUTBOUND_ALLOW names it
  try { await resolveSafe(host); } catch (e) { if (e instanceof OutboundBlocked) throw bad(e.message); }
  return url;
}

const hookDto = (h: any, withSecret = false) => ({ id: h.id, name: h.name, url: h.url, events: h.events, active: h.active, consecutiveFailures: h.consecutiveFailures, disabledReason: h.disabledReason, createdBy: h.createdBy, createdAt: h.createdAt, ...(withSecret ? { secret: h.secret } : {}) });
const HookBody = z.object({ name: z.string().trim().min(2).max(80), url: z.string().trim().max(500), events: z.array(z.string()).min(1).max(40), active: z.boolean().default(true) });
const knownEvents = new Set([...EVENTS.map((e) => e.id), '*']);

developer.get('/webhooks', requires('users:read'), async (req, res) => {
  adminOnly(req);
  const rows = await raw<any>(
    `SELECT h.*, (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = h.id AND d.status = 'PENDING') AS pending,
            (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = h.id AND d.status = 'FAILED' AND d.created_at > now() - interval '7 days') AS failed7,
            (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.endpoint_id = h.id) AS last_delivered FROM webhook_endpoints h WHERE h.org_id = $1 ORDER BY h.created_at DESC`, [me(req).tenantId]);
  res.json(rows.map((h) => ({ ...hookDto(h), pending: h.pending, failedLastWeek: h.failed7, lastDeliveredAt: h.lastDelivered })));
});

developer.post('/webhooks', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), b = parse(HookBody, req.body);
  await assertSafeUrl(b.url);
  if (b.events.some((e) => !knownEvents.has(e))) throw bad('One of those events does not exist. See the list of events.');
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  const [row] = await raw<any>(`INSERT INTO webhook_endpoints (org_id, name, url, secret, events, active, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [p.tenantId, b.name, b.url, encrypt(secret), b.events, b.active, p.name]);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'CREATE', entityType: 'WEBHOOK', entityId: row.id, entityName: b.name, after: { url: b.url, events: b.events } }));
  res.status(201).json({ ...hookDto(row), secret, notice: 'Copy the signing secret now. It is not shown again.' });
});

developer.put('/webhooks/:id', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id), b = parse(HookBody, req.body);
  await assertSafeUrl(b.url);
  if (b.events.some((e) => !knownEvents.has(e))) throw bad('One of those events does not exist. See the list of events.');
  const [row] = await raw<any>(`UPDATE webhook_endpoints SET name = $3, url = $4, events = $5, active = $6, consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures END, disabled_reason = CASE WHEN $6 THEN NULL ELSE disabled_reason END WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, p.tenantId, b.name, b.url, b.events, b.active]);
  if (!row) throw notFound('Webhook');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'WEBHOOK', entityId: id, entityName: b.name, after: { url: b.url, events: b.events, active: b.active } }));
  res.json(hookDto(row));
});

developer.post('/webhooks/:id/rotate-secret', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id), secret = `whsec_${randomBytes(24).toString('hex')}`;
  const [row] = await raw<any>('UPDATE webhook_endpoints SET secret = $3 WHERE id = $1 AND org_id = $2 RETURNING *', [id, p.tenantId, encrypt(secret)]);
  if (!row) throw notFound('Webhook');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'WEBHOOK', entityId: id, entityName: row.name, diffSummary: 'Signing secret replaced' }));
  res.json({ ...hookDto(row), secret, notice: 'The old secret stops working now. Copy the new one.' });
});

developer.delete('/webhooks/:id', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id);
  const [row] = await raw<any>('DELETE FROM webhook_endpoints WHERE id = $1 AND org_id = $2 RETURNING name', [id, p.tenantId]);
  if (!row) throw notFound('Webhook');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'DELETE', entityType: 'WEBHOOK', entityId: id, entityName: row.name }));
  res.json({ ok: true });
});

/** Send a test message right now and say what the receiver answered. */
developer.post('/webhooks/:id/test', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id);
  const [h] = await raw<any>('SELECT * FROM webhook_endpoints WHERE id = $1 AND org_id = $2', [id, p.tenantId]);
  if (!h) throw notFound('Webhook');
  const r = await send(h, { id: randomUUID(), event: 'webhook.ping', createdAt: new Date().toISOString(), data: { message: 'This is a test from the WFM platform.', by: p.name } });
  res.json(r);
});

developer.get('/webhooks/:id/deliveries', requires('users:read'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id);
  const rows = await raw<any>(`SELECT d.id, d.event, d.status, d.attempts, d.last_status, d.last_error, d.created_at, d.delivered_at, d.next_attempt_at FROM webhook_deliveries d JOIN webhook_endpoints h ON h.id = d.endpoint_id WHERE d.endpoint_id = $1 AND h.org_id = $2 ORDER BY d.created_at DESC LIMIT 50`, [id, p.tenantId]);
  res.json(rows.map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, responseStatus: d.lastStatus, error: d.lastError, createdAt: d.createdAt, deliveredAt: d.deliveredAt, nextAttemptAt: d.status === 'PENDING' ? d.nextAttemptAt : null })));
});

developer.post('/deliveries/:id/retry', requires('users:write'), async (req, res) => {
  adminOnly(req);
  const p = me(req), id = parse(uuid, req.params.id);
  const [row] = await raw<any>(`UPDATE webhook_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL WHERE id = $1 AND org_id = $2 AND status = 'FAILED' RETURNING id`, [id, p.tenantId]);
  if (!row) throw conflict('Only a failed delivery can be retried.');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- sending

export const sign = (secret: string, timestamp: string, body: string) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

async function send(h: { id: string; url: string; secret: string }, payload: { id: string; event: string; createdAt: string; data: unknown }) {
  const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000)), t0 = Date.now();
  const key = open(h.secret);
  if (!key) return { ok: false, status: null as number | null, ms: 0, error: 'The signing secret cannot be read with the current key. Make a new one (New secret).' };
  try {
    await assertSafeUrl(h.url);
    const r = await safeFetch(h.url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'WFM-Platform-Webhook/1', 'X-WFM-Event': payload.event, 'X-WFM-Delivery': payload.id, 'X-WFM-Timestamp': ts, 'X-WFM-Signature': sign(key, ts, body) },
      body,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, ms: Date.now() - t0, error: r.status >= 200 && r.status < 300 ? null : `The receiver answered ${r.status}` };
  } catch (e: any) { return { ok: false, status: null as number | null, ms: Date.now() - t0, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 300) }; }
}

const BACKOFF_SCALE = Number(process.env.WEBHOOK_BACKOFF_SCALE || 1);                 // tests shrink the waits; production leaves this alone
const BACKOFF_SEC = [30, 120, 600, 3600, 21600].map((s) => s * BACKOFF_SCALE);
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;
const DISABLE_AFTER = 20;

/** Put an event in the outbox for every active endpoint that listens for it. */
export async function enqueueEvent(orgId: string, event: string, data: unknown) {
  const hooks = await raw<any>(`SELECT id FROM webhook_endpoints WHERE org_id = $1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`, [orgId, event]);
  for (const h of hooks) {
    const id = randomUUID();
    await raw(`INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event, payload) VALUES ($1, $2, $3, $4, $5)`, [id, orgId, h.id, event, JSON.stringify({ id, event, createdAt: new Date().toISOString(), data })]);
  }
  return hooks.length;
}

let busy = false;
async function deliverDue() {
  if (busy) return;
  busy = true;
  try {
    // leasing a delivery pushes its next attempt out, so a crash mid-send only delays it
    const due = await raw<any>(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, next_attempt_at = now() + interval '3 minutes'
        WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 20) RETURNING *`);
    await Promise.all(due.map(async (d) => {
      const [h] = await raw<any>('SELECT * FROM webhook_endpoints WHERE id = $1', [d.endpointId]);
      if (!h || !h.active) { await raw(`UPDATE webhook_deliveries SET status = 'FAILED', last_error = 'The webhook is switched off or removed' WHERE id = $1`, [d.id]); return; }
      const r = await send(h, d.payload);
      if (r.ok) {
        await raw(`UPDATE webhook_deliveries SET status = 'DELIVERED', delivered_at = now(), last_status = $2, last_error = NULL WHERE id = $1`, [d.id, r.status]);
        await raw('UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1', [h.id]);
        return;
      }
      const final = d.attempts >= MAX_ATTEMPTS;
      await raw(`UPDATE webhook_deliveries SET status = $2, last_status = $3, last_error = $4, next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id = $1`, [d.id, final ? 'FAILED' : 'PENDING', r.status, r.error, String(BACKOFF_SEC[Math.min(d.attempts - 1, BACKOFF_SEC.length - 1)])]);
      const [after] = await raw<any>('UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures', [h.id]);
      if (after && after.consecutiveFailures >= DISABLE_AFTER) await raw(`UPDATE webhook_endpoints SET active = false, disabled_reason = $2 WHERE id = $1`, [h.id, `Switched off after ${DISABLE_AFTER} failed deliveries in a row. Fix the receiver, then switch it back on.`]);
    }));
    await raw(`DELETE FROM webhook_deliveries WHERE status = 'DELIVERED' AND delivered_at < now() - interval '14 days'`);
  } catch (e) { console.error('[webhooks]', (e as Error).message); } finally { busy = false; }
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Listen for events and send them. Safe to run on every gateway: each event is taken by one, and each delivery is sent by one. */
export async function startWebhooks() {
  if (timer) return;
  for (const domain of ['schedule', 'timeoff', 'forecast', 'integration', 'report', 'adherence']) {
    await consume(`webhooks-${domain}`, `wfm.*.${domain}.>`, async (payload, tokens) => {
      const name = eventName(tokens);
      await enqueueEvent(tokens[1], name, payload);
      await (await import('./channels.ts')).enqueueAlerts(tokens[1], name, EVENTS.find((e) => e.id === name)?.label ?? name, payload);   // and anyone an alert rule names
    }, { fromNow: true });                                       // a new consumer starts with the next event, not with a week of old ones
  }
  timer = setInterval(deliverDue, 3000);
  timer.unref();
}
export const stopWebhooks = () => { if (timer) clearInterval(timer); timer = null; };

// ---------------------------------------------------------------- a short description of the read API

developer.get('/openapi.json', requires('users:read'), (_req, res) => {
  const read = (summary: string, scope: string, params: { name: string; in: 'path' | 'query'; required?: boolean; description?: string }[] = []) =>
    ({ get: { summary, security: [{ apiKey: [] }], 'x-required-scope': scope, parameters: params.map((p) => ({ ...p, required: p.required ?? p.in === 'path', schema: { type: 'string' } })), responses: { 200: { description: 'OK' }, 401: { description: 'Missing, revoked or expired key' }, 403: { description: 'The key does not have the scope' }, 429: { description: 'Rate limit reached' } } } });
  res.json({
    openapi: '3.0.3', info: { title: 'AgnoWFM read API', version: '1', description: 'Read-only access with an API key: Authorization: Bearer wfm_<id>_<secret>. Webhooks are signed with X-WFM-Signature = sha256 HMAC of "<X-WFM-Timestamp>.<body>".' },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/config/groups': read('WFM groups', 'config:read'),
      '/workforce/employees': read('Employees', 'workforce:read', [{ name: 'groupId', in: 'query' }, { name: 'status', in: 'query' }, { name: 'q', in: 'query' }, { name: 'limit', in: 'query' }, { name: 'offset', in: 'query' }]),
      '/workforce/teams': read('Teams', 'workforce:read'),
      '/forecast/versions': read('Forecast versions', 'forecast:read', [{ name: 'groupId', in: 'query' }]),
      '/scheduling/versions': read('Schedule versions', 'schedule:read', [{ name: 'groupId', in: 'query' }]),
      '/scheduling/versions/{id}': read('One schedule with its statistics and rule violations', 'schedule:read', [{ name: 'id', in: 'path' }]),
      '/scheduling/versions/{id}/shifts': read('The shifts of a schedule', 'schedule:read', [{ name: 'id', in: 'path' }, { name: 'from', in: 'query' }, { name: 'to', in: 'query' }, { name: 'employeeId', in: 'query' }]),
      '/scheduling/versions/{id}/plan': read('A long schedule week by week', 'schedule:read', [{ name: 'id', in: 'path' }]),
      '/scheduling/versions/{id}/lines': read('Rotation lines of a long schedule', 'schedule:read', [{ name: 'id', in: 'path' }]),
      '/attendance/summary': read('Actual against scheduled hours, with overtime', 'workforce:read', [{ name: 'from', in: 'query', required: true }, { name: 'to', in: 'query', required: true }]),
    },
    'x-webhook-events': EVENTS,
  });
});
