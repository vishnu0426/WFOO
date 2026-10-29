/**
 * Platform / Super Admin routes (/api/v1/platform/*).
 * Manages organisations, workspaces, and organisation administrator provisioning.
 * Never returns passwords in any response.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { raw } from '../../db.ts';
import { dropCache, redis } from '../../infra.ts';
import { bad, conflict, notFound, parse } from '../../http.ts';
import { ensureRolePermissions } from '../../bootstrap.ts';
import { authenticatePlatform, signPlatformToken } from './auth.ts';

export const platform = Router();

const uuid = z.string().uuid();
const PlatformLogin = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const NewOrgBody = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  legalName: z.string().max(200).optional(),
  timezone: z.string().min(1).max(80).default('UTC'),
  currency: z.string().min(3).max(3).default('USD'),
  adminUser: z.string().min(1).max(60).optional(),
  adminPassword: z.string().min(8).optional(),
  adminEmail: z.string().email().optional(),
  planTier: z.enum(['STARTER', 'PROFESSIONAL', 'ENTERPRISE', 'ENTERPRISE_PLUS', 'CUSTOM']).optional(),
  maxEmployees: z.number().int().min(1).optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxSites: z.number().int().min(1).optional(),
  modules: z.array(z.string()).optional(),
});

const OrgPatch = z.object({
  name: z.string().min(1).max(160).optional(),
  legalName: z.string().max(200).optional(),
  displayName: z.string().max(160).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: z.string().email().nullable().optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: z.string().min(3).max(3).optional(),
  locale: z.string().min(2).max(20).optional(),
});

const NewWorkspaceBody = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, 'may only contain lowercase letters, numbers and dash').optional(),
  description: z.string().max(500).optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: z.string().min(3).max(3).optional(),
});

const NewOrgAdminBody = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
});

const EmergencyResetBody = z.object({
  userId: z.string().uuid(),
  method: z.enum(['TEMPORARY_PASSWORD', 'RESET_LINK', 'BOTH']).default('BOTH'),
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';

function getClientIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

function generateSecureTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const nums = '23456789';
  const special = '!@#$%^&*';

  let pwd = '';
  pwd += upper[crypto.randomInt(upper.length)];
  pwd += lower[crypto.randomInt(lower.length)];
  pwd += nums[crypto.randomInt(nums.length)];
  pwd += special[crypto.randomInt(special.length)];

  const all = upper + lower + nums + special;
  for (let i = 0; i < 8; i++) {
    pwd += all[crypto.randomInt(all.length)];
  }
  return pwd.split('').sort(() => 0.5 - Math.random()).join('');
}

async function logPlatformAudit(params: {
  adminId?: string | null;
  adminEmail: string;
  action: string;
  targetTenantId?: string | null;
  targetTenantName?: string | null;
  targetTenantCode?: string | null;
  targetEntityType: string;
  targetEntityId?: string | null;
  targetEntityName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, any>;
  status?: 'SUCCESS' | 'FAILURE' | 'WARNING';
}) {
  try {
    await raw(
      `INSERT INTO wfm.platform_audit_log (
        admin_id, admin_email, action, target_tenant_id, target_tenant_name, target_tenant_code,
        target_entity_type, target_entity_id, target_entity_name, ip_address, user_agent, details, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        params.adminId || null,
        params.adminEmail,
        params.action,
        params.targetTenantId || null,
        params.targetTenantName || null,
        params.targetTenantCode || null,
        params.targetEntityType,
        params.targetEntityId || null,
        params.targetEntityName || null,
        params.ipAddress || null,
        params.userAgent || null,
        JSON.stringify(params.details || {}),
        params.status || 'SUCCESS',
      ]
    );
  } catch (err) {
    console.error('[platform_audit] Error recording log:', err);
  }
}

// ---------------------------------------------------------------- Super Admin Authentication

platform.post('/auth/login', async (req, res) => {
  const b = parse(PlatformLogin, req.body);
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || 'Unknown';

  const rows = await raw<{ id: string; email: string; password_hash: string; status: string }>(
    `SELECT id, email, password_hash, status FROM wfm.platform_admins WHERE lower(email) = lower($1)`,
    [b.email]
  );
  if (!rows.length) {
    await logPlatformAudit({
      adminEmail: b.email,
      action: 'SIGN_IN_FAILED',
      targetEntityType: 'PLATFORM_SESSION',
      ipAddress: ip,
      userAgent,
      details: { reason: 'Admin account not found' },
      status: 'FAILURE',
    });
    throw bad('Invalid email or password');
  }
  const admin = rows[0];
  if (admin.status !== 'ACTIVE') {
    await logPlatformAudit({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'SIGN_IN_FAILED',
      targetEntityType: 'PLATFORM_SESSION',
      ipAddress: ip,
      userAgent,
      details: { reason: 'Admin account disabled' },
      status: 'FAILURE',
    });
    throw bad('This super admin account has been disabled');
  }
  const passwordHash = (admin as any).passwordHash || (admin as any).password_hash;
  if (!passwordHash) {
    throw bad('Invalid email or password');
  }
  const ok = await bcrypt.compare(b.password, passwordHash);
  if (!ok) {
    await logPlatformAudit({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'SIGN_IN_FAILED',
      targetEntityType: 'PLATFORM_SESSION',
      ipAddress: ip,
      userAgent,
      details: { reason: 'Incorrect password' },
      status: 'FAILURE',
    });
    throw bad('Invalid email or password');
  }

  await logPlatformAudit({
    adminId: admin.id,
    adminEmail: admin.email,
    action: 'SIGN_IN',
    targetEntityType: 'PLATFORM_SESSION',
    ipAddress: ip,
    userAgent,
    status: 'SUCCESS',
  });

  const token = signPlatformToken({ id: admin.id, email: admin.email });
  res.json({
    token,
    admin: {
      id: admin.id,
      email: admin.email,
      status: admin.status,
    },
  });
});

// All routes below require platform authentication
platform.use(authenticatePlatform);

platform.post('/auth/logout', async (req, res) => {
  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'SIGN_OUT',
    targetEntityType: 'PLATFORM_SESSION',
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    status: 'SUCCESS',
  });
  res.json({ ok: true });
});

platform.get('/auth/me', async (req, res) => {
  res.json({
    admin: req.platformAdmin,
  });
});

// ---------------------------------------------------------------- Organizations

platform.get('/organizations', async (_req, res) => {
  const list = await raw<any>(
    `SELECT t.id, t.name, t.code, t.timezone, t.currency, t.created_at,
            coalesce(s.legal_name, t.name) AS legal_name,
            coalesce(s.display_name, t.name) AS display_name,
            s.contact_name, s.contact_email, s.locale,
            (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = t.id) AS workspace_count,
            (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = t.id) AS user_count
     FROM wfm.tenants t
     LEFT JOIN wfm.organization_settings s ON s.tenant_id = t.id
     ORDER BY t.name`
  );
  res.json(list);
});

// ---------------------------------------------------------------- Hierarchy Tree
platform.get('/tree', async (_req, res) => {
  const orgs = await raw<any>(
    `SELECT t.id, t.name, t.code, t.timezone, t.currency, t.created_at,
            coalesce(s.legal_name, t.name) AS legal_name,
            coalesce(s.display_name, t.name) AS display_name,
            s.contact_name, s.contact_email, s.locale
     FROM wfm.tenants t
     LEFT JOIN wfm.organization_settings s ON s.tenant_id = t.id
     ORDER BY t.name`
  );

  const workspaces = await raw<any>(
    `SELECT w.id, w.tenant_id, w.name, w.code, w.slug, w.description, w.timezone, w.currency, w.status, w.is_default, w.created_at,
            (SELECT count(*)::int FROM wfm.workspace_members m WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM wfm.workspaces w
     ORDER BY w.is_default DESC, w.name`
  );

  const admins = await raw<any>(
    `SELECT u.id, u.tenant_id, u.username, u.display_name, u.email, u.role, u.status, u.created_at
     FROM wfm.users u
     WHERE u.role = 'WFM_ADMIN'
     ORDER BY u.username`
  );

  const tree = orgs.map((org: any) => {
    const orgId = org.id;
    const orgWorkspaces = workspaces.filter((w: any) => (w.tenantId || w.tenant_id) === orgId);
    const orgAdmins = admins.filter((u: any) => (u.tenantId || u.tenant_id) === orgId);
    return {
      id: orgId,
      name: org.name,
      code: org.code,
      displayName: org.displayName || org.display_name || org.name,
      legalName: org.legalName || org.legal_name || org.name,
      contactName: org.contactName || org.contact_name || '',
      contactEmail: org.contactEmail || org.contact_email || null,
      timezone: org.timezone,
      currency: org.currency,
      locale: org.locale || 'en',
      createdAt: org.createdAt || org.created_at,
      workspaceCount: orgWorkspaces.length,
      adminCount: orgAdmins.length,
      workspaces: orgWorkspaces.map((w: any) => ({
        id: w.id,
        tenantId: orgId,
        name: w.name,
        code: w.code,
        slug: w.slug,
        description: w.description || '',
        timezone: w.timezone,
        currency: w.currency,
        status: w.status,
        isDefault: w.isDefault ?? w.is_default ?? false,
        memberCount: w.memberCount ?? w.member_count ?? 0,
        createdAt: w.createdAt || w.created_at,
      })),
      admins: orgAdmins.map((u: any) => ({
        id: u.id,
        tenantId: orgId,
        username: u.username,
        displayName: u.displayName || u.display_name || u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt || u.created_at,
      })),
    };
  });

  res.json({
    platform: {
      name: 'Enterprise WFM Platform',
      version: '1.0.0',
      totalOrgs: orgs.length,
      totalWorkspaces: workspaces.length,
      totalAdmins: admins.length,
    },
    tree,
  });
});

// ---------------------------------------------------------------- Cross-Tenant Analytics & Capacity Telemetry
platform.get('/analytics', async (_req, res) => {
  const orgs = await raw<any>(
    `SELECT 
      t.id, t.name, t.code, t.timezone, t.currency, t.created_at,
      coalesce(s.display_name, t.name) AS display_name,
      coalesce(s.legal_name, t.name) AS legal_name,
      (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = t.id) AS workspace_count,
      (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = t.id) AS user_count,
      (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = t.id AND u.status = 'ACTIVE') AS active_user_count,
      (SELECT count(*)::int FROM wfm.employees e WHERE e.tenant_id = t.id) AS employee_count,
      (SELECT count(*)::int FROM wfm.schedule_versions sv WHERE sv.tenant_id = t.id) AS schedule_count,
      (SELECT count(*)::int FROM wfm.schedule_versions sv WHERE sv.tenant_id = t.id AND sv.status = 'PUBLISHED') AS published_schedule_count,
      (SELECT count(*)::int FROM wfm.forecast_versions fv WHERE fv.tenant_id = t.id) AS forecast_count,
      (SELECT count(*)::int FROM wfm.interval_history ih WHERE ih.tenant_id = t.id) AS interval_count,
      (SELECT count(*)::int FROM wfm.shift_templates st WHERE st.tenant_id = t.id) AS shift_template_count,
      (SELECT count(*)::int FROM wfm.integration_connectors ic WHERE ic.tenant_id = t.id) AS connector_count,
      (SELECT count(*)::int FROM wfm.audit_log al WHERE al.tenant_id = t.id) AS audit_count,
      (SELECT max(al.at) FROM wfm.audit_log al WHERE al.tenant_id = t.id) AS last_audit_at,
      (SELECT max(u.last_login_at) FROM wfm.users u WHERE u.tenant_id = t.id) AS last_login_at
    FROM wfm.tenants t
    LEFT JOIN wfm.organization_settings s ON s.tenant_id = t.id
    ORDER BY t.name`
  );

  const [shiftSummary] = await raw<any>('SELECT count(*)::int AS total_shifts FROM wfm.schedule_shifts');
  const totalShifts = shiftSummary?.total_shifts ?? 0;

  const recentAudit = await raw<any>(
    `SELECT al.id, al.at, al.tenant_id, t.name AS tenant_name, t.code AS tenant_code,
            al.actor_name, al.actor_role, al.action, al.entity_type, al.entity_name, al.diff_summary, al.source
     FROM wfm.audit_log al
     JOIN wfm.tenants t ON t.id = al.tenant_id
     ORDER BY al.at DESC
     LIMIT 15`
  );

  const totalOrgs = orgs.length;
  const totalWorkspaces = orgs.reduce((acc: number, o: any) => acc + (o.workspaceCount ?? o.workspace_count ?? 0), 0);
  const totalUsers = orgs.reduce((acc: number, o: any) => acc + (o.userCount ?? o.user_count ?? 0), 0);
  const totalActiveUsers = orgs.reduce((acc: number, o: any) => acc + (o.activeUserCount ?? o.active_user_count ?? 0), 0);
  const totalEmployees = orgs.reduce((acc: number, o: any) => acc + (o.employeeCount ?? o.employee_count ?? 0), 0);
  const totalSchedules = orgs.reduce((acc: number, o: any) => acc + (o.scheduleCount ?? o.schedule_count ?? 0), 0);
  const totalPublishedSchedules = orgs.reduce((acc: number, o: any) => acc + (o.publishedScheduleCount ?? o.published_schedule_count ?? 0), 0);
  const totalForecasts = orgs.reduce((acc: number, o: any) => acc + (o.forecastCount ?? o.forecast_count ?? 0), 0);
  const totalIntervals = orgs.reduce((acc: number, o: any) => acc + (o.intervalCount ?? o.interval_count ?? 0), 0);
  const totalConnectors = orgs.reduce((acc: number, o: any) => acc + (o.connectorCount ?? o.connector_count ?? 0), 0);
  const totalAuditLogs = orgs.reduce((acc: number, o: any) => acc + (o.auditCount ?? o.audit_count ?? 0), 0);

  const tenantMetrics = orgs.map((o: any) => {
    const workspaceCount = o.workspaceCount ?? o.workspace_count ?? 0;
    const userCount = o.userCount ?? o.user_count ?? 0;
    const activeUserCount = o.activeUserCount ?? o.active_user_count ?? 0;
    const employeeCount = o.employeeCount ?? o.employee_count ?? 0;
    const scheduleCount = o.scheduleCount ?? o.schedule_count ?? 0;
    const publishedScheduleCount = o.publishedScheduleCount ?? o.published_schedule_count ?? 0;
    const forecastCount = o.forecastCount ?? o.forecast_count ?? 0;
    const intervalCount = o.intervalCount ?? o.interval_count ?? 0;
    const shiftTemplateCount = o.shiftTemplateCount ?? o.shift_template_count ?? 0;
    const connectorCount = o.connectorCount ?? o.connector_count ?? 0;
    const auditCount = o.auditCount ?? o.audit_count ?? 0;
    const lastActive = o.lastAuditAt || o.last_audit_at || o.lastLoginAt || o.last_login_at || o.createdAt || o.created_at;

    const activityScore = (userCount * 10) + (scheduleCount * 25) + (forecastCount * 15) + (intervalCount > 0 ? 50 : 0) + auditCount;
    let statusTier: 'HIGH_ACTIVITY' | 'MODERATE' | 'IDLE' = 'IDLE';
    if (activityScore > 100 || scheduleCount > 0 || intervalCount > 0) {
      statusTier = 'HIGH_ACTIVITY';
    } else if (activityScore > 10 || userCount > 1) {
      statusTier = 'MODERATE';
    }

    return {
      id: o.id,
      name: o.name,
      code: o.code,
      displayName: o.displayName || o.display_name || o.name,
      legalName: o.legalName || o.legal_name || o.name,
      timezone: o.timezone,
      currency: o.currency,
      createdAt: o.createdAt || o.created_at,
      workspaceCount,
      userCount,
      activeUserCount,
      employeeCount,
      scheduleCount,
      publishedScheduleCount,
      forecastCount,
      intervalCount,
      shiftTemplateCount,
      connectorCount,
      auditCount,
      lastActiveAt: lastActive,
      activityScore,
      statusTier,
    };
  });

  res.json({
    platform: {
      totalOrgs,
      totalWorkspaces,
      totalUsers,
      totalActiveUsers,
      totalEmployees,
      totalSchedules,
      totalPublishedSchedules,
      totalShifts,
      totalForecasts,
      totalIntervals,
      totalConnectors,
      totalAuditLogs,
      telemetryUptime: '99.98%',
      telemetryStatus: 'OPTIMAL',
    },
    tenants: tenantMetrics,
    storageDistribution: [
      { name: 'Interval History', records: totalIntervals, category: 'Telemetry & Timeseries' },
      { name: 'Schedule Shifts', records: totalShifts, category: 'Operational Rostering' },
      { name: 'Audit Ledger', records: totalAuditLogs, category: 'Security & Compliance' },
      { name: 'Workforce Roster', records: totalEmployees, category: 'Personnel Data' },
      { name: 'Forecast Versions', records: totalForecasts, category: 'Mathematical Models' },
    ],
    recentAudit: recentAudit.map((a: any) => ({
      id: a.id,
      at: a.at,
      tenantId: a.tenant_id,
      tenantName: a.tenant_name,
      tenantCode: a.tenant_code,
      actorName: a.actor_name,
      actorRole: a.actor_role,
      action: a.action,
      entityType: a.entity_type,
      entityName: a.entity_name,
      diffSummary: a.diff_summary,
      source: a.source,
    })),
  });
});

platform.post('/organizations', async (req, res) => {
  const b = parse(NewOrgBody, req.body);
  const code = b.code.toUpperCase();
  const existing = await raw<{ id: string }>('SELECT id FROM wfm.tenants WHERE upper(code) = $1', [code]);
  if (existing.length) {
    throw conflict(`An organisation with code "${code}" already exists.`);
  }

  const [t] = await raw<any>(
    'INSERT INTO wfm.tenants (name, code, timezone, currency) VALUES ($1, $2, $3, $4) RETURNING *',
    [b.name, code, b.timezone, b.currency]
  );
  await ensureRolePermissions(t.id);

  // default workspace
  const [ws] = await raw<any>(
    `INSERT INTO wfm.workspaces (tenant_id, name, code, slug, timezone, currency, is_default, status)
     VALUES ($1, $2, 'DEFAULT', 'default', $3, $4, true, 'ACTIVE') RETURNING *`,
    [t.id, `${b.name} Default`, b.timezone, b.currency]
  );

  // organization settings
  await raw(
    `INSERT INTO wfm.organization_settings (tenant_id, legal_name, display_name, timezone, currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [t.id, b.legalName || b.name, b.name, b.timezone, b.currency]
  );

  // provision first-class license & modules only if planTier is explicitly specified
  if (b.planTier) {
    const keyPrefix = `LIC-${code.replace(/[^A-Za-z0-9]/g, '')}-${new Date().getFullYear()}-`;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const licenseKey = `${keyPrefix}${randomSuffix}`;

    const [lic] = await raw<any>(
      `INSERT INTO wfm.licenses (
        license_key, tenant_id, plan_tier, edition, status,
        start_date, end_date, renewal_date, grace_period_days,
        max_employees, max_users, max_supervisors, max_sites, max_workspaces
      ) VALUES ($1, $2, $3, 'WFM_ENTERPRISE', 'ACTIVE', now(), now() + interval '1 year', now() + interval '1 year', 14, $4, $5, 25, $6, 5)
      RETURNING *`,
      [licenseKey, t.id, b.planTier, b.maxEmployees || 500, b.maxUsers || 100, b.maxSites || 10]
    );

    const defaultModules = b.modules && b.modules.length > 0
      ? b.modules
      : ['FORECASTING', 'SCHEDULING', 'INTRADAY', 'ADHERENCE', 'TIME_OFF', 'SHIFT_BIDDING', 'EMPLOYEE_SELF_SERVICE', 'REPORTING', 'AI_COPILOT'];

    for (const m of defaultModules) {
      await raw(
        `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled)
         VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
        [lic.id, t.id, m]
      );
    }
  }

  let initialAdmin: any = null;
  if (b.adminUser && b.adminPassword) {
    const hash = await bcrypt.hash(b.adminPassword, 12);
    const [admin] = await raw<any>(
      `INSERT INTO wfm.users (tenant_id, username, display_name, email, role, password_hash, default_workspace_id)
       VALUES ($1, $2, $3, $4, 'WFM_ADMIN', $5, $6)
       RETURNING id, username, display_name, email, role, status`,
      [t.id, b.adminUser, 'Administrator', b.adminEmail || null, hash, ws.id]
    );
    await raw(
      `INSERT INTO wfm.workspace_members (tenant_id, workspace_id, user_id, role, is_default)
       VALUES ($1, $2, $3, 'WFM_ADMIN', true)`,
      [t.id, ws.id, admin.id]
    );
    initialAdmin = {
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      email: admin.email,
      role: admin.role,
      status: admin.status,
    };
  }

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: 'PROVISION_ORGANISATION',
    targetTenantId: t.id,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'ORGANISATION',
    targetEntityId: t.id,
    targetEntityName: t.name,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: {
      name: t.name,
      code: t.code,
      legalName: b.legalName || b.name,
      timezone: b.timezone,
      currency: b.currency,
      defaultWorkspace: ws.name,
      initialAdminUser: initialAdmin?.username || null,
    },
    status: 'SUCCESS',
  });

  res.status(201).json({
    organization: {
      id: t.id,
      name: t.name,
      code: t.code,
      timezone: t.timezone,
      currency: t.currency,
      createdAt: t.created_at,
    },
    workspace: {
      id: ws.id,
      name: ws.name,
      code: ws.code,
      slug: ws.slug,
      isDefault: ws.is_default,
    },
    admin: initialAdmin,
  });
});

platform.get('/organizations/:id', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  const [s] = await raw<any>('SELECT * FROM wfm.organization_settings WHERE tenant_id = $1', [orgId]);
  const workspaces = await raw<any>(
    `SELECT w.*, (SELECT count(*)::int FROM wfm.workspace_members m WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM wfm.workspaces w WHERE w.tenant_id = $1 ORDER BY w.is_default DESC, w.name`,
    [orgId]
  );
  const users = await raw<any>(
    `SELECT id, username, display_name, email, role, status, created_at, last_login_at
     FROM wfm.users WHERE tenant_id = $1 ORDER BY username`,
    [orgId]
  );

  res.json({
    organization: {
      id: t.id,
      name: s?.displayName || s?.display_name || t.name,
      code: t.code,
      legalName: s?.legalName || s?.legal_name || t.name,
      displayName: s?.displayName || s?.display_name || t.name,
      contactName: s?.contactName || s?.contact_name || '',
      contactEmail: s?.contactEmail || s?.contact_email || null,
      timezone: s?.timezone || t.timezone,
      currency: s?.currency || t.currency,
      locale: s?.locale || 'en',
      createdAt: t.createdAt || t.created_at,
    },
    workspaces,
    users,
  });
});

platform.patch('/organizations/:id', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const b = parse(OrgPatch, req.body);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  if (b.name || b.timezone || b.currency) {
    await raw(
      'UPDATE wfm.tenants SET name = coalesce($2, name), timezone = coalesce($3, timezone), currency = coalesce($4, currency) WHERE id = $1',
      [orgId, b.name ?? null, b.timezone ?? null, b.currency ?? null]
    );
  }

  await raw(
    `INSERT INTO wfm.organization_settings (tenant_id, legal_name, display_name, contact_name, contact_email, timezone, currency, locale)
     SELECT $1, coalesce($2, t.name), coalesce($3, t.name), coalesce($4, ''), $5,
            coalesce($6, t.timezone), coalesce($7, t.currency), coalesce($8, 'en')
     FROM wfm.tenants t WHERE t.id = $1
     ON CONFLICT (tenant_id) DO UPDATE SET
       legal_name = coalesce($2, wfm.organization_settings.legal_name),
       display_name = coalesce($3, wfm.organization_settings.display_name),
       contact_name = coalesce($4, wfm.organization_settings.contact_name),
       contact_email = CASE WHEN $9::boolean THEN $5 ELSE wfm.organization_settings.contact_email END,
       timezone = coalesce($6, wfm.organization_settings.timezone),
       currency = coalesce($7, wfm.organization_settings.currency),
       locale = coalesce($8, wfm.organization_settings.locale),
       updated_at = now()`,
    [
      orgId,
      b.legalName ?? b.name ?? null,
      b.displayName ?? b.name ?? null,
      b.contactName ?? null,
      b.contactEmail ?? null,
      b.timezone ?? null,
      b.currency ?? null,
      b.locale ?? null,
      b.contactEmail !== undefined,
    ]
  );

  const [updatedT] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  const [updatedS] = await raw<any>('SELECT * FROM wfm.organization_settings WHERE tenant_id = $1', [orgId]);

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'UPDATE_ORGANISATION',
    targetTenantId: orgId,
    targetTenantName: updatedT.name,
    targetTenantCode: updatedT.code,
    targetEntityType: 'ORGANISATION',
    targetEntityId: orgId,
    targetEntityName: updatedT.name,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: b,
    status: 'SUCCESS',
  });

  res.json({
    id: updatedT.id,
    name: updatedS?.displayName || updatedS?.display_name || updatedT.name,
    code: updatedT.code,
    legalName: updatedS?.legalName || updatedS?.legal_name || updatedT.name,
    displayName: updatedS?.displayName || updatedS?.display_name || updatedT.name,
    contactName: updatedS?.contactName || updatedS?.contact_name || '',
    contactEmail: updatedS?.contactEmail || updatedS?.contact_email || null,
    timezone: updatedS?.timezone || updatedT.timezone,
    currency: updatedS?.currency || updatedT.currency,
    locale: updatedS?.locale || 'en',
    createdAt: updatedT.createdAt || updatedT.created_at,
  });
});

// ---------------------------------------------------------------- Workspaces of an Organization

platform.get('/organizations/:id/workspaces', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const rows = await raw<any>(
    `SELECT w.*, (SELECT count(*)::int FROM wfm.workspace_members m WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM wfm.workspaces w WHERE w.tenant_id = $1 ORDER BY w.is_default DESC, w.name`,
    [orgId]
  );
  res.json(rows);
});

platform.post('/organizations/:id/workspaces', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  const b = parse(NewWorkspaceBody, req.body);
  const code = b.code.toUpperCase();
  const existing = await raw<{ id: string }>('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND upper(code) = $2', [orgId, code]);
  if (existing.length) throw conflict(`A workspace with code "${code}" already exists in this organisation.`);

  const [ws] = await raw<any>(
    `INSERT INTO wfm.workspaces (tenant_id, name, code, slug, description, timezone, currency, is_default, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'ACTIVE') RETURNING *`,
    [orgId, b.name, code, b.slug || slugify(code), b.description ?? '', b.timezone || t.timezone, b.currency || t.currency]
  );

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'CREATE_WORKSPACE',
    targetTenantId: orgId,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'WORKSPACE',
    targetEntityId: ws.id,
    targetEntityName: ws.name,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: { code: ws.code, slug: ws.slug, timezone: ws.timezone },
    status: 'SUCCESS',
  });

  res.status(201).json({
    ...ws,
    memberCount: 0,
  });
});

// ---------------------------------------------------------------- Organization Administrator Provisioning

platform.post('/organizations/:id/admin', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  const b = parse(NewOrgAdminBody, req.body);
  const existing = await raw<{ id: string }>('SELECT id FROM wfm.users WHERE tenant_id = $1 AND lower(username) = lower($2)', [orgId, b.username]);
  if (existing.length) throw conflict(`User "${b.username}" already exists in this organisation.`);

  const [defaultWs] = await raw<any>('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND is_default LIMIT 1', [orgId]);
  const hash = await bcrypt.hash(b.password, 12);
  const [u] = await raw<any>(
    `INSERT INTO wfm.users (tenant_id, username, display_name, email, role, password_hash, default_workspace_id)
     VALUES ($1, $2, $3, $4, 'WFM_ADMIN', $5, $6)
     RETURNING id, username, display_name, email, role, status, created_at`,
    [orgId, b.username, b.displayName || b.username, b.email || null, hash, defaultWs?.id || null]
  );

  if (defaultWs) {
    await raw(
      `INSERT INTO wfm.workspace_members (tenant_id, workspace_id, user_id, role, is_default)
       VALUES ($1, $2, $3, 'WFM_ADMIN', true) ON CONFLICT DO NOTHING`,
      [orgId, defaultWs.id, u.id]
    );
  }

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'PROVISION_ADMIN',
    targetTenantId: orgId,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'ORGANISATION_ADMIN',
    targetEntityId: u.id,
    targetEntityName: u.username,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: { username: u.username, email: u.email, role: u.role },
    status: 'SUCCESS',
  });

  res.status(201).json({
    user: {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
    },
  });
});

// ---------------------------------------------------------------- Emergency Credential Reset

platform.post('/emergency-reset', async (req, res) => {
  const b = parse(EmergencyResetBody, req.body);
  const [user] = await raw<any>(
    `SELECT u.id, u.username, u.display_name, u.email, u.status, u.role, u.tenant_id,
            t.name AS tenant_name, t.code AS tenant_code
     FROM wfm.users u
     JOIN wfm.tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [b.userId]
  );
  if (!user) throw notFound('User');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const tempPassword = generateSecureTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  if (b.method === 'TEMPORARY_PASSWORD' || b.method === 'BOTH') {
    await raw(
      `UPDATE wfm.users 
       SET password_hash = $1, status = 'ACTIVE', must_change_password = true 
       WHERE id = $2 AND tenant_id = $3`,
      [passwordHash, user.id, user.tenantId || user.tenant_id]
    );
  }

  await raw(
    `UPDATE wfm.emergency_password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await raw(
    `INSERT INTO wfm.emergency_password_resets (
      tenant_id, user_id, token_hash, created_by_admin_id, created_by_admin_email, temp_password_hint, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      user.tenantId || user.tenant_id,
      user.id,
      tokenHash,
      req.platformAdmin!.id,
      req.platformAdmin!.email,
      tempPassword.slice(0, 3) + '••••' + tempPassword.slice(-2),
      expiresAt.toISOString(),
    ]
  );

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'EMERGENCY_CREDENTIAL_RESET',
    targetTenantId: user.tenantId || user.tenant_id,
    targetTenantName: user.tenantName || user.tenant_name,
    targetTenantCode: user.tenantCode || user.tenant_code,
    targetEntityType: 'ORGANISATION_ADMIN',
    targetEntityId: user.id,
    targetEntityName: user.username,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: {
      method: b.method,
      userEmail: user.email,
      mustChangePassword: true,
      expiresAt: expiresAt.toISOString(),
    },
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.display_name || user.username,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId || user.tenant_id,
      tenantName: user.tenantName || user.tenant_name,
      tenantCode: user.tenantCode || user.tenant_code,
    },
    method: b.method,
    temporaryPassword: (b.method === 'TEMPORARY_PASSWORD' || b.method === 'BOTH') ? tempPassword : null,
    resetToken: rawToken,
    resetUrl: `/reset-password?token=${rawToken}&org=${user.tenantCode || user.tenant_code}`,
    expiresAt: expiresAt.toISOString(),
    mustChangePassword: true,
  });
});

platform.get('/emergency-resets', async (_req, res) => {
  const items = await raw<any>(
    `SELECT r.id, r.tenant_id, r.user_id, r.created_by_admin_email, r.temp_password_hint,
            r.expires_at, r.used_at, r.created_at,
            u.username, u.display_name, u.email, u.role,
            t.name AS tenant_name, t.code AS tenant_code,
            CASE 
              WHEN r.used_at IS NOT NULL THEN 'USED'
              WHEN r.expires_at < now() THEN 'EXPIRED'
              ELSE 'ACTIVE'
            END AS token_status
     FROM wfm.emergency_password_resets r
     JOIN wfm.users u ON u.id = r.user_id
     JOIN wfm.tenants t ON t.id = r.tenant_id
     ORDER BY r.created_at DESC
     LIMIT 50`
  );
  res.json(items);
});

// ---------------------------------------------------------------- Global Platform Audit Trail

platform.get('/audit', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const actionFilter = typeof req.query.action === 'string' ? req.query.action.trim() : '';
  const tenantFilter = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const conditions: string[] = ['1=1'];
  const params: any[] = [];

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(
      admin_email ILIKE ${p} OR
      target_tenant_name ILIKE ${p} OR
      target_tenant_code ILIKE ${p} OR
      target_entity_name ILIKE ${p} OR
      action ILIKE ${p} OR
      ip_address ILIKE ${p}
    )`);
  }

  if (actionFilter) {
    params.push(actionFilter);
    conditions.push(`action = $${params.length}`);
  }

  if (tenantFilter) {
    params.push(tenantFilter);
    conditions.push(`target_tenant_id = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');

  const [countResult] = await raw<any>(
    `SELECT count(*)::int AS total FROM wfm.platform_audit_log WHERE ${whereClause}`,
    params
  );
  const total = countResult?.total ?? 0;

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const items = await raw<any>(
    `SELECT id, at, admin_id, admin_email, action, target_tenant_id, target_tenant_name, target_tenant_code,
            target_entity_type, target_entity_id, target_entity_name, ip_address, user_agent, details, status
     FROM wfm.platform_audit_log
     WHERE ${whereClause}
     ORDER BY at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const [stats] = await raw<any>(
    `SELECT 
      count(*)::int AS total_events,
      count(*) FILTER (WHERE action IN ('SIGN_IN', 'SIGN_IN_FAILED', 'SIGN_OUT'))::int AS session_events,
      count(*) FILTER (WHERE action IN ('PROVISION_ORGANISATION', 'CREATE_WORKSPACE', 'UPDATE_ORGANISATION', 'PROVISION_ADMIN'))::int AS provisioning_events,
      count(*) FILTER (WHERE action = 'EMERGENCY_CREDENTIAL_RESET')::int AS credential_resets,
      count(*) FILTER (WHERE status = 'FAILURE')::int AS security_alerts
     FROM wfm.platform_audit_log`
  );

  res.json({
    total,
    limit,
    offset,
    items,
    stats: {
      totalEvents: stats?.totalEvents ?? stats?.total_events ?? total,
      sessionEvents: stats?.sessionEvents ?? stats?.session_events ?? 0,
      provisioningEvents: stats?.provisioningEvents ?? stats?.provisioning_events ?? 0,
      credentialResets: stats?.credentialResets ?? stats?.credential_resets ?? 0,
      securityAlerts: stats?.securityAlerts ?? stats?.security_alerts ?? 0,
    },
  });
});

// ---------------------------------------------------------------- Platform Licensing & Entitlements

platform.get('/licenses', async (_req, res) => {
  const rows = await raw<any>(
    `SELECT l.*, t.name AS tenant_name, t.code AS tenant_code,
            (SELECT count(*)::int FROM wfm.employees e WHERE e.tenant_id = l.tenant_id AND e.status != 'TERMINATED') AS active_employees,
            (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = l.tenant_id AND u.status = 'ACTIVE') AS active_users,
            (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = l.tenant_id AND w.status = 'ACTIVE') AS active_workspaces,
            (SELECT coalesce(array_agg(module_code), '{}') FROM wfm.license_modules lm WHERE lm.license_id = l.id AND lm.enabled = true) AS enabled_modules
     FROM wfm.licenses l
     JOIN wfm.tenants t ON t.id = l.tenant_id
     ORDER BY l.created_at DESC`
  );
  res.json(rows);
});

const IssueLicenseBody = z.object({
  tenantId: z.string().uuid(),
  planTier: z.enum(['STARTER', 'PROFESSIONAL', 'ENTERPRISE', 'ENTERPRISE_PLUS', 'CUSTOM']).default('ENTERPRISE'),
  maxEmployees: z.number().int().min(1).default(500),
  maxUsers: z.number().int().min(1).default(100),
  maxSites: z.number().int().min(1).default(10),
  maxWorkspaces: z.number().int().min(1).default(5),
  gracePeriodDays: z.number().int().min(0).default(14),
  endDate: z.string().optional(),
  modules: z.array(z.string()).optional(),
  adminUser: z.string().min(1).max(60).optional(),
  adminPassword: z.string().min(8).optional(),
  adminEmail: z.string().email().optional(),
});

platform.post('/licenses', async (req, res) => {
  const b = parse(IssueLicenseBody, req.body);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [b.tenantId]);
  if (!t) throw notFound('Organisation');

  const [existingLic] = await raw<any>('SELECT id FROM wfm.licenses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [t.id]);

  let lic: any;
  if (existingLic) {
    [lic] = await raw<any>(
      `UPDATE wfm.licenses SET
         plan_tier = $2,
         status = 'ACTIVE',
         max_employees = $3,
         max_users = $4,
         max_sites = $5,
         max_workspaces = $6,
         grace_period_days = $7,
         end_date = coalesce($8, end_date),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [existingLic.id, b.planTier, b.maxEmployees, b.maxUsers, b.maxSites, b.maxWorkspaces, b.gracePeriodDays, b.endDate ? new Date(b.endDate) : null]
    );
  } else {
    const keyPrefix = `LIC-${t.code.replace(/[^A-Za-z0-9]/g, '')}-${new Date().getFullYear()}-`;
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const licenseKey = `${keyPrefix}${randomSuffix}`;
    const endDate = b.endDate ? new Date(b.endDate) : new Date(Date.now() + 365 * 86400000);

    [lic] = await raw<any>(
      `INSERT INTO wfm.licenses (
        license_key, tenant_id, plan_tier, edition, status,
        start_date, end_date, renewal_date, grace_period_days,
        max_employees, max_users, max_supervisors, max_sites, max_workspaces
      ) VALUES ($1, $2, $3, 'WFM_ENTERPRISE', 'ACTIVE', now(), $4, $4, $5, $6, $7, 25, $8, $9)
      RETURNING *`,
      [licenseKey, t.id, b.planTier, endDate, b.gracePeriodDays, b.maxEmployees, b.maxUsers, b.maxSites, b.maxWorkspaces]
    );
  }

  const defaultModules = b.modules && b.modules.length > 0
    ? b.modules
    : ['FORECASTING', 'SCHEDULING', 'INTRADAY', 'ADHERENCE', 'TIME_OFF', 'SHIFT_BIDDING', 'EMPLOYEE_SELF_SERVICE', 'REPORTING', 'AI_COPILOT'];

  for (const m of defaultModules) {
    await raw(
      `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = true`,
      [lic.id, t.id, m]
    );
  }

  let adminSummary: any = null;
  if (b.adminUser && b.adminPassword) {
    const hash = await bcrypt.hash(b.adminPassword, 12);
    const [ws] = await raw<any>('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND is_default LIMIT 1', [t.id]);
    const wsId = ws?.id;

    const [existingUser] = await raw<any>('SELECT id FROM wfm.users WHERE tenant_id = $1 AND username = $2', [t.id, b.adminUser]);
    if (existingUser) {
      await raw('UPDATE wfm.users SET password_hash = $2, status = \'ACTIVE\' WHERE id = $1', [existingUser.id, hash]);
    } else {
      const [u] = await raw<any>(
        `INSERT INTO wfm.users (tenant_id, username, display_name, email, role, password_hash, default_workspace_id)
         VALUES ($1, $2, 'Administrator', $3, 'WFM_ADMIN', $4, $5)
         RETURNING id`,
        [t.id, b.adminUser, b.adminEmail || null, hash, wsId || null]
      );
      if (wsId) {
        await raw(
          `INSERT INTO wfm.workspace_members (tenant_id, workspace_id, user_id, role, is_default)
           VALUES ($1, $2, $3, 'WFM_ADMIN', true)
           ON CONFLICT DO NOTHING`,
          [t.id, wsId, u.id]
        );
      }
    }
    adminSummary = {
      username: b.adminUser,
      password: b.adminPassword,
    };
  }

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: 'ISSUE_LICENSE',
    targetTenantId: t.id,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'LICENSE',
    targetEntityId: lic.id,
    targetEntityName: lic.licenseKey,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: {
      planTier: b.planTier,
      maxEmployees: b.maxEmployees,
      maxUsers: b.maxUsers,
      licenseKey: lic.licenseKey,
    },
    status: 'SUCCESS',
  });

  res.status(201).json({
    organization: t,
    license: lic,
    adminUser: adminSummary?.username || null,
    adminPassword: adminSummary?.password || null,
  });
});

platform.get('/licenses/:id', async (req, res) => {
  const id = req.params.id;
  const [lic] = await raw<any>(
    `SELECT l.*, t.name AS tenant_name, t.code AS tenant_code
     FROM wfm.licenses l
     JOIN wfm.tenants t ON t.id = l.tenant_id
     WHERE l.id = $1`,
    [id]
  );
  if (!lic) throw notFound('License');
  const modules = await raw<any>('SELECT * FROM wfm.license_modules WHERE license_id = $1 ORDER BY module_code', [id]);
  const [{ count: activeEmployees }] = await raw<any>("SELECT count(*)::int AS count FROM wfm.employees WHERE tenant_id = $1 AND status != 'TERMINATED'", [lic.tenantId]);
  const [{ count: activeUsers }] = await raw<any>("SELECT count(*)::int AS count FROM wfm.users WHERE tenant_id = $1 AND status = 'ACTIVE'", [lic.tenantId]);
  res.json({ ...lic, modules, usage: { activeEmployees, activeUsers } });
});

const LicensePatch = z.object({
  planTier: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'PROVISIONING', 'ACTIVE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELLED', 'EXPIRED']).optional(),
  endDate: z.string().optional(),
  maxEmployees: z.number().int().min(1).optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxSites: z.number().int().min(1).optional(),
  maxWorkspaces: z.number().int().min(1).optional(),
  gracePeriodDays: z.number().int().min(0).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
});

platform.patch('/licenses/:id', async (req, res) => {
  const id = req.params.id;
  const b = parse(LicensePatch, req.body);
  const [existing] = await raw<any>('SELECT * FROM wfm.licenses WHERE id = $1', [id]);
  if (!existing) throw notFound('License');

  const [updated] = await raw<any>(
    `UPDATE wfm.licenses SET
       plan_tier = coalesce($2, plan_tier),
       status = coalesce($3, status),
       end_date = coalesce($4, end_date),
       max_employees = coalesce($5, max_employees),
       max_users = coalesce($6, max_users),
       max_sites = coalesce($7, max_sites),
       max_workspaces = coalesce($8, max_workspaces),
       grace_period_days = coalesce($9, grace_period_days),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, b.planTier ?? null, b.status ?? null, b.endDate ? new Date(b.endDate) : null, b.maxEmployees ?? null, b.maxUsers ?? null, b.maxSites ?? null, b.maxWorkspaces ?? null, b.gracePeriodDays ?? null]
  );

  const tenantId = existing.tenantId || existing.tenant_id;
  if (b.modules) {
    for (const [mod, enabled] of Object.entries(b.modules)) {
      await raw(
        `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = $4`,
        [id, tenantId, mod, enabled]
      );
    }
  }

  // Invalidate cached role permissions in Redis so tenant users immediately see updated permissions
  await dropCache(tenantId, 'perms:*').catch(() => {});
  const redisKeys = await redis.keys(`wfm:${tenantId}:*`).catch(() => []);
  if (redisKeys.length) await redis.del(...redisKeys).catch(() => {});

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: 'UPDATE_LICENSE',
    targetTenantId: tenantId,
    targetEntityType: 'LICENSE',
    targetEntityId: id,
    details: { before: existing, patch: b },
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    status: 'SUCCESS',
  });

  const [fullUpdated] = await raw<any>(
    `SELECT l.*, t.name AS tenant_name, t.code AS tenant_code,
            (SELECT count(*)::int FROM wfm.employees e WHERE e.tenant_id = l.tenant_id AND e.status != 'TERMINATED') AS active_employees,
            (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = l.tenant_id AND u.status = 'ACTIVE') AS active_users,
            (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = l.tenant_id AND w.status = 'ACTIVE') AS active_workspaces,
            (SELECT coalesce(array_agg(module_code), '{}') FROM wfm.license_modules lm WHERE lm.license_id = l.id AND lm.enabled = true) AS enabled_modules
     FROM wfm.licenses l
     JOIN wfm.tenants t ON t.id = l.tenant_id
     WHERE l.id = $1`,
    [id]
  );

  res.json(fullUpdated || updated);
});

platform.get('/capacity-requests', async (_req, res) => {
  const rows = await raw<any>(
    `SELECT r.*, t.name AS tenant_name, t.code AS tenant_code, u.username AS requester_name, u.email AS requester_email
     FROM wfm.license_capacity_requests r
     JOIN wfm.tenants t ON t.id = r.tenant_id
     JOIN wfm.users u ON u.id = r.requested_by_user_id
     ORDER BY r.created_at DESC`
  );
  res.json(rows);
});

const DecideCapacityRequest = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  notes: z.string().max(500).optional(),
});

platform.post('/capacity-requests/:id/decide', async (req, res) => {
  const id = req.params.id;
  const b = parse(DecideCapacityRequest, req.body);
  const [r] = await raw<any>('SELECT * FROM wfm.license_capacity_requests WHERE id = $1', [id]);
  if (!r) throw notFound('Capacity request');
  if (r.status !== 'PENDING') throw bad(`Request already decided (${r.status})`);

  if (b.action === 'APPROVE') {
    const [lic] = await raw<any>('SELECT id, max_employees, max_users FROM wfm.licenses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [r.tenantId]);
    if (lic) {
      if (r.resourceType === 'EMPLOYEES') {
        await raw('UPDATE wfm.licenses SET max_employees = max_employees + $2, updated_at = now() WHERE id = $1', [lic.id, r.additionalNeeded]);
      } else if (r.resourceType === 'USERS') {
        await raw('UPDATE wfm.licenses SET max_users = max_users + $2, updated_at = now() WHERE id = $1', [lic.id, r.additionalNeeded]);
      }
    }
  }

  const [updated] = await raw<any>(
    `UPDATE wfm.license_capacity_requests SET
       status = $2,
       reviewed_by_admin = $3,
       reviewed_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, b.action === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.platformAdmin?.id || null]
  );

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: b.action === 'APPROVE' ? 'APPROVE_CAPACITY_REQUEST' : 'REJECT_CAPACITY_REQUEST',
    targetTenantId: r.tenantId,
    targetEntityType: 'CAPACITY_REQUEST',
    targetEntityId: id,
    details: { request: r, decision: b.action, notes: b.notes },
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    status: 'SUCCESS',
  });

  res.json(updated);
});
