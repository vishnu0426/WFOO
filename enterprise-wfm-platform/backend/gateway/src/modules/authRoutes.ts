import { Router, type Request } from 'express';
import { checkPassword, hashPassword } from '../passwordHash.ts';
import { z } from 'zod';
import { withTenant, raw } from '../db.ts';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, ROLES, dropUserState, me, permissionsFor, requires, revokeToken, signToken, type Principal, type Role } from '../auth.ts';
import { checkNewPassword } from '../passwordPolicy.ts';
import { config } from '../config.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, notFound, parse } from '../http.ts';
import { dropCache, redis } from '../infra.ts';
import { discoveryOn, DISCOVERY_OFF_MSG, ORG_REQUIRED_MSG, ORG_UNKNOWN_MSG, validOrgCode } from './orgLogin.ts';

export const publicAuth = Router();
export const authed = Router();

const DUMMY_HASH = '$2b$12$bDvbNw7qj/0du6DHal8lJumzGh/JvA/5XCy91sJfOuCVHATP9E73G';   // a cost-12 hash of nothing anyone knows: a sign-in for a name that does not exist still costs one comparison
const Login = z.object({ tenant: z.string().optional(), username: z.string().min(1), password: z.string().min(1) });

async function sessionFor(tenantId: string, userId: string) {
  const [tenant] = await raw<{ id: string; name: string; code: string; timezone: string; currency: string; fourEyes: boolean }>('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  const user = await withTenant(tenantId, (tx) => tx.one<any>('SELECT id, username, display_name, email, role, employee_id, must_change_password FROM users WHERE tenant_id = :t AND id = $1', [userId]));
  if (!user) throw notFound('User');
  const perms = [...(await permissionsFor(tenantId, user.role as Role))].sort();
  return {
    user: { id: user.id, userName: user.displayName, username: user.username, email: user.email, role: user.role, tenantId, tenantName: tenant.name, employeeId: user.employeeId },
    tenant: { id: tenant.id, name: tenant.name, code: tenant.code, timezone: tenant.timezone, currency: tenant.currency, fourEyes: tenant.fourEyes },
    permissions: perms,
    /** signed in with a temporary password: the app must ask for a new one before anything else */
    mustChangePassword: !!user.mustChangePassword,
  };
}

/** A person replaces their own password. Needs the current one, applies the password rules, clears the temporary flag and returns a fresh session. */
export async function changeOwnPassword(p: Principal, req: Request, currentPassword: string, newPassword: string) {
  const limitKey = `wfm:pwchange:${p.userId}`;
  if ((Number(await redis.get(limitKey).catch(() => 0)) || 0) >= 5) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again in 15 minutes.');
  const user = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT id, username, display_name, role, password_hash FROM users WHERE tenant_id = :t AND id = $1', [p.userId]));
  if (!user || !(await checkPassword(currentPassword, user.passwordHash))) {
    await redis.multi().incr(limitKey).expire(limitKey, 900).exec().catch(() => {});
    throw bad('Current password is incorrect.');
  }
  const problem = checkNewPassword(newPassword, { current: currentPassword, username: user.username });
  if (problem) throw bad(problem);
  await withTenant(p.tenantId, async (tx) => {
    await tx.exec('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE tenant_id = :t AND id = $1', [p.userId, await hashPassword(newPassword, 12)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: p.userId, entityName: user.username, diffSummary: p.mustChangePassword ? 'Replaced a temporary password' : 'Changed their own password' });
  });
  await redis.del(limitKey).catch(() => {});
  await dropUserState(p.tenantId, p.userId);
  if (p.mustChangePassword) await revokeToken(p);          // a temporary-password session ends here; the fresh token below replaces it. A voluntary change leaves the current session alone.
  const token = signToken({ userId: user.id, tenantId: p.tenantId, role: user.role, name: user.displayName, username: user.username });
  return { token, ...(await sessionFor(p.tenantId, user.id)) };
}


// ---------------------------------------------------------------- signing in without knowing the organisation code

/** A few lookups per address per quarter of an hour: enough for a person, too few for someone guessing codes or email addresses. */
async function allow(req: Request, what: string, max: number) {
  const key = `wfm:${what}:${req.ip}`;
  const n = Number(await redis.get(key).catch(() => 0)) || 0;
  if (n >= max) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many tries from this device. Wait a few minutes and try again.');
  await redis.multi().incr(key).expire(key, 900).exec().catch(() => {});
}

/** What the sign-in screen needs before anyone types: whether there is only one organisation (then no code is needed), and whether email lookup is on. */
publicAuth.get('/auth/login-options', async (req, res) => {
  await allow(req, 'login-options', 60);                 // anyone can ask, so it is limited like the other lookups
  const tenants = await raw<{ code: string; name: string }>('SELECT code, name FROM tenants ORDER BY name');
  // the organisation's name is only given out while lookups are switched on (LOGIN_DISCOVERY=false keeps it private; the sign-in screen then asks for the code)
  res.json({ singleOrganisation: tenants.length === 1 && discoveryOn() ? { code: tenants[0].code, name: tenants[0].name } : null, discovery: discoveryOn() });
});

/** Is this a real organisation code? Used when the code comes from a link, a web address or the last sign-in on the device. Says only its name. */
publicAuth.get('/auth/org/:code', async (req, res) => {
  await allow(req, 'org', 60);
  const code = String(req.params.code ?? '');
  const t = validOrgCode(code) ? (await raw<{ code: string; name: string }>('SELECT code, name FROM tenants WHERE lower(code) = lower($1)', [code.trim()]))[0] : undefined;
  if (!t) throw new HttpError(404, 'ORG_UNKNOWN', ORG_UNKNOWN_MSG);
  res.json({ code: t.code, name: t.name });
});

/**
 * "Find my organisation": the person types their work email (or username) and gets the organisations that have an active account for it, to choose from.
 * It does reveal that an account exists to whoever asks, so it is rate limited and can be switched off with LOGIN_DISCOVERY=false.
 */
publicAuth.post('/auth/discover', async (req, res) => {
  if (!discoveryOn()) throw new HttpError(404, 'NOT_AVAILABLE', DISCOVERY_OFF_MSG);
  const b = parse(z.object({ identifier: z.string().trim().min(3).max(120) }), req.body);
  await allow(req, 'discover', 15);
  const id = b.identifier.toLowerCase(), normalized = id.replace(/[^a-z0-9._-]+/g, '');
  const found: { code: string; name: string }[] = [];
  for (const t of await raw<{ id: string; code: string; name: string }>('SELECT id, code, name FROM tenants ORDER BY name')) {
    const hit = await withTenant(t.id, (tx) => tx.one<{ id: string }>(`SELECT id FROM users WHERE tenant_id = :t AND status = 'ACTIVE' AND (lower(email) = $1 OR lower(username) = $1 OR lower(username) = $2) LIMIT 1`, [id, normalized]));
    if (hit) found.push({ code: t.code, name: t.name });
  }
  res.json({ organisations: found });
});

publicAuth.post('/auth/login', async (req, res) => {
  const b = parse(Login, req.body);
  // brute-force guard: 10 failures per client + username per 15 minutes
  const limitKey = `wfm:login:${req.ip}:${b.username.toLowerCase()}`;
  const tries = Number(await redis.get(limitKey).catch(() => 0)) || 0;
  if (tries >= 10) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-ins. Try again in 15 minutes.');

  const tenants = await raw<{ id: string; code: string }>('SELECT id, code FROM tenants');
  const tenant = b.tenant ? tenants.find((t) => t.code.toLowerCase() === b.tenant!.toLowerCase()) : tenants.length === 1 ? tenants[0] : undefined;
  if (!tenant) throw b.tenant ? new HttpError(400, 'ORG_UNKNOWN', ORG_UNKNOWN_MSG) : new HttpError(400, 'ORG_REQUIRED', ORG_REQUIRED_MSG);

  // a username is derived from the employee number with anything outside a-z0-9._- stripped (see selfAdmin's /logins),
  // so "1002@agnoshin.com" (the employee number, easy to type by habit) and "1002agnoshin.com" (the real username)
  // look almost identical -- accept either, rather than let that trip someone up every time they sign in
  const normalized = b.username.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  let user = await withTenant(tenant.id, (tx) => tx.one<any>('SELECT * FROM users WHERE tenant_id = :t AND (lower(username) = lower($1) OR lower(username) = $2)', [b.username, normalized]));
  // a work email works as a username too, so the person who found their organisation by email can carry on with it; only when it names exactly one account
  if (!user && b.username.includes('@')) {
    const byEmail = await withTenant(tenant.id, (tx) => tx.q<any>('SELECT * FROM users WHERE tenant_id = :t AND lower(email) = lower($1) LIMIT 2', [b.username.trim()]));
    if (byEmail.length === 1) user = byEmail[0];
  }
  // an organisation can require single sign-on; the administrator keeps a password so a broken identity provider cannot lock everyone out
  const sso = await withTenant(tenant.id, (tx) => tx.one<{ enabled: boolean; passwordLogin: boolean }>('SELECT enabled, password_login FROM sso_providers WHERE tenant_id = :t'));
  if (sso?.enabled && !sso.passwordLogin && user && user.role !== 'WFM_ADMIN') throw new HttpError(403, 'SSO_REQUIRED', 'Your organisation uses single sign-on. Use the single sign-on button.');
  // always run one bcrypt comparison, so the time taken does not tell an outsider whether the username exists
  const compared = await checkPassword(b.password, user?.passwordHash ?? DUMMY_HASH);
  const ok = user && user.status === 'ACTIVE' && compared;
  if (!ok) {
    await redis.multi().incr(limitKey).expire(limitKey, 900).exec().catch(() => {});
    // failed attempts are evidence for security reviews: record them (and the lock-out) against the account when there is one
    if (user) await withTenant(tenant.id, (tx) => audit(tx, { userId: user.id, tenantId: tenant.id, role: user.role, name: user.displayName, username: user.username, jti: '' }, req, { action: 'LOGIN_FAILED', entityType: 'USER', entityId: user.id, entityName: user.username, after: { reason: user.status !== 'ACTIVE' ? 'account disabled' : 'wrong password', attempt: tries + 1 } })).catch(() => {});
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }
  await redis.del(limitKey).catch(() => {});
  await withTenant(tenant.id, async (tx) => {
    await tx.exec('UPDATE users SET last_login_at = now() WHERE tenant_id = :t AND id = $1', [user.id]);
    await audit(tx, { userId: user.id, tenantId: tenant.id, role: user.role, name: user.displayName, username: user.username, jti: '' }, req, { action: 'LOGIN', entityType: 'USER', entityId: user.id, entityName: user.username });
  });
  const token = signToken({ userId: user.id, tenantId: tenant.id, role: user.role, name: user.displayName, username: user.username, mustChangePassword: !!user.mustChangePassword });
  res.json({ token, ...(await sessionFor(tenant.id, user.id)) });
});

authed.get('/auth/me', async (req, res) => { const p = me(req); res.json(await sessionFor(p.tenantId, p.userId)); });
authed.post('/auth/logout', async (req, res) => { await revokeToken(me(req)); res.json({ ok: true }); });
authed.post('/auth/change-password', async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(100) }), req.body);
  res.json(await changeOwnPassword(me(req), req, b.currentPassword, b.newPassword));
});

