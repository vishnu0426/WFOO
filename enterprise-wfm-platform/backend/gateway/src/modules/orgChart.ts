/**
 * The reporting lines as a chart: who is at the top, who reports to whom, and the chain above one person. Read a level at a time, so it is as quick for
 * 50,000 people as for 50; the screen opens a branch only when asked. People who have left are not in it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, notFound, parse } from '../http.ts';

export const orgChart = Router();     // mounted at /workforce
const uuid = z.string().uuid();
const LIVE = `e.status <> 'TERMINATED'`;
const NODE = `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.employee_number, e.team_id, t.name AS team_name, e.status, e.is_supervisor, e.is_manager, e.reports_to,
    (SELECT count(*)::int FROM employees x WHERE x.tenant_id = :t AND x.reports_to = e.id AND x.status <> 'TERMINATED') AS direct_reports
  FROM employees e LEFT JOIN teams t ON t.id = e.team_id`;

/** Everyone below each person, however many levels down (capped, so a bad loop in old data cannot run away). */
async function allBelow(tx: Tx, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await tx.q<{ root: string; n: number }>(
    `WITH RECURSIVE d(root, id, depth) AS (
       SELECT id, id, 0 FROM employees WHERE tenant_id = :t AND id = ANY($1::uuid[])
       UNION ALL SELECT d.root, e.id, d.depth + 1 FROM employees e JOIN d ON e.reports_to = d.id WHERE e.tenant_id = :t AND e.status <> 'TERMINATED' AND d.depth < 12)
     SELECT root, count(*)::int - 1 AS n FROM d GROUP BY root`, [ids]);
  return new Map(rows.map((r) => [r.root, r.n]));
}
const nodeDto = (r: any, below: Map<string, number>) => ({
  id: r.id, name: r.name, employeeNumber: r.employeeNumber, teamId: r.teamId, teamName: r.teamName, status: r.status, isSupervisor: !!r.isSupervisor, isManager: !!r.isManager,
  reportsTo: r.reportsTo, directReports: r.directReports, allReports: below.get(r.id) ?? r.directReports,
});

/** The top of each branch: people nobody leads who lead somebody. Also how many people have no line at all. */
orgChart.get('/org-chart/roots', requires('workforce:read'), async (req, res) => {
  const q = parse(z.object({ groupId: uuid.optional() }), req.query);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const g = q.groupId ?? null;
    const scope = `AND ($1::uuid IS NULL OR e.primary_group_id = $1 OR $1 = ANY(e.eligible_group_ids))`;
    const roots = await tx.q<any>(`${NODE} WHERE e.tenant_id = :t AND ${LIVE} AND e.reports_to IS NULL ${scope} AND EXISTS (SELECT 1 FROM employees x WHERE x.tenant_id = :t AND x.reports_to = e.id AND x.status <> 'TERMINATED') ORDER BY e.is_manager DESC, e.last_name, e.first_name LIMIT 200`, [g]);
    const below = await allBelow(tx, roots.map((r) => r.id));
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id = :t AND ${LIVE} ${scope}`, [g]))!.n;
    const unassigned = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id = :t AND ${LIVE} AND e.reports_to IS NULL ${scope} AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.tenant_id = :t AND x.reports_to = e.id AND x.status <> 'TERMINATED')`, [g]))!.n;
    return { roots: roots.map((r) => nodeDto(r, below)), unassigned, total };
  });
  res.json(out);
});

