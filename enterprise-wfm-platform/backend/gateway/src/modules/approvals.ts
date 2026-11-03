/**
 * Who decides a request first, and who covers while they are away.
 *   First line: a team's supervisor, deputy, or whoever covers for them today, decides that team's time off and swaps. Managers and schedulers can always
 *   decide anything. A request nobody has decided within the escalation time is flagged to the managers.
 *   Cover: between two dates one person takes over a supervisor's teams.
 *   Team limit: when the organisation switches it on, a Supervisor sees and acts only on their own teams' people.
 * With no supervisor on a team, requests go straight to the managers, exactly as before.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../db.ts';
import { me, permissionsFor, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { notify } from '../notify.ts';
import { finalizeDepartures } from './departures.ts';

export const approvalRoutes = Router();       // mounted at /workforce
const uuid = z.string().uuid();
const MANAGERS = `SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role IN ('WFM_ADMIN', 'WFM_MANAGER', 'SCHEDULER')`;

export interface ApprovalSettings { supervisorFirst: boolean; escalateHours: number; limitToTeams: boolean }
export async function approvalSettings(tx: Tx): Promise<ApprovalSettings> {
  const r = await tx.one<any>('SELECT supervisor_first, escalate_hours, limit_supervisors_to_teams FROM self_service_policy WHERE tenant_id = :t');
  return { supervisorFirst: r?.supervisorFirst ?? true, escalateHours: r?.escalateHours ?? 24, limitToTeams: r?.limitSupervisorsToTeams ?? false };
}

/** The teams someone supervises today: their own (as supervisor or deputy), and the ones they cover for somebody. */
export async function myTeamIds(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx.q<{ id: string }>(
    `SELECT t.id FROM teams t JOIN users u ON u.id = $1 AND u.tenant_id = t.tenant_id WHERE t.tenant_id = :t AND (t.manager_id = u.employee_id OR t.deputy_id = u.employee_id)
     UNION
     SELECT t.id FROM approval_cover c JOIN users u ON u.id = $1 AND u.employee_id = c.to_employee_id AND u.tenant_id = c.tenant_id
       JOIN teams t ON t.tenant_id = c.tenant_id AND (t.manager_id = c.from_employee_id OR t.deputy_id = c.from_employee_id)
     WHERE c.tenant_id = :t AND c.cancelled_at IS NULL AND current_date BETWEEN c.starts_on AND c.ends_on`, [userId]);
  return rows.map((r) => r.id);
}

