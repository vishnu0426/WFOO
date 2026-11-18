/**
 * What a person asks for about their days off, decided the way time off is decided (the team's supervisor first, else a manager).
 *   WEEKEND_OFF  "the weekends in these dates off, together". Once approved the scheduler treats those weekend days as time off, so a generated schedule leaves them free
 *                and a hand edit that puts a shift on them is reported. A schedule already published is not changed: the approver is told how many shifts fall on those days.
 *   STANDING     "from now on at least N days off together / N full weekends off a month". Once approved it raises the person's own limits; it can never lower them, and it never
 *                weakens the company's or the labour law's rule (the strictest of the three always applies).
 * The person's routes are mounted at /me/off-requests, the approver's at /workforce/off-requests.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, requiresAny, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache, publish } from '../infra.ts';
import { notify, usersOf } from '../notify.ts';
import { approvalAudience, approverLevel, inScope, teamLimit, waitingFor } from './approvals.ts';
import { whoAmI } from './selfService.ts';
import { weekendDaysFor } from './payWeek.ts';
import { weekendDatesIn, weekendRunsIn } from './weekendRule.ts';
import { loadPolicy } from './policyRoutes.ts';
import { loadRuleSets } from './compliance/routes.ts';
import { limitsFrom } from './compliance/rules.ts';
import { addDays } from './forecast/service.ts';

export const offRequestsMe = Router();
export const offRequestsAdmin = Router();
const uuid = z.string().uuid();

const SQL = `SELECT r.*, r.start_day::text AS start_day, r.end_day::text AS end_day, e.first_name || ' ' || e.last_name AS employee_name, e.team_id, t.name AS team_name
               FROM off_requests r JOIN employees e ON e.id = r.employee_id LEFT JOIN teams t ON t.id = e.team_id WHERE r.tenant_id = :t`;

export const offDto = (r: any) => ({
  id: r.id, employeeId: r.employeeId, employeeName: r.employeeName, team: r.teamName ?? null, kind: r.kind as 'WEEKEND_OFF' | 'STANDING',
  startDate: r.startDay ?? null, endDate: r.endDay ?? null, minDaysTogether: r.minDaysTogether ?? null, minWeekendsMonth: r.minWeekendsMonth ?? null,
  status: r.status as 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED', reason: r.reason, decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionNote: r.decisionNote, createdAt: r.createdAt, escalatedAt: r.escalatedAt ?? null,
});

/** What limits a person has now: their own, the company's and the labour pack's. The strictest of the three is what the scheduler applies. */
export async function limitsOf(tx: Tx, emp: any) {
  const pol = await loadPolicy(tx);
  const law = emp.primaryGroupId ? limitsFrom((await loadRuleSets(tx, emp.primaryGroupId)).forTeam(emp.teamId, emp.id)) : {};
  const own = { daysTogether: emp.minDaysOffTogether ?? 0, weekendsMonth: emp.minWeekendsOffMonth ?? 0 };
  const company = { daysTogether: pol.minDaysOffTogether ?? 0, weekendsMonth: pol.minWeekendsOffMonth ?? 0 };
  const pack = { daysTogether: law.minDaysOffTogether ?? 0, weekendsMonth: law.minWeekendsOffMonth ?? 0 };
  return { own, company, pack, effective: { daysTogether: Math.max(own.daysTogether, company.daysTogether, pack.daysTogether), weekendsMonth: Math.max(own.weekendsMonth, company.weekendsMonth, pack.weekendsMonth) } };
}

const Create = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('WEEKEND_OFF'), startDate: z.string().regex(isoDay), endDate: z.string().regex(isoDay), reason: z.string().trim().max(300).default('') }),
  z.object({ kind: z.literal('STANDING'), minDaysTogether: z.number().int().min(1).max(3).optional(), minWeekendsMonth: z.number().int().min(1).max(4).optional(), reason: z.string().trim().max(300).default('') }),
]);

// ---------------------------------------------------------------- the person's side

