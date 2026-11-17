/**
 * "Who is working today". A team lead (a team's supervisor, deputy or cover, or a group's manager) sees their people's day: working, off, on leave and what kind.
 * Everyone else sees only what the organisation allows (Configuration > Self-service > "Who can see the team"), and only their own team: nobody, who is on shift
 * right now by name, or the team roster for the week. Colleagues never learn that someone is on leave. Mounted at /me/team.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { isoDay, parse } from '../http.ts';
import { myTeamIds } from './approvals.ts';
import { whoAmI } from './selfService.ts';
import { hhmm } from './workforceRoutes.ts';
import { accessFor, clampDate, coveredByPublished, shownStatus, statusOf, type PersonDay, type TeamAccess, type TeamViewSetting } from './teamViewLogic.ts';

export const teamToday = Router();
const MAX_PEOPLE = 300;

/** The teams and groups this person leads (empty for a colleague), and their own team. */
async function reach(tx: Tx, p: Principal) {
  const w = await whoAmI(tx, p);
  const teamIds = await myTeamIds(tx, p.userId);
  const groupIds = (await tx.q<{ id: string }>('SELECT id FROM wfm_groups WHERE tenant_id = :t AND manager_id = $1', [w.employeeId])).map((g) => g.id);
  const setting = ((await tx.one<{ teamView: string }>('SELECT team_view FROM self_service_policy WHERE tenant_id = :t AND workspace_id = :w'))?.teamView ?? 'MANAGERS') as TeamViewSetting;
  const access: TeamAccess = accessFor(setting, teamIds.length > 0 || groupIds.length > 0, !!w.emp.teamId);
  return { w, teamIds, groupIds, access };
}

/** The 15-minute slot it is now, on the clock of `tz`. */
function nowSlot(tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    return Math.floor((Number(parts.find((x) => x.type === 'hour')?.value) * 60 + Number(parts.find((x) => x.type === 'minute')?.value)) / 15);
  } catch { const d = new Date(); return Math.floor((d.getHours() * 60 + d.getMinutes()) / 15); }
}

teamToday.get('/access', requires('self:use'), async (req, res) => {
  const p = me(req);
  const access = await withTenant(p.tenantId, async (tx) => (await reach(tx, p).catch(() => null))?.access ?? 'NONE');   // a login with no employee record has no team
  res.json({ access });
});

teamToday.get('/', requires('self:use'), async (req, res) => {
  const p = me(req), q = parse(z.object({ date: z.string().regex(isoDay).optional() }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const { w, teamIds, groupIds, access } = await reach(tx, p);
    if (access === 'NONE') return { access, date: w.today, today: w.today, scope: null, people: [], counts: { working: 0, onNow: 0, off: 0, leave: 0, unpublished: 0 }, truncated: false };
    const date = clampDate(access, w.today, q.date), isToday = date === w.today;
    const people = access === 'FULL'
      ? await tx.q<any>(`SELECT e.id, e.first_name, e.last_name, e.primary_group_id, e.eligible_group_ids, t.name AS team_name FROM employees e LEFT JOIN teams t ON t.id = e.team_id
                          WHERE e.tenant_id = :t AND e.status IN ('ACTIVE', 'LEAVE') AND e.id <> $3 AND (e.team_id = ANY($1::uuid[]) OR e.primary_group_id = ANY($2::uuid[])) ORDER BY e.last_name, e.first_name LIMIT ${MAX_PEOPLE + 1}`, [teamIds, groupIds, w.employeeId])
      : await tx.q<any>(`SELECT e.id, e.first_name, e.last_name, e.primary_group_id, e.eligible_group_ids, t.name AS team_name FROM employees e LEFT JOIN teams t ON t.id = e.team_id
                          WHERE e.tenant_id = :t AND e.status IN ('ACTIVE', 'LEAVE') AND e.id <> $2 AND e.team_id = $1 ORDER BY e.last_name, e.first_name LIMIT ${MAX_PEOPLE + 1}`, [w.emp.teamId, w.employeeId]);
    const truncated = people.length > MAX_PEOPLE;
    const ids = people.slice(0, MAX_PEOPLE).map((e) => e.id);
    const shifts = ids.length ? await tx.q<any>(
      `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
        WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.employee_id = ANY($1::uuid[])
          AND s.day IN ($2::date, ($2::date - 1))`, [ids, date]) : [];
    const leave = ids.length ? await tx.q<any>(
      `SELECT employee_id, type FROM time_off WHERE tenant_id = :t AND status = 'APPROVED' AND employee_id = ANY($1::uuid[]) AND start_day <= $2::date AND end_day >= $2::date`, [ids, date]) : [];
    // which groups have a published schedule covering the day: a person with no shift in none of theirs is "not published", not "off"
    const publishedGroups = new Set((await tx.q<{ wfmGroupId: string }>(
      `SELECT DISTINCT wfm_group_id FROM schedule_versions WHERE tenant_id = :t AND status = 'PUBLISHED' AND period_start <= $1::date AND period_end >= $1::date AND (publish_through IS NULL OR publish_through >= $1::date)`, [date])).map((r) => r.wfmGroupId));
    const leaveOf = new Map(leave.map((l) => [l.employeeId as string, l.type as string]));
    const slot = isToday ? nowSlot(w.tz) : null;
    const rows: { employeeId: string; name: string; team: string | null; status: string; startTime: string | null; endTime: string | null; leaveType: string | null }[] = [];
    for (const e of people.slice(0, MAX_PEOPLE)) {
      const mine = shifts.filter((s) => s.employeeId === e.id);
      const today = mine.filter((s) => s.day === date), yesterday = mine.filter((s) => s.day !== date);
      const day: PersonDay = {
        shifts: today.map((s) => ({ startSlot: s.startSlot, lengthSlots: s.lengthSlots })),
        spillSlots: Math.max(0, ...yesterday.map((s) => s.startSlot + s.lengthSlots - 96)),
        leave: leaveOf.has(e.id),
        published: coveredByPublished([e.primaryGroupId, ...(e.eligibleGroupIds ?? [])], publishedGroups),
      };
      const status = shownStatus(access, statusOf(day, slot));
      if (!status) continue;
      const first = today[0];
      rows.push({
        employeeId: e.id, name: `${e.firstName} ${e.lastName}`, team: e.teamName ?? null, status,
        startTime: first ? hhmm(first.startSlot) : null, endTime: first ? hhmm(first.startSlot + first.lengthSlots) : null,
        leaveType: access === 'FULL' && status === 'LEAVE' ? leaveOf.get(e.id) ?? null : null,        // the kind of leave is for team leads only
      });
    }
    const working = rows.filter((r) => ['ON_NOW', 'LATER', 'DONE', 'WORKING'].includes(r.status)).length;
    const scope = access === 'FULL' ? (teamIds.length ? 'Your teams' : 'Your groups') : w.emp.teamName ?? 'Your team';
    return { access, date, today: w.today, scope, people: rows, counts: { working, onNow: rows.filter((r) => r.status === 'ON_NOW').length, off: rows.filter((r) => r.status === 'OFF').length, leave: rows.filter((r) => r.status === 'LEAVE').length, unpublished: rows.filter((r) => r.status === 'UNPUBLISHED').length }, truncated };
  }));
});