/** The people who decide this person's requests first: their team's supervisor, deputy and today's cover, who hold the approval permission. Never the person themselves. */
export async function firstLineUsers(tx: Tx, teamId: string | null, employeeId: string): Promise<string[]> {
  if (!teamId) return [];
  const rows = await tx.q<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u
     WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.employee_id IS NOT NULL AND u.employee_id <> $2
       AND u.role IN (SELECT role FROM role_permissions WHERE tenant_id = :t AND permission = 'requests:approve')
       AND (u.employee_id IN (SELECT manager_id FROM teams WHERE tenant_id = :t AND id = $1) OR u.employee_id IN (SELECT deputy_id FROM teams WHERE tenant_id = :t AND id = $1)
         OR u.employee_id IN (SELECT c.to_employee_id FROM approval_cover c JOIN teams t ON t.tenant_id = c.tenant_id AND t.id = $1 AND (t.manager_id = c.from_employee_id OR t.deputy_id = c.from_employee_id)
                              WHERE c.tenant_id = :t AND c.cancelled_at IS NULL AND current_date BETWEEN c.starts_on AND c.ends_on))`, [teamId, employeeId]);
  return rows.map((r) => r.id);
}

/** Who to tell that a request is waiting: the team's supervisors first when the organisation works that way and the team has any, else the managers. */
export async function approvalAudience(tx: Tx, employeeId: string): Promise<{ users: string[]; level: 'SUPERVISOR' | 'MANAGER' }> {
  const s = await approvalSettings(tx);
  if (s.supervisorFirst) {
    const e = await tx.one<{ teamId: string | null }>('SELECT team_id FROM employees WHERE tenant_id = :t AND id = $1', [employeeId]);
    const first = await firstLineUsers(tx, e?.teamId ?? null, employeeId);
    if (first.length) return { users: first, level: 'SUPERVISOR' };
  }
  return { users: (await tx.q<{ id: string }>(MANAGERS)).map((r) => r.id), level: 'MANAGER' };
}

/** For the person who asked: who has their request, so their screen can say so. */
export async function waitingFor(tx: Tx, employeeId: string): Promise<{ level: 'SUPERVISOR' | 'MANAGER'; names: string[] }> {
  const a = await approvalAudience(tx, employeeId);
  const names = a.level === 'SUPERVISOR' ? (await tx.q<{ name: string }>('SELECT DISTINCT display_name AS name FROM users WHERE tenant_id = :t AND id = ANY($1::uuid[]) ORDER BY 1 LIMIT 3', [a.users])).map((r) => r.name) : [];
  return { level: a.level, names };
}

/** At what level may this person decide the request of this employee? Throws when they may not. `full` is the permission managers and schedulers already use. */
export async function approverLevel(tx: Tx, p: Principal, employeeId: string, full: 'workforce:write' | 'schedule:edit'): Promise<'MANAGER' | 'SUPERVISOR'> {
  const have = p.scopes ? new Set(p.scopes) : await permissionsFor(p.tenantId, p.role);
  if (have.has(full)) return 'MANAGER';
  if (have.has('requests:approve') && (await approvalSettings(tx)).supervisorFirst) {
    const mine = await tx.one<{ employeeId: string | null }>('SELECT employee_id FROM users WHERE tenant_id = :t AND id = $1', [p.userId]);
    if (mine?.employeeId && mine.employeeId === employeeId) throw new HttpError(403, 'FORBIDDEN', 'You cannot decide your own request. Your manager or scheduler can.');
    const e = await tx.one<{ teamId: string | null }>('SELECT team_id FROM employees WHERE tenant_id = :t AND id = $1', [employeeId]);
    if (e?.teamId && (await myTeamIds(tx, p.userId)).includes(e.teamId)) return 'SUPERVISOR';
    throw new HttpError(403, 'FORBIDDEN', 'This request belongs to a team you do not supervise. A manager or scheduler can decide it.');
  }
  throw new HttpError(403, 'FORBIDDEN', `Your role (${p.role}) is not allowed to decide requests.`);
}

/** Null for everyone but a Supervisor in an organisation that limits supervisors to their teams; for them, the teams (and themselves) they may see. */
export async function teamLimit(tx: Tx, p: Principal): Promise<{ teamIds: string[]; self: string | null } | null> {
  if (p.role !== 'SUPERVISOR_RTA' || p.scopes) return null;
  if (!(await approvalSettings(tx)).limitToTeams) return null;
  const u = await tx.one<{ employeeId: string | null }>('SELECT employee_id FROM users WHERE tenant_id = :t AND id = $1', [p.userId]);
  return { teamIds: await myTeamIds(tx, p.userId), self: u?.employeeId ?? null };
}
/** May this person act on / see that employee? Everyone may unless a team limit applies. */
export async function inScope(tx: Tx, p: Principal, employeeId: string): Promise<boolean> {
  const lim = await teamLimit(tx, p);
  if (!lim) return true;
  if (lim.self === employeeId) return true;
  const e = await tx.one<{ teamId: string | null }>('SELECT team_id FROM employees WHERE tenant_id = :t AND id = $1', [employeeId]);
  return !!e?.teamId && lim.teamIds.includes(e.teamId);
}

// ---------------------------------------------------------------- cover

const CoverBody = z.object({ fromEmployeeId: uuid, toEmployeeId: uuid, startsOn: z.string().regex(isoDay), endsOn: z.string().regex(isoDay), note: z.string().trim().max(200).default('') });
const coverDto = (c: any) => ({ id: c.id, fromEmployeeId: c.fromEmployeeId, fromName: c.fromName, toEmployeeId: c.toEmployeeId, toName: c.toName, startsOn: c.startsOn, endsOn: c.endsOn, note: c.note, createdBy: c.createdBy, createdAt: c.createdAt, teams: c.teams ?? [], active: !!c.active });
const COVER_SQL = `SELECT c.*, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, f.first_name || ' ' || f.last_name AS from_name, t.first_name || ' ' || t.last_name AS to_name,
    (current_date BETWEEN c.starts_on AND c.ends_on) AS active,
    coalesce((SELECT array_agg(x.name ORDER BY x.name) FROM teams x WHERE x.tenant_id = c.tenant_id AND (x.manager_id = c.from_employee_id OR x.deputy_id = c.from_employee_id)), '{}') AS teams
  FROM approval_cover c JOIN employees f ON f.id = c.from_employee_id JOIN employees t ON t.id = c.to_employee_id WHERE c.tenant_id = :t AND c.cancelled_at IS NULL`;

/** Who may hand a supervisor's teams over: whoever manages workforce data, or the supervisor themselves. */
async function mayHandOver(tx: Tx, p: Principal, fromEmployeeId: string): Promise<boolean> {
  const have = p.scopes ? new Set(p.scopes) : await permissionsFor(p.tenantId, p.role);
  if (have.has('workforce:write')) return true;
  if (!have.has('requests:approve')) return false;
  const u = await tx.one<{ employeeId: string | null }>('SELECT employee_id FROM users WHERE tenant_id = :t AND id = $1', [p.userId]);
  return !!u?.employeeId && u.employeeId === fromEmployeeId;
}

approvalRoutes.get('/cover', requires('workforce:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(`${COVER_SQL} AND c.ends_on >= current_date ORDER BY c.starts_on, f.last_name`));
  res.json(rows.map(coverDto));
});

approvalRoutes.post('/cover', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(CoverBody, req.body);
  if (b.endsOn < b.startsOn) throw bad('The last day cannot be before the first day.');
  if ((Date.parse(b.endsOn) - Date.parse(b.startsOn)) / 864e5 > 366) throw bad('Cover can be set for up to a year at a time.');
  const out = await withTenant(p.tenantId, async (tx) => {
    if (!(await mayHandOver(tx, p, b.fromEmployeeId))) throw new HttpError(403, 'FORBIDDEN', 'Only a manager, a scheduler or the supervisor themselves can hand over a supervisor\'s teams.');
    if (b.fromEmployeeId === b.toEmployeeId) throw bad('Choose someone else to cover.');
    const [from, to] = [await tx.one<any>('SELECT first_name, last_name, status FROM employees WHERE tenant_id = :t AND id = $1', [b.fromEmployeeId]), await tx.one<any>('SELECT first_name, last_name, status FROM employees WHERE tenant_id = :t AND id = $1', [b.toEmployeeId])];
    if (!from || !to) throw notFound('Employee');
    const leads = await tx.q<{ name: string }>('SELECT name FROM teams WHERE tenant_id = :t AND (manager_id = $1 OR deputy_id = $1) ORDER BY name', [b.fromEmployeeId]);
    if (!leads.length) throw bad(`${from.firstName} ${from.lastName} is not the supervisor or deputy of any team, so there is nothing to cover.`);
    if (to.status === 'TERMINATED') throw bad(`${to.firstName} ${to.lastName} has left.`);
    // the cover has to be able to act: a login whose role may approve requests
    const login = await tx.one<{ id: string }>(`SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.employee_id = $1 AND u.status = 'ACTIVE' AND u.role IN (SELECT role FROM role_permissions WHERE tenant_id = :t AND permission = 'requests:approve')`, [b.toEmployeeId]);
    if (!login) throw bad(`${to.firstName} ${to.lastName} has no login whose role can approve requests, so could not act as cover. Give them a login with the Supervisor role first.`);
    if (await tx.one(`SELECT 1 FROM approval_cover WHERE tenant_id = :t AND cancelled_at IS NULL AND from_employee_id = $1 AND to_employee_id = $2 AND starts_on <= $4::date AND ends_on >= $3::date`, [b.fromEmployeeId, b.toEmployeeId, b.startsOn, b.endsOn])) throw conflict('That cover already exists for some of those days.');
    const c = await tx.one<{ id: string }>('INSERT INTO approval_cover (tenant_id, from_employee_id, to_employee_id, starts_on, ends_on, note, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6) RETURNING id', [b.fromEmployeeId, b.toEmployeeId, b.startsOn, b.endsOn, b.note, p.name]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'APPROVAL_COVER', entityId: c!.id, entityName: `${to.firstName} ${to.lastName} covers ${from.firstName} ${from.lastName}`, diffSummary: `${leads.map((l) => l.name).join(', ')} from ${b.startsOn} to ${b.endsOn}` });
    await notify(tx, [login.id], { kind: 'INFO', title: 'You are covering a team', body: `You cover ${from.firstName} ${from.lastName}'s teams (${leads.map((l) => l.name).join(', ')}) from ${b.startsOn} to ${b.endsOn}.`, data: { screen: 'time-off' } });
    return coverDto((await tx.q<any>(`${COVER_SQL} AND c.id = $1`, [c!.id]))[0]);
  });
  res.status(201).json(out);
});