// ---------------------------------------------------------------- users (admin)

const NewUser = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  displayName: z.string().min(1).max(120),
  email: z.string().email().optional(),
  role: z.enum(ROLES),
  employeeId: z.string().uuid().optional(),
  password: z.string().min(8, 'must be at least 8 characters'),
});
const UserPatch = z.object({
  displayName: z.string().min(1).max(120).optional(), email: z.string().email().nullable().optional(),
  role: z.enum(ROLES).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), password: z.string().min(8).optional(),
});

authed.get('/users', requires('users:read'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, (tx) => tx.q('SELECT id, username, display_name AS user_name, email, role, status, employee_id, created_at, last_login_at FROM users WHERE tenant_id = :t ORDER BY username')));
});

authed.post('/users', requires('users:write'), async (req, res) => {
  const p = me(req), b = parse(NewUser, req.body);
  const created = await withTenant(p.tenantId, async (tx) => {
    const u = await tx.one<any>(
      `INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, employee_id, must_change_password) VALUES (:t, $1, $2, $3, $4, $5, $6, $7::boolean) RETURNING id, username, display_name AS user_name, email, role, status, employee_id`,
      [b.username, b.displayName, b.email ?? null, b.role, await hashPassword(b.password, 12), b.employeeId ?? null, config.forcePasswordChange]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'USER', entityId: u!.id, entityName: b.username, after: { username: b.username, role: b.role } });
    return u;
  });
  res.status(201).json(created);
});

