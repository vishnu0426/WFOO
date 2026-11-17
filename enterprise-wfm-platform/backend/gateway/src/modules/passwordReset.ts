/**
 * "Forgot my password" without an administrator. The person gives their organisation and username, asks for a one-time code by email or SMS (whichever
 * the organisation allows), types the code with a new password, and signs in. The code is six digits, works once, expires in ten minutes and is burned
 * after five wrong guesses. Nothing here says whether an account exists: a request always gets the same answer.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { raw, withTenant } from '../db.ts';
import { HttpError, bad, parse } from '../http.ts';
import { config } from '../config.ts';
import { redis } from '../infra.ts';
import { audit } from '../audit.ts';
import { dropUserState } from '../auth.ts';
import { hashPassword } from '../passwordHash.ts';
import { checkNewPassword } from '../passwordPolicy.ts';
import { deliver, loadSettings } from './channels.ts';
import { ORG_REQUIRED_MSG, ORG_UNKNOWN_MSG } from './orgLogin.ts';
import { BAD_CODE, CODE_MINUTES, MAX_CODES_PER_HOUR, MAX_CODE_TRIES, REQUEST_ANSWER, RESEND_SECONDS, codeMatches, hashCode, makeCode, messageFor, pickChannel, usableChannels, type ResetMethod } from './passwordResetLogic.ts';

export const passwordResetPublic = Router();

async function allow(req: Request, what: string, max: number) {
  const key = `wfm:${what}:${req.ip}`;
  const n = Number(await redis.get(key).catch(() => 0)) || 0;
  if (n >= max) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many tries from this device. Wait a few minutes and try again.');
  await redis.multi().incr(key).expire(key, 900).exec().catch(() => {});
}

const Who = z.object({ tenant: z.string().trim().max(60).optional(), username: z.string().trim().min(1).max(200) });

async function tenantOf(code?: string) {
  const tenants = await raw<{ id: string; code: string; name: string }>('SELECT id, code, name FROM tenants');
  const t = code ? tenants.find((x) => x.code.toLowerCase() === code.toLowerCase()) : tenants.length === 1 ? tenants[0] : undefined;
  if (!t) throw code ? new HttpError(400, 'ORG_UNKNOWN', ORG_UNKNOWN_MSG) : new HttpError(400, 'ORG_REQUIRED', ORG_REQUIRED_MSG);
  return t;
}

/** The same lookup sign-in uses: the username, the username with odd characters dropped, or a work email that names exactly one account. */
async function findUser(tenantId: string, name: string) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  const sel = 'SELECT u.id, u.username, u.display_name, u.role, u.status, u.default_workspace_id, u.email, e.email AS emp_email, e.phone FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.tenant_id = :t';
  let u = await withTenant(tenantId, (tx) => tx.one<any>(`${sel} AND (lower(u.username) = lower($1) OR lower(u.username) = $2)`, [name, normalized]));
  if (!u && name.includes('@')) {
    const byEmail = await withTenant(tenantId, (tx) => tx.q<any>(`${sel} AND lower(u.email) = lower($1) LIMIT 2`, [name]));
    if (byEmail.length === 1) u = byEmail[0];
  }
  return u as { id: string; username: string; displayName: string; role: string; status: string; defaultWorkspaceId: string | null; email: string | null; empEmail: string | null; phone: string | null } | undefined;
}
const asUser = (tenantId: string, u: { id: string; role: string; displayName: string; username: string; defaultWorkspaceId: string | null }) =>
  ({ userId: u.id, tenantId, workspaceId: u.defaultWorkspaceId ?? '', role: u.role as any, name: u.displayName, username: u.username, jti: '' });

/** What the sign-in screen needs to decide whether to offer "Forgot your password?" and which choices to show. */
passwordResetPublic.post('/auth/password-reset/options', async (req, res) => {
  await allow(req, 'pwreset-options', 60);
  const b = parse(z.object({ tenant: z.string().trim().max(60).optional() }), req.body ?? {});
  const t = await tenantOf(b.tenant);
  const s = await loadSettings(t.id);
  const method = (s.passwordReset ?? 'OFF') as ResetMethod;
  res.json({ channels: method === 'OFF' ? [] : usableChannels(method, s.email.enabled, s.sms.enabled) });
});

