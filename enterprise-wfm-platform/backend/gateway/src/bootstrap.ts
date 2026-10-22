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

/** Creates the first administrator when the tenant has no users. Returns the password only when it was generated here. */
async function ensureAdmin(tenantId: string): Promise<{ created: boolean; generated?: string }> {
  const b = config.bootstrap;
  const password = b.adminPassword || randomBytes(9).toString('base64url');
  const created = await withTenant(tenantId, async (tx) => {
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE tenant_id = :t');
    if (n > 0) return false;
    await tx.exec(`INSERT INTO users (tenant_id, username, display_name, password_hash, role) VALUES (:t, $1, $2, $3, 'WFM_ADMIN')`, [b.adminUser, 'Administrator', await bcrypt.hash(password, 12)]);
    return true;
  });
  return { created, generated: created && !b.adminPassword ? password : undefined };
}

export async function bootstrapIfEmpty(): Promise<void> {
  const b = config.bootstrap;
  let tenants = await raw<{ id: string }>('SELECT id FROM tenants');
  if (tenants.length === 0) {
    tenants = await raw<{ id: string }>('INSERT INTO tenants (name, code, timezone) VALUES ($1, $2, $3) RETURNING id', [b.tenantName, b.tenantCode, b.timezone]);
  }
  for (const t of tenants) {
    if (await ensureRolePermissions(t.id)) console.log(`[bootstrap] default permission matrix created for tenant ${t.id}`);
    const a = await ensureAdmin(t.id);
    if (a.created) {
      console.log('');
      console.log('================ FIRST-RUN SETUP ================');
      console.log(` Tenant  : ${b.tenantName} (${b.tenantCode}, ${b.timezone})`);
      console.log(` Admin   : ${b.adminUser}`);
      console.log(` Password: ${a.generated ?? '(from BOOTSTRAP_ADMIN_PASSWORD)'}`);
      if (a.generated) console.log(' This password is shown once. Sign in and change it, or set BOOTSTRAP_ADMIN_PASSWORD before the first start.');
      console.log('=================================================');
      console.log('');
    }
  }
}
