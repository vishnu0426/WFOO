/**
 * Email and SMS. Notifications that reach a person's inbox can also go to their email and phone, by their own choice or the organisation's defaults. Alert rules tell
 * roles about platform events (a schedule published, a connector failing...) the same way. Every message goes through a durable outbox and is retried with growing
 * delays, so a mail server that is down for an hour loses nothing.
 *
 * Email is SMTP (Nodemailer). SMS goes through any HTTP SMS gateway the organisation names (its address, headers and body, with {{to}} and {{message}} filled in), so no
 * particular provider is built in. Phone numbers come from the employee record.
 */
import nodemailer from 'nodemailer';
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, notFound, parse } from '../http.ts';
import { assertSafeUrl } from './developer.ts';
import { safeFetch } from '../netGuard.ts';
import { normaliseSettings, type Email, type Settings, type Sms, emailPlanFor, emailProvider, emailProviders, fingerprint, missingFields, smsProvider, smsProviders, smsRequestFor, withDefaults, type Attachment, type ProviderInfo, type SmtpOptions } from './providers.ts';
import { notify } from '../notify.ts';
import { lockFields, openFields } from '../secrets.ts';

export const channels = Router();
const uuid = z.string().uuid();
const BACKOFF_SEC = [30, 120, 600, 3600].map((s) => s * Number(process.env.CHANNEL_BACKOFF_SCALE || 1));
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;

// ---------------------------------------------------------------- settings

type Values = Record<string, string>;
async function loadSettings(orgId: string): Promise<Settings> {
  await raw('INSERT INTO channel_settings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING', [orgId]);
  const [r] = await raw<any>('SELECT * FROM channel_settings WHERE org_id = $1', [orgId]);
  const n = normaliseSettings({ email: r.email, sms: r.sms, defaults: r.defaults });
  // credentials are encrypted in the database and opened only here, in memory, to be used
  n.email.values = openFields(n.email.values, secretKeys(emailProvider(n.email.provider)?.info));
  n.sms.values = openFields(n.sms.values, secretKeys(smsProvider(n.sms.provider)?.info));
  return n;
}

const secretKeys = (info?: ProviderInfo) => new Set((info?.fields ?? []).filter((x) => x.secret).map((x) => x.key));
/** What the screen gets: the choices made and the non-secret values; secrets are only reported as saved or not. */
function sideView(provider: string, values: Values, info?: ProviderInfo) {
  const secrets = secretKeys(info);
  return { values: Object.fromEntries(Object.entries(values).filter(([k]) => !secrets.has(k))), saved: Object.fromEntries([...secrets].map((k) => [k, !!values[k]])) };
}
const view = (s: Settings) => ({
  email: { enabled: s.email.enabled, provider: s.email.provider, from: s.email.from, ...sideView(s.email.provider, s.email.values, emailProvider(s.email.provider)?.info) },
  sms: { enabled: s.sms.enabled, provider: s.sms.provider, ...sideView(s.sms.provider, s.sms.values, smsProvider(s.sms.provider)?.info) },
  defaults: s.defaults,
});
const KINDS = ['TIME_OFF', 'SWAP', 'SCHEDULE', 'OFFER', 'BID', 'INFO'] as const;
const SettingsBody = z.object({
  email: z.object({ enabled: z.boolean(), provider: z.string().max(40), from: z.string().trim().max(200).default(''), values: z.record(z.string().max(60), z.string().max(4000)).default({}) }),
  sms: z.object({ enabled: z.boolean(), provider: z.string().max(40), values: z.record(z.string().max(60), z.string().max(4000)).default({}) }),
  defaults: z.record(z.enum(KINDS), z.array(z.enum(['EMAIL', 'SMS']))).default({}),
});

channels.get('/providers', requires('users:read'), (_req, res) => { res.json({ email: emailProviders(), sms: smsProviders() }); });
channels.get('/settings', requires('users:read'), async (req, res) => { res.json(view(await loadSettings(me(req).tenantId))); });

