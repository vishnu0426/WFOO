/** Organisation profile, workspaces and workspace membership. */
import { Router } from 'express';
import { assertCapacity } from './licensing/service.ts';
import { z } from 'zod';
import { withTenant, withWorkspace, raw, pool, type Tx } from '../db.ts';
import { me, requires, requireUnscoped } from '../auth.ts';
import { addHolidays, hasCountry, publicHolidays } from './holidays.ts';
import { ensureBuiltIns } from './compliance/routes.ts';
import { BUILT_INS } from './compliance/rules.ts';
import { cleanWeekend } from './payWeek.ts';
import { audit } from '../audit.ts';
import { bad, conflict, notFound, parse } from '../http.ts';

export const organization = Router();
export const workspaces = Router();

const uuid = z.string().uuid();
const WorkspaceBody = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, 'may only contain lowercase letters, numbers and dash').optional(),
  description: z.string().max(500).optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: z.string().min(3).max(3).optional(),
});
const WorkspacePatch = WorkspaceBody.partial();

/**
 * Creating a workspace asks for little: a name, and optionally a country (its time zone, currency, holidays, week and labour-law pack are filled in), or a workspace to start from
 * (its shift templates, scheduling rules, holidays, labour-law packs and skills are copied: never people, schedules, forecasts or history), and who manages it.
 * The code and the web address are made from the name unless given.
 */
const CopyWhat = z.object({ shiftTemplates: z.boolean().default(true), schedulingRules: z.boolean().default(true), holidays: z.boolean().default(true), labourLawPacks: z.boolean().default(true), skills: z.boolean().default(true) });
const CreateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().max(40).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore').optional(),
  slug: z.string().max(60).regex(/^[a-z0-9-]+$/, 'may only contain lowercase letters, numbers and dash').optional(),
  description: z.string().max(500).optional(),
  timezone: z.string().min(1).max(80).optional(), currency: z.string().length(3).optional(),
  country: z.string().length(2).optional(),
  addHolidays: z.boolean().default(true), applyPack: z.boolean().default(true),
  copyFromWorkspaceId: uuid.nullable().default(null), copy: CopyWhat.default({ shiftTemplates: true, schedulingRules: true, holidays: true, labourLawPacks: true, skills: true }),
  adminUserIds: z.array(uuid).max(50).default([]),
});

/** A code or address that is not taken yet: the base, then base_2, base_3... */
async function freeValue(tx: Tx, column: 'code' | 'slug', base: string, sep: string): Promise<string> {
  for (let n = 1; n < 200; n++) {
    const v = n === 1 ? base : `${base}${sep}${n}`;
    if (!(await tx.one(`SELECT 1 FROM workspaces WHERE tenant_id = :t AND ${column} = $1`, [v]))) return v;
  }
  throw bad('Could not find a free code for this workspace. Give it one.');
}

