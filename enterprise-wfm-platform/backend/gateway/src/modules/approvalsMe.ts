/**
 * The approvals a team lead can act on from the employee portal and the mobile app: time-off requests and swap requests that are waiting for them.
 * Who sees what follows the same rules as the admin screens: a supervisor, deputy or cover sees their own teams' requests; managers and schedulers see
 * everyone's (oldest first). Nobody sees their own request here. Deciding goes through the existing decide calls (/workforce/time-off/:id/decide and
 * /scheduling/swaps/:id/decide), so every check and notification is the same as in the admin app. Mounted at /me/approvals.
 */
import { Router } from 'express';
import { withTenant, type Tx } from '../db.ts';
import { me, permissionsFor, requires, type Principal } from '../auth.ts';
import { approvalSettings, myTeamIds } from './approvals.ts';
import { TO_SQL, toDto } from './workforceRoutes.ts';
import { pendingApprovalSwaps } from './swaps.ts';
import { offRequestList } from './offRequests.ts';

export const approvalsMe = Router();
const LIMIT = 100;

/** What this person may decide: everything (managers, schedulers) or their own teams' requests (supervisors, deputies, cover). */
async function scopeOf(tx: Tx, p: Principal) {
  const have = p.scopes ? new Set(p.scopes) : await permissionsFor(p.tenantId, p.role);
  const emp = (await tx.one<{ employeeId: string | null }>('SELECT employee_id FROM users WHERE tenant_id = :t AND id = $1', [p.userId]))?.employeeId ?? null;
  const fullTimeOff = have.has('workforce:write'), fullSwaps = have.has('schedule:edit');
  const first = have.has('requests:approve') && (await approvalSettings(tx)).supervisorFirst;
  const teamIds = first ? await myTeamIds(tx, p.userId) : [];
  return {
    emp,
    timeOff: fullTimeOff ? { teams: null as string[] | null } : teamIds.length ? { teams: teamIds } : null,
    off: fullTimeOff ? { teams: null as string[] | null } : teamIds.length ? { teams: teamIds } : null,         // requests about days off are decided by the same people as time off
    swaps: fullSwaps ? { teams: null as string[] | null } : teamIds.length ? { teams: teamIds } : null,
  };
}

async function pendingTimeOff(tx: Tx, teams: string[] | null, selfEmployee: string | null) {
  const rows = await tx.q<any>(
    `${TO_SQL} AND o.status = 'REQUESTED' AND ($1::uuid[] IS NULL OR e.team_id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR e.id <> $2::uuid)
      ORDER BY o.created_at LIMIT ${LIMIT + 1}`, [teams, selfEmployee]);
  const ids = rows.slice(0, LIMIT).map((r) => r.id);
  // who the person is waiting with, and how many of their team are already off in the same days
  const ctx = ids.length ? await tx.q<any>(
    `SELECT o.id, t.name AS team,
            (SELECT count(*)::int FROM employees m WHERE m.tenant_id = :t AND m.team_id = e.team_id AND m.id <> e.id AND m.status IN ('ACTIVE', 'LEAVE')) AS team_size,
            (SELECT count(DISTINCT x.employee_id)::int FROM employees m JOIN time_off x ON x.employee_id = m.id AND x.tenant_id = :t AND x.status = 'APPROVED' AND x.start_day <= o.end_day AND x.end_day >= o.start_day
              WHERE m.tenant_id = :t AND m.team_id = e.team_id AND m.id <> e.id) AS team_off
       FROM time_off o JOIN employees e ON e.id = o.employee_id LEFT JOIN teams t ON t.id = e.team_id WHERE o.tenant_id = :t AND o.id = ANY($1::uuid[])`, [ids]) : [];
  const by = new Map(ctx.map((c) => [c.id as string, c]));
  return {
    truncated: rows.length > LIMIT,
    items: rows.slice(0, LIMIT).map((r) => ({ ...toDto(r), team: by.get(r.id)?.team ?? null, teamSize: by.get(r.id)?.teamSize ?? 0, teamOff: by.get(r.id)?.teamOff ?? 0, escalated: !!r.escalatedAt })),
  };
}

/** Whether the person has anything to approve at all, and how many are waiting: for the tab and its badge. */
approvalsMe.get('/count', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const sc = await scopeOf(tx, p).catch(() => null);
    if (!sc || (!sc.timeOff && !sc.swaps)) return { access: false, count: 0 };
    const t = sc.timeOff ? (await pendingTimeOff(tx, sc.timeOff.teams, sc.emp)).items.length : 0;
    const s = sc.swaps ? (await pendingApprovalSwaps(tx, sc.swaps.teams, sc.emp)).length : 0;
    const o = sc.off ? (await offRequestList(tx, { statuses: ['REQUESTED'], teams: sc.off.teams, excludeEmployee: sc.emp })).items.length : 0;
    return { access: true, count: t + s + o };
  }));
});

approvalsMe.get('/', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const sc = await scopeOf(tx, p).catch(() => null);
    if (!sc || (!sc.timeOff && !sc.swaps)) return { access: false, timeOff: [], swaps: [], offRequests: [], truncated: false };
    const t = sc.timeOff ? await pendingTimeOff(tx, sc.timeOff.teams, sc.emp) : { items: [], truncated: false };
    const s = sc.swaps ? await pendingApprovalSwaps(tx, sc.swaps.teams, sc.emp) : [];
    const o = sc.off ? await offRequestList(tx, { statuses: ['REQUESTED'], teams: sc.off.teams, excludeEmployee: sc.emp }) : { items: [], truncated: false };
    return { access: true, timeOff: t.items, swaps: s, offRequests: o.items, truncated: t.truncated || o.truncated };
  }));
});
