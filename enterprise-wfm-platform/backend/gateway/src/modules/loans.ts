/**
 * Loans between sites. A person keeps their home group and is lent to a group at another site for a stretch of days, with a reason on record. While it runs, the scheduler
 * draws them into the borrowing group's pool and keeps them off their home group (see loadCtx in scheduleRoutes.ts); outside the dates nothing changes. A loan can be
 * ended early or, before it starts, cancelled. Nothing is deleted: who worked where stays on record.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, requireUnscoped } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { addDays } from './forecast/service.ts';
import { dropCache } from '../infra.ts';

export const loans = Router();   // mounted at /workforce/loans
const uuid = z.string().uuid();
const todayUtc = () => new Date().toISOString().slice(0, 10);
const MAX_DAYS = 180;

const LoanBody = z.object({
  employeeId: uuid, toGroupId: uuid, startDay: z.string().regex(isoDay), endDay: z.string().regex(isoDay),
  reason: z.string().trim().min(3, 'Say why the person is being lent').max(300),
});

const SELECT = `
  SELECT l.id, l.employee_id, l.home_group_id, l.to_group_id, l.start_day::text AS start_day, l.end_day::text AS end_day, l.reason, l.status, l.created_by, l.created_at, l.ended_by,
         e.first_name || ' ' || e.last_name AS employee_name, e.employee_number,
         hg.name AS home_group, hs.name AS home_site, tg.name AS to_group, ts.name AS to_site
  FROM site_loans l
  JOIN employees e ON e.id = l.employee_id
  LEFT JOIN wfm_groups hg ON hg.id = l.home_group_id LEFT JOIN sites hs ON hs.id = hg.site_id
  LEFT JOIN wfm_groups tg ON tg.id = l.to_group_id LEFT JOIN sites ts ON ts.id = tg.site_id
  WHERE l.tenant_id = :t`;

const stateOf = (l: any, today: string): 'CANCELLED' | 'UPCOMING' | 'CURRENT' | 'PAST' =>
  l.status === 'CANCELLED' ? 'CANCELLED' : l.startDay > today ? 'UPCOMING' : l.endDay >= today ? 'CURRENT' : 'PAST';

const dto = (l: any, today = todayUtc()) => ({
  id: l.id, employeeId: l.employeeId, employeeName: l.employeeName, employeeNumber: l.employeeNumber,
  homeGroupId: l.homeGroupId, homeGroup: l.homeGroup ?? null, homeSite: l.homeSite ?? null, toGroupId: l.toGroupId, toGroup: l.toGroup ?? null, toSite: l.toSite ?? null,
  startDay: l.startDay, endDay: l.endDay, reason: l.reason, status: l.status, state: stateOf(l, today), createdBy: l.createdBy ?? null, endedBy: l.endedBy ?? null,
});

loans.get('/', requires('workforce:read'), async (req, res) => {
  const q = parse(z.object({ employeeId: uuid.optional(), groupId: uuid.optional(), when: z.enum(['active', 'past', 'all']).default('active') }), req.query);
  const today = todayUtc();
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `${SELECT} AND ($1::uuid IS NULL OR l.employee_id = $1) AND ($2::uuid IS NULL OR l.to_group_id = $2 OR l.home_group_id = $2)
     ORDER BY l.start_day DESC, e.last_name`, [q.employeeId ?? null, q.groupId ?? null]));
  const all = rows.map((r) => dto(r, today));
  res.json(q.when === 'all' ? all : q.when === 'past' ? all.filter((l) => l.state === 'PAST' || l.state === 'CANCELLED') : all.filter((l) => l.state === 'CURRENT' || l.state === 'UPCOMING'));
});

loans.post('/', requires('workforce:write'), async (req, res) => {
  requireUnscoped(req);   // lending someone between sites needs a view of both
  const p = me(req), b = parse(LoanBody, req.body), today = todayUtc();
  if (b.startDay < today) throw bad('A loan starts today or later. Days already worked are not changed.');
  if (b.endDay < b.startDay) throw bad('The last day cannot be before the first day.');
  if (addDays(b.startDay, MAX_DAYS - 1) < b.endDay) throw bad(`A loan runs up to ${MAX_DAYS} days. For longer, move the person to the other group instead.`);
  const out = await withTenant(p.tenantId, async (tx: Tx) => {
    const e = await tx.one<any>(`SELECT id, first_name, last_name, status, primary_group_id FROM employees WHERE tenant_id = :t AND id = $1`, [b.employeeId]);
    if (!e) throw notFound('Employee');
    if (e.status !== 'ACTIVE') throw bad('Only people who are active can be lent.');
    if (!e.primaryGroupId) throw bad('This person has no home group. Put them in a WFM group first.');
    if (e.primaryGroupId === b.toGroupId) throw bad('That is the person\'s own group.');
    const to = await tx.one<any>(`SELECT g.id, g.name, g.status, g.site_id, s.name AS site_name, s.status AS site_status FROM wfm_groups g LEFT JOIN sites s ON s.id = g.site_id WHERE g.tenant_id = :t AND g.id = $1`, [b.toGroupId]);
    if (!to) throw notFound('WFM group');
    if (to.status !== 'ACTIVE') throw bad(`${to.name} is switched off.`);
    if (to.siteStatus === 'CLOSED') throw bad(`${to.siteName} is closed.`);
    const home = await tx.one<any>(`SELECT g.name, g.site_id, s.name AS site_name FROM wfm_groups g LEFT JOIN sites s ON s.id = g.site_id WHERE g.tenant_id = :t AND g.id = $1`, [e.primaryGroupId]);
    if (home?.siteId && to.siteId && home.siteId === to.siteId) throw bad(`${home.name} and ${to.name} are both at ${to.siteName}. A loan is for lending a person to another site; for the same site, mark the person eligible for the other group.`);
    const clash = await tx.one<any>(
      `SELECT start_day::text AS s, end_day::text AS e FROM site_loans WHERE tenant_id = :t AND employee_id = $1 AND status = 'ACTIVE' AND start_day <= $3::date AND end_day >= $2::date LIMIT 1`,
      [b.employeeId, b.startDay, b.endDay]);
    if (clash) throw conflict(`${e.firstName} ${e.lastName} is already on loan from ${clash.s} to ${clash.e}. End that loan first, or choose other dates.`);
    const r = await tx.one<any>(
      `INSERT INTO site_loans (tenant_id, employee_id, home_group_id, to_group_id, start_day, end_day, reason, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [b.employeeId, e.primaryGroupId, b.toGroupId, b.startDay, b.endDay, b.reason, p.name]);
    // what the lender may still have to sort out: shifts already published at the home group in these days
    const published = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
       WHERE s.tenant_id = :t AND s.employee_id = $1 AND v.status = 'PUBLISHED' AND v.wfm_group_id = $2 AND s.day >= $3::date AND s.day <= $4::date`, [b.employeeId, e.primaryGroupId, b.startDay, b.endDay]);
    const [row] = await tx.q<any>(`${SELECT} AND l.id = $1`, [r!.id]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SITE_LOAN', entityId: r!.id, entityName: `${e.firstName} ${e.lastName} to ${to.name}`, after: dto(row), reason: b.reason });
    return { loan: dto(row), warnings: { publishedShiftsAtHome: published?.n ?? 0 } };
  });
  await dropCache(p.tenantId, 'sched:*');
  res.status(201).json(out);
});

/** Ends a loan: before it starts it is cancelled; once it is running the person is back at their home group from today. */
loans.post('/:id/end', requires('workforce:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), id = parse(uuid, req.params.id), today = todayUtc();
  const out = await withTenant(p.tenantId, async (tx: Tx) => {
    const [l] = await tx.q<any>(`${SELECT} AND l.id = $1`, [id]);
    if (!l) throw notFound('Loan');
    if (l.status === 'CANCELLED' || l.endDay < today) throw bad('That loan has already ended.');
    if (l.startDay >= today) await tx.exec(`UPDATE site_loans SET status = 'CANCELLED', ended_by = $2, ended_at = now() WHERE tenant_id = :t AND id = $1`, [id, p.name]);
    else await tx.exec(`UPDATE site_loans SET end_day = $2::date, ended_by = $3, ended_at = now() WHERE tenant_id = :t AND id = $1`, [id, addDays(today, -1), p.name]);
    const [after] = await tx.q<any>(`${SELECT} AND l.id = $1`, [id]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SITE_LOAN', entityId: id, entityName: `${l.employeeName} to ${l.toGroup}`, before: dto(l), after: dto(after), diffSummary: l.startDay >= today ? 'loan cancelled' : 'loan ended early' });
    return dto(after);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json(out);
});
