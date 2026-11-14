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
import { parseCsv } from './csv.ts';
import { parseLines, planAssignments } from './reportingLines.ts';

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

// ---------------------------------------------------------------- setting the lines up in bulk

const SCOPE = `AND ($1::uuid IS NULL OR e.primary_group_id = $1 OR $1 = ANY(e.eligible_group_ids))`;
const currentLines = async (tx: Tx) => new Map((await tx.q<{ id: string; reportsTo: string | null }>(`SELECT id, reports_to FROM employees WHERE tenant_id = :t AND status <> 'TERMINATED'`)).map((r) => [r.id, r.reportsTo]));

/**
 * What "make each team lead the manager of their team" would do, before doing it: per team with a lead, how many people have no line yet (would be set) and how many report to
 * someone else (would be changed only if asked); the teams with no lead (their people cannot be set until the team has one); people in no team.
 */
orgChart.get('/org-chart/setup', requires('workforce:read'), async (req, res) => {
  const q = parse(z.object({ groupId: uuid.optional() }), req.query);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const g = q.groupId ?? null;
    const teams = await tx.q<any>(
      `SELECT t.id, t.name, t.manager_id, m.first_name || ' ' || m.last_name AS manager_name,
              count(e.id)::int AS people,
              count(e.id) FILTER (WHERE e.id IS DISTINCT FROM t.manager_id AND e.reports_to IS NULL)::int AS none,
              count(e.id) FILTER (WHERE e.id IS DISTINCT FROM t.manager_id AND e.reports_to IS NOT NULL AND e.reports_to IS DISTINCT FROM t.manager_id)::int AS other
       FROM teams t LEFT JOIN employees m ON m.id = t.manager_id
       LEFT JOIN employees e ON e.tenant_id = t.tenant_id AND e.team_id = t.id AND e.status <> 'TERMINATED' ${SCOPE}
       WHERE t.tenant_id = :t AND t.status = 'ACTIVE' GROUP BY t.id, t.name, t.manager_id, m.first_name, m.last_name HAVING count(e.id) > 0 ORDER BY count(e.id) DESC, t.name`, [g]);
    const noTeam = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id = :t AND e.status <> 'TERMINATED' AND e.team_id IS NULL AND e.reports_to IS NULL ${SCOPE}`, [g]))!.n;
    const withLead = teams.filter((t) => t.managerId), without = teams.filter((t) => !t.managerId);
    return {
      teams: teams.map((t) => ({ id: t.id, name: t.name, leadName: t.managerName ?? null, people: t.people, wouldSet: t.managerId ? t.none : 0, wouldChange: t.managerId ? t.other : 0 })),
      withLead: { teams: withLead.length, wouldSet: withLead.reduce((n, t) => n + t.none, 0), wouldChange: withLead.reduce((n, t) => n + t.other, 0) },
      withoutLead: { teams: without.length, people: without.reduce((n, t) => n + t.none, 0) },
      noTeam,
    };
  });
  res.json(out);
});

/** Everyone in a team with a lead reports to that lead, across all teams at once. People who already report to somebody are left unless asked; a line that would make a loop is skipped and listed. */
orgChart.post('/org-chart/apply-teams', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ overwrite: z.boolean().default(false), groupId: uuid.optional(), reason: z.string().trim().min(3, 'is required').max(300) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const rows = await tx.q<{ id: string; name: string; boss: string }>(
      `SELECT e.id, e.first_name || ' ' || e.last_name AS name, t.manager_id AS boss FROM employees e JOIN teams t ON t.id = e.team_id AND t.tenant_id = e.tenant_id
       WHERE e.tenant_id = :t AND t.status = 'ACTIVE' AND t.manager_id IS NOT NULL AND e.id <> t.manager_id AND e.status <> 'TERMINATED' AND ($2::boolean OR e.reports_to IS NULL) AND e.reports_to IS DISTINCT FROM t.manager_id ${SCOPE}`, [b.groupId ?? null, b.overwrite]);
    const plan = planAssignments(await currentLines(tx), rows.map((r) => ({ id: r.id, boss: r.boss })));
    if (plan.accepted.length) await tx.exec(
      `UPDATE employees e SET reports_to = x.boss, updated_at = now(), version = version + 1 FROM unnest($1::uuid[], $2::uuid[]) AS x(id, boss) WHERE e.tenant_id = :t AND e.id = x.id`,
      [plan.accepted.map((a) => a.id), plan.accepted.map((a) => a.boss)]);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'EMPLOYEE', entityId: p.userId, entityName: 'Reporting lines (every team)', reason: b.reason, diffSummary: `${plan.accepted.length} people now report to their team lead${plan.rejected.length ? `; ${plan.rejected.length} skipped (would loop)` : ''}` });
    return { updated: plan.accepted.length, skipped: plan.rejected.length, skippedPeople: plan.rejected.slice(0, 20).map((r) => ({ id: r.proposal.id, name: names.get(r.proposal.id) ?? '', why: r.why === 'SELF' ? 'cannot report to themselves' : 'would make a loop of reporting lines' })) };
  });
  res.json(out);
});

/** Reporting lines from a file: employee_number and reports_to_number (the file the chart exports works as it is). Always check first with dryRun; rows with a problem are listed and skipped. */
orgChart.post('/org-chart/import', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ csv: z.string().min(3).max(8_000_000), dryRun: z.boolean().default(true), reason: z.string().trim().max(300).optional() }), req.body);
  if (!b.dryRun && (b.reason ?? '').length < 3) throw bad('A reason is needed to apply reporting lines (it is kept in the history)');
  const parsed = parseLines(parseCsv(b.csv));
  if (parsed.error) throw bad(parsed.error);
  if (parsed.rows.length > 50_000) throw bad('More than 50,000 rows: split the file');
  const out = await withTenant(p.tenantId, async (tx) => {
    const numbers = [...new Set(parsed.rows.flatMap((r) => [r.employee, r.boss]))];
    const found = await tx.q<{ id: string; employeeNumber: string; status: string; name: string }>(
      `SELECT id, employee_number, status, first_name || ' ' || last_name AS name FROM employees WHERE tenant_id = :t AND employee_number = ANY($1::text[])`, [numbers]);
    const by = new Map(found.map((e) => [e.employeeNumber, e]));
    const problems: { line: number; message: string }[] = [], proposals: { id: string; boss: string; line: number }[] = [];
    for (const r of parsed.rows) {
      const e = by.get(r.employee), m = by.get(r.boss);
      if (!e) problems.push({ line: r.line, message: `No employee has the number "${r.employee}"` });
      else if (e.status === 'TERMINATED') problems.push({ line: r.line, message: `${e.name} (${r.employee}) has left` });
      else if (!m) problems.push({ line: r.line, message: `The manager "${r.boss}" is not an employee number (for ${e.name})` });
      else if (m.status === 'TERMINATED') problems.push({ line: r.line, message: `${m.name} (${r.boss}) has left, so cannot be the manager of ${e.name}` });
      else proposals.push({ id: e.id, boss: m.id, line: r.line });
    }
    const plan = planAssignments(await currentLines(tx), proposals);
    const lineOf = new Map(proposals.map((x) => [x.id, x.line]));
    for (const r of plan.rejected) problems.push({ line: lineOf.get(r.proposal.id) ?? 0, message: r.why === 'SELF' ? 'A person cannot report to themselves' : 'This line would make a loop of reporting lines (it would end up reporting to itself)' });
    problems.sort((x, y) => x.line - y.line);
    if (!b.dryRun && plan.accepted.length) {
      await tx.exec(`UPDATE employees e SET reports_to = x.boss, updated_at = now(), version = version + 1 FROM unnest($1::uuid[], $2::uuid[]) AS x(id, boss) WHERE e.tenant_id = :t AND e.id = x.id`, [plan.accepted.map((a) => a.id), plan.accepted.map((a) => a.boss)]);
      await audit(tx, p, req, { action: 'IMPORT', entityType: 'EMPLOYEE', entityId: p.userId, entityName: 'Reporting lines (file)', reason: b.reason, diffSummary: `${plan.accepted.length} reporting lines set from a file${problems.length ? `; ${problems.length} rows skipped` : ''}` });
    }
    return { dryRun: b.dryRun, rows: parsed.rows.length, blank: parsed.blank, willChange: plan.accepted.length, unchanged: plan.unchanged, problemCount: problems.length, problems: problems.slice(0, 50), applied: b.dryRun ? 0 : plan.accepted.length };
  });
  res.json(out);
});