/** Copy one table's rows from a workspace to another, as the database owner (a request may only touch its own workspace). `nulls` are columns left empty because they point at things not copied. */
async function copyTable(client: import('pg').PoolClient, table: string, tenantId: string, from: string, to: string, opts: { where?: string; nulls?: string[] } = {}): Promise<number> {
  const cols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'wfm' AND table_name = $1 AND is_generated <> 'ALWAYS' AND coalesce(identity_generation, '') <> 'ALWAYS' ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name as string);
  const skip = new Set(['id', 'tenant_id', 'workspace_id', 'created_at', 'updated_at']);
  const data = cols.filter((c) => !skip.has(c));
  const list = ['tenant_id', 'workspace_id', ...data];
  const sel = ['tenant_id', '$3::uuid', ...data.map((c) => (opts.nulls?.includes(c) ? 'NULL' : `"${c}"`))];
  const r = await client.query(`INSERT INTO wfm."${table}" (${list.map((c) => `"${c}"`).join(', ')}) SELECT ${sel.join(', ')} FROM wfm."${table}" WHERE tenant_id = $1 AND workspace_id = $2 ${opts.where ? `AND ${opts.where}` : ''}`, [tenantId, from, to]);
  return r.rowCount ?? 0;
}
const OrgPatch = z.object({
  name: z.string().min(1).max(160).optional(),
  legalName: z.string().max(200).optional(),
  displayName: z.string().max(160).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: z.string().email().nullable().optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: z.string().min(3).max(3).optional(),
  locale: z.string().min(2).max(20).optional(),
  fourEyes: z.boolean().optional(),
});
const MemberBody = z.object({
  userId: uuid,
  role: z.enum(['WFM_ADMIN', 'WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST', 'AGENT']),
  employeeId: uuid.nullable().optional(),
});
const MemberPatch = z.object({
  role: z.enum(['WFM_ADMIN', 'WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST', 'AGENT']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  employeeId: uuid.nullable().optional(),
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';

const workspaceDto = (w: any) => ({
  id: w.id, name: w.name, code: w.code, slug: w.slug, description: w.description, timezone: w.timezone, currency: w.currency,
  status: w.status, isDefault: w.isDefault, memberCount: w.memberCount ?? 0, createdAt: w.createdAt, updatedAt: w.updatedAt,
});

async function workspace(tx: Tx, tenantId: string, id: string) {
  const w = await tx.one<any>('SELECT * FROM workspaces WHERE tenant_id = :t AND id = $1', [id]);
  if (!w) throw notFound('Workspace');
  return w;
}

organization.get('/', requires('organization:read'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>('SELECT * FROM tenants WHERE id = :t');
    const s = await tx.one<any>('SELECT * FROM organization_settings WHERE tenant_id = :t');
    return {
      id: t.id, orgId: t.id, code: t.code, name: s?.displayName || t.name, legalName: s?.legalName || t.name,
      displayName: s?.displayName || t.name, timezone: s?.timezone || t.timezone, currency: s?.currency || t.currency,
      fourEyes: t.fourEyes, contactName: s?.contactName ?? '', contactEmail: s?.contactEmail ?? null,
      locale: s?.locale ?? 'en', settings: s?.settings ?? {}, createdAt: t.createdAt,
    };
  }));
});

organization.patch('/', requires('organization:write'), async (req, res) => {
  const p = me(req), b = parse(OrgPatch, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT t.*, s.* FROM tenants t LEFT JOIN organization_settings s ON s.tenant_id = t.id WHERE t.id = :t');
    if (b.name || b.fourEyes !== undefined || b.timezone || b.currency) {
      await tx.exec('UPDATE tenants SET name = coalesce($2, name), four_eyes = coalesce($3, four_eyes), timezone = coalesce($4, timezone), currency = coalesce($5, currency) WHERE id = :t',
        [b.name ?? null, b.fourEyes ?? null, b.timezone ?? null, b.currency ?? null]);
    }
    await tx.exec(
      `INSERT INTO organization_settings (tenant_id, legal_name, display_name, contact_name, contact_email, timezone, currency, locale)
       SELECT :t, coalesce($1, ''), coalesce($2, ''), coalesce($3, ''), $4,
              coalesce($5, t.timezone), coalesce($6, t.currency), coalesce($7, 'en')
       FROM tenants t WHERE t.id = :t
       ON CONFLICT (tenant_id) DO UPDATE SET legal_name = coalesce($1, organization_settings.legal_name),
         display_name = coalesce($2, organization_settings.display_name), contact_name = coalesce($3, organization_settings.contact_name),
         contact_email = CASE WHEN $8::boolean THEN $4 ELSE organization_settings.contact_email END,
         timezone = coalesce($5, organization_settings.timezone), currency = coalesce($6, organization_settings.currency),
         locale = coalesce($7, organization_settings.locale), updated_at = now()`,
      [b.legalName ?? b.name ?? null, b.displayName ?? b.name ?? null, b.contactName ?? null, b.contactEmail ?? null,
        b.timezone ?? null, b.currency ?? null, b.locale ?? null, b.contactEmail !== undefined]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'ORGANIZATION', entityId: p.tenantId, entityName: b.name ?? before?.name ?? 'Organisation', before, after: b });
    const t = await tx.one<any>('SELECT * FROM tenants WHERE id = :t');
    const s = await tx.one<any>('SELECT * FROM organization_settings WHERE tenant_id = :t');
    return {
      id: t.id, orgId: t.id, code: t.code, name: s?.displayName || t.name, legalName: s?.legalName || t.name,
      displayName: s?.displayName || t.name, timezone: s?.timezone || t.timezone, currency: s?.currency || t.currency,
      fourEyes: t.fourEyes, contactName: s?.contactName ?? '', contactEmail: s?.contactEmail ?? null,
      locale: s?.locale ?? 'en', settings: s?.settings ?? {}, createdAt: t.createdAt,
    };
  });
  res.json(out);
});