passwordResetPublic.post('/auth/password-reset/request', async (req, res) => {
  const b = parse(Who.extend({ channel: z.enum(['EMAIL', 'SMS']).optional() }), req.body);
  await allow(req, 'pwreset-request', 10);
  const t = await tenantOf(b.tenant);
  const s = await loadSettings(t.id);
  const method = (s.passwordReset ?? 'OFF') as ResetMethod;
  const usable = method === 'OFF' ? [] : usableChannels(method, s.email.enabled, s.sms.enabled);
  if (!usable.length) throw new HttpError(403, 'NOT_AVAILABLE', 'Your organisation has not turned on password reset by email or SMS. Ask your administrator for a new temporary password.');
  const channel = pickChannel(usable, b.channel);
  if (!channel) throw bad(b.channel ? 'That way of getting a code is not available. Choose another.' : 'Choose whether to get the code by email or by SMS.');

  const u = await findUser(t.id, b.username);
  const to = !u ? null : channel === 'EMAIL' ? (u.email || u.empEmail) : (u.phone ? u.phone.replace(/[^\d+]/g, '') : null);
  const sso = u ? await withTenant(t.id, (tx) => tx.one<{ enabled: boolean; passwordLogin: boolean }>('SELECT enabled, password_login FROM sso_providers WHERE tenant_id = :t')) : null;
  const ssoOnly = !!(sso?.enabled && !sso.passwordLogin && u?.role !== 'WFM_ADMIN');   // their password is not how they sign in
  if (u && to && u.status === 'ACTIVE' && !ssoOnly) {
    const recent = (await raw<{ n: number; last: number }>("SELECT count(*)::int AS n, coalesce(extract(epoch FROM now() - max(created_at)), 99999)::float8 AS last FROM password_reset_codes WHERE user_id = $1 AND created_at > now() - interval '1 hour'", [u.id]))[0];
    if (recent.last >= RESEND_SECONDS && recent.n < MAX_CODES_PER_HOUR) {
      const code = makeCode();
      await raw('UPDATE password_reset_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [u.id]);     // a new code replaces any earlier one
      const [row] = await raw<{ id: string }>("INSERT INTO password_reset_codes (org_id, user_id, channel, code_hash, expires_at, ip) VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval, $6) RETURNING id", [t.id, u.id, channel, hashCode(code, u.id, config.jwtSecret), String(CODE_MINUTES), req.ip ?? null]);
      const m = messageFor(channel, t.name, code);
      const sent = await deliver(t.id, s, { channel, to: to!, subject: m.subject, body: m.body });       // sent now, not queued: a queued copy would keep the code in the outbox
      if (!sent.ok) { await raw('UPDATE password_reset_codes SET used_at = now() WHERE id = $1', [row.id]); console.error(`[password-reset] ${channel} for a ${t.code} user failed: ${sent.error}`); }
      const how = channel === 'EMAIL' ? 'email' : 'SMS';
      await withTenant(t.id, (tx) => audit(tx, asUser(t.id, u), req, { action: 'UPDATE', entityType: 'USER', entityId: u.id, entityName: u.username, diffSummary: `Asked for a password reset code by ${how}${sent.ok ? '' : '; it could not be sent'}` })).catch(() => {});
    }
  }
  res.json({ ok: true, message: REQUEST_ANSWER, resendSeconds: RESEND_SECONDS });
});

passwordResetPublic.post('/auth/password-reset/confirm', async (req, res) => {
  const b = parse(Who.extend({ code: z.string().trim().regex(/^[\d\s]{6,8}$/, 'The code is six digits.'), newPassword: z.string().min(1).max(100) }), req.body);
  await allow(req, 'pwreset-confirm', 20);
  const t = await tenantOf(b.tenant);
  const u = await findUser(t.id, b.username);
  const row = u ? (await raw<any>('SELECT * FROM password_reset_codes WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [u.id]))[0] : null;
  if (!u || !row || u.status !== 'ACTIVE') throw bad(BAD_CODE);
  if (!codeMatches(b.code, row.codeHash, u.id, config.jwtSecret)) {
    const [r] = await raw<{ attempts: number }>('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [row.id]);
    if (r && r.attempts >= MAX_CODE_TRIES) await raw('UPDATE password_reset_codes SET used_at = now() WHERE id = $1', [row.id]);       // too many guesses: ask for a new code
    throw bad(BAD_CODE);
  }
  const problem = checkNewPassword(b.newPassword, { username: u.username });
  if (problem) throw bad(problem);                           // a correct code is not used up by a password that is too weak
  const claimed = await raw('UPDATE password_reset_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id]);
  if (!claimed.length) throw bad(BAD_CODE);                  // someone else used it a moment ago
  await withTenant(t.id, async (tx) => {
    await tx.exec('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE tenant_id = :t AND id = $1', [u.id, await hashPassword(b.newPassword, 12)]);
    await audit(tx, asUser(t.id, u), req, { action: 'UPDATE', entityType: 'USER', entityId: u.id, entityName: u.username, diffSummary: `Reset their own password with a code sent by ${row.channel === 'EMAIL' ? 'email' : 'SMS'}` });
  });
  await dropUserState(t.id, u.id);
  await redis.del(`wfm:login:${req.ip}:${u.username.toLowerCase()}`).catch(() => {});
  res.json({ ok: true });
});