authed.patch('/users/:id', requires('users:write'), async (req, res) => {
  const p = me(req), b = parse(UserPatch, req.body), id = String(req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT id, username, display_name, email, role, status FROM users WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('User');
    if (id === p.userId && (b.role && b.role !== before.role || b.status === 'DISABLED')) throw bad('You cannot change your own role or disable your own account');
    const hash = b.password ? await hashPassword(b.password, 12) : null;
    const after = await tx.one<any>(
      `UPDATE users SET display_name = coalesce($2, display_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END, role = coalesce($5, role),
              status = coalesce($6, status), password_hash = coalesce($7, password_hash), must_change_password = must_change_password OR $8::boolean WHERE tenant_id = :t AND id = $1
       RETURNING id, username, display_name AS user_name, email, role, status`,
      [id, b.displayName ?? null, b.email !== undefined, b.email ?? null, b.role ?? null, b.status ?? null, hash, !!hash && id !== p.userId && config.forcePasswordChange]);   // a password set by an administrator is temporary; setting your own is not
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: id, entityName: before.username, before: { role: before.role, status: before.status }, after: { role: after!.role, status: after!.status, passwordReset: !!b.password } });
    return after;
  });
  await dropUserState(p.tenantId, id);
  res.json(out);
});

// ---------------------------------------------------------------- RBAC matrix