offRequestsMe.get('/', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const rows = await tx.q<any>(`${SQL} AND r.employee_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [w.employeeId]);
    const wf = rows.some((r) => r.status === 'REQUESTED') ? await waitingFor(tx, w.employeeId) : null;
    const weekend = await weekendDaysFor(tx, w.emp.primaryGroupId ?? null);
    return { requests: rows.map((r) => ({ ...offDto(r), waitingFor: r.status === 'REQUESTED' ? wf : null })), weekendDays: weekend, today: w.today, limits: await limitsOf(tx, w.emp) };
  }));
});

offRequestsMe.post('/', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(Create, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const name = `${w.emp.firstName} ${w.emp.lastName}`;
    let startDay: string | null = null, endDay: string | null = null, daysT: number | null = null, weekendsM: number | null = null, summary = '';
    if (b.kind === 'WEEKEND_OFF') {
      if (b.endDate < b.startDate) throw bad('The last date is before the first date.');
      if (b.startDate < w.today) throw bad('Those dates have already started. Ask your manager for a change to a schedule that is already running.');
      if (b.startDate > addDays(w.today, 366)) throw bad('Ask for dates within the next year.');
      if ((Date.parse(b.endDate) - Date.parse(b.startDate)) / 864e5 > 92) throw bad('Ask for at most about three months at a time.');
      const weekend = await weekendDaysFor(tx, w.emp.primaryGroupId ?? null);
      const runs = weekendRunsIn(b.startDate, b.endDate, weekend);
      if (!runs.length) throw bad('There is no weekend in those dates.');
      const clash = await tx.one<any>(`SELECT start_day::text AS s, end_day::text AS e FROM off_requests WHERE tenant_id = :t AND employee_id = $1 AND kind = 'WEEKEND_OFF' AND status IN ('REQUESTED','APPROVED') AND end_day >= $2::date AND start_day <= $3::date LIMIT 1`, [w.employeeId, b.startDate, b.endDate]);
      if (clash) throw conflict(`You already have a weekends-off request from ${clash.s} to ${clash.e} that overlaps these dates.`);
      startDay = b.startDate; endDay = b.endDate;
      summary = `${runs.length} ${runs.length === 1 ? 'weekend' : 'weekends'} off together, ${b.startDate} to ${b.endDate}`;
    } else {
      const lim = await limitsOf(tx, w.emp);
      if (b.minDaysTogether !== undefined && b.minDaysTogether <= lim.effective.daysTogether) throw bad(`You already have at least ${lim.effective.daysTogether} ${lim.effective.daysTogether === 1 ? 'day' : 'days'} off together each week (${lim.own.daysTogether >= lim.effective.daysTogether ? 'your own setting' : 'the company or labour-law rule'}). Ask for more than that.`);
      if (b.minWeekendsMonth !== undefined && b.minWeekendsMonth <= lim.effective.weekendsMonth) throw bad(`You already have at least ${lim.effective.weekendsMonth} full ${lim.effective.weekendsMonth === 1 ? 'weekend' : 'weekends'} off each month. Ask for more than that.`);
      if (b.minDaysTogether === undefined && b.minWeekendsMonth === undefined) throw bad('Choose what you are asking for: days off together, weekends off in a month, or both.');
      if (await tx.one(`SELECT 1 FROM off_requests WHERE tenant_id = :t AND employee_id = $1 AND kind = 'STANDING' AND status = 'REQUESTED' LIMIT 1`, [w.employeeId])) throw conflict('You already have a request of this kind waiting for a decision. Cancel it first to change it.');
      daysT = b.minDaysTogether ?? null; weekendsM = b.minWeekendsMonth ?? null;
      summary = [daysT ? `${daysT} days off together each week` : '', weekendsM ? `${weekendsM} full ${weekendsM === 1 ? 'weekend' : 'weekends'} off each month` : ''].filter(Boolean).join(' and ');
    }
    const id = (await tx.one<{ id: string }>(
      `INSERT INTO off_requests (tenant_id, employee_id, kind, start_day, end_day, min_days_together, min_weekends_month, reason) VALUES (:t, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [w.employeeId, b.kind, startDay, endDay, daysT, weekendsM, b.reason]))!.id;
    const row = (await tx.q<any>(`${SQL} AND r.id = $1`, [id]))[0];
    await audit(tx, p, req, { action: 'CREATE', entityType: 'OFF_REQUEST', entityId: id, entityName: name, reason: b.reason || undefined, after: offDto(row), diffSummary: `${summary}: sent for approval` });
    const audience = (await approvalAudience(tx, w.employeeId)).users;
    publish(p.tenantId, ['offrequest', 'requested'], { id, employeeId: w.employeeId, employee: name, kind: b.kind });
    await notify(tx, audience, { kind: 'TIME_OFF', title: b.kind === 'WEEKEND_OFF' ? 'Weekends-off request' : 'Standing days-off request', body: `${name}: ${summary}`, data: { screen: 'time-off', id } });
    return { request: { ...offDto(row), waitingFor: await waitingFor(tx, w.employeeId) } };
  });
  res.status(201).json(out);
});

