/**
 * Plan catalogue and country templates, both managed by Super Admins.
 *
 * A plan says what a customer on it gets: the range of employee seats it covers, the limits on users, sites and workspaces, the modules, how long
 * the grace period and a trial run. A licence COPIES those numbers when it is issued, so editing a plan never changes a customer by itself.
 * "Apply to customers" does that on purpose, after a preview, and skips licences with custom terms.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw } from '../../db.ts';
import { bad, conflict, notFound, parse } from '../../http.ts';
import { dropCache, redis } from '../../infra.ts';
import type { AuditFn } from './settings.ts';
import { BUILT_INS } from '../compliance/rules.ts';

export const ALL_MODULES = ['FORECASTING', 'SCHEDULING', 'INTRADAY', 'ADHERENCE', 'TIME_OFF', 'SHIFT_BIDDING', 'EMPLOYEE_SELF_SERVICE', 'REPORTING', 'AI_COPILOT'] as const;

export interface PlanRow {
  code: string; name: string; description: string; seatsMin: number; seatsMax: number; maxUsers: number; maxSites: number; maxWorkspaces: number;
  modules: string[]; gracePeriodDays: number; trialDays: number; listPrice: number | null; priceCurrency: string; status: 'ACTIVE' | 'RETIRED'; isCustom: boolean; sortOrder: number;
}

const planOf = (r: any): PlanRow => ({
  code: r.code, name: r.name, description: r.description ?? '', seatsMin: r.seatsMin ?? r.seats_min, seatsMax: r.seatsMax ?? r.seats_max,
  maxUsers: r.maxUsers ?? r.max_users, maxSites: r.maxSites ?? r.max_sites, maxWorkspaces: r.maxWorkspaces ?? r.max_workspaces,
  modules: r.modules ?? [], gracePeriodDays: r.gracePeriodDays ?? r.grace_period_days, trialDays: r.trialDays ?? r.trial_days,
  listPrice: (r.listPrice ?? r.list_price) == null ? null : Number(r.listPrice ?? r.list_price), priceCurrency: r.priceCurrency ?? r.price_currency ?? 'USD',
  status: r.status, isCustom: !!(r.isCustom ?? r.is_custom), sortOrder: r.sortOrder ?? r.sort_order ?? 100,
});

export async function getPlan(code: string): Promise<PlanRow | null> {
  const [r] = await raw<any>('SELECT * FROM wfm.plans WHERE code = $1', [code]);
  return r ? planOf(r) : null;
}

export interface TermsInput { maxEmployees?: number; maxUsers?: number; maxSites?: number; maxWorkspaces?: number; gracePeriodDays?: number; modules?: string[]; reason?: string }
export interface Terms { maxEmployees: number; maxUsers: number; maxSites: number; maxWorkspaces: number; gracePeriodDays: number; modules: string[]; customTerms: boolean; customReason: string }

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The limits a licence on this plan gets. Anything not given comes from the plan. Seats must be within the plan's range (the Custom plan has no range).
 * If users, sites, workspaces or modules differ from the plan, the terms are custom and a reason is required.
 */
export function resolveTerms(plan: PlanRow, input: TermsInput): Terms {
  // The plan sets the employee limit. Only a negotiated (Custom) plan has no number of its own, so one must be given.
  const maxEmployees = input.maxEmployees ?? (plan.isCustom ? undefined : plan.seatsMax);
  if (maxEmployees === undefined) throw bad('Enter the number of employee seats for this negotiated plan.');
  const maxUsers = input.maxUsers ?? plan.maxUsers, maxSites = input.maxSites ?? plan.maxSites, maxWorkspaces = input.maxWorkspaces ?? plan.maxWorkspaces;
  const modules = (input.modules ?? plan.modules).filter((m, i, a) => a.indexOf(m) === i);
  if (modules.length === 0) throw bad('Enable at least one module.');
  const differs = (!plan.isCustom && maxEmployees !== plan.seatsMax) || maxUsers !== plan.maxUsers || maxSites !== plan.maxSites || maxWorkspaces !== plan.maxWorkspaces || !sameSet(modules, plan.modules);
  const customTerms = plan.isCustom || differs;
  const reason = (input.reason ?? '').trim();
  if (differs && !plan.isCustom && reason.length < 5) throw bad(`These limits differ from the ${plan.name} plan. Say why (at least a few words) so the exception is on record.`);
  return { maxEmployees, maxUsers, maxSites, maxWorkspaces, gracePeriodDays: input.gracePeriodDays ?? plan.gracePeriodDays, modules, customTerms, customReason: customTerms ? reason : '' };
}