authed.get('/rbac/matrix', requires('users:read'), async (req, res) => {
  const p = me(req);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<{ role: string; permission: string }>('SELECT role, permission FROM role_permissions WHERE tenant_id = :t'));
  const byRole: Record<string, string[]> = Object.fromEntries(ROLES.map((r) => [r, [] as string[]]));
  for (const r of rows) byRole[r.role]?.push(r.permission);
  res.json({ roles: ROLES, permissions: ALL_PERMISSIONS, matrix: byRole, defaults: DEFAULT_PERMISSIONS });
});

authed.put('/rbac/matrix/:role', requires('users:write'), async (req, res) => {
  const p = me(req);
  const role = parse(z.enum(ROLES), req.params.role);
  const perms = parse(z.object({ permissions: z.array(z.string().refine((x) => ALL_PERMISSIONS.includes(x), 'unknown permission')) }), req.body).permissions;
  if (role === 'WFM_ADMIN' && !['users:read', 'users:write'].every((x) => perms.includes(x))) throw bad('WFM_ADMIN must keep users:read and users:write, otherwise nobody can manage access');
  await withTenant(p.tenantId, async (tx) => {
    const before = (await tx.q<{ permission: string }>('SELECT permission FROM role_permissions WHERE tenant_id = :t AND role = $1', [role])).map((r) => r.permission);
    await tx.exec('DELETE FROM role_permissions WHERE tenant_id = :t AND role = $1', [role]);
    for (const perm of perms) await tx.exec('INSERT INTO role_permissions (tenant_id, role, permission) VALUES (:t, $1, $2)', [role, perm]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROLE', entityId: role, entityName: role, before, after: perms });
  });
  await dropCache(p.tenantId, 'perms:*');
  res.json({ role, permissions: perms });
});
