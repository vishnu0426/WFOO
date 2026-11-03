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
import { checkNewPassword } from './passwordPolicy.ts';

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
  // the bootstrap password is temporary (changed at first sign-in) unless FORCE_PASSWORD_CHANGE=false, the explicit "throwaway test stack" switch; say so loudly when both are true
  const weak = !!b.adminPassword && checkNewPassword(b.adminPassword, { username: b.adminUser }) !== null;
  // in production a guessable first password, or switching the first-sign-in change off, is a refusal to start, not a warning
  if (process.env.NODE_ENV === 'production' && (weak || !config.forcePasswordChange)) throw new Error('Refusing to start in production: BOOTSTRAP_ADMIN_PASSWORD is too easy to guess, or FORCE_PASSWORD_CHANGE=false is set. Choose a strong BOOTSTRAP_ADMIN_PASSWORD (or leave it unset to get a generated one) and leave FORCE_PASSWORD_CHANGE on.');
  if (weak && !config.forcePasswordChange) console.warn('[bootstrap] BOOTSTRAP_ADMIN_PASSWORD is too easy to guess and a password change is not forced (FORCE_PASSWORD_CHANGE=false). Fine for a test stack, never for production.');
  const created = await withTenant(tenantId, async (tx) => {
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE tenant_id = :t');
    if (n > 0) return false;
    await tx.exec(`INSERT INTO users (tenant_id, username, display_name, password_hash, role, must_change_password) VALUES (:t, $1, $2, $3, 'WFM_ADMIN', $4::boolean)`, [b.adminUser, 'Administrator', await bcrypt.hash(password, 12), config.forcePasswordChange]);
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
      if (a.generated) console.log(' This password is shown once. Set BOOTSTRAP_ADMIN_PASSWORD before the first start if you want to choose it.');
      if (config.forcePasswordChange) console.log(' You will be asked to choose your own password the first time you sign in.');
      console.log('=================================================');
      console.log('');
    }
  }
}