export async function listPlans(): Promise<PlanRow[]> {
  return (await raw<any>('SELECT * FROM wfm.plans ORDER BY sort_order, name')).map(planOf);
}

export interface Usage { seats: number; employees: number; users: number; sites: number; workspaces: number }
/** Why a customer cannot move to this plan right now, in plain words. Empty when it fits: their seats and what they use today are within the plan's limits. */
export function whyNotFit(plan: PlanRow, u: Usage): string[] {
  const out: string[] = [];
  if (plan.isCustom) return ['Negotiated plans are arranged with us directly.'];
  if (u.employees > plan.seatsMax) out.push(`You have ${u.employees.toLocaleString()} employees; ${plan.name} allows ${plan.seatsMax.toLocaleString()}.`);
  if (u.users > plan.maxUsers) out.push(`You have ${u.users} users; ${plan.name} allows ${plan.maxUsers}.`);
  if (u.sites > plan.maxSites) out.push(`You have ${u.sites} sites; ${plan.name} allows ${plan.maxSites}.`);
  if (u.workspaces > plan.maxWorkspaces) out.push(`You have ${u.workspaces} workspaces; ${plan.name} allows ${plan.maxWorkspaces}.`);
  return out;
}

export async function usageOf(tenantId: string, seats: number): Promise<Usage> {
  const [r] = await raw<any>(
    `SELECT (SELECT count(*)::int FROM wfm.employees WHERE tenant_id = $1 AND status <> 'TERMINATED') AS employees,
            (SELECT count(*)::int FROM wfm.users WHERE tenant_id = $1 AND status = 'ACTIVE') AS users,
            (SELECT count(*)::int FROM wfm.sites WHERE tenant_id = $1) AS sites,
            (SELECT count(*)::int FROM wfm.workspaces WHERE tenant_id = $1 AND status = 'ACTIVE') AS workspaces`, [tenantId]);
  return { seats, employees: r.employees, users: r.users, sites: r.sites, workspaces: r.workspaces };
}

/** Move a licence onto a plan: the plan's employee limit, other limits and modules replace the licence's, and any exceptions are cleared. Dates stay. */
export async function applyPlanToLicence(licenceId: string, tenantId: string, plan: PlanRow): Promise<void> {
  await raw(
    `UPDATE wfm.licenses SET plan_tier = $2, max_users = $3, max_sites = $4, max_workspaces = $5, grace_period_days = $6, max_employees = $7, custom_terms = false, custom_reason = '', updated_at = now() WHERE id = $1`,
    [licenceId, plan.code, plan.maxUsers, plan.maxSites, plan.maxWorkspaces, plan.gracePeriodDays, plan.seatsMax]);
  for (const m of ALL_MODULES) {
    await raw(
      `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled) VALUES ($1, $2, $3, $4)
       ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = $4`, [licenceId, tenantId, m, plan.modules.includes(m)]);
  }
  await forget(tenantId);
}

export const addMonths = (from: Date, months: number): Date => { const d = new Date(from); d.setUTCMonth(d.getUTCMonth() + months); return d; };

const Code = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/, 'Use capital letters, digits and underscores, starting with a letter');
const Int = (min: number, max: number) => z.number().int().min(min).max(max);
const PlanBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  seatsMin: Int(1, 1_000_000).default(1), seatsMax: Int(1, 1_000_000),     // seatsMin is unused: the plan's employee limit is seatsMax
  maxUsers: Int(1, 1_000_000), maxSites: Int(1, 1_000_000), maxWorkspaces: Int(1, 1_000_000),
  modules: z.array(z.enum(ALL_MODULES)).min(1, 'Choose at least one module'),
  gracePeriodDays: Int(0, 365), trialDays: Int(1, 365),
  listPrice: z.number().min(0).max(1_000_000).nullable().default(null),
  priceCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD'),
  sortOrder: Int(0, 10000).default(100),
}).refine((b) => b.seatsMax >= b.seatsMin, { message: 'The largest seat count must be at least the smallest', path: ['seatsMax'] });