/** Keep a saved secret when the box was left empty and the provider did not change; drop everything the provider does not use. */
function mergeValues(info: ProviderInfo, incoming: Values, before: { provider: string; values: Values }): Values {
  const out: Values = {};
  for (const f of info.fields) {
    const v = (incoming[f.key] ?? '').trim();
    out[f.key] = v !== '' ? incoming[f.key] : f.secret && before.provider === info.id ? before.values[f.key] ?? '' : '';
  }
  return out;
}
async function checkSide(kind: 'email' | 'sms', info: ProviderInfo | undefined, values: Values, enabled: boolean) {
  if (!info) throw bad(`Choose a ${kind === 'email' ? 'email' : 'SMS'} provider from the list.`);
  const withDflt = withDefaults(info, values);
  if (enabled) {
    const missing = missingFields(info, withDflt);
    if (missing.length) throw bad(`${info.label} needs: ${missing.map((m) => m.label).join(', ')}.`);
  }
  for (const k of ['apiBase', 'url', 'baseUrl']) if (withDflt[k]) await assertSafeUrl(/^https?:\/\//.test(withDflt[k]) ? withDflt[k] : `https://${withDflt[k]}`);
}
channels.put('/settings', requires('users:write'), async (req, res) => {
  const p = me(req), b = parse(SettingsBody, req.body), cur = await loadSettings(p.tenantId);
  const ei = emailProvider(b.email.provider)?.info, si = smsProvider(b.sms.provider)?.info;
  const emailValues = ei ? mergeValues(ei, b.email.values, cur.email) : {}, smsValues = si ? mergeValues(si, b.sms.values, cur.sms) : {};
  await checkSide('email', ei, emailValues, b.email.enabled);
  await checkSide('sms', si, smsValues, b.sms.enabled);
  if (b.email.enabled && !b.email.from) throw bad('Say which address the email comes from.');
  const next: Settings = { email: { enabled: b.email.enabled, provider: b.email.provider, from: b.email.from, values: emailValues }, sms: { enabled: b.sms.enabled, provider: b.sms.provider, values: smsValues }, defaults: b.defaults };
  const locked = { email: { ...next.email, values: lockFields(next.email.values, secretKeys(ei)) }, sms: { ...next.sms, values: lockFields(next.sms.values, secretKeys(si)) } };
  await raw('UPDATE channel_settings SET email = $2, sms = $3, defaults = $4, updated_at = now() WHERE org_id = $1', [p.tenantId, JSON.stringify(locked.email), JSON.stringify(locked.sms), JSON.stringify(next.defaults)]);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'CHANNELS', entityId: 'channels', entityName: 'Email and SMS settings', after: { email: { enabled: next.email.enabled, provider: next.email.provider, from: next.email.from }, sms: { enabled: next.sms.enabled, provider: next.sms.provider }, defaults: next.defaults } }));
  res.json(view(next));
});

// ---------------------------------------------------------------- sending

