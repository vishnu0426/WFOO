import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenant, withWorkspace, raw } from '../db.ts';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, ROLES, me, permissionsFor, requires, revokeToken, signToken, type Principal, type Role, getTenantEnabledModules, PERMISSION_TO_MODULE } from '../auth.ts';
import { checkNewPassword } from '../passwordPolicy.ts';
import { config } from '../config.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, notFound, parse } from '../http.ts';
import { dropCache, redis } from '../infra.ts';
import { assertCapacity } from './licensing/service.ts';

export const publicAuth = Router();
export const authed = Router();

const Login = z.object({ tenant: z.string().optional(), workspace: z.string().optional(), username: z.string().min(1), password: z.string().min(1) });

type WorkspaceMemberRow = {
  id: string; name: string; code: string; slug: string; description: string; timezone: string; currency: string;
  status: 'ACTIVE' | 'ARCHIVED'; isDefault: boolean; role: Role; employeeId: string | null; memberCount: number;
};

const workspaceDto = (w: WorkspaceMemberRow) => ({
  id: w.id, name: w.name, code: w.code, slug: w.slug, description: w.description, timezone: w.timezone, currency: w.currency,
  status: w.status, role: w.role, isDefault: w.isDefault, employeeId: w.employeeId, memberCount: w.memberCount,
});

async function workspacesFor(tenantId: string, userId: string): Promise<WorkspaceMemberRow[]> {
  return withTenant(tenantId, async (tx) => {
    const user = await tx.one<{ role: string }>('SELECT role FROM users WHERE tenant_id = :t AND id = $1', [userId]);
    const isOrgAdmin = user?.role === 'WFM_ADMIN';

    return tx.q<WorkspaceMemberRow>(
      `SELECT w.id, w.name, w.code, w.slug, w.description, w.timezone, w.currency, w.status,
              coalesce(m.is_default, false) AS is_default,
              coalesce(m.role, $2) AS role,
              m.employee_id AS employee_id,
              (SELECT count(*)::int FROM workspace_members x
               WHERE x.tenant_id = w.tenant_id AND x.workspace_id = w.id AND x.status = 'ACTIVE') AS member_count
       FROM workspaces w
       LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.tenant_id = w.tenant_id AND m.user_id = $1 AND m.status = 'ACTIVE'
       WHERE w.tenant_id = :t AND w.status = 'ACTIVE'
         AND ($3::boolean = true OR m.user_id IS NOT NULL)
       ORDER BY coalesce(m.is_default, false) DESC, w.is_default DESC, w.name`,
      [userId, user?.role || 'AGENT', isOrgAdmin]
    );
  });
}

function chooseWorkspace(list: WorkspaceMemberRow[], selector?: string): WorkspaceMemberRow {
  if (!list.length) throw new HttpError(403, 'NO_WORKSPACE', 'You do not have access to an active workspace in this organisation.');
  if (selector) {
    const s = selector.toLowerCase();
    const found = list.find((w) => w.id === selector || w.slug.toLowerCase() === s || w.code.toLowerCase() === s);
    if (!found) throw new HttpError(403, 'WORKSPACE_FORBIDDEN', 'You do not have access to that workspace.');
    return found;
  }
  return list.find((w) => w.isDefault) ?? list.find((w) => w.status === 'ACTIVE') ?? list[0];
}