offRequestsMe.post('/:id/cancel', requires('self:use'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const cur = (await tx.q<any>(`${SQL} AND r.id = $1 AND r.employee_id = $2`, [id, w.employeeId]))[0];
    if (!cur) throw notFound('Request');
    if (cur.status === 'CANCELLED' || cur.status === 'REJECTED') throw conflict(`This request is already ${cur.status.toLowerCase()}.`);
    if (cur.kind === 'STANDING' && cur.status === 'APPROVED') throw conflict('This has already been added to your limits. Ask your manager to change it.');
    if (cur.status === 'APPROVED' && cur.startDay <= w.today) throw conflict('These weekends have started. Ask your manager.');
    await tx.exec(`UPDATE off_requests SET status = 'CANCELLED', decided_by = $2, decided_at = now() WHERE tenant_id = :t AND id = $1`, [id, `${w.emp.firstName} ${w.emp.lastName}`]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'OFF_REQUEST', entityId: id, entityName: `${w.emp.firstName} ${w.emp.lastName}`, before: { status: cur.status }, after: { status: 'CANCELLED' }, diffSummary: 'cancelled by the employee' });
    return offDto((await tx.q<any>(`${SQL} AND r.id = $1`, [id]))[0]);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json(out);
});

// ---------------------------------------------------------------- the approver's side

/** What the approver needs to decide: who is off those weekends already, what is scheduled, and what approving changes. */
async function contextOf(tx: Tx, rows: any[]) {
  const out = new Map<string, any>();
  for (const r of rows) {
    const emp = await tx.one<any>('SELECT e.*, t.name AS team_name FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.tenant_id = :t AND e.id = $1', [r.employeeId]);
    if (!emp) continue;
    if (r.kind === 'WEEKEND_OFF') {
      const weekend = await weekendDaysFor(tx, emp.primaryGroupId ?? null);
      const days = weekendDatesIn(r.startDay, r.endDay, weekend);
      const runs = weekendRunsIn(r.startDay, r.endDay, weekend);
      const scheduled = days.length ? (await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.employee_id = $1 AND s.day = ANY($2::date[])`, [r.employeeId, days]))!.n : 0;
      const teamSize = emp.teamId ? (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND team_id = $1 AND id <> $2 AND status IN ('ACTIVE', 'LEAVE')`, [emp.teamId, emp.id]))!.n : 0;
      // teammates already off on those days: approved time off, or an approved weekends-off request
      const teamOff = emp.teamId && days.length ? (await tx.one<{ n: number }>(
        `SELECT count(DISTINCT m.id)::int AS n FROM employees m WHERE m.tenant_id = :t AND m.team_id = $1 AND m.id <> $2 AND (
           EXISTS (SELECT 1 FROM time_off x WHERE x.tenant_id = :t AND x.employee_id = m.id AND x.status = 'APPROVED' AND x.start_day <= $4::date AND x.end_day >= $3::date)
           OR EXISTS (SELECT 1 FROM off_requests o WHERE o.tenant_id = :t AND o.employee_id = m.id AND o.kind = 'WEEKEND_OFF' AND o.status = 'APPROVED' AND o.start_day <= $4::date AND o.end_day >= $3::date))`, [emp.teamId, emp.id, days[0], days[days.length - 1]]))!.n : 0;
      out.set(r.id, { weekends: runs.map((x) => ({ from: x[0], to: x[x.length - 1] })), scheduledShifts: scheduled, teamSize, teamOff });
    } else {
      const lim = await limitsOf(tx, emp);
      out.set(r.id, { now: lim.own, effective: lim.effective, after: { daysTogether: Math.max(lim.own.daysTogether, r.minDaysTogether ?? 0), weekendsMonth: Math.max(lim.own.weekendsMonth, r.minWeekendsMonth ?? 0) } });
    }
  }
  return out;
}

/** The requests waiting for this person (or those matching a status), with the context for deciding. `teams` limits them to a supervisor's teams; null means everyone's. */
export async function offRequestList(tx: Tx, opts: { statuses?: string[]; teams?: string[] | null; self?: string | null; excludeEmployee?: string | null; limit?: number }) {
  const limit = opts.limit ?? 200;
  const rows = await tx.q<any>(
    `${SQL} AND ($1::text[] IS NULL OR r.status = ANY($1::text[])) AND ($2::uuid[] IS NULL OR e.team_id = ANY($2::uuid[]) OR e.id = $3::uuid) AND ($4::uuid IS NULL OR e.id <> $4::uuid)
      ORDER BY (r.status = 'REQUESTED') DESC, r.created_at LIMIT ${limit + 1}`, [opts.statuses ?? null, opts.teams ?? null, opts.self ?? null, opts.excludeEmployee ?? null]);
  const items = rows.slice(0, limit);
  const ctx = await contextOf(tx, items);
  return { truncated: rows.length > limit, items: items.map((r) => ({ ...offDto(r), escalated: !!r.escalatedAt, context: ctx.get(r.id) ?? null })) };
}