const transports = new Map<string, nodemailer.Transporter>();
function transportFor(o: SmtpOptions) {
  const key = fingerprint(o);
  let t = transports.get(key);
  if (!t) {
    if (transports.size >= 20) transports.delete(transports.keys().next().value!);
    t = nodemailer.createTransport({ host: o.host, port: o.port, secure: o.secure, requireTLS: o.requireTLS, ignoreTLS: o.ignoreTLS, auth: o.auth, tls: { rejectUnauthorized: !o.tlsAllowSelfSigned }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
    transports.set(key, t);
  }
  return t;
}

const MAX_ATTACHMENT = 5_000_000;
interface Msg { channel: 'EMAIL' | 'SMS'; to: string; subject: string; body: string; attachment?: Attachment | Attachment[] | null }
/** Send one message. Never throws: every failure, including a provider answering nonsense, comes back as a plain reason. */
async function deliver(_orgId: string, s: Settings, m: Msg): Promise<{ ok: boolean; error?: string }> {
  try {
    if (m.channel === 'EMAIL') {
      if (!s.email.enabled) return { ok: false, error: 'Email is switched off for this organisation.' };
      const files: Attachment[] = Array.isArray(m.attachment) ? m.attachment : m.attachment ? [m.attachment] : [];
      if (files.reduce((n, f) => n + f.content.length, 0) > MAX_ATTACHMENT) return { ok: false, error: 'The attachments are too large to email (over 5 MB).' };
      const plan = emailPlanFor(s.email.provider, s.email.values);
      if ('smtp' in plan) {
        if (!plan.smtp.host) return { ok: false, error: 'No mail server is set.' };
        await transportFor(plan.smtp).sendMail({ from: s.email.from, to: m.to, subject: m.subject, text: m.body, attachments: files.length ? files.map((f) => ({ filename: f.name, contentType: f.type, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) })) : undefined });
        return { ok: true };
      }
      const rq = plan.request({ from: s.email.from, to: m.to, subject: m.subject, text: m.body, attachments: files });
      await assertSafeUrl(rq.url);
      const r = await safeFetch(rq.url, { ...(rq.init as any), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const e = plan.verify(r.status, (await r.text().catch(() => '')).slice(0, 2000));
      return e ? { ok: false, error: e } : { ok: true };
    }
    if (!s.sms.enabled) return { ok: false, error: 'SMS is switched off for this organisation.' };
    const rq = smsRequestFor(s.sms.provider, s.sms.values, m.to, m.body);
    await assertSafeUrl(rq.url);
    const r = await safeFetch(rq.url, { ...(rq.init as any), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const e = rq.verify(r.status, (await r.text().catch(() => '')).slice(0, 2000));
    return e ? { ok: false, error: e } : { ok: true };
  } catch (e: any) { return { ok: false, error: String(e?.response ?? e?.cause?.code ?? e?.message ?? e).slice(0, 300) }; }
}

export async function queueMessage(orgId: string, m: Msg & { ref?: string }) {
  await raw(`INSERT INTO channel_deliveries (org_id, channel, to_address, subject, body, attachment, ref) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [orgId, m.channel, m.to, m.subject, m.body, m.attachment ? JSON.stringify(m.attachment) : null, m.ref ?? null]);
}

let busy = false;
async function sendDue() {
  if (busy) return;
  busy = true;
  try {
    const due = await raw<any>(`UPDATE channel_deliveries SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
      WHERE id IN (SELECT id FROM channel_deliveries WHERE status = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 25) RETURNING *`);
    for (const d of due) {
      const s = await loadSettings(d.orgId);
      const r = await deliver(d.orgId, s, { channel: d.channel, to: d.toAddress, subject: d.subject, body: d.body, attachment: d.attachment });
      if (r.ok) await raw(`UPDATE channel_deliveries SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = $1`, [d.id]);
      else await raw(`UPDATE channel_deliveries SET status = $2, last_error = $3, next_attempt_at = now() + ($4 || ' seconds')::interval WHERE id = $1`, [d.id, d.attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING', r.error, String(BACKOFF_SEC[Math.min(d.attempts - 1, BACKOFF_SEC.length - 1)])]);
    }
    await raw(`DELETE FROM channel_deliveries WHERE status = 'SENT' AND sent_at < now() - interval '30 days'`);
  } catch (e) { console.error('[channels]', (e as Error).message); } finally { busy = false; }
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startChannelSender() { if (timer) return; timer = setInterval(sendDue, 3000); timer.unref(); }
export const stopChannelSender = () => { if (timer) clearInterval(timer); timer = null; };

channels.post('/test', requires('users:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ channel: z.enum(['EMAIL', 'SMS']), to: z.string().trim().min(3).max(200) }), req.body);
  const r = await deliver(p.tenantId, await loadSettings(p.tenantId), { channel: b.channel, to: b.to, subject: 'Test from the WFM platform', body: 'This is a test message from the WFM platform. If you can read it, sending works.' });
  res.json(r);
});

channels.get('/deliveries', requires('users:read'), async (req, res) => {
  const rows = await raw<any>(`SELECT id, channel, to_address, subject, status, attempts, last_error, ref, created_at, sent_at FROM channel_deliveries WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`, [me(req).tenantId]);
  res.json(rows.map((d) => ({ id: d.id, channel: d.channel, to: d.channel === 'SMS' ? d.toAddress.replace(/.(?=.{3})/g, '•') : d.toAddress, subject: d.subject, status: d.status, attempts: d.attempts, error: d.lastError, ref: d.ref, createdAt: d.createdAt, sentAt: d.sentAt })));
});
channels.post('/deliveries/:id/retry', requires('users:write'), async (req, res) => {
  const [row] = await raw<any>(`UPDATE channel_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = now() WHERE id = $1 AND org_id = $2 AND status = 'FAILED' RETURNING id`, [parse(uuid, req.params.id), me(req).tenantId]);
  if (!row) throw conflict('Only a failed message can be tried again.');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- what reaches a person

/** The channels a person gets a kind of notification on: their own choice if they made one, else the organisation's default. */
async function wantsOf(tx: Tx, s: Settings, userIds: string[], kind: string) {
  const prefs = new Map((await tx.q<{ userId: string; email: boolean; sms: boolean }>('SELECT user_id, email, sms FROM notification_prefs WHERE tenant_id = :t AND user_id = ANY($1::uuid[]) AND kind = $2', [userIds, kind])).map((r) => [r.userId, r]));
  const dflt = new Set(s.defaults[kind] ?? []);
  return (u: string) => { const p = prefs.get(u); return { email: p ? p.email : dflt.has('EMAIL'), sms: p ? p.sms : dflt.has('SMS') }; };
}
/** Queue email and SMS for people who should get this notification that way. Called by `notify`; never allowed to fail the action that caused it. */
export async function queueForUsers(tx: Tx, userIds: string[], n: { kind: string; title: string; body?: string }) {
  try {
    const s = await loadSettings(tx.tenantId);
    if (!s.email.enabled && !s.sms.enabled) return;
    const who = await wantsOf(tx, s, userIds, n.kind);
    const people = await tx.q<{ id: string; email: string | null; phone: string | null }>(`SELECT u.id, u.email, e.phone FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.tenant_id = :t AND u.id = ANY($1::uuid[]) AND u.status = 'ACTIVE'`, [userIds]);
    for (const u of people) {
      const w = who(u.id);
      if (w.email && s.email.enabled && u.email) await queueMessage(tx.tenantId, { channel: 'EMAIL', to: u.email, subject: n.title, body: `${n.title}${n.body ? `\n\n${n.body}` : ''}`, ref: `notification:${n.kind}` });
      if (w.sms && s.sms.enabled && u.phone) await queueMessage(tx.tenantId, { channel: 'SMS', to: u.phone.replace(/[^\d+]/g, ''), subject: '', body: `${n.title}${n.body ? `: ${n.body}` : ''}`.slice(0, 300), ref: `notification:${n.kind}` });
    }
  } catch (e) { console.error('[channels]', (e as Error).message); }
}

channels.get('/me', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const s = await loadSettings(p.tenantId);
    const u = await tx.one<{ email: string | null; phone: string | null }>(`SELECT u.email, e.phone FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.tenant_id = :t AND u.id = $1`, [p.userId]);
    const who = await wantsOf(tx, s, [p.userId], 'INFO');
    const kinds = await Promise.all(KINDS.map(async (k) => ({ kind: k, ...(await wantsOf(tx, s, [p.userId], k))(p.userId) })));
    void who;
    return { emailAvailable: s.email.enabled, smsAvailable: s.sms.enabled, email: u?.email ?? null, phone: u?.phone ? u.phone.replace(/.(?=.{3})/g, '•') : null, kinds };
  }));
});
channels.put('/me', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ kinds: z.array(z.object({ kind: z.enum(KINDS), email: z.boolean(), sms: z.boolean() })).max(10) }), req.body);
  await withTenant(p.tenantId, async (tx) => { for (const k of b.kinds) await tx.exec(`INSERT INTO notification_prefs (tenant_id, user_id, kind, email, sms) VALUES (:t, $1, $2, $3, $4) ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET email = $3, sms = $4`, [p.userId, k.kind, k.email, k.sms]); });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- alert rules

const ROLE_LIST = ['WFM_ADMIN', 'WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST', 'AGENT'] as const;
const RuleBody = z.object({ name: z.string().trim().min(2).max(80), event: z.string().max(60), roles: z.array(z.enum(ROLE_LIST)).min(1), channels: z.array(z.enum(['INBOX', 'EMAIL', 'SMS'])).min(1), active: z.boolean().default(true) });
const ruleDto = (r: any) => ({ id: r.id, name: r.name, event: r.event, roles: r.roles, channels: r.channels, active: r.active, createdBy: r.createdBy });
channels.get('/alert-rules', requires('users:read'), async (req, res) => { res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM alert_rules WHERE tenant_id = :t ORDER BY created_at'))).map(ruleDto)); });
channels.post('/alert-rules', requires('users:write'), async (req, res) => {
  const p = me(req), b = parse(RuleBody, req.body);
  const { EVENTS } = await import('./developer.ts');
  if (b.event !== '*' && !EVENTS.some((e) => e.id === b.event)) throw bad('That event does not exist. See the list of events.');
  const out = await withTenant(p.tenantId, async (tx) => {
    const r = (await tx.one<any>('INSERT INTO alert_rules (tenant_id, name, event, roles, channels, active, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6) RETURNING *', [b.name, b.event, b.roles, b.channels, b.active, p.name]))!;
    await audit(tx, p, req, { action: 'CREATE', entityType: 'ALERT_RULE', entityId: r.id, entityName: b.name, after: ruleDto(r) });
    return ruleDto(r);
  });
  res.status(201).json(out);
});
channels.delete('/alert-rules/:id', requires('users:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('DELETE FROM alert_rules WHERE tenant_id = :t AND id = $1 RETURNING name', [id]);
    if (!r) throw notFound('Alert rule');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'ALERT_RULE', entityId: id, entityName: r.name });
  });
  res.json({ ok: true });
});

/** A short, plain message for an event. */
export function describeEvent(event: string, label: string, data: any): { title: string; body: string } {
  const d = data && typeof data === 'object' ? data : {};
  const bits = Object.entries(d).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v).length < 120).slice(0, 6).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v}`);
  return { title: label || event, body: bits.join('\n') };
}

/** Tell the people named by matching alert rules. Called for every platform event by the webhook consumer, which delivers each event once. */
export async function enqueueAlerts(tenantId: string, event: string, label: string, data: unknown) {
  await withTenant(tenantId, async (tx) => {
    const rules = await tx.q<any>(`SELECT * FROM alert_rules WHERE tenant_id = :t AND active AND (event = $1 OR event = '*')`, [event]);
    if (!rules.length) return;
    const s = await loadSettings(tenantId), msg = describeEvent(event, label, data);
    for (const r of rules) {
      const users = await tx.q<{ id: string; email: string | null; phone: string | null }>(`SELECT u.id, u.email, e.phone FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role = ANY($1::text[])`, [r.roles]);
      if (r.channels.includes('INBOX')) await notify(tx, users.map((u) => u.id), { kind: 'INFO', title: msg.title, body: msg.body, data: { event } });
      for (const u of users) {
        if (r.channels.includes('EMAIL') && s.email.enabled && u.email) await queueMessage(tenantId, { channel: 'EMAIL', to: u.email, subject: msg.title, body: `${msg.title}\n\n${msg.body}`, ref: `alert:${r.name}` });
        if (r.channels.includes('SMS') && s.sms.enabled && u.phone) await queueMessage(tenantId, { channel: 'SMS', to: u.phone.replace(/[^\d+]/g, ''), subject: '', body: `${msg.title}${msg.body ? `: ${msg.body.replace(/\n/g, '; ')}` : ''}`.slice(0, 300), ref: `alert:${r.name}` });
      }
    }
  });
}