/** People who report to nobody and lead nobody: the list to work through when setting reporting lines up. */
orgChart.get('/org-chart/unassigned', requires('workforce:read'), async (req, res) => {
  const q = parse(z.object({ groupId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const rows = await tx.q<any>(`${NODE} WHERE e.tenant_id = :t AND ${LIVE} AND e.reports_to IS NULL AND ($1::uuid IS NULL OR e.primary_group_id = $1 OR $1 = ANY(e.eligible_group_ids))
      AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.tenant_id = :t AND x.reports_to = e.id AND x.status <> 'TERMINATED') ORDER BY e.last_name, e.first_name LIMIT $2 OFFSET $3`, [q.groupId ?? null, q.limit, q.offset]);
    return rows.map((r) => nodeDto(r, new Map()));
  });
  res.json(out);
});

/** Every reporting line as a file: who reports to whom. */
orgChart.get('/org-chart/export.csv', requires('workforce:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `SELECT e.employee_number, e.first_name || ' ' || e.last_name AS name, t.name AS team, e.status, e.is_supervisor, e.is_manager, b.employee_number AS boss_number, b.first_name || ' ' || b.last_name AS boss
     FROM employees e LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN employees b ON b.id = e.reports_to WHERE e.tenant_id = :t AND ${LIVE} ORDER BY e.last_name, e.first_name`));
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="reporting-lines.csv"');
  res.send(['employee_number,name,team,status,is_supervisor,is_manager,reports_to_number,reports_to', ...rows.map((r) => [r.employeeNumber, r.name, r.team, r.status, r.isSupervisor, r.isManager, r.bossNumber, r.boss].map(cell).join(','))].join('\n') + '\n');
});

/** One level down from a person, a page at a time. */
orgChart.get('/org-chart/:id/reports', requires('workforce:read'), async (req, res) => {
  const id = parse(uuid, req.params.id), q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    if (!(await tx.one('SELECT 1 FROM employees WHERE tenant_id = :t AND id = $1', [id]))) throw notFound('Employee');
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id = :t AND e.reports_to = $1 AND ${LIVE}`, [id]))!.n;
    const rows = await tx.q<any>(`${NODE} WHERE e.tenant_id = :t AND e.reports_to = $1 AND ${LIVE} ORDER BY e.is_manager DESC, e.is_supervisor DESC, e.last_name, e.first_name LIMIT $2 OFFSET $3`, [id, q.limit, q.offset]);
    const below = await allBelow(tx, rows.map((r) => r.id));
    return { total, items: rows.map((r) => nodeDto(r, below)) };
  });
  res.json(out);
});

/** The chain above one person, from the top down to them. */
orgChart.get('/org-chart/:id/chain', requires('workforce:read'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const rows = await tx.q<any>(
      `WITH RECURSIVE up(id, depth) AS (SELECT id, 0 FROM employees WHERE tenant_id = :t AND id = $1 UNION ALL SELECT e.reports_to, up.depth + 1 FROM employees e JOIN up ON e.id = up.id WHERE e.tenant_id = :t AND e.reports_to IS NOT NULL AND up.depth < 20)
       SELECT n.*, up.depth FROM up JOIN (${NODE} WHERE e.tenant_id = :t) n ON n.id = up.id ORDER BY up.depth DESC`, [id]);
    if (!rows.length) throw notFound('Employee');
    return rows.map((r) => nodeDto(r, new Map()));
  });
  res.json(out);
});

/** Put everyone in a team under the team's supervisor in one go (people who already report to somebody are left, unless asked). */
orgChart.post('/teams/:id/apply-reports-to', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(z.object({ overwrite: z.boolean().default(false), reason: z.string().trim().min(3, 'is required').max(300) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>('SELECT id, name, manager_id FROM teams WHERE tenant_id = :t AND id = $1', [id]);
    if (!t) throw notFound('Team');
    if (!t.managerId) throw bad(`${t.name} has no supervisor yet. Choose one on the team first.`);
    const rows = await tx.q<{ id: string }>(
      `UPDATE employees SET reports_to = $2, updated_at = now(), version = version + 1
       WHERE tenant_id = :t AND team_id = $1 AND id <> $2 AND status <> 'TERMINATED' AND ($3::boolean OR reports_to IS NULL) AND reports_to IS DISTINCT FROM $2 RETURNING id`, [id, t.managerId, b.overwrite]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'TEAM', entityId: id, entityName: t.name, reason: b.reason, diffSummary: `${rows.length} people now report to the team's supervisor` });
    return { updated: rows.length };
  });
  res.json(out);
});
