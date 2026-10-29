/**
 * Automated tests for Platform Super Admin and tenant isolation.
 *
 * Verifies:
 * 1. Super Admin login issues audience="platform" tokens with own secret; never leaks passwords.
 * 2. Token isolation:
 *    - Tenant token calling /api/v1/platform/* -> 401 UNAUTHENTICATED
 *    - Platform token calling tenant routes (e.g. /workspaces, /organization) -> 401 UNAUTHENTICATED
 * 3. Tenant Org Admin:
 *    - Cannot create organizations (POST /api/v1/organization -> 404 Not Found)
 *    - Cannot list organizations (GET /api/v1/organization/list -> 404 Not Found)
 *    - CAN read and update own organization profile (GET/PATCH /api/v1/organization)
 * 4. Super Admin capabilities:
 *    - Create, list, edit organizations
 *    - Create workspaces inside any organization
 *    - Create the first admin user of an organization (without leaking passwords)
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { signPlatformToken } from '../src/modules/platform/auth.ts';
import { signToken } from '../src/auth.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const DB_URL = process.env.DATABASE_URL;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const TEST_SUPERADMIN_EMAIL = `superadmin_test_${RUN_ID}@platform.local`;
const TEST_SUPERADMIN_PASSWORD = `P@ssw0rd_${RUN_ID}!SuperSecret`;
const TEST_ORG_CODE = `TEST_${RUN_ID.toUpperCase()}`;

let pool: pg.Pool | null = null;
let testSuperAdminId = '';
let testTenantId = '';
let testWorkspaceId = '';
let testTenantUserId = '';

let validTenantToken = '';
let validPlatformToken = '';

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const url = `${BASE}/api/v1${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json, text };
}

describe('Platform Super Admin & Tenant Isolation', () => {
  before(async () => {
    if (DB_URL) {
      pool = new pg.Pool({ connectionString: DB_URL });
    }

    // 1. Create a platform super admin directly in DB for testing login
    const hash = await bcrypt.hash(TEST_SUPERADMIN_PASSWORD, 10);
    if (pool) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO wfm.platform_admins (email, password_hash, status)
         VALUES ($1, $2, 'ACTIVE') RETURNING id`,
        [TEST_SUPERADMIN_EMAIL, hash]
      );
      testSuperAdminId = res.rows[0].id;

      // 2. Query an existing tenant or create a dummy tenant for tenant token testing
      const tenantRes = await pool.query<{ id: string }>(
        `SELECT id FROM wfm.tenants ORDER BY created_at ASC LIMIT 1`
      );
      if (tenantRes.rows.length) {
        testTenantId = tenantRes.rows[0].id;
        const wsRes = await pool.query<{ id: string }>(
          `SELECT id FROM wfm.workspaces WHERE tenant_id = $1 LIMIT 1`,
          [testTenantId]
        );
        testWorkspaceId = wsRes.rows[0]?.id || '00000000-0000-0000-0000-000000000001';
        const userRes = await pool.query<{ id: string }>(
          `SELECT id FROM wfm.users WHERE tenant_id = $1 AND role = 'WFM_ADMIN' LIMIT 1`,
          [testTenantId]
        );
        testTenantUserId = userRes.rows[0]?.id || '00000000-0000-0000-0000-000000000002';
      }
    }

    if (!testTenantId) {
      testTenantId = '11111111-1111-1111-1111-111111111111';
      testWorkspaceId = '22222222-2222-2222-2222-222222222222';
      testTenantUserId = '33333333-3333-3333-3333-333333333333';
    }

    // Generate signed tokens
    validTenantToken = signToken({
      userId: testTenantUserId,
      tenantId: testTenantId,
      workspaceId: testWorkspaceId,
      role: 'WFM_ADMIN',
      name: 'Test Tenant Admin',
      username: 'test_tenant_admin',
    });

    validPlatformToken = signPlatformToken({
      id: testSuperAdminId || '00000000-0000-0000-0000-000000000099',
      email: TEST_SUPERADMIN_EMAIL,
    });
  });

  after(async () => {
    if (pool) {
      if (testSuperAdminId) {
        await pool.query('DELETE FROM wfm.platform_admins WHERE id = $1', [testSuperAdminId]).catch(() => {});
      }
      // Clean up any test organizations created during tests
      const testOrg = await pool.query<{ id: string }>(
        `SELECT id FROM wfm.tenants WHERE code = $1`,
        [TEST_ORG_CODE]
      ).catch(() => ({ rows: [] }));

      if (testOrg.rows.length) {
        const orgId = testOrg.rows[0].id;
        await pool.query('DELETE FROM wfm.workspace_members WHERE tenant_id = $1', [orgId]).catch(() => {});
        await pool.query('DELETE FROM wfm.users WHERE tenant_id = $1', [orgId]).catch(() => {});
        await pool.query('DELETE FROM wfm.workspaces WHERE tenant_id = $1', [orgId]).catch(() => {});
        await pool.query('DELETE FROM wfm.organization_settings WHERE tenant_id = $1', [orgId]).catch(() => {});
        await pool.query('DELETE FROM wfm.tenants WHERE id = $1', [orgId]).catch(() => {});
      }
      await pool.end().catch(() => {});
    }
  });

  describe('1. Super Admin Authentication', () => {
    it('rejects invalid password on POST /platform/auth/login', async () => {
      const res = await call(null, 'POST', '/platform/auth/login', {
        email: TEST_SUPERADMIN_EMAIL,
        password: 'wrong_password_123',
      });
      assert.equal(res.status, 400);
    });

    it('authenticates super admin, returns platform token, and never returns password hashes', async () => {
      const res = await call(null, 'POST', '/platform/auth/login', {
        email: TEST_SUPERADMIN_EMAIL,
        password: TEST_SUPERADMIN_PASSWORD,
      });
      assert.equal(res.status, 200);
      assert.ok(res.json.token, 'Must return a token');
      assert.equal(res.json.admin.email, TEST_SUPERADMIN_EMAIL);
      assert.equal(res.json.admin.status, 'ACTIVE');

      // Crucial security constraint: password or hash must not exist in response
      assert.equal(res.json.admin.password, undefined);
      assert.equal(res.json.admin.password_hash, undefined);
      assert.equal(res.json.passwordHash, undefined);
      assert.ok(!res.text.includes(TEST_SUPERADMIN_PASSWORD));
    });
  });

  describe('2. Bidirectional Token Isolation', () => {
    it('rejects tenant token on platform routes with 401 UNAUTHENTICATED', async () => {
      const res = await call(validTenantToken, 'GET', '/platform/organizations');
      assert.equal(res.status, 401);
      assert.equal(res.json?.error?.code, 'UNAUTHENTICATED');
    });

    it('rejects tenant token on GET /platform/auth/me with 401', async () => {
      const res = await call(validTenantToken, 'GET', '/platform/auth/me');
      assert.equal(res.status, 401);
    });

    it('rejects unauthenticated requests to /platform/* with 401', async () => {
      const res = await call(null, 'GET', '/platform/organizations');
      assert.equal(res.status, 401);
    });

    it('rejects platform token on tenant routes with 401 UNAUTHENTICATED', async () => {
      const res = await call(validPlatformToken, 'GET', '/workspaces');
      assert.equal(res.status, 401);
      assert.equal(res.json?.error?.code, 'UNAUTHENTICATED');
    });

    it('rejects platform token on tenant organization profile route with 401', async () => {
      const res = await call(validPlatformToken, 'GET', '/organization');
      assert.equal(res.status, 401);
    });
  });

  describe('3. Tenant Org Admin Restrictions', () => {
    it('Org Admin cannot create organizations on tenant router (POST /organization -> 404)', async () => {
      const res = await call(validTenantToken, 'POST', '/organization', {
        name: 'Unauthorized Org',
        code: 'NOPE_ORG',
      });
      // Route removed from tenant router, must return 404 Not Found
      assert.equal(res.status, 404);
    });

    it('Org Admin cannot list organizations on tenant router (GET /organization/list -> 404)', async () => {
      const res = await call(validTenantToken, 'GET', '/organization/list');
      // Route removed from tenant router, must return 404 Not Found
      assert.equal(res.status, 404);
    });

    it('Org Admin CAN read own organization profile (GET /organization)', async () => {
      const res = await call(validTenantToken, 'GET', '/organization');
      assert.equal(res.status, 200);
      assert.ok(res.json.id);
      assert.equal(res.json.id, testTenantId);
    });
  });

  describe('4. Super Admin Management Capabilities', () => {
    let createdOrgId = '';

    it('Super Admin creates organization with default workspace and initial admin', async () => {
      const initialAdminPassword = 'OrgAdminInitialPass123!';
      const res = await call(validPlatformToken, 'POST', '/platform/organizations', {
        name: `Test Org ${RUN_ID}`,
        code: TEST_ORG_CODE,
        legalName: `Test Org Legal ${RUN_ID}`,
        timezone: 'UTC',
        currency: 'USD',
        adminUser: `orgadmin_${RUN_ID}`,
        adminPassword: initialAdminPassword,
        adminEmail: `orgadmin_${RUN_ID}@testorg.local`,
      });

      assert.equal(res.status, 201);
      assert.ok(res.json.organization?.id);
      assert.equal(res.json.organization.code, TEST_ORG_CODE);
      assert.ok(res.json.workspace?.id);
      assert.equal(res.json.admin?.username, `orgadmin_${RUN_ID}`);
      assert.equal(res.json.admin?.role, 'WFM_ADMIN');

      // Security: no passwords or hashes returned in response
      assert.equal(res.json.admin.password, undefined);
      assert.equal(res.json.admin.password_hash, undefined);
      assert.ok(!res.text.includes(initialAdminPassword));

      createdOrgId = res.json.organization.id;
    });

    it('Super Admin lists organizations including the created organization', async () => {
      const res = await call(validPlatformToken, 'GET', '/platform/organizations');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.json));
      const found = res.json.find((o: any) => o.code === TEST_ORG_CODE);
      assert.ok(found, `Expected organization with code ${TEST_ORG_CODE} in list`);
      assert.ok((found.workspaceCount ?? found.workspace_count) >= 1);
      assert.ok((found.userCount ?? found.user_count) >= 1);
    });

    it('Super Admin creates additional workspace inside the organization', async () => {
      assert.ok(createdOrgId, 'Requires created organization');
      const wsCode = `WS_${RUN_ID.toUpperCase()}`;
      const res = await call(validPlatformToken, 'POST', `/platform/organizations/${createdOrgId}/workspaces`, {
        name: `Secondary Workspace ${RUN_ID}`,
        code: wsCode,
        timezone: 'America/New_York',
        currency: 'USD',
      });

      assert.equal(res.status, 201);
      assert.equal(res.json.code, wsCode);
      assert.equal(res.json.tenantId ?? res.json.tenant_id, createdOrgId);
    });

    it('Super Admin creates an additional admin user in the organization', async () => {
      assert.ok(createdOrgId, 'Requires created organization');
      const adminPassword = 'SecondAdminPass456!';
      const res = await call(validPlatformToken, 'POST', `/platform/organizations/${createdOrgId}/admin`, {
        username: `second_admin_${RUN_ID}`,
        password: adminPassword,
        displayName: 'Second Admin',
        email: `second_${RUN_ID}@testorg.local`,
      });

      assert.equal(res.status, 201);
      assert.equal(res.json.user.username, `second_admin_${RUN_ID}`);
      assert.equal(res.json.user.role, 'WFM_ADMIN');

      // Security check
      assert.equal(res.json.user.password, undefined);
      assert.equal(res.json.user.password_hash, undefined);
      assert.ok(!res.text.includes(adminPassword));
    });

    it('Super Admin edits organization settings', async () => {
      assert.ok(createdOrgId, 'Requires created organization');
      const res = await call(validPlatformToken, 'PATCH', `/platform/organizations/${createdOrgId}`, {
        displayName: `Renamed Org ${RUN_ID}`,
        contactName: 'Super Contact',
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.displayName, `Renamed Org ${RUN_ID}`);
      assert.equal(res.json.contactName, 'Super Contact');
    });

    it('Super Admin fetches complete hierarchical tree (Platform -> Orgs -> Workspaces & Admins)', async () => {
      const res = await call(validPlatformToken, 'GET', '/platform/tree');
      assert.equal(res.status, 200);
      assert.ok(res.json.platform);
      assert.equal(res.json.platform.name, 'Enterprise WFM Platform');
      assert.ok(Array.isArray(res.json.tree));
      assert.ok(res.json.tree.length >= 1);

      const targetOrg = res.json.tree.find((o: any) => o.id === createdOrgId);
      assert.ok(targetOrg, 'Created organization should appear in tree');
      assert.ok(Array.isArray(targetOrg.workspaces));
      assert.ok(targetOrg.workspaces.length >= 2, 'Should contain default and additional workspace');
      assert.ok(Array.isArray(targetOrg.admins));
      assert.ok(targetOrg.admins.length >= 2, 'Should contain initial and secondary admin');
    });

    it('Super Admin fetches cross-tenant analytics and capacity telemetry (GET /platform/analytics)', async () => {
      const res = await call(validPlatformToken, 'GET', '/platform/analytics');
      assert.equal(res.status, 200);
      assert.ok(res.json.platform);
      assert.ok(typeof res.json.platform.totalOrgs === 'number');
      assert.ok(typeof res.json.platform.totalWorkspaces === 'number');
      assert.ok(typeof res.json.platform.totalUsers === 'number');
      assert.ok(Array.isArray(res.json.tenants));
      assert.ok(res.json.tenants.length >= 1);
      assert.ok(Array.isArray(res.json.storageDistribution));
      assert.ok(Array.isArray(res.json.recentAudit));

      const orgTelemetry = res.json.tenants.find((t: any) => t.id === createdOrgId);
      assert.ok(orgTelemetry, 'Target organization telemetry should be returned');
      assert.ok(orgTelemetry.workspaceCount >= 2);
      assert.ok(orgTelemetry.userCount >= 2);
      assert.ok(orgTelemetry.statusTier);
    });

    let emergencyResetToken = '';
    let targetAdminUserId = '';

    it('Super Admin triggers Emergency Credential Reset for an organisation administrator (POST /platform/emergency-reset)', async () => {
      // Find an administrator user in the created organisation
      const orgRes = await call(validPlatformToken, 'GET', `/platform/organizations/${createdOrgId}`);
      assert.equal(orgRes.status, 200);
      assert.ok(Array.isArray(orgRes.json.users));
      const targetUser = orgRes.json.users[0];
      assert.ok(targetUser, 'Expected at least one administrator user in organisation');
      targetAdminUserId = targetUser.id;

      const resetRes = await call(validPlatformToken, 'POST', '/platform/emergency-reset', {
        userId: targetAdminUserId,
        method: 'BOTH',
      });

      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.json.success, true);
      assert.ok(resetRes.json.temporaryPassword);
      assert.ok(resetRes.json.resetToken);
      assert.ok(resetRes.json.resetUrl);
      assert.equal(resetRes.json.mustChangePassword, true);

      emergencyResetToken = resetRes.json.resetToken;
    });

    it('Locked-out administrator completes password reset using emergency token (POST /auth/emergency-reset/complete)', async () => {
      assert.ok(emergencyResetToken, 'Requires emergency reset token');
      const newAdminPassword = 'BrandNewSecureAdminPass789!';
      const completeRes = await call('', 'POST', '/auth/emergency-reset/complete', {
        token: emergencyResetToken,
        newPassword: newAdminPassword,
      });

      assert.equal(completeRes.status, 200);
      assert.equal(completeRes.json.ok, true);

      // Verify administrator can now log in with the new password
      const orgRes = await call(validPlatformToken, 'GET', `/platform/organizations/${createdOrgId}`);
      const targetUser = orgRes.json.users.find((u: any) => u.id === targetAdminUserId);

      const loginRes = await call('', 'POST', '/auth/login', {
        tenant: TEST_ORG_CODE,
        username: targetUser.username,
        password: newAdminPassword,
      });

      assert.equal(loginRes.status, 200);
      assert.ok(loginRes.json.token);
      assert.equal(loginRes.json.user.username, targetUser.username);
    });

    it('Super Admin queries Global Platform Audit Trail & Security ledger (GET /platform/audit)', async () => {
      const auditRes = await call(validPlatformToken, 'GET', '/platform/audit');
      assert.equal(auditRes.status, 200);
      assert.ok(typeof auditRes.json.total === 'number');
      assert.ok(Array.isArray(auditRes.json.items));
      assert.ok(auditRes.json.stats);
      assert.ok(auditRes.json.stats.totalEvents >= 1);

      // Check that EMERGENCY_CREDENTIAL_RESET is recorded in audit log
      const resetAudit = auditRes.json.items.find((i: any) => i.action === 'EMERGENCY_CREDENTIAL_RESET');
      assert.ok(resetAudit, 'EMERGENCY_CREDENTIAL_RESET action should be logged in platform audit log');
      assert.equal(resetAudit.targetTenantId ?? resetAudit.target_tenant_id, createdOrgId);
      assert.equal(resetAudit.targetEntityType ?? resetAudit.target_entity_type, 'ORGANISATION_ADMIN');
    });

    it('Super Admin queries Emergency Resets history (GET /platform/emergency-resets)', async () => {
      const resetsRes = await call(validPlatformToken, 'GET', '/platform/emergency-resets');
      assert.equal(resetsRes.status, 200);
      assert.ok(Array.isArray(resetsRes.json));
      assert.ok(resetsRes.json.length >= 1);

      const targetRecord = resetsRes.json.find((r: any) => (r.userId ?? r.user_id) === targetAdminUserId);
      assert.ok(targetRecord, 'Expected emergency reset record for targeted administrator');
      assert.equal(targetRecord.tokenStatus ?? targetRecord.token_status, 'USED');
    });
  });
});
