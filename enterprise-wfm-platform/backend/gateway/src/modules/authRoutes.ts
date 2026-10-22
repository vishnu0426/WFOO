import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { withTenant, raw } from '../db.ts';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, ROLES, me, permissionsFor, requires, revokeToken, signToken, type Role } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, notFound, parse } from '../http.ts';
import { dropCache, redis } from '../infra.ts';

export const publicAuth = Router();
export const authed = Router();

const Login = z.object({ tenant: z.string().optional(), username: z.string().min(1), password: z.string().min(1) });

async function sessionFor(tenantId: string, userId: string) {
  const [tenant] = await raw<{ id: string; name: string; code: string; timezone: string; currency: string; fourEyes: boolean }>('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  const user = await withTenant(tenantId, (tx) => tx.one<any>('SELECT id, username, display_name, email, role, employee_id FROM users WHERE tenant_id = :t AND id = $1', [userId]));
  if (!user) throw notFound('User');
  const perms = [...(await permissionsFor(tenantId, user.role as Role))].sort();
  return {
    user: { id: user.id, userName: user.displayName, username: user.username, email: user.email, role: user.role, tenantId, tenantName: tenant.name, employeeId: user.employeeId },
    tenant: { id: tenant.id, name: tenant.name, code: tenant.code, timezone: tenant.timezone, currency: tenant.currency, fourEyes: tenant.fourEyes },
    permissions: perms,
  };
}

publicAuth.post('/auth/login', async (req, res) => {
  const b = parse(Login, req.body);
  // brute-force guard: 10 failures per client + username per 15 minutes
  const limitKey = `wfm:login:${req.ip}:${b.username.toLowerCase()}`;
  const tries = Number(await redis.get(limitKey).catch(() => 0)) || 0;
  if (tries >= 10) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-ins. Try again in 15 minutes.');

  const tenants = await raw<{ id: string; code: string }>('SELECT id, code FROM tenants');
  const tenant = b.tenant ? tenants.find((t) => t.code.toLowerCase() === b.tenant!.toLowerCase()) : tenants.length === 1 ? tenants[0] : undefined;
  if (!tenant) throw bad(b.tenant ? 'Unknown organisation' : 'Say which organisation to sign in to (tenant)');

  // a username is derived from the employee number with anything outside a-z0-9._- stripped (see selfAdmin's /logins),
  // so "1002@agnoshin.com" (the employee number, easy to type by habit) and "1002agnoshin.com" (the real username)
  // look almost identical -- accept either, rather than let that trip someone up every time they sign in
  const normalized = b.username.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
  const user = await withTenant(tenant.id, (tx) => tx.one<any>('SELECT * FROM users WHERE tenant_id = :t AND (lower(username) = lower($1) OR lower(username) = $2)', [b.username, normalized]));
  const ok = user && user.status === 'ACTIVE' && (await bcrypt.compare(b.password, user.passwordHash));
  if (!ok) {
    await redis.multi().incr(limitKey).expire(limitKey, 900).exec().catch(() => {});
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }
  await redis.del(limitKey).catch(() => {});
  await withTenant(tenant.id, async (tx) => {
    await tx.exec('UPDATE users SET last_login_at = now() WHERE tenant_id = :t AND id = $1', [user.id]);
    await audit(tx, { userId: user.id, tenantId: tenant.id, role: user.role, name: user.displayName, username: user.username, jti: '' }, req, { action: 'LOGIN', entityType: 'USER', entityId: user.id, entityName: user.username });
  });
  const token = signToken({ userId: user.id, tenantId: tenant.id, role: user.role, name: user.displayName, username: user.username });
  res.json({ token, ...(await sessionFor(tenant.id, user.id)) });
});

authed.get('/auth/me', async (req, res) => { const p = me(req); res.json(await sessionFor(p.tenantId, p.userId)); });
authed.post('/auth/logout', async (req, res) => { await revokeToken(me(req)); res.json({ ok: true }); });

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
      `INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, employee_id) VALUES (:t, $1, $2, $3, $4, $5, $6) RETURNING id, username, display_name AS user_name, email, role, status, employee_id`,
      [b.username, b.displayName, b.email ?? null, b.role, await bcrypt.hash(b.password, 12), b.employeeId ?? null]);
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
    const hash = b.password ? await bcrypt.hash(b.password, 12) : null;
    const after = await tx.one<any>(
      `UPDATE users SET display_name = coalesce($2, display_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END, role = coalesce($5, role),
              status = coalesce($6, status), password_hash = coalesce($7, password_hash) WHERE tenant_id = :t AND id = $1
       RETURNING id, username, display_name AS user_name, email, role, status`,
      [id, b.displayName ?? null, b.email !== undefined, b.email ?? null, b.role ?? null, b.status ?? null, hash]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: id, entityName: before.username, before: { role: before.role, status: before.status }, after: { role: after!.role, status: after!.status, passwordReset: !!b.password } });
    return after;
  });
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