workspaces.get('/', requires('workspace:read'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT w.*, (SELECT count(*)::int FROM workspace_members m
       WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM workspaces w WHERE w.tenant_id = :t ORDER BY w.is_default DESC, w.name`)).then((rows) => rows.map(workspaceDto)));
});

workspaces.post('/', requires('workspace:create'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), b = parse(CreateWorkspaceBody, req.body);
  const cc = b.country?.toUpperCase();
  if (cc && !hasCountry(cc)) throw bad('Choose a country from the list.');
  const [tpl] = cc ? await raw<any>('SELECT * FROM wfm.country_templates WHERE upper(code) = $1', [cc]) : [];

  // 1) the workspace itself, with the people who manage it
  const made = await withTenant(p.tenantId, async (tx) => {
    await assertCapacity(tx, p.tenantId, 'WORKSPACES', 1);
    if (b.copyFromWorkspaceId && !(await tx.one('SELECT 1 FROM workspaces WHERE tenant_id = :t AND id = $1', [b.copyFromWorkspaceId]))) throw notFound('Workspace to copy');
    const base = (b.code ?? b.name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16).toUpperCase() || 'WORKSPACE';
    const code = b.code ? b.code : await freeValue(tx, 'code', base, '_');
    const slug = b.slug ? b.slug : await freeValue(tx, 'slug', slugify(b.name), '-');
    const w = await tx.one<any>(
      `INSERT INTO workspaces (tenant_id, name, code, slug, description, timezone, currency, created_by)
       SELECT :t, $1, $2, $3, $4, coalesce($5, $8, t.timezone), coalesce($6, $9, t.currency), $7
       FROM tenants t WHERE t.id = :t RETURNING *`,
      [b.name, code, slug, b.description ?? '', b.timezone ?? null, b.currency ?? null, p.userId, tpl?.timezone ?? null, tpl?.currency ?? null]).catch((e) => { throw e.code === '23505' ? conflict('A workspace with that code or web address already exists.') : e; });
    const members = new Map<string, string>([[p.userId, p.role]]);
    if (b.adminUserIds.length) for (const u of await tx.q<any>('SELECT id, role FROM users WHERE tenant_id = :t AND status = \'ACTIVE\' AND id = ANY($1::uuid[])', [b.adminUserIds])) if (!members.has(u.id)) members.set(u.id, u.role);
    for (const [userId, role] of members) {
      await tx.exec(`INSERT INTO workspace_members (tenant_id, workspace_id, user_id, role, is_default) VALUES (:t, $1, $2, $3, false) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'ACTIVE', updated_at = now()`, [w!.id, userId, role]);
    }
    await audit(tx, p, req, { action: 'CREATE', entityType: 'WORKSPACE', entityId: w!.id, entityName: b.name, after: { name: b.name, country: cc ?? null, copiedFrom: b.copyFromWorkspaceId, admins: members.size } });
    return { w: w!, members: members.size };
  });

  // 2) what it starts with: a copy of another workspace's setup, or the country's defaults
  const setup = { copied: [] as string[], holidaysAdded: 0, packName: null as string | null, failed: null as string | null };
  try {
    if (b.copyFromWorkspaceId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const [from, to, t] = [b.copyFromWorkspaceId, made.w.id, p.tenantId];
        const c = b.copy;
        if (c.skills) { const n = await copyTable(client, 'skills', t, from, to); if (n) setup.copied.push(`${n} skill${n === 1 ? '' : 's'}`); }
        if (c.shiftTemplates) { const n = await copyTable(client, 'shift_templates', t, from, to, { nulls: ['group_ids', 'skill_ids'] }); if (n) setup.copied.push(`${n} shift template${n === 1 ? '' : 's'}`); }
        if (c.schedulingRules) { const n = await copyTable(client, 'scheduling_policy', t, from, to); if (n) setup.copied.push('scheduling rules'); }
        if (c.holidays) { const n = await copyTable(client, 'special_events', t, from, to, { where: `kind = 'holiday' AND wfm_group_id IS NULL AND site_id IS NULL AND queue_id IS NULL` }); if (n) setup.copied.push(`${n} holiday${n === 1 ? '' : 's'}`); }
        if (c.labourLawPacks) {
          const n = await copyTable(client, 'compliance_packs', t, from, to);
          if (n) setup.copied.push(`${n} labour-law pack${n === 1 ? '' : 's'}`);
          // the organisation-wide choice of pack, pointed at the copies
          await client.query(
            `INSERT INTO wfm.compliance_assignments (tenant_id, workspace_id, scope_type, scope_id, scope_key, pack_id)
             SELECT a.tenant_id, $3::uuid, 'TENANT', NULL, 'tenant', np.id FROM wfm.compliance_assignments a JOIN wfm.compliance_packs op ON op.id = a.pack_id
             JOIN wfm.compliance_packs np ON np.tenant_id = a.tenant_id AND np.workspace_id = $3::uuid AND np.code = op.code WHERE a.tenant_id = $1 AND a.workspace_id = $2 AND a.scope_type = 'TENANT'`, [t, from, to]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    } else if (cc) {
      await withWorkspace(p.tenantId, made.w.id, async (tx) => {
        if (tpl && (tpl.payWeekStart != null || tpl.weekendDays)) {
          await tx.exec(`INSERT INTO scheduling_policy (tenant_id, workspace_id, defaults, updated_by) VALUES (:t, :w, $1::jsonb, $2) ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
            [JSON.stringify({ payWeekStart: tpl.payWeekStart ?? 0, weekendDays: cleanWeekend(tpl.weekendDays) }), p.name]);
          setup.copied.push('the country\'s working week');
        }
        if (b.addHolidays) { const y = new Date().getUTCFullYear(); setup.holidaysAdded = await addHolidays(tx, [...publicHolidays(cc, y), ...publicHolidays(cc, y + 1)]); }
        const pack = b.applyPack && tpl?.compliancePack ? BUILT_INS.find((x) => x.code === tpl.compliancePack) : undefined;
        if (pack) {
          await ensureBuiltIns(tx);
          const row = await tx.one<any>('SELECT id, name FROM compliance_packs WHERE tenant_id = :t AND code = $1', [pack.code]);
          if (row) { await tx.exec(`INSERT INTO compliance_assignments (tenant_id, workspace_id, scope_type, scope_id, scope_key, pack_id) VALUES (:t, :w, 'TENANT', NULL, 'tenant', $1) ON CONFLICT DO NOTHING`, [row.id]); setup.packName = row.name; }
        }
      });
    }
  } catch (e: any) { setup.failed = e?.message ?? 'Part of the setup could not be completed.'; }
  res.status(201).json({ ...workspaceDto({ ...made.w, memberCount: made.members }), setup });
});