offRequestsAdmin.get('/', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), employeeId: uuid.optional() }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const lim = await teamLimit(tx, p);
    const r = await offRequestList(tx, { statuses: q.status ? [q.status] : undefined, teams: lim ? lim.teamIds : null, self: lim?.self ?? null });
    return q.employeeId ? { ...r, items: r.items.filter((i) => i.employeeId === q.employeeId) } : r;
  }));
});

/**
 * Decide one request. A supervisor may decide their own team's, a manager anyone's; nobody decides their own. Approving a STANDING request raises the person's own limits (never lowers them).
 * Rejecting needs a reason the person will read.
 */
export async function decideOffRequest(tx: Tx, p: Principal, req: any, id: string, status: 'APPROVED' | 'REJECTED', note: string) {
  const cur = (await tx.q<any>(`${SQL} AND r.id = $1`, [id]))[0];
  if (!cur) throw notFound('Request');
  if (!(await inScope(tx, p, cur.employeeId))) throw notFound('Request');
  const level = await approverLevel(tx, p, cur.employeeId, 'workforce:write');
  if (cur.status !== 'REQUESTED') throw conflict(`This request is already ${cur.status.toLowerCase()}.`);
  if (status === 'REJECTED' && note.trim().length < 3) throw bad('Give a reason when declining a request.');
  const warnings: string[] = [];
  if (status === 'APPROVED') {
    if (cur.kind === 'STANDING') {
      await tx.exec(
        `UPDATE employees SET min_days_off_together = GREATEST(min_days_off_together, coalesce($2::int, 0)), min_weekends_off_month = GREATEST(min_weekends_off_month, coalesce($3::int, 0)), updated_at = now(), version = version + 1 WHERE tenant_id = :t AND id = $1`,
        [cur.employeeId, cur.minDaysTogether, cur.minWeekendsMonth]);
    } else {
      const emp = await tx.one<any>('SELECT primary_group_id FROM employees WHERE tenant_id = :t AND id = $1', [cur.employeeId]);
      const days = weekendDatesIn(cur.startDay, cur.endDay, await weekendDaysFor(tx, emp?.primaryGroupId ?? null));
      const n = days.length ? (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.employee_id = $1 AND s.day = ANY($2::date[])`, [cur.employeeId, days]))!.n : 0;
      if (n) warnings.push(`${cur.employeeName} is already scheduled on ${n} of these weekend days in a published schedule. Take them off those shifts; the next schedule you generate leaves the weekends free.`);
    }
  }
  await tx.exec(`UPDATE off_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE tenant_id = :t AND id = $1`, [id, status, p.name, note.trim()]);
  const after = (await tx.q<any>(`${SQL} AND r.id = $1`, [id]))[0];
  await audit(tx, p, req, { action: status === 'APPROVED' ? 'APPROVE' : 'REJECT', entityType: 'OFF_REQUEST', entityId: id, entityName: cur.employeeName, reason: note || undefined, before: { status: cur.status }, after: { status }, diffSummary: level === 'SUPERVISOR' ? 'Decided by the team supervisor (first line)' : 'Decided by a manager' });
  publish(p.tenantId, ['offrequest', 'decided'], { id, employeeId: cur.employeeId, employee: cur.employeeName, status });
  const what = cur.kind === 'WEEKEND_OFF' ? `weekends off, ${cur.startDay} to ${cur.endDay}` : [cur.minDaysTogether ? `${cur.minDaysTogether} days off together` : '', cur.minWeekendsMonth ? `${cur.minWeekendsMonth} weekends off a month` : ''].filter(Boolean).join(' and ');
  await notify(tx, await usersOf(tx, [cur.employeeId]), { kind: 'TIME_OFF', title: `Your request was ${status === 'APPROVED' ? 'approved' : 'declined'}`, body: `${what}${note ? `: ${note}` : ''}`, data: { screen: 'time-off', id } });
  return { ...offDto(after), warnings };
}

offRequestsAdmin.post('/:id/decide', requiresAny('workforce:write', 'requests:approve'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ status: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().max(300).default('') }), req.body);
  const out = await withTenant(p.tenantId, (tx) => decideOffRequest(tx, p, req, id, b.status, b.reason));
  await dropCache(p.tenantId, 'sched:*');
  res.json(out);
});
