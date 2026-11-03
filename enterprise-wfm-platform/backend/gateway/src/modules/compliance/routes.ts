/**
 * Compliance packs: list the ready-made ones (India, EU, US), copy and edit them, and say where each applies
 * (organisation, WFM group or team). Rules are data: see rules.ts for the catalogue and how they are checked.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../../db.ts';
import { me, requires } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { bad, conflict, notFound, parse } from '../../http.ts';
import { dropCache } from '../../infra.ts';
import { BUILT_INS, CATALOG, RULE_TYPES, normaliseRule, type Rule } from './rules.ts';

export const compliance = Router();
const uuid = z.string().uuid();

/** Make sure the ready-made packs exist for this organisation (they are added once, then left alone). */
async function ensureBuiltIns(tx: Tx) {
  for (const b of BUILT_INS) {
    await tx.exec(
      `INSERT INTO compliance_packs (tenant_id, workspace_id, code, name, region, description, rules, built_in) VALUES (:t, :w, $1, $2, $3, $4, $5, true) ON CONFLICT (tenant_id, workspace_id, code) DO NOTHING`,
      [b.code, b.name, b.region, b.description, JSON.stringify(b.rules)]);
  }
}

const packDto = (p: any, used = 0) => ({ id: p.id, code: p.code, name: p.name, region: p.region, description: p.description, rules: p.rules as Rule[], builtIn: p.builtIn, version: p.version, usedBy: used });

/** The rules that apply to each person of a WFM group: their own override, else their team's pack, else the group's, else the organisation's, else none. */
export interface RuleSets { forTeam: (teamId: string | null | undefined, employeeId?: string | null) => Rule[]; group: Rule[]; packName: (teamId: string | null | undefined, employeeId?: string | null) => string | null }
export async function loadRuleSets(tx: Tx, groupId: string): Promise<RuleSets> {
  const rows = await tx.q<any>(
    `SELECT a.scope_type, a.scope_id, p.name, p.rules FROM compliance_assignments a JOIN compliance_packs p ON p.id = a.pack_id
     WHERE a.tenant_id = :t AND (a.scope_type = 'TENANT' OR a.scope_type = 'TEAM' OR a.scope_type = 'EMPLOYEE' OR (a.scope_type = 'GROUP' AND a.scope_id = $1))`, [groupId]);
  const tenant = rows.find((r) => r.scopeType === 'TENANT'), group = rows.find((r) => r.scopeType === 'GROUP');
  const teams = new Map(rows.filter((r) => r.scopeType === 'TEAM').map((r) => [r.scopeId, r]));
  const employees = new Map(rows.filter((r) => r.scopeType === 'EMPLOYEE').map((r) => [r.scopeId, r]));
  const pick = (teamId: string | null | undefined, employeeId?: string | null) => (employeeId && employees.get(employeeId)) || (teamId && teams.get(teamId)) || group || tenant || null;
  return { forTeam: (t, e) => (pick(t, e)?.rules as Rule[]) ?? [], group: ((group ?? tenant)?.rules as Rule[]) ?? [], packName: (t, e) => pick(t, e)?.name ?? null };
}

compliance.get('/catalog', requires('config:read'), (_req, res) => { res.json(CATALOG); });

compliance.get('/packs', requires('config:read'), async (req, res) => {
  const out = await withTenant(me(req).tenantId, async (tx) => {
    await ensureBuiltIns(tx);
    const packs = await tx.q<any>(`SELECT * FROM compliance_packs WHERE tenant_id = :t ORDER BY built_in DESC, (region <> 'India'), region, name`);
    const use = new Map((await tx.q<any>('SELECT pack_id, count(*)::int AS n FROM compliance_assignments WHERE tenant_id = :t GROUP BY pack_id')).map((r) => [r.packId, r.n]));
    return packs.map((p) => packDto(p, use.get(p.id) ?? 0));
  });
  res.json(out);
});

const RuleIn = z.object({ id: z.string().max(60).optional(), type: z.enum(RULE_TYPES), severity: z.enum(['BLOCK', 'WARN']).optional(), params: z.record(z.string(), z.any()).default({}) });
const PackBody = z.object({ name: z.string().trim().min(2).max(120), region: z.string().trim().max(80).default(''), description: z.string().trim().max(600).default(''), rules: z.array(RuleIn).max(30) });
const rulesOf = (b: z.infer<typeof PackBody>): Rule[] => {
  try { return b.rules.map((r, i) => normaliseRule(r, i)); } catch (e) { throw bad((e as Error).message); }
};
const codeOf = (name: string) => `CUSTOM_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}_${Date.now().toString(36).toUpperCase()}`;

compliance.post('/packs', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(PackBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const row = await tx.one<any>('INSERT INTO compliance_packs (tenant_id, code, name, region, description, rules) VALUES (:t, $1, $2, $3, $4, $5) RETURNING *', [codeOf(b.name), b.name, b.region, b.description, JSON.stringify(rulesOf(b))]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'COMPLIANCE_PACK', entityId: row!.id, entityName: b.name, after: { rules: row!.rules.length } });
    return packDto(row);
  });
  res.status(201).json(out);
});

