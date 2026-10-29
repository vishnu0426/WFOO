/**
 * First run: create the tenant, its role permission matrix and an admin user. Nothing else is seeded:
 * no queues, history, forecasts or people. The admin password comes from the environment or is generated and printed once.
 * Every step is idempotent, so an interrupted first run is repaired on the next start.
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { raw, withTenant } from './db.ts';
import { DEFAULT_PERMISSIONS, ROLES } from './auth.ts';

/** Seeds the default role -> permission matrix for a tenant that has none. */
export async function ensureRolePermissions(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM role_permissions WHERE tenant_id = :t');
    if (n > 0) return false;
    for (const role of ROLES) for (const p of new Set(DEFAULT_PERMISSIONS[role])) await tx.exec('INSERT INTO role_permissions (tenant_id, role, permission) VALUES (:t, $1, $2)', [role, p]);
    return true;
  });
}

/** Every organisation needs a licence row (seat limits are checked against it). The migration backfills tenants that already exist; this covers one created on a fresh install. */
export async function ensureLicense(tenantId: string): Promise<boolean> {
  const [have] = await raw<{ id: string }>('SELECT id FROM wfm.licenses WHERE tenant_id = $1 LIMIT 1', [tenantId]);
  if (have) return false;
  const [t] = await raw<{ code: string }>('SELECT code FROM wfm.tenants WHERE id = $1', [tenantId]);
  const key = `LIC-${t.code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}-${new Date().getFullYear()}-${1000 + Math.floor(Math.random() * 9000)}`;
  const [lic] = await raw<{ id: string }>(
    `INSERT INTO wfm.licenses (license_key, tenant_id, plan_tier, edition, status, start_date, end_date, renewal_date, grace_period_days, max_employees, max_users, max_supervisors, max_sites, max_workspaces)
     VALUES ($1, $2, 'ENTERPRISE', 'WFM_ENTERPRISE', 'ACTIVE', now(), now() + interval '1 year', now() + interval '1 year', 14, 500, 100, 25, 10, 5) RETURNING id`, [key, tenantId]);
  for (const m of ['FORECASTING', 'SCHEDULING', 'INTRADAY', 'ADHERENCE', 'TIME_OFF', 'SHIFT_BIDDING', 'EMPLOYEE_SELF_SERVICE', 'REPORTING', 'AI_COPILOT'])
    await raw('INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING', [lic.id, tenantId, m]);
  return true;
}

/** Every organisation gets one default workspace, and every user a membership in it. */
async function ensureDefaultWorkspace(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    await tx.exec('INSERT INTO organization_settings (tenant_id) VALUES (:t) ON CONFLICT (tenant_id) DO NOTHING');
    await tx.exec(
      `INSERT INTO workspaces (tenant_id, name, code, slug, timezone, currency, is_default, status, created_by)
       SELECT :t, 'Default Workspace', 'DEFAULT', 'default', t.timezone, t.currency, true, 'ACTIVE', NULL
       FROM tenants t WHERE t.id = :t AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.tenant_id = :t)`);
    let w = await tx.one<{ id: string }>('SELECT id FROM workspaces WHERE tenant_id = :t AND is_default LIMIT 1');
    if (!w) {
      w = await tx.one<{ id: string }>('SELECT id FROM workspaces WHERE tenant_id = :t ORDER BY created_at LIMIT 1');
      if (w) await tx.exec('UPDATE workspaces SET is_default = true, updated_at = now() WHERE tenant_id = :t AND id = $1', [w.id]);
    }
    return w!.id;
  });
}

/** Creates the first administrator when the tenant has no users. Returns the password only when it was generated here. */
async function ensureAdmin(tenantId: string, workspaceId: string): Promise<{ created: boolean; generated?: string }> {
  const b = config.bootstrap;
  const password = b.adminPassword || randomBytes(9).toString('base64url');
  const created = await withTenant(tenantId, async (tx) => {
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE tenant_id = :t');
    if (n > 0) return false;
    const user = await tx.one<{ id: string }>(
      `INSERT INTO users (tenant_id, username, display_name, password_hash, role, must_change_password, default_workspace_id)
       VALUES (:t, $1, $2, $3, 'WFM_ADMIN', $4::boolean, $5) RETURNING id`,
      [b.adminUser, 'Administrator', await bcrypt.hash(password, 12), config.forcePasswordChange, workspaceId]);
    await tx.exec(
      `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, role, is_default)
       VALUES (:t, $1, $2, 'WFM_ADMIN', true) ON CONFLICT DO NOTHING`, [workspaceId, user!.id]);
    return true;
  });
  return { created, generated: created && !b.adminPassword ? password : undefined };
}

async function ensureMemberships(tenantId: string, workspaceId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.exec(
      `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, employee_id, role, status, is_default)
       SELECT :t, $1, u.id, u.employee_id, u.role, 'ACTIVE', true
       FROM users u
       WHERE u.tenant_id = :t AND u.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.tenant_id = :t AND m.user_id = u.id)
       ON CONFLICT DO NOTHING`, [workspaceId]);
    await tx.exec('UPDATE users SET default_workspace_id = $1 WHERE tenant_id = :t AND default_workspace_id IS NULL', [workspaceId]);
  });
}

export async function ensurePlatformSuperAdmin(): Promise<void> {
  const email = (config.platformAdmin.email || '').trim().toLowerCase();
  const password = config.platformAdmin.password;
  if (!email || !password) return;
  const hash = await bcrypt.hash(password, 12);
  await raw(
    `INSERT INTO wfm.platform_admins (email, password_hash, status)
     VALUES ($1, $2, 'ACTIVE')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'ACTIVE', updated_at = now()`,
    [email, hash]
  );
  console.log(`[bootstrap] Super Admin account ensured for "${email}"`);
}

export async function bootstrapIfEmpty(): Promise<void> {
  await ensurePlatformSuperAdmin();
  const b = config.bootstrap;
  let tenants = await raw<{ id: string }>('SELECT id FROM tenants');
  if (tenants.length === 0) {
    tenants = await raw<{ id: string }>('INSERT INTO tenants (name, code, timezone) VALUES ($1, $2, $3) RETURNING id', [b.tenantName, b.tenantCode, b.timezone]);
  }
  for (const t of tenants) {
    if (await ensureRolePermissions(t.id)) console.log(`[bootstrap] default permission matrix created for tenant ${t.id}`);
    if (await ensureLicense(t.id)) console.log(`[bootstrap] default licence created for tenant ${t.id}`);
    const workspaceId = await ensureDefaultWorkspace(t.id);
    const a = await ensureAdmin(t.id, workspaceId);
    await ensureMemberships(t.id, workspaceId);
    if (a.created) {
      console.log('');
      console.log('================ FIRST-RUN SETUP ================');
      console.log(` Tenant  : ${b.tenantName} (${b.tenantCode}, ${b.timezone})`);
      console.log(` Admin   : ${b.adminUser}`);
      console.log(` Password: ${a.generated ?? '(from BOOTSTRAP_ADMIN_PASSWORD)'}`);
      if (a.generated) console.log(' This password is shown once. Set BOOTSTRAP_ADMIN_PASSWORD before the first start if you want to choose it.');
      if (config.forcePasswordChange) console.log(' You will be asked to choose your own password the first time you sign in.');
      console.log('=================================================');
      console.log('');
    }
  }
}
