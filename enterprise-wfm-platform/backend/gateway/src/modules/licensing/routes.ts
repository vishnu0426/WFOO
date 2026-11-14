import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant } from '../../db.ts';
import { me, requires } from '../../auth.ts';
import { parse, bad, conflict } from '../../http.ts';
import { getTenantLicenseUsage } from './service.ts';
import { ALL_MODULES, getPlan, listPlans, whyNotFit } from '../platform/plans.ts';
import { notifyPlatformAdmins } from '../platform/settings.ts';

export const license = Router();

/**
 * Ask for more of something (employees, users, sites, workspaces) or for modules the plan does not include. The customer says what and how much;
 * the current capacity is read from the licence here, never taken from the request, and a second request of the same kind waits until the first is decided.
 */
const CapacityRequestBody = z.object({
  resourceType: z.enum(['EMPLOYEES', 'USERS', 'SITES', 'WORKSPACES', 'MODULES']),
  additionalNeeded: z.number().int().min(1).max(100000).optional(),
  modules: z.array(z.enum(ALL_MODULES)).max(9).optional(),
  justification: z.string().trim().max(1000).default(''),
});

license.get('/', requires('users:read'), async (req, res) => {
  const p = me(req);
  const report = await withTenant(p.tenantId, (tx) => getTenantLicenseUsage(tx, p.tenantId));
  res.json(report);
});

license.get('/requests', requires('users:read'), async (req, res) => {
  const p = me(req);
  const rows = await withTenant(p.tenantId, (tx) =>
    tx.q(
      `SELECT r.*, u.username AS requester_name, u.email AS requester_email
       FROM wfm.license_capacity_requests r
       JOIN wfm.users u ON u.id = r.requested_by_user_id
       WHERE r.tenant_id = :t
       ORDER BY r.created_at DESC`
    )
  );
  res.json(rows);
});

/** The plans a customer can look at, with what each would mean for them today. No prices; limits and modules only. */
license.get('/plans', requires('users:read'), async (req, res) => {
  const p = me(req);
  const [report, pending] = await withTenant(p.tenantId, async (tx) => [
    await getTenantLicenseUsage(tx, p.tenantId),
    await tx.one<any>(`SELECT id, requested_plan, created_at FROM wfm.license_capacity_requests WHERE tenant_id = :t AND resource_type = 'PLAN' AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`),
  ] as const);
  const usage = { seats: report.license.maxEmployees, employees: report.capacity.employees.current, users: report.capacity.users.current, sites: report.capacity.sites.current, workspaces: report.capacity.workspaces.current };
  const current = String((report.license as any).planTier ?? '');
  const plans = (await listPlans()).filter((x) => x.status === 'ACTIVE' || x.code === current);
  res.json({
    current,
    usage,
    pending: pending ? { id: pending.id, planCode: pending.requestedPlan ?? pending.requested_plan, createdAt: pending.createdAt ?? pending.created_at } : null,
    plans: plans.map((x) => ({
      code: x.code, name: x.name, description: x.description, isCustom: x.isCustom, current: x.code === current,
      seatsMin: x.seatsMin, seatsMax: x.seatsMax, maxUsers: x.maxUsers, maxSites: x.maxSites, maxWorkspaces: x.maxWorkspaces, modules: x.modules,
      problems: x.code === current ? [] : whyNotFit(x, usage),
    })),
  });
});