compliance.put('/packs/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(PackBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const cur = await tx.one<any>('SELECT * FROM compliance_packs WHERE tenant_id = :t AND id = $1', [id]);
    if (!cur) throw notFound('Compliance pack');
    if (cur.builtIn) throw conflict('A ready-made pack cannot be changed. Copy it, then edit the copy.');
    const row = await tx.one<any>('UPDATE compliance_packs SET name = $2, region = $3, description = $4, rules = $5, version = version + 1, updated_at = now() WHERE tenant_id = :t AND id = $1 RETURNING *', [id, b.name, b.region, b.description, JSON.stringify(rulesOf(b))]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'COMPLIANCE_PACK', entityId: id, entityName: b.name, before: { rules: cur.rules }, after: { rules: row!.rules } });
    return packDto(row);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json(out);
});

compliance.delete('/packs/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const cur = await tx.one<any>('SELECT * FROM compliance_packs WHERE tenant_id = :t AND id = $1', [id]);
    if (!cur) throw notFound('Compliance pack');
    if (cur.builtIn) throw conflict('A ready-made pack cannot be deleted.');
    const used = (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM compliance_assignments WHERE tenant_id = :t AND pack_id = $1', [id]))!.n;
    if (used) throw conflict(`This pack is assigned in ${used} place${used === 1 ? '' : 's'}. Remove those assignments first.`);
    await tx.exec('DELETE FROM compliance_packs WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'COMPLIANCE_PACK', entityId: id, entityName: cur.name });
  });
  res.json({ ok: true });
});

compliance.get('/assignments', requires('config:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `SELECT a.scope_type, a.scope_id, a.pack_id, p.name AS pack_name, coalesce(g.name, t.name, e.first_name || ' ' || e.last_name, 'Whole organisation') AS scope_name
     FROM compliance_assignments a JOIN compliance_packs p ON p.id = a.pack_id LEFT JOIN wfm_groups g ON g.id = a.scope_id AND a.scope_type = 'GROUP' LEFT JOIN teams t ON t.id = a.scope_id AND a.scope_type = 'TEAM'
     LEFT JOIN employees e ON e.id = a.scope_id AND a.scope_type = 'EMPLOYEE' WHERE a.tenant_id = :t ORDER BY a.scope_type, scope_name`));
  res.json(rows.map((r) => ({ scopeType: r.scopeType, scopeId: r.scopeId, scopeName: r.scopeName, packId: r.packId, packName: r.packName })));
});

compliance.put('/assignments', requires('config:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ scopeType: z.enum(['TENANT', 'GROUP', 'TEAM', 'EMPLOYEE']), scopeId: uuid.nullable().optional(), packId: uuid.nullable() }), req.body);
  if (b.scopeType !== 'TENANT' && !b.scopeId) throw bad('Say which group, team or employee this applies to');
  const key = b.scopeType === 'TENANT' ? 'tenant' : b.scopeId!;
  await withTenant(p.tenantId, async (tx) => {
    if (b.scopeType === 'GROUP' && !(await tx.one('SELECT 1 FROM wfm_groups WHERE tenant_id = :t AND id = $1', [b.scopeId]))) throw notFound('WFM group');
    if (b.scopeType === 'TEAM' && !(await tx.one('SELECT 1 FROM teams WHERE tenant_id = :t AND id = $1', [b.scopeId]))) throw notFound('Team');
    if (b.scopeType === 'EMPLOYEE' && !(await tx.one('SELECT 1 FROM employees WHERE tenant_id = :t AND id = $1', [b.scopeId]))) throw notFound('Employee');
    if (b.packId === null) {
      await tx.exec('DELETE FROM compliance_assignments WHERE tenant_id = :t AND scope_type = $1 AND scope_key = $2', [b.scopeType, key]);
      await audit(tx, p, req, { action: 'UPDATE', entityType: 'COMPLIANCE_ASSIGNMENT', entityId: key, entityName: b.scopeType, diffSummary: `${b.scopeType.toLowerCase()} pack removed` });
      return;
    }
    const pack = await tx.one<any>('SELECT name FROM compliance_packs WHERE tenant_id = :t AND id = $1', [b.packId]);
    if (!pack) throw notFound('Compliance pack');
    await tx.exec(
      `INSERT INTO compliance_assignments (tenant_id, workspace_id, scope_type, scope_id, scope_key, pack_id) VALUES (:t, :w, $1, $2, $3, $4)
       ON CONFLICT (tenant_id, workspace_id, scope_type, scope_key) DO UPDATE SET pack_id = EXCLUDED.pack_id, updated_at = now()`, [b.scopeType, b.scopeType === 'TENANT' ? null : b.scopeId, key, b.packId]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'COMPLIANCE_ASSIGNMENT', entityId: key, entityName: b.scopeType, diffSummary: `${b.scopeType.toLowerCase()} now follows "${pack.name}"` });
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json({ ok: true });
});
