/**
 * Platform settings the Super Admin controls: the mail server and operator security. (The public addresses of the apps come from backend/.env.)
 * Stored one row per setting in wfm.platform_settings. Secrets (the mail password) are encrypted and are never sent back to the browser.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw } from '../../db.ts';
import { bad, parse } from '../../http.ts';
import { lockFields, openFields } from '../../secrets.ts';
import { emailProvider, emailProviders, type ProviderInfo, type Settings } from '../providers.ts';
import { checkSide, deliver, mergeValues, secretKeys } from '../channels.ts';

type Values = Record<string, string>;
export interface EmailSetting { enabled: boolean; provider: string; from: string; values: Values; lastTest?: { at: string; ok: boolean; error?: string; to: string; by: string } }
export interface UrlSetting { tenantApp: string; employeePortal: string; superAdminPortal: string }
export interface SecuritySetting { requireMfa: boolean; sessionHours: number }

export type AuditFn = (p: {
  adminId?: string | null; adminEmail: string; action: string; targetEntityType: string; targetEntityId?: string | null; targetEntityName?: string | null;
  targetTenantId?: string | null; targetTenantName?: string | null; targetTenantCode?: string | null;
  ipAddress?: string | null; userAgent?: string | null; details?: Record<string, any>; status?: 'SUCCESS' | 'FAILURE' | 'WARNING';
}) => Promise<void>;

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const [r] = await raw<any>('SELECT value FROM wfm.platform_settings WHERE key = $1', [key]);
  return r ? ({ ...fallback, ...(r.value as object) } as T) : fallback;
}
async function putSetting(key: string, value: unknown, by: string): Promise<void> {
  await raw(
    `INSERT INTO wfm.platform_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), by]
  );
}

const NO_EMAIL: EmailSetting = { enabled: false, provider: 'SMTP', from: '', values: {} };
const emailInfo = (id: string): ProviderInfo | undefined => emailProvider(id)?.info;

/** The saved mail settings with the password opened, for sending. Server-side only. */
export async function loadEmailSetting(): Promise<EmailSetting> {
  const s = await getSetting<EmailSetting>('email', NO_EMAIL);
  return { ...s, values: openFields(s.values || {}, secretKeys(emailInfo(s.provider))) };
}

/** Send one email from the platform. Never throws: the reason for a failure comes back as text. */
export async function sendPlatformEmail(to: string, subject: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const e = await loadEmailSetting();
  if (!e.enabled) return { ok: false, error: 'Email is not set up. Add a mail server under Settings, then Email.' };
  const s: Settings = { email: { enabled: true, provider: e.provider, from: e.from, values: e.values }, sms: { enabled: false, provider: 'HTTP', values: {} }, defaults: {} };
  return deliver('platform', s, { channel: 'EMAIL', to, subject, body });
}

/** Email every active Super Admin. Best effort: it never fails the request that caused it (the request also shows in the portal). */
export async function notifyPlatformAdmins(subject: string, body: string): Promise<void> {
  const admins = await raw<any>(`SELECT email FROM wfm.platform_admins WHERE status = 'ACTIVE'`);
  for (const a of admins) sendPlatformEmail(a.email, subject, body).catch(() => {});
}

const envUrl = (k: string) => (process.env[k] || '').replace(/\/+$/, '');
/** The public addresses of the apps. They are deployment settings, so they come from the environment (backend/.env), not from a screen. */
export async function getPlatformUrls(): Promise<UrlSetting> {
  return {
    tenantApp: envUrl('APP_URL') || envUrl('PUBLIC_URL') || 'http://localhost:3000',
    employeePortal: envUrl('PORTAL_URL') || 'http://localhost:3001',
    superAdminPortal: envUrl('SUPERADMIN_URL') || 'http://localhost:3002',
  };
}

export const getSecuritySetting = () => getSetting<SecuritySetting>('security', { requireMfa: false, sessionHours: 8 });

const EmailBody = z.object({
  enabled: z.boolean(),
  provider: z.string().max(40),
  from: z.string().trim().max(200).default(''),
  values: z.record(z.string().max(60), z.string().max(4000)).default({}),
});
const SecurityBody = z.object({ requireMfa: z.boolean(), sessionHours: z.number().int().min(1).max(24) });