/** Ask to move to another plan. The customer only chooses the plan (and may add a note): its limits come from the catalogue. A Super Admin decides. */
license.post('/plan-change', requires('users:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ planCode: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/), note: z.string().trim().max(1000).default('') }), req.body);
  const plan = await getPlan(b.planCode);
  if (!plan || plan.status !== 'ACTIVE') throw bad('Choose one of the plans listed.');
  const row = await withTenant(p.tenantId, async (tx) => {
    const report = await getTenantLicenseUsage(tx, p.tenantId);
    if (String((report.license as any).planTier) === plan.code) throw bad('You are already on this plan.');
    const problems = whyNotFit(plan, { seats: report.license.maxEmployees, employees: report.capacity.employees.current, users: report.capacity.users.current, sites: report.capacity.sites.current, workspaces: report.capacity.workspaces.current });
    if (problems.length) throw bad(problems.join(' '));
    if (await tx.one(`SELECT 1 FROM wfm.license_capacity_requests WHERE tenant_id = :t AND resource_type = 'PLAN' AND status = 'PENDING'`)) throw conflict('A plan change is already waiting for approval.');
    return tx.one<any>(
      `INSERT INTO wfm.license_capacity_requests (tenant_id, requested_by_user_id, resource_type, current_capacity, requested_capacity, additional_needed, justification, requested_plan)
       VALUES (:t, $1, 'PLAN', $2, $2, 0, $3, $4) RETURNING *`,
      [p.userId, report.license.maxEmployees, b.note, plan.code]);
  });
  // Tell the Super Admins by email when mail is set up. The request is saved either way and shows in their Licensing page and dashboard.
  const [org] = await raw<any>('SELECT name FROM wfm.tenants WHERE id = $1', [p.tenantId]);
  void notifyPlatformAdmins(`Plan change request from ${org?.name ?? 'a customer'}`, `${org?.name ?? 'A customer'} asked to move to the ${plan.name} plan.${b.note ? `\n\nTheir note: ${b.note}` : ''}\n\nReview it under Licensing in the Super Admin portal.`);
  res.status(201).json(row);
});

license.post('/requests', requires('users:write'), async (req, res) => {
  const p = me(req);
  const b = parse(CapacityRequestBody, req.body);
  const LIMIT_COLUMN: Record<string, string> = { EMPLOYEES: 'max_employees', USERS: 'max_users', SITES: 'max_sites', WORKSPACES: 'max_workspaces' };
  const LABEL: Record<string, string> = { EMPLOYEES: 'employee seats', USERS: 'user accounts', SITES: 'sites', WORKSPACES: 'workspaces', MODULES: 'modules' };

  const row = await withTenant(p.tenantId, async (tx) => {
    const lic = await tx.one<any>(`SELECT id, max_employees, max_users, max_sites, max_workspaces FROM wfm.licenses WHERE tenant_id = :t AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 1`);
    if (!lic) throw bad('This organisation has no active licence.');
    let current = 0, additional = 0, modules: string[] = [];
    if (b.resourceType === 'MODULES') {
      modules = [...new Set(b.modules ?? [])];
      if (!modules.length) throw bad('Choose the modules you want.');
      const have = new Set((await tx.q<any>('SELECT module_code FROM wfm.license_modules WHERE license_id = $1 AND enabled', [lic.id])).map((m) => m.moduleCode ?? m.module_code));
      const already = modules.filter((m) => have.has(m));
      if (already.length) throw bad(`Already included in your licence: ${already.join(', ')}.`);
      current = have.size; additional = modules.length;
    } else {
      if (!b.additionalNeeded) throw bad(`Say how many more ${LABEL[b.resourceType]} you need.`);
      const col = LIMIT_COLUMN[b.resourceType];
      const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      current = Number(lic[camel] ?? lic[col]); additional = b.additionalNeeded;
    }
    if (await tx.one(`SELECT 1 FROM wfm.license_capacity_requests WHERE tenant_id = :t AND resource_type = $1 AND status = 'PENDING'`, [b.resourceType])) {
      throw conflict(`A request for ${LABEL[b.resourceType]} is already waiting for approval.`);
    }
    return tx.one<any>(
      `INSERT INTO wfm.license_capacity_requests (tenant_id, requested_by_user_id, resource_type, current_capacity, requested_capacity, additional_needed, justification, requested_modules)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [p.userId, b.resourceType, current, current + additional, additional, b.justification, modules]);
  });
  const [org] = await raw<any>('SELECT name FROM wfm.tenants WHERE id = $1', [p.tenantId]);
  const what = b.resourceType === 'MODULES' ? `the ${(b.modules ?? []).join(', ')} module${(b.modules ?? []).length > 1 ? 's' : ''}` : `${b.additionalNeeded} more ${LABEL[b.resourceType]}`;
  void notifyPlatformAdmins(`Request from ${org?.name ?? 'a customer'}: ${what}`, `${org?.name ?? 'A customer'} asked for ${what}.${b.justification ? `\n\nTheir reason: ${b.justification}` : ''}\n\nReview it under Licensing in the Super Admin portal.`);
  res.status(201).json(row);
});
