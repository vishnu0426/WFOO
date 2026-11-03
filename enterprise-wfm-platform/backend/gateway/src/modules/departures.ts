/**
 * Someone leaves. Recording a last working day and a reason removes them from every shift after it (drafts and published schedules), and when the day has
 * come: marks them Terminated, switches off their login, cancels what they had waiting, hands their direct reports to their own manager and ends any cover.
 * A person who still supervises a team or manages a group cannot leave until someone else has that job.
 */
import { withTenant, type Tx } from '../db.ts';
import type { Request } from 'express';
import type { Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { conflict } from '../http.ts';
import { dropCache } from '../infra.ts';

export interface Departure { futureShifts: number; schedules: number; pendingTimeOff: number; openSwaps: number; reports: number; logins: number; covers: number }
const SYSTEM = (tenantId: string): Principal => ({ userId: null as unknown as string, tenantId, role: 'WFM_ADMIN', name: 'System', username: 'system', jti: '' });

/** What recording this departure would touch, counted without changing anything. */
export async function departureImpact(tx: Tx, employeeId: string, lastDay: string): Promise<Departure & { leads: string[] }> {
  const n = async (sql: string, args: unknown[] = [employeeId]) => (await tx.one<{ n: number }>(sql, args))!.n;
  const shifts = await tx.one<{ n: number; v: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT s.version_id)::int AS v FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
     WHERE s.tenant_id = :t AND s.employee_id = $1 AND s.day > $2::date AND s.day >= current_date AND v.status IN ('DRAFT', 'PUBLISHED')`, [employeeId, lastDay]);
  const leads = [
    ...(await tx.q<{ name: string }>('SELECT name FROM teams WHERE tenant_id = :t AND (manager_id = $1 OR deputy_id = $1) ORDER BY name', [employeeId])).map((t) => `team ${t.name}`),
    ...(await tx.q<{ name: string }>('SELECT name FROM wfm_groups WHERE tenant_id = :t AND manager_id = $1 ORDER BY name', [employeeId])).map((g) => `group ${g.name}`),
  ];
  return {
    futureShifts: shifts!.n, schedules: shifts!.v, leads,
    pendingTimeOff: await n(`SELECT count(*)::int AS n FROM time_off WHERE tenant_id = :t AND employee_id = $1 AND status = 'REQUESTED'`),
    openSwaps: await n(`SELECT count(*)::int AS n FROM shift_swaps WHERE tenant_id = :t AND status IN ('OPEN', 'PENDING_PARTNER', 'PENDING_APPROVAL') AND (requester_id = $1 OR partner_id = $1)`),
    reports: await n(`SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND reports_to = $1 AND status <> 'TERMINATED'`),
    logins: await n(`SELECT count(*)::int AS n FROM users WHERE tenant_id = :t AND employee_id = $1 AND status = 'ACTIVE'`),
    covers: await n(`SELECT count(*)::int AS n FROM approval_cover WHERE tenant_id = :t AND cancelled_at IS NULL AND (from_employee_id = $1 OR to_employee_id = $1)`),
  };
}

/** A person who still leads something cannot leave: say what, so someone else is chosen first. */
export function refuseIfLeading(name: string, leads: string[]) {
  if (leads.length) throw conflict(`${name} is still the supervisor, deputy or manager of ${leads.join(', ')}. Choose someone else for ${leads.length === 1 ? 'it' : 'them'} first.`);
}

/**
 * Do the work. Always: remove shifts after the last day. When `finalize`: also mark Terminated, switch off the login, cancel pending requests and open swaps,
 * hand the direct reports to their manager, end cover. Returns what was touched and the schedules whose figures must be recalculated afterwards.
 */
export async function applyDeparture(tx: Tx, p: Principal, req: Request | null, e: { id: string; name: string; reportsTo: string | null }, lastDay: string, reason: string, finalize: boolean): Promise<Departure & { versionIds: string[] }> {
  const removed = await tx.q<{ versionId: string }>(
    `DELETE FROM schedule_shifts s USING schedule_versions v WHERE v.id = s.version_id AND s.tenant_id = :t AND s.employee_id = $1 AND s.day > $2::date AND s.day >= current_date AND v.status IN ('DRAFT', 'PUBLISHED') RETURNING s.version_id`, [e.id, lastDay]);
  const out: Departure & { versionIds: string[] } = { futureShifts: removed.length, schedules: new Set(removed.map((r) => r.versionId)).size, pendingTimeOff: 0, openSwaps: 0, reports: 0, logins: 0, covers: 0, versionIds: [...new Set(removed.map((r) => r.versionId))] };
  if (finalize) {
    const why = `${e.name} left the company on ${lastDay}`;
    out.pendingTimeOff = (await tx.q(`UPDATE time_off SET status = 'CANCELLED', decided_by = 'System', decided_at = now(), reason = $2 WHERE tenant_id = :t AND employee_id = $1 AND status = 'REQUESTED' RETURNING id`, [e.id, why])).length;
    out.openSwaps = (await tx.q(`UPDATE shift_swaps SET status = 'CANCELLED', decision_reason = $2, updated_at = now() WHERE tenant_id = :t AND status IN ('OPEN', 'PENDING_PARTNER', 'PENDING_APPROVAL') AND (requester_id = $1 OR partner_id = $1) RETURNING id`, [e.id, why])).length;
    out.logins = (await tx.q(`UPDATE users SET status = 'DISABLED' WHERE tenant_id = :t AND employee_id = $1 AND status = 'ACTIVE' RETURNING id`, [e.id])).length;
    out.reports = (await tx.q(`UPDATE employees SET reports_to = $2, updated_at = now(), version = version + 1 WHERE tenant_id = :t AND reports_to = $1 AND status <> 'TERMINATED' RETURNING id`, [e.id, e.reportsTo])).length;
    out.covers = (await tx.q(`UPDATE approval_cover SET cancelled_at = now(), cancelled_by = 'System' WHERE tenant_id = :t AND cancelled_at IS NULL AND (from_employee_id = $1 OR to_employee_id = $1) RETURNING id`, [e.id])).length;
  }
  const parts = [`${out.futureShifts} later shift${out.futureShifts === 1 ? '' : 's'} removed`, ...(finalize ? [`${out.logins} login${out.logins === 1 ? '' : 's'} switched off`, `${out.pendingTimeOff + out.openSwaps} waiting request${out.pendingTimeOff + out.openSwaps === 1 ? '' : 's'} cancelled`, `${out.reports} direct report${out.reports === 1 ? '' : 's'} handed to their manager`] : ['status unchanged until the last day'])];
  await audit(tx, p, req, { action: 'UPDATE', entityType: 'EMPLOYEE', entityId: e.id, entityName: e.name, reason, diffSummary: `${finalize ? 'Left' : 'Leaving'} after ${lastDay}: ${parts.join(', ')}` });
  return out;
}

/** After the transaction: the schedules that lost shifts get their coverage figures and revision history brought up to date. */
export async function afterDeparture(tenantId: string, p: Principal, name: string, versionIds: string[], removedShifts: number, reason: string) {
  if (!versionIds.length) return;
  const { refreshStats, revision } = await import('./scheduleRoutes.ts');
  for (const id of versionIds) {
    const st = await refreshStats(tenantId, id);
    await withTenant(tenantId, (tx) => revision(tx, p, id, 'EDIT', `${name} left: later shifts removed (${removedShifts} across ${versionIds.length} schedule${versionIds.length === 1 ? '' : 's'})`, reason, st.stats));
  }
}

/** Departures recorded with a future last day, once that day has passed. */
export async function finalizeDepartures(tenantId: string): Promise<number> {
  const due = await withTenant(tenantId, (tx) => tx.q<any>(
    `SELECT id, first_name || ' ' || last_name AS name, reports_to, termination_date::text AS last_day, termination_reason FROM employees WHERE tenant_id = :t AND status <> 'TERMINATED' AND termination_date IS NOT NULL AND termination_date <= current_date`));
  const p = SYSTEM(tenantId);
  for (const d of due) {
    const done = await withTenant(tenantId, async (tx) => {
      await tx.exec(`UPDATE employees SET status = 'TERMINATED', updated_at = now(), version = version + 1 WHERE tenant_id = :t AND id = $1`, [d.id]);
      return applyDeparture(tx, p, null, { id: d.id, name: d.name, reportsTo: d.reportsTo }, d.lastDay, d.terminationReason ?? 'Left the company', true);
    });
    await afterDeparture(tenantId, p, d.name, done.versionIds, done.futureShifts, d.terminationReason ?? '');
    await dropCache(tenantId, 'userstate:*');
  }
  return due.length;
}