async function sessionFor(tenantId: string, userId: string, workspaceId?: string) {
  const [tenant] = await raw<{ id: string; name: string; code: string; timezone: string; currency: string; fourEyes: boolean }>('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  const user = await withTenant(tenantId, (tx) => tx.one<any>('SELECT id, username, display_name, email, role, employee_id, must_change_password, default_workspace_id FROM users WHERE tenant_id = :t AND id = $1', [userId]));
  if (!user) throw notFound('User');
  const list = await workspacesFor(tenantId, userId);
  const active = workspaceId ? list.find((w) => w.id === workspaceId) : chooseWorkspace(list);
  if (!active) throw new HttpError(403, 'WORKSPACE_FORBIDDEN', 'You do not have access to that workspace.');
  const role = active.role;
  const perms = [...(await permissionsFor(tenantId, role))].sort();
  const enabledModules = await getTenantEnabledModules(tenantId);
  const org = { id: tenant.id, name: tenant.name, code: tenant.code, timezone: tenant.timezone, currency: tenant.currency, fourEyes: tenant.fourEyes };
  const workspace = workspaceDto(active);
  return {
    user: {
      id: user.id, userName: user.displayName, username: user.username, email: user.email, role,
      tenantId, tenantName: tenant.name, employeeId: active.employeeId ?? user.employeeId,
      orgId: tenantId, orgName: tenant.name, workspaceId: active.id, workspaceName: active.name,
    },
    tenant: org,
    organization: org,
    workspace,
    workspaces: list.map(workspaceDto),
    permissions: perms,
    /** signed in with a temporary password: the app must ask for a new one before anything else */
    mustChangePassword: !!user.mustChangePassword,
    enabledModules,
  };
}

/** A person replaces their own password. Needs the current one, applies the password rules, clears the temporary flag and returns a fresh session. */
export async function changeOwnPassword(p: Principal, req: Request, currentPassword: string, newPassword: string) {
  const limitKey = `wfm:pwchange:${p.userId}`;
  if ((Number(await redis.get(limitKey).catch(() => 0)) || 0) >= 5) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Try again in 15 minutes.');
  const user = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT id, username, display_name, role, password_hash FROM users WHERE tenant_id = :t AND id = $1', [p.userId]));
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    await redis.multi().incr(limitKey).expire(limitKey, 900).exec().catch(() => {});
    throw bad('Current password is incorrect.');
  }
  const problem = checkNewPassword(newPassword, { current: currentPassword, username: user.username });
  if (problem) throw bad(problem);
  await withTenant(p.tenantId, async (tx) => {
    await tx.exec('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE tenant_id = :t AND id = $1', [p.userId, await bcrypt.hash(newPassword, 12)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: p.userId, entityName: user.username, diffSummary: p.mustChangePassword ? 'Replaced a temporary password' : 'Changed their own password' });
  });
  await redis.del(limitKey).catch(() => {});
  if (p.mustChangePassword) await revokeToken(p);          // a temporary-password session ends here; the fresh token below replaces it. A voluntary change leaves the current session alone.
  const token = signToken({ userId: user.id, tenantId: p.tenantId, workspaceId: p.workspaceId, role: p.role, name: user.displayName, username: user.username });
  return { token, ...(await sessionFor(p.tenantId, user.id, p.workspaceId)) };
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
  const workspace = chooseWorkspace(await workspacesFor(tenant.id, user.id), b.workspace);
  const role = workspace.role;
  await withWorkspace(tenant.id, workspace.id, async (tx) => {
    await tx.exec('UPDATE users SET last_login_at = now() WHERE tenant_id = :t AND id = $1', [user.id]);
    if (!user.defaultWorkspaceId) await tx.exec('UPDATE users SET default_workspace_id = $2 WHERE tenant_id = :t AND id = $1', [user.id, workspace.id]);
    await audit(tx, { userId: user.id, tenantId: tenant.id, workspaceId: workspace.id, role, name: user.displayName, username: user.username, jti: '' }, req, { action: 'LOGIN', entityType: 'USER', entityId: user.id, entityName: user.username });
  });
  const token = signToken({ userId: user.id, tenantId: tenant.id, workspaceId: workspace.id, role, name: user.displayName, username: user.username, mustChangePassword: !!user.mustChangePassword });
  res.json({ token, ...(await sessionFor(tenant.id, user.id, workspace.id)) });
});

const CompleteEmergencyReset = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