export function settingsRouter(audit: AuditFn, ipOf: (req: any) => string): Router {
  const r = Router();
  const who = (req: any) => req.platformAdmin!.email as string;
  const ua = (req: any) => (req.headers['user-agent'] as string) || 'Unknown';

  // ---- email
  r.get('/email', async (_req, res) => {
    const s = await getSetting<EmailSetting>('email', NO_EMAIL);
    const secrets = secretKeys(emailInfo(s.provider));
    res.json({
      providers: emailProviders(),
      enabled: s.enabled, provider: s.provider, from: s.from,
      values: Object.fromEntries(Object.entries(s.values || {}).filter(([k]) => !secrets.has(k))),
      saved: Object.fromEntries([...secrets].map((k) => [k, !!(s.values || {})[k]])),
      lastTest: s.lastTest ?? null,
    });
  });

  r.put('/email', async (req, res) => {
    const b = parse(EmailBody, req.body);
    const before = await loadEmailSetting();
    const info = emailInfo(b.provider);
    const values = info ? mergeValues(info, b.values, before) : {};
    await checkSide('email', info, values, b.enabled);
    if (b.enabled && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$|^.+<[^\s@<>]+@[^\s@<>]+>$/.test(b.from)) throw bad('Enter the address the email is sent from, for example "Enterprise WFM <noreply@yourcompany.com>".');
    const next: EmailSetting = { enabled: b.enabled, provider: b.provider, from: b.from, values: lockFields(values, secretKeys(info)) };
    await putSetting('email', next, who(req));
    await audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action: 'UPDATE_SETTINGS', targetEntityType: 'PLATFORM_SETTINGS', targetEntityName: 'Email', ipAddress: ipOf(req), userAgent: ua(req), details: { enabled: b.enabled, provider: b.provider, from: b.from }, status: 'SUCCESS' });
    res.json({ ok: true });
  });

  r.post('/email/test', async (req, res) => {
    const b = parse(z.object({ to: z.string().trim().email() }), req.body);
    const result = await sendPlatformEmail(b.to, 'Test from Enterprise WFM Platform', 'This is a test message from the platform settings. If you can read it, the mail server works.');
    const s = await getSetting<EmailSetting>('email', NO_EMAIL);
    await putSetting('email', { ...s, lastTest: { at: new Date().toISOString(), ok: result.ok, error: result.error, to: b.to, by: who(req) } }, who(req));
    await audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action: 'TEST_EMAIL', targetEntityType: 'PLATFORM_SETTINGS', targetEntityName: 'Email', ipAddress: ipOf(req), userAgent: ua(req), details: { to: b.to, error: result.error }, status: result.ok ? 'SUCCESS' : 'FAILURE' });
    res.json(result);
  });

  // ---- public addresses (read-only: set APP_URL, PORTAL_URL and SUPERADMIN_URL in backend/.env)
  r.get('/urls', async (_req, res) => { res.json({ effective: await getPlatformUrls() }); });

  // ---- operator security
  r.get('/security', async (_req, res) => { res.json(await getSecuritySetting()); });
  r.put('/security', async (req, res) => {
    const b = parse(SecurityBody, req.body);
    if (b.requireMfa) {
      // Requiring two-factor sign-in before the person turning it on has set it up themselves would lock them out.
      const [a] = await raw<any>('SELECT totp_enabled FROM wfm.platform_admins WHERE id = $1', [req.platformAdmin!.id]);
      if (!(a?.totpEnabled ?? a?.totp_enabled)) throw bad('Set up two-factor sign-in on your own account first (Account page), then require it for everyone.');
    }
    await putSetting('security', b, who(req));
    await audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action: 'UPDATE_SETTINGS', targetEntityType: 'PLATFORM_SETTINGS', targetEntityName: 'Security', ipAddress: ipOf(req), userAgent: ua(req), details: b, status: 'SUCCESS' });
    res.json({ ok: true });
  });

  return r;
}