workspaces.post('/:id/restore', requires('workspace:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), id = parse(uuid, req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await workspace(tx, p.tenantId, id);
    if (before.status !== 'ARCHIVED') throw bad('That workspace is not archived.');
    await assertCapacity(tx, p.tenantId, 'WORKSPACES', 1);
    const w = await tx.one<any>(`UPDATE workspaces SET status = 'ACTIVE', updated_at = now() WHERE tenant_id = :t AND id = $1 RETURNING *`, [id]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WORKSPACE', entityId: id, entityName: before.name, diffSummary: 'Restored' });
    return workspaceDto({ ...w, memberCount: 0 });
  });
  res.json(out);
});

workspaces.patch('/:id', requires('workspace:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(WorkspacePatch, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await workspace(tx, p.tenantId, id);
    const w = await tx.one<any>(
      `UPDATE workspaces SET name = coalesce($2, name), code = coalesce($3, code), slug = coalesce($4, slug),
              description = coalesce($5, description), timezone = coalesce($6, timezone), currency = coalesce($7, currency), updated_at = now()
       WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name ?? null, b.code ?? null, b.slug ?? null, b.description ?? null, b.timezone ?? null, b.currency ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WORKSPACE', entityId: id, entityName: w!.name, before, after: b });
    return workspaceDto({ ...w, memberCount: 0 });
  });
  res.json(out);
});

workspaces.post('/:id/archive', requires('workspace:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await workspace(tx, p.tenantId, id);
    if (before.isDefault) throw bad('The default workspace cannot be archived. Make another workspace the default first.');
    if (before.id === p.workspaceId) throw bad('You cannot archive the workspace you are currently using.');
    const w = await tx.one<any>(`UPDATE workspaces SET status = 'ARCHIVED', is_default = false, updated_at = now() WHERE tenant_id = :t AND id = $1 RETURNING *`, [id]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WORKSPACE', entityId: id, entityName: before.name, diffSummary: 'Archived' });
    return workspaceDto({ ...w, memberCount: 0 });
  });
  res.json(out);
});

workspaces.get('/:id/members', requires('workspace:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  res.json(await withTenant(p.tenantId, async (tx) => {
    await workspace(tx, p.tenantId, id);
    return tx.q<any>(
      `SELECT m.user_id, m.role, m.status, m.is_default, m.employee_id, m.created_at,
              u.username, u.display_name AS user_name, u.email
       FROM workspace_members m JOIN users u ON u.id = m.user_id AND u.tenant_id = m.tenant_id
       WHERE m.tenant_id = :t AND m.workspace_id = $1 ORDER BY m.role, u.username`, [id]);
  }));
});

workspaces.post('/:id/members', requires('workspace:members'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(MemberBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    await workspace(tx, p.tenantId, id);
    const u = await tx.one<any>('SELECT id, username FROM users WHERE tenant_id = :t AND id = $1', [b.userId]);
    if (!u) throw notFound('User');
    const m = await tx.one<any>(
      `INSERT INTO workspace_members (tenant_id, workspace_id, user_id, employee_id, role, status, is_default)
       VALUES (:t, $1, $2, $3, $4, 'ACTIVE', false)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET employee_id = EXCLUDED.employee_id, role = EXCLUDED.role, status = 'ACTIVE', updated_at = now()
       RETURNING *`, [id, b.userId, b.employeeId ?? null, b.role]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'WORKSPACE_MEMBER', entityId: b.userId, entityName: u.username, after: { workspaceId: id, role: b.role } });
    return m;
  });
  res.status(201).json(out);
});

workspaces.patch('/:id/members/:userId', requires('workspace:members'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), userId = parse(uuid, req.params.userId), b = parse(MemberPatch, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    await workspace(tx, p.tenantId, id);
    const before = await tx.one<any>('SELECT * FROM workspace_members WHERE tenant_id = :t AND workspace_id = $1 AND user_id = $2', [id, userId]);
    if (!before) throw notFound('Workspace member');
    if (userId === p.userId && b.status === 'DISABLED') throw bad('You cannot disable your own workspace membership.');
    if ((b.role && b.role !== 'WFM_ADMIN') || b.status === 'DISABLED') {
      const [{ n }] = await tx.q<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members WHERE tenant_id = :t AND workspace_id = $1 AND role = 'WFM_ADMIN' AND status = 'ACTIVE'`, [id]);
      if (before.role === 'WFM_ADMIN' && before.status === 'ACTIVE' && n <= 1) throw conflict('A workspace needs at least one active administrator.');
    }
    const m = await tx.one<any>(
      `UPDATE workspace_members SET role = coalesce($3, role), status = coalesce($4, status),
              employee_id = CASE WHEN $5::boolean THEN $6 ELSE employee_id END, updated_at = now()
       WHERE tenant_id = :t AND workspace_id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, b.role ?? null, b.status ?? null, b.employeeId !== undefined, b.employeeId ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WORKSPACE_MEMBER', entityId: userId, entityName: userId, before, after: b });
    return m;
  });
  res.json(out);
});

workspaces.delete('/:id/members/:userId', requires('workspace:members'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), userId = parse(uuid, req.params.userId);
  await withTenant(p.tenantId, async (tx) => {
    await workspace(tx, p.tenantId, id);
    if (userId === p.userId) throw bad('You cannot remove your own workspace membership.');
    const before = await tx.one<any>('SELECT * FROM workspace_members WHERE tenant_id = :t AND workspace_id = $1 AND user_id = $2', [id, userId]);
    if (!before) throw notFound('Workspace member');
    if (before.role === 'WFM_ADMIN' && before.status === 'ACTIVE') {
      const [{ n }] = await tx.q<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members WHERE tenant_id = :t AND workspace_id = $1 AND role = 'WFM_ADMIN' AND status = 'ACTIVE'`, [id]);
      if (n <= 1) throw conflict('A workspace needs at least one active administrator.');
    }
    await tx.exec('DELETE FROM workspace_members WHERE tenant_id = :t AND workspace_id = $1 AND user_id = $2', [id, userId]);
    await tx.exec(`UPDATE users SET default_workspace_id = (
      SELECT m.workspace_id FROM workspace_members m WHERE m.tenant_id = :t AND m.user_id = $1 AND m.status = 'ACTIVE' ORDER BY m.is_default DESC LIMIT 1
    ) WHERE tenant_id = :t AND id = $1`, [userId]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'WORKSPACE_MEMBER', entityId: userId, entityName: userId, before });
  });
  res.json({ ok: true });
});