publicAuth.post('/auth/emergency-reset/complete', async (req, res) => {
  const b = parse(CompleteEmergencyReset, req.body);
  const tokenHash = crypto.createHash('sha256').update(b.token).digest('hex');
  const [resetRow] = await raw<any>(
    `SELECT * FROM wfm.emergency_password_resets 
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  if (!resetRow) {
    throw bad('Invalid or expired emergency reset link');
  }

  const hash = await bcrypt.hash(b.newPassword, 12);
  const targetUserId = resetRow.userId ?? resetRow.user_id;
  const targetTenantId = resetRow.tenantId ?? resetRow.tenant_id;
  await raw(
    `UPDATE wfm.users SET password_hash = $1, status = 'ACTIVE', must_change_password = false WHERE id = $2 AND tenant_id = $3`,
    [hash, targetUserId, targetTenantId]
  );
  await raw(
    `UPDATE wfm.emergency_password_resets SET used_at = now() WHERE id = $1`,
    [resetRow.id]
  );

  res.json({ ok: true, message: 'Password reset successfully. You may now sign in with your new password.' });
});

authed.get('/auth/me', async (req, res) => { const p = me(req); res.json(await sessionFor(p.tenantId, p.userId, p.workspaceId)); });
authed.post('/auth/logout', async (req, res) => { await revokeToken(me(req)); res.json({ ok: true }); });
authed.post('/auth/change-password', async (req, res) => {
  const b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(100) }), req.body);
  res.json(await changeOwnPassword(me(req), req, b.currentPassword, b.newPassword));
});

authed.post('/auth/switch-workspace', async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ workspaceId: z.string().uuid() }), req.body);
  const workspace = chooseWorkspace(await workspacesFor(p.tenantId, p.userId), b.workspaceId);
  const token = signToken({ userId: p.userId, tenantId: p.tenantId, workspaceId: workspace.id, role: workspace.role, name: p.name, username: p.username });
  await withWorkspace(p.tenantId, workspace.id, async (tx) => {
    await tx.exec('UPDATE users SET default_workspace_id = $2 WHERE tenant_id = :t AND id = $1', [p.userId, workspace.id]);
    await tx.exec('UPDATE workspace_members SET is_default = false WHERE tenant_id = :t AND user_id = $1', [p.userId]);
    await tx.exec(
      `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, role, status, is_default)
       VALUES (:t, $2, $1, $3, 'ACTIVE', true)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET is_default = true, status = 'ACTIVE', updated_at = now()`,
      [p.userId, workspace.id, workspace.role]
    );
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SESSION', entityId: p.jti, entityName: 'Workspace switch', diffSummary: `Switched to ${workspace.name}` });
  });
  res.json({ token, ...(await sessionFor(p.tenantId, p.userId, workspace.id)) });
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
    await assertCapacity(tx, p.tenantId, 'USERS', 1);
    const u = await tx.one<any>(
      `INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, employee_id, must_change_password, default_workspace_id)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7::boolean, $8)
       RETURNING id, username, display_name AS user_name, email, role, status, employee_id`,
      [b.username, b.displayName, b.email ?? null, b.role, await bcrypt.hash(b.password, 12), b.employeeId ?? null, config.forcePasswordChange, p.workspaceId || null]);
    if (p.workspaceId) {
      await tx.exec(
        `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, employee_id, role, is_default)
         VALUES (:t, $1, $2, $3, $4, true) ON CONFLICT DO NOTHING`,
        [p.workspaceId, u!.id, b.employeeId ?? null, b.role]);
    }
    await audit(tx, p, req, { action: 'CREATE', entityType: 'USER', entityId: u!.id, entityName: b.username, after: { username: b.username, role: b.role, workspaceId: p.workspaceId } });
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
    if (before.status === 'DISABLED' && b.status === 'ACTIVE') {
      await assertCapacity(tx, p.tenantId, 'USERS', 1);
    }
    const hash = b.password ? await bcrypt.hash(b.password, 12) : null;
    const after = await tx.one<any>(
      `UPDATE users SET display_name = coalesce($2, display_name), email = CASE WHEN $3::boolean THEN $4 ELSE email END, role = coalesce($5, role),
              status = coalesce($6, status), password_hash = coalesce($7, password_hash), must_change_password = must_change_password OR $8::boolean WHERE tenant_id = :t AND id = $1
       RETURNING id, username, display_name AS user_name, email, role, status`,
      [id, b.displayName ?? null, b.email !== undefined, b.email ?? null, b.role ?? null, b.status ?? null, hash, !!hash && id !== p.userId && config.forcePasswordChange]);   // a password set by an administrator is temporary; setting your own is not
    if (b.role) await tx.exec('UPDATE workspace_members SET role = $2, updated_at = now() WHERE tenant_id = :t AND user_id = $1', [id, b.role]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: id, entityName: before.username, before: { role: before.role, status: before.status }, after: { role: after!.role, status: after!.status, passwordReset: !!b.password } });
    return after;
  });
  res.json(out);
});

// ---------------------------------------------------------------- RBAC matrix

authed.get('/rbac/matrix', requires('users:read'), async (req, res) => {
  const p = me(req);
  const enabledModules = await getTenantEnabledModules(p.tenantId);
  const enabledSet = new Set(enabledModules);
  const hasLic = enabledModules.length > 0;

  const rows = await withTenant(p.tenantId, (tx) => tx.q<{ role: string; permission: string }>('SELECT role, permission FROM role_permissions WHERE tenant_id = :t'));
  const byRole: Record<string, string[]> = Object.fromEntries(ROLES.map((r) => [r, [] as string[]]));
  for (const r of rows) {
    const reqMod = PERMISSION_TO_MODULE[r.permission];
    if (!hasLic || !reqMod || enabledSet.has(reqMod)) {
      byRole[r.role]?.push(r.permission);
    }
  }

  const effectiveAllPerms = hasLic
    ? ALL_PERMISSIONS.filter((perm) => {
        const reqMod = PERMISSION_TO_MODULE[perm];
        return !reqMod || enabledSet.has(reqMod);
      })
    : ALL_PERMISSIONS;

  res.json({ roles: ROLES, permissions: effectiveAllPerms, matrix: byRole, defaults: DEFAULT_PERMISSIONS });
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