const TemplateBody = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().trim().min(1).max(80),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code'),
  locale: z.string().trim().min(2).max(20).default('en'),
  payWeekStart: Int(0, 6),
  weekendDays: z.array(Int(0, 6)).min(1, 'Choose at least one weekend day').max(3, 'A weekend is at most three days').refine((a) => new Set(a).size === a.length, 'Each day once'),
  addHolidays: z.boolean().default(true),
  compliancePack: z.string().trim().max(60).nullable().default(null).refine((v) => v === null || BUILT_INS.some((b) => b.code === v), 'Choose one of the ready-made labour-law packs'),
  sortOrder: Int(0, 10000).default(100),
});

/** Make the cache of a tenant forget its licence, so a change shows at once. */
export async function forget(tenantId: string) {
  await dropCache(tenantId, 'perms:*').catch(() => {});
  const keys = await redis.keys(`wfm:${tenantId}:*`).catch(() => []);
  if (keys.length) await redis.del(...keys).catch(() => {});
}

export function plansRouter(audit: AuditFn, ipOf: (req: any) => string): Router {
  const r = Router();
  const who = (req: any) => req.platformAdmin!.email as string;
  const ua = (req: any) => (req.headers['user-agent'] as string) || 'Unknown';
  const log = (req: any, action: string, name: string, details: Record<string, any>) =>
    audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action, targetEntityType: 'PLAN', targetEntityName: name, ipAddress: ipOf(req), userAgent: ua(req), details, status: 'SUCCESS' });

  // ---------------------------------------------------------------- plans
  r.get('/plans', async (_req, res) => {
    const rows = await raw<any>('SELECT * FROM wfm.plans ORDER BY sort_order, name');
    const use = await raw<any>(
      `SELECT l.plan_tier AS code, count(*)::int AS customers,
              count(*) FILTER (WHERE NOT l.custom_terms AND NOT p.is_custom AND (l.max_employees <> p.seats_max OR l.max_users <> p.max_users OR l.max_sites <> p.max_sites OR l.max_workspaces <> p.max_workspaces
                OR l.grace_period_days <> p.grace_period_days
                OR (SELECT coalesce(array_agg(module_code ORDER BY module_code), '{}') FROM wfm.license_modules m WHERE m.license_id = l.id AND m.enabled) <> (SELECT array_agg(x ORDER BY x) FROM unnest(p.modules) x)))::int AS out_of_date
       FROM wfm.licenses l JOIN wfm.plans p ON p.code = l.plan_tier WHERE l.status <> 'CANCELLED' GROUP BY l.plan_tier, p.is_custom`
    );
    const by = new Map(use.map((u: any) => [u.code, u]));
    res.json(rows.map((p) => ({ ...planOf(p), customers: (by.get(p.code) as any)?.customers ?? 0, outOfDate: (by.get(p.code) as any)?.outOfDate ?? (by.get(p.code) as any)?.out_of_date ?? 0 })));
  });

  r.post('/plans', async (req, res) => {
    const code = parse(Code, req.body?.code);
    const b = parse(PlanBody, req.body);
    if (await getPlan(code)) throw conflict(`A plan with the code ${code} already exists.`);
    await raw(
      `INSERT INTO wfm.plans (code, name, description, seats_min, seats_max, max_users, max_sites, max_workspaces, modules, grace_period_days, trial_days, list_price, price_currency, sort_order, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [code, b.name, b.description, b.seatsMin, b.seatsMax, b.maxUsers, b.maxSites, b.maxWorkspaces, b.modules, b.gracePeriodDays, b.trialDays, b.listPrice, b.priceCurrency, b.sortOrder, who(req)]
    );
    await log(req, 'CREATE_PLAN', code, { ...b, code });
    res.status(201).json(await getPlan(code));
  });

  r.patch('/plans/:code', async (req, res) => {
    const code = parse(Code, req.params.code);
    const before = await getPlan(code);
    if (!before) throw notFound('Plan');
    const b = parse(PlanBody, req.body);
    await raw(
      `UPDATE wfm.plans SET name = $2, description = $3, seats_min = $4, seats_max = $5, max_users = $6, max_sites = $7, max_workspaces = $8, modules = $9,
              grace_period_days = $10, trial_days = $11, list_price = $12, price_currency = $13, sort_order = $14, updated_by = $15, updated_at = now() WHERE code = $1`,
      [code, b.name, b.description, b.seatsMin, b.seatsMax, b.maxUsers, b.maxSites, b.maxWorkspaces, b.modules, b.gracePeriodDays, b.trialDays, b.listPrice, b.priceCurrency, b.sortOrder, who(req)]
    );
    await log(req, 'UPDATE_PLAN', code, { before, after: b });
    res.json(await getPlan(code));
  });

  r.post('/plans/:code/status', async (req, res) => {
    const code = parse(Code, req.params.code);
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'RETIRED']) }), req.body);
    const p = await getPlan(code);
    if (!p) throw notFound('Plan');
    if (p.isCustom && status === 'RETIRED') throw bad('The Custom plan is how negotiated deals are recorded, so it cannot be retired.');
    await raw('UPDATE wfm.plans SET status = $2, updated_by = $3, updated_at = now() WHERE code = $1', [code, status, who(req)]);
    await log(req, status === 'RETIRED' ? 'RETIRE_PLAN' : 'REACTIVATE_PLAN', code, {});
    res.json(await getPlan(code));
  });

  /** Who is on this plan with numbers that differ from it. Nothing changes. Licences with custom terms are never touched. */
  const outOfDate = async (code: string) => {
    const rows = await raw<any>(
      `SELECT l.id, l.tenant_id, t.name AS tenant_name, t.code AS tenant_code, l.max_employees, l.max_users, l.max_sites, l.max_workspaces, l.grace_period_days,
              (SELECT coalesce(array_agg(module_code ORDER BY module_code), '{}') FROM wfm.license_modules m WHERE m.license_id = l.id AND m.enabled) AS modules
       FROM wfm.licenses l JOIN wfm.tenants t ON t.id = l.tenant_id
       WHERE l.plan_tier = $1 AND l.status <> 'CANCELLED' AND NOT l.custom_terms ORDER BY t.name`, [code]);
    const plan = (await getPlan(code))!;
    if (plan.isCustom) return [];                 // negotiated terms are per customer: there is nothing to apply
    return rows.map((l) => {
      const cur = { maxEmployees: l.maxEmployees ?? l.max_employees, maxUsers: l.maxUsers ?? l.max_users, maxSites: l.maxSites ?? l.max_sites, maxWorkspaces: l.maxWorkspaces ?? l.max_workspaces, gracePeriodDays: l.gracePeriodDays ?? l.grace_period_days, modules: [...(l.modules ?? [])].sort() };
      const next = { maxEmployees: plan.seatsMax, maxUsers: plan.maxUsers, maxSites: plan.maxSites, maxWorkspaces: plan.maxWorkspaces, gracePeriodDays: plan.gracePeriodDays, modules: [...plan.modules].sort() };
      const changed = cur.maxEmployees !== next.maxEmployees || cur.maxUsers !== next.maxUsers || cur.maxSites !== next.maxSites || cur.maxWorkspaces !== next.maxWorkspaces || cur.gracePeriodDays !== next.gracePeriodDays || !sameSet(cur.modules, next.modules);
      return { licenseId: l.id, tenantId: l.tenantId ?? l.tenant_id, tenantName: l.tenantName ?? l.tenant_name, tenantCode: l.tenantCode ?? l.tenant_code, current: cur, next, changed };
    }).filter((x) => x.changed);
  };

  r.get('/plans/:code/apply-preview', async (req, res) => {
    const code = parse(Code, req.params.code);
    if (!(await getPlan(code))) throw notFound('Plan');
    res.json(await outOfDate(code));
  });

  r.post('/plans/:code/apply', async (req, res) => {
    const code = parse(Code, req.params.code);
    const plan = await getPlan(code);
    if (!plan) throw notFound('Plan');
    const todo = await outOfDate(code);
    for (const t of todo) {
      await raw('UPDATE wfm.licenses SET max_employees = $6, max_users = $2, max_sites = $3, max_workspaces = $4, grace_period_days = $5, updated_at = now() WHERE id = $1', [t.licenseId, plan.maxUsers, plan.maxSites, plan.maxWorkspaces, plan.gracePeriodDays, plan.seatsMax]);
      for (const m of ALL_MODULES) {
        await raw(
          `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled) VALUES ($1, $2, $3, $4)
           ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = $4`, [t.licenseId, t.tenantId, m, plan.modules.includes(m)]);
      }
      await forget(t.tenantId);
      await audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action: 'APPLY_PLAN', targetEntityType: 'LICENSE', targetEntityId: t.licenseId, targetEntityName: t.tenantName, ipAddress: ipOf(req), userAgent: ua(req), details: { plan: code, from: t.current, to: t.next }, status: 'SUCCESS' });
    }
    res.json({ updated: todo.length });
  });

  // ---------------------------------------------------------------- country templates
  r.get('/country-templates', async (_req, res) => {
    const rows = await raw<any>('SELECT * FROM wfm.country_templates ORDER BY sort_order, name');
    res.json(rows.map((t) => ({ code: t.code, name: t.name, timezone: t.timezone, currency: t.currency, locale: t.locale, payWeekStart: t.payWeekStart ?? t.pay_week_start, weekendDays: (t.weekendDays ?? t.weekend_days).map(Number), addHolidays: t.addHolidays ?? t.add_holidays, compliancePack: t.compliancePack ?? t.compliance_pack ?? null, sortOrder: t.sortOrder ?? t.sort_order })));
  });

  /** The ready-made labour-law packs a country template can point at. */
  r.get('/builtin-packs', (_req, res) => { res.json(BUILT_INS.map((b) => ({ code: b.code, name: b.name, region: b.region }))); });

  r.put('/country-templates/:code', async (req, res) => {
    const code = parse(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use the two-letter country code'), req.params.code);
    const b = parse(TemplateBody, req.body);
    const [clash] = await raw<any>('SELECT code FROM wfm.country_templates WHERE lower(name) = lower($1) AND code <> $2', [b.name, code]);
    if (clash) throw conflict(`${clash.code} already uses the name "${b.name}".`);
    await raw(
      `INSERT INTO wfm.country_templates (code, name, timezone, currency, locale, pay_week_start, weekend_days, add_holidays, sort_order, updated_by, compliance_pack)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (code) DO UPDATE SET name = $2, timezone = $3, currency = $4, locale = $5, pay_week_start = $6, weekend_days = $7, add_holidays = $8, sort_order = $9, updated_by = $10, compliance_pack = $11, updated_at = now()`,
      [code, b.name, b.timezone, b.currency, b.locale, b.payWeekStart, [...b.weekendDays].sort((a, c) => a - c), b.addHolidays, b.sortOrder, who(req), b.compliancePack]
    );
    await audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action: 'UPDATE_COUNTRY_TEMPLATE', targetEntityType: 'COUNTRY_TEMPLATE', targetEntityName: `${code} ${b.name}`, ipAddress: ipOf(req), userAgent: ua(req), details: b, status: 'SUCCESS' });
    res.json({ ok: true });
  });

  r.delete('/country-templates/:code', async (req, res) => {
    const code = parse(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/), req.params.code);
    const gone = await raw<any>('DELETE FROM wfm.country_templates WHERE code = $1 RETURNING name', [code]);
    if (!gone.length) throw notFound('Country template');
    await audit({ adminId: req.platformAdmin!.id, adminEmail: who(req), action: 'DELETE_COUNTRY_TEMPLATE', targetEntityType: 'COUNTRY_TEMPLATE', targetEntityName: `${code} ${gone[0].name}`, ipAddress: ipOf(req), userAgent: ua(req), status: 'SUCCESS' });
    res.json({ ok: true });
  });

  return r;
}