approvalRoutes.delete('/cover/:id', requires('self:use'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const c = (await tx.q<any>(`${COVER_SQL} AND c.id = $1`, [id]))[0];
    if (!c) throw notFound('Cover');
    if (!(await mayHandOver(tx, p, c.fromEmployeeId))) throw new HttpError(403, 'FORBIDDEN', 'Only a manager, a scheduler or the supervisor themselves can end this cover.');
    await tx.exec('UPDATE approval_cover SET cancelled_at = now(), cancelled_by = $2 WHERE tenant_id = :t AND id = $1', [id, p.name]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'APPROVAL_COVER', entityId: id, entityName: `${c.toName} covers ${c.fromName}`, diffSummary: 'Cover ended' });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- waiting too long

/** Requests whose team has supervisors, that nobody has decided within the time set: tell the managers once. */
export async function escalateOverdue(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const s = await approvalSettings(tx);
    if (!s.supervisorFirst) return 0;
    const waiting = await tx.q<any>(
      `SELECT 'TIME_OFF' AS kind, o.id, o.employee_id, e.team_id, e.first_name || ' ' || e.last_name AS name, o.start_day::text AS what FROM time_off o JOIN employees e ON e.id = o.employee_id
         WHERE o.tenant_id = :t AND o.status = 'REQUESTED' AND o.escalated_at IS NULL AND o.created_at < now() - make_interval(hours => $1)
       UNION ALL
       SELECT 'SWAP', w.id, w.requester_id, e.team_id, e.first_name || ' ' || e.last_name, w.created_at::date::text FROM shift_swaps w JOIN employees e ON e.id = w.requester_id
         WHERE w.tenant_id = :t AND w.status = 'PENDING_APPROVAL' AND w.escalated_at IS NULL AND w.updated_at < now() - make_interval(hours => $1)`, [s.escalateHours]);
    let n = 0;
    const managers = (await tx.q<{ id: string }>(MANAGERS)).map((r) => r.id);
    for (const w of waiting) {
      if (!(await firstLineUsers(tx, w.teamId, w.employeeId)).length) continue;          // the managers were told at the start
      await tx.exec(`UPDATE ${w.kind === 'TIME_OFF' ? 'time_off' : 'shift_swaps'} SET escalated_at = now() WHERE tenant_id = :t AND id = $1`, [w.id]);
      await notify(tx, managers, { kind: w.kind === 'TIME_OFF' ? 'TIME_OFF' : 'SWAP', title: 'A request has waited for its supervisor', body: `${w.name}'s ${w.kind === 'TIME_OFF' ? `time off from ${w.what}` : 'shift change'} has waited more than ${s.escalateHours} hours. You can decide it.`, data: { screen: w.kind === 'TIME_OFF' ? 'time-off' : 'swap', id: w.id } });
      n++;
    }
    return n;
  });
}

let ticker: NodeJS.Timeout | null = null;
/** Every few minutes: escalate overdue requests, and finish departures whose last day has come. APPROVAL_TICK_SECONDS shortens it for tests. */
export function startApprovalTicker() {
  if (ticker) return;
  const every = Math.max(1, Number(process.env.APPROVAL_TICK_SECONDS) || 300) * 1000;
  ticker = setInterval(async () => {
    try { for (const t of await raw<{ id: string }>('SELECT id FROM tenants')) { await escalateOverdue(t.id); await finalizeDepartures(t.id); } }
    catch (e) { console.error('[approvals]', (e as Error).message); }
  }, every);
  ticker.unref();
}
