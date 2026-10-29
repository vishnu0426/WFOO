import { Tx } from '../../db.ts';
import { HttpError, bad, conflict, notFound } from '../../http.ts';

export interface LicenseRecord {
  id: string;
  licenseKey: string;
  tenantId: string;
  planTier: string;
  edition: string;
  status: 'DRAFT' | 'ISSUED' | 'PROVISIONING' | 'ACTIVE' | 'GRACE_PERIOD' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  gracePeriodDays: number;
  maxEmployees: number;
  maxUsers: number;
  maxSupervisors: number;
  maxSites: number;
  maxWorkspaces: number;
  maxApiCallsPm: number;
  maxStorageGb: number;
  contractId: string | null;
  issuedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LicenseModuleRecord {
  moduleCode: string;
  enabled: boolean;
  tier: string;
}

export interface LicenseUsageReport {
  license: LicenseRecord;
  modules: LicenseModuleRecord[];
  capacity: {
    employees: {
      current: number;
      max: number;
      remaining: number;
      percentage: number;
    };
    users: {
      current: number;
      max: number;
      remaining: number;
      percentage: number;
    };
    supervisors: {
      current: number;
      max: number;
      remaining: number;
      percentage: number;
    };
    workspaces: {
      current: number;
      max: number;
      remaining: number;
      percentage: number;
    };
  };
  lifecycle: {
    status: string;
    daysRemaining: number;
    inGracePeriod: boolean;
    daysInGrace: number;
    isRestricted: boolean;
    isReadOnly: boolean;
    message?: string;
  };
}

export async function getTenantLicense(tx: Tx, tenantId: string): Promise<LicenseRecord> {
  const lic = await tx.one<LicenseRecord>(
    `SELECT * FROM wfm.licenses WHERE tenant_id = :t ORDER BY created_at DESC LIMIT 1`
  );
  if (!lic) {
    throw notFound('License for tenant');
  }
  return lic;
}

export async function getTenantModules(tx: Tx, licenseId: string): Promise<LicenseModuleRecord[]> {
  return tx.q<LicenseModuleRecord>(
    `SELECT module_code, enabled, tier FROM wfm.license_modules WHERE tenant_id = :t AND license_id = $1 ORDER BY module_code`,
    [licenseId]
  );
}

export function computeLifecycle(license: LicenseRecord) {
  const now = new Date();
  const endDate = new Date(license.endDate);
  const diffMs = endDate.getTime() - now.getTime();
  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  let inGracePeriod = false;
  let daysInGrace = 0;
  let isRestricted = false;
  let isReadOnly = false;
  let message: string | undefined;

  if (license.status === 'SUSPENDED' || license.status === 'CANCELLED') {
    isReadOnly = true;
    message = 'Tenant subscription has been suspended. Modifications are disabled.';
  } else if (diffMs < 0) {
    // Past end date
    daysInGrace = Math.floor(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
    if (daysInGrace <= license.gracePeriodDays) {
      inGracePeriod = true;
      if (daysInGrace > 7) {
        isRestricted = true;
        message = `License expired ${daysInGrace} days ago. System is in restricted grace period: new user and employee creations are disabled.`;
      } else {
        message = `License expired on ${endDate.toLocaleDateString()}. Grace period active (${license.gracePeriodDays - daysInGrace} days remaining).`;
      }
    } else {
      isReadOnly = true;
      message = 'License expired and grace period ended. System operates in read-only mode.';
    }
  } else if (daysRemaining <= 14) {
    message = `License will expire in ${daysRemaining} days (on ${endDate.toLocaleDateString()}). Please renew your subscription.`;
  }

  return {
    status: isReadOnly ? 'EXPIRED' : inGracePeriod ? 'GRACE_PERIOD' : license.status,
    daysRemaining,
    inGracePeriod,
    daysInGrace,
    isRestricted,
    isReadOnly,
    message,
  };
}

export async function getTenantLicenseUsage(tx: Tx, tenantId: string): Promise<LicenseUsageReport> {
  const license = await getTenantLicense(tx, tenantId);
  const modules = await getTenantModules(tx, license.id);

  // Active employees (non-terminated)
  const [{ count: empCount }] = await tx.q<{ count: number }>(
    `SELECT count(*)::int AS count FROM wfm.employees WHERE tenant_id = :t AND status != 'TERMINATED'`
  );

  // Active users
  const [{ count: userCount }] = await tx.q<{ count: number }>(
    `SELECT count(*)::int AS count FROM wfm.users WHERE tenant_id = :t AND status = 'ACTIVE'`
  );

  // Supervisor users
  const [{ count: supervisorCount }] = await tx.q<{ count: number }>(
    `SELECT count(*)::int AS count FROM wfm.users WHERE tenant_id = :t AND status = 'ACTIVE' AND role = 'SUPERVISOR_RTA'`
  );

  // Workspaces
  const [{ count: workspaceCount }] = await tx.q<{ count: number }>(
    `SELECT count(*)::int AS count FROM wfm.workspaces WHERE tenant_id = :t AND status = 'ACTIVE'`
  );

  const lifecycle = computeLifecycle(license);

  return {
    license,
    modules,
    capacity: {
      employees: {
        current: empCount,
        max: license.maxEmployees,
        remaining: Math.max(0, license.maxEmployees - empCount),
        percentage: license.maxEmployees > 0 ? Math.round((empCount / license.maxEmployees) * 1000) / 10 : 0,
      },
      users: {
        current: userCount,
        max: license.maxUsers,
        remaining: Math.max(0, license.maxUsers - userCount),
        percentage: license.maxUsers > 0 ? Math.round((userCount / license.maxUsers) * 1000) / 10 : 0,
      },
      supervisors: {
        current: supervisorCount,
        max: license.maxSupervisors,
        remaining: Math.max(0, license.maxSupervisors - supervisorCount),
        percentage: license.maxSupervisors > 0 ? Math.round((supervisorCount / license.maxSupervisors) * 1000) / 10 : 0,
      },
      workspaces: {
        current: workspaceCount,
        max: license.maxWorkspaces,
        remaining: Math.max(0, license.maxWorkspaces - workspaceCount),
        percentage: license.maxWorkspaces > 0 ? Math.round((workspaceCount / license.maxWorkspaces) * 1000) / 10 : 0,
      },
    },
    lifecycle,
  };
}

export async function assertCapacity(
  tx: Tx,
  tenantId: string,
  resource: 'EMPLOYEES' | 'USERS',
  delta: number = 1
): Promise<void> {
  const license = await getTenantLicense(tx, tenantId);
  const lifecycle = computeLifecycle(license);

  if (lifecycle.isReadOnly) {
    throw new HttpError(403, 'LICENSE_EXPIRED', lifecycle.message || 'Subscription has expired or is suspended. Modifications are blocked.');
  }

  if (lifecycle.isRestricted && delta > 0) {
    throw new HttpError(403, 'LICENSE_RESTRICTED', lifecycle.message || 'License is in restricted grace period. New capacity cannot be added.');
  }

  if (resource === 'EMPLOYEES') {
    const [{ count: current }] = await tx.q<{ count: number }>(
      `SELECT count(*)::int AS count FROM wfm.employees WHERE tenant_id = :t AND status != 'TERMINATED'`
    );
    if (current + delta > license.maxEmployees) {
      throw new HttpError(
        409,
        'EMPLOYEE_CAPACITY_EXCEEDED',
        `Employee capacity reached. Your subscription allows up to ${license.maxEmployees} active employees (current: ${current}, requested: +${delta}).`,
        {
          current,
          max: license.maxEmployees,
          remaining: Math.max(0, license.maxEmployees - current),
          requestedDelta: delta,
          resource: 'EMPLOYEES',
        }
      );
    }
  } else if (resource === 'USERS') {
    const [{ count: current }] = await tx.q<{ count: number }>(
      `SELECT count(*)::int AS count FROM wfm.users WHERE tenant_id = :t AND status = 'ACTIVE'`
    );
    if (current + delta > license.maxUsers) {
      throw new HttpError(
        409,
        'USER_CAPACITY_EXCEEDED',
        `User login capacity reached. Your subscription allows up to ${license.maxUsers} active users (current: ${current}, requested: +${delta}).`,
        {
          current,
          max: license.maxUsers,
          remaining: Math.max(0, license.maxUsers - current),
          requestedDelta: delta,
          resource: 'USERS',
        }
      );
    }
  }
}
