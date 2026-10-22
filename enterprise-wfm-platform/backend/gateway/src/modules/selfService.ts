/**
 * Employee self-service: what a person sees and can ask for about their own work. Everything under /me is limited to the signed-in
 * person (their login must be linked to an employee). Simple requests are decided by rules the organisation sets; the rest go to a manager.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache } from '../infra.ts';
import { notify, usersOf } from '../notify.ts';
import { addDays, loadGroup, todayIn } from './forecast/service.ts';
import { hhmm } from './workforceRoutes.ts';

export const selfService = Router();   // mounted at /me
export const selfAdmin = Router();     // mounted at /self-service (policy and logins, for managers)
const uuid = z.string().uuid();
const TYPES = ['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER'] as const;
const slotOf = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Math.min(96, Math.floor((+m[1] * 60 + +m[2]) / 15)) : NaN; };

// ---------------------------------------------------------------- policy

export interface Policy {
  timeOffAutoApprove: boolean; timeOffMinNoticeDays: number; timeOffMaxOffPercent: number; entitlements: Record<string, number>; agentCanEditAvailability: boolean;
  swapAutoApprove: boolean; swapMaxExtraGapSlots: number; swapMinNoticeHours: number; swapBoardHours: number;
}
export async function loadSelfPolicy(tx: Tx): Promise<Policy> {
  await tx.exec('INSERT INTO self_service_policy (tenant_id) VALUES (:t) ON CONFLICT (tenant_id) DO NOTHING');
  const r = (await tx.one<any>('SELECT * FROM self_service_policy WHERE tenant_id = :t'))!;
  return { timeOffAutoApprove: r.timeOffAutoApprove, timeOffMinNoticeDays: r.timeOffMinNoticeDays, timeOffMaxOffPercent: r.timeOffMaxOffPercent, entitlements: r.entitlements ?? {}, agentCanEditAvailability: r.agentCanEditAvailability,
    swapAutoApprove: r.swapAutoApprove, swapMaxExtraGapSlots: r.swapMaxExtraGapSlots, swapMinNoticeHours: r.swapMinNoticeHours, swapBoardHours: r.swapBoardHours };
}
const PolicyBody = z.object({
  timeOffAutoApprove: z.boolean(), timeOffMinNoticeDays: z.number().int().min(0).max(365), timeOffMaxOffPercent: z.number().int().min(0).max(100),
  entitlements: z.record(z.enum(TYPES), z.number().min(0).max(366)), agentCanEditAvailability: z.boolean(),
  swapAutoApprove: z.boolean(), swapMaxExtraGapSlots: z.number().int().min(0).max(96), swapMinNoticeHours: z.number().int().min(0).max(720), swapBoardHours: z.number().int().min(1).max(720),
});
selfAdmin.get('/policy', requires('config:read'), async (req, res) => { res.json(await withTenant(me(req).tenantId, loadSelfPolicy)); });
selfAdmin.put('/policy', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(PolicyBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await loadSelfPolicy(tx);
    await tx.exec(
      `UPDATE self_service_policy SET time_off_auto_approve = $1, time_off_min_notice_days = $2, time_off_max_off_percent = $3, entitlements = $4, agent_can_edit_availability = $5,
         swap_auto_approve = $6, swap_max_extra_gap_slots = $7, swap_min_notice_hours = $8, swap_board_hours = $9, updated_at = now() WHERE tenant_id = :t`,
      [b.timeOffAutoApprove, b.timeOffMinNoticeDays, b.timeOffMaxOffPercent, JSON.stringify(b.entitlements), b.agentCanEditAvailability, b.swapAutoApprove, b.swapMaxExtraGapSlots, b.swapMinNoticeHours, b.swapBoardHours]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SELF_SERVICE_POLICY', entityId: 'policy', entityName: 'Self-service rules', before, after: b });
    return loadSelfPolicy(tx);
  });
  res.json(out);
});

// ---------------------------------------------------------------- logins for employees

selfAdmin.get('/logins', requires('users:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(`SELECT id, username, role, status, employee_id, last_login_at FROM users WHERE tenant_id = :t AND employee_id IS NOT NULL`));
  res.json(rows.map((r) => ({ userId: r.id, username: r.username, role: r.role, status: r.status, employeeId: r.employeeId, lastLoginAt: r.lastLoginAt })));
});
/** Give an employee a login for the app. The temporary password is shown once; they should change it. */
selfAdmin.post('/logins', requires('users:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ employeeId: uuid, username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/).optional(), password: z.string().min(10).max(100).optional(), role: z.enum(['AGENT', 'SUPERVISOR_RTA', 'SCHEDULER']).default('AGENT') }), req.body);
  const password = b.password ?? randomBytes(9).toString('base64url');
  const out = await withTenant(p.tenantId, async (tx) => {
    const e = await tx.one<any>('SELECT id, employee_number, first_name, last_name, email FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!e) throw notFound('Employee');
    if (await tx.one('SELECT 1 FROM users WHERE tenant_id = :t AND employee_id = $1', [b.employeeId])) throw conflict('This employee already has a login');
    const username = b.username ?? String(e.employeeNumber).toLowerCase().replace(/[^a-z0-9._-]+/g, '');
    if (await tx.one('SELECT 1 FROM users WHERE tenant_id = :t AND lower(username) = lower($1)', [username])) throw conflict(`The username "${username}" is taken. Choose another.`);
    const u = await tx.one<any>('INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, employee_id) VALUES (:t, $1, $2, $3, $4, $5, $6) RETURNING id', [username, `${e.firstName} ${e.lastName}`, e.email, b.role, await bcrypt.hash(password, 12), b.employeeId]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'USER', entityId: u!.id, entityName: username, after: { username, role: b.role, employeeId: b.employeeId } });
    return { userId: u!.id, username };
  });
  res.status(201).json({ ...out, password });
});

/** Issues a new temporary password for an existing login (e.g. the person forgot it, or it was never delivered). Shown once, same as creation. */
selfAdmin.put('/logins/:userId/reset-password', requires('users:write'), async (req, res) => {
  const p = me(req), userId = parse(uuid, req.params.userId);
  const b = parse(z.object({ password: z.string().min(10).max(100).optional() }), req.body);
  const password = b.password ?? randomBytes(9).toString('base64url');
  const out = await withTenant(p.tenantId, async (tx) => {
    const u = await tx.one<any>('SELECT id, username FROM users WHERE tenant_id = :t AND id = $1 AND employee_id IS NOT NULL', [userId]);
    if (!u) throw notFound('Login');
    await tx.exec(`UPDATE users SET password_hash = $2, status = 'ACTIVE' WHERE tenant_id = :t AND id = $1`, [userId, await bcrypt.hash(password, 12)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: userId, entityName: u.username, diffSummary: 'Password reset' });
    return { userId: u.id, username: u.username };
  });
  res.json({ ...out, password });
});

// ---------------------------------------------------------------- who am I

export interface Me { userId: string; employeeId: string; emp: any; group: any | null; today: string; tz: string }
export async function whoAmI(tx: Tx, p: Principal): Promise<Me> {
  const u = await tx.one<any>('SELECT employee_id FROM users WHERE tenant_id = :t AND id = $1', [p.userId]);
  if (!u?.employeeId) throw bad('Your login is not linked to an employee record, so there is no personal schedule to show. Ask an administrator to link it.');
  const emp = await tx.one<any>('SELECT e.*, e.hire_date::text AS hire_date, t.name AS team_name FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.tenant_id = :t AND e.id = $1', [u.employeeId]);
  if (!emp) throw notFound('Employee');
  const group = emp.primaryGroupId ? await loadGroup(tx, emp.primaryGroupId).catch(() => null) : null;
  const tz = emp.timezone || group?.timezone || 'UTC';
  return { userId: p.userId, employeeId: emp.id, emp, group, today: todayIn(tz), tz };
}

const days = (from: string, to: string) => { const o: string[] = []; for (let d = from; d <= to && o.length < 400; d = addDays(d, 1)) o.push(d); return o; };
const shiftDto = (s: any) => ({ id: s.id, day: s.day, startTime: hhmm(s.startSlot), endTime: hhmm(s.startSlot + s.lengthSlots), overnight: s.startSlot + s.lengthSlots > 96, startSlot: s.startSlot, lengthSlots: s.lengthSlots, paidHours: (s.lengthSlots - (s.mealSlots ?? 0)) / 4,
  template: s.templateName ?? null, schedule: s.versionName, versionId: s.versionId, activities: (s.activities ?? []).map((a: any) => ({ ...a, startTime: hhmm(a.startSlot), endTime: hhmm(a.startSlot + a.slots) })) });

/** Which days in [from,to] fall inside a published schedule for any group this employee is eligible for -- not just
 * their primary group, since a shift can be published under any group they're eligible for (Alvin's own shifts, for
 * example, live under "Pre-Paid" while his primary group is "Testing"). Lets the portal say "nothing published yet"
 * instead of "Rest day" when really no one has published anything, which reads as a day off and isn't. */
async function publishedDays(tx: Tx, groupIds: string[], from: string, to: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!groupIds.length) return out;
  const ranges = await tx.q<any>(
    `SELECT period_start::text AS period_start, period_end::text AS period_end FROM schedule_versions
     WHERE tenant_id = :t AND wfm_group_id = ANY($1::uuid[]) AND status = 'PUBLISHED' AND period_end >= $2::date AND period_start <= $3::date`,
    [groupIds, from, to]);
  for (const day of days(from, to)) if (ranges.some((r: any) => day >= r.periodStart && day <= r.periodEnd)) out.add(day);
  return out;
}

// same fallback palette as the admin web app's Schedule Timeline and RTA Timelines (DayTimeline.tsx, IntradayView.tsx),
// so a colour means the same thing everywhere -- overridden per category the moment an admin sets a real activity colour
const ACTIVITY_FALLBACK: Record<string, string> = { WORK: '#BFE3CF', MEAL: '#E7C27D', BREAK: '#A9C4DE', TRAINING: '#B8A9D6', COACHING: '#9ACFC4' };
async function categoryColors(tx: Tx): Promise<Record<string, string>> {
  const out = { ...ACTIVITY_FALLBACK };
  const rows = await tx.q<any>(`SELECT category, color FROM activities WHERE tenant_id = :t AND status = 'ACTIVE' ORDER BY name`);
  const seen = new Set<string>();
  for (const r of rows) if (!seen.has(r.category)) { seen.add(r.category); out[r.category] = r.color; }
  return out;
}
/** Colours a shift's activities (and the shift's own "work" block) the same way the admin screens do -- resolved
 * server-side so the portal never needs its own read access to the activities config. */
function colorShift<T extends { activities: { type: string }[] }>(shift: T, colors: Record<string, string>) {
  return { ...shift, color: colors.WORK, activities: shift.activities.map((a) => ({ ...a, color: colors[a.type] ?? '#E9E9E4' })) };
}

export async function myShifts(tx: Tx, employeeId: string, from: string, to: string) {
  return (await tx.q<any>(
    `SELECT s.id, s.day::text AS day, s.start_slot, s.length_slots, s.activities, s.version_id, t.name AS template_name, coalesce(t.meal_slots, 0) AS meal_slots, v.name AS version_name
     FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id LEFT JOIN shift_templates t ON t.id = s.template_id
     WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND s.employee_id = $1 AND s.day >= $2::date AND s.day <= $3::date ORDER BY s.day, s.start_slot`, [employeeId, from, to])).map(shiftDto);
}

// ---------------------------------------------------------------- profile, schedule, home

selfService.get('/profile', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const skills = await tx.q<any>('SELECT s.name, es.proficiency FROM employee_skills es JOIN skills s ON s.id = es.skill_id WHERE es.tenant_id = :t AND es.employee_id = $1 ORDER BY s.name', [w.employeeId]);
    const e = w.emp;
    return { employeeId: e.id, name: `${e.firstName} ${e.lastName}`, employeeNumber: e.employeeNumber, email: e.email, phone: e.phone, extension: e.extension, team: e.teamName, group: w.group?.name ?? null, timezone: w.tz,
      employmentType: e.employmentType, weeklyContractHours: Number(e.weeklyContractHours), nightShiftConsent: e.nightShiftConsent, skills: skills.map((s) => ({ name: s.name, proficiency: s.proficiency })), today: w.today };
  }));
});

/** Manually typed change of your own password -- requires the current one, unlike the admin-triggered reset above. */
selfService.put('/change-password', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10).max(100) }), req.body);
  await withTenant(p.tenantId, async (tx) => {
    const u = await tx.one<any>('SELECT id, password_hash FROM users WHERE tenant_id = :t AND id = $1', [p.userId]);
    if (!u || !(await bcrypt.compare(b.currentPassword, u.passwordHash))) throw bad('Current password is incorrect.');
    if (b.currentPassword === b.newPassword) throw bad('Choose a password different from your current one.');
    await tx.exec('UPDATE users SET password_hash = $2 WHERE tenant_id = :t AND id = $1', [p.userId, await bcrypt.hash(b.newPassword, 12)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: p.userId, entityName: p.username, diffSummary: 'Changed their own password' });
  });
  res.json({ ok: true });
});

selfService.get('/schedule', requires('self:use'), async (req, res) => {
  const p = me(req);
  const q = parse(z.object({ from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional() }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const from = q.from ?? w.today, to = q.to ?? addDays(from, 27);
    if (to < from || days(from, to).length >= 400) throw bad('Ask for at most about a year at a time');
    const colors = await categoryColors(tx);
    const shifts = (await myShifts(tx, w.employeeId, from, to)).map((s) => colorShift(s, colors));
    const pub = await publishedDays(tx, w.emp.eligibleGroupIds ?? [], from, to);
    const off = await tx.q<any>(`SELECT id, type, start_day::text AS start_day, end_day::text AS end_day, status FROM time_off WHERE tenant_id = :t AND employee_id = $1 AND status IN ('REQUESTED','APPROVED') AND end_day >= $2::date AND start_day <= $3::date`, [w.employeeId, from, to]);
    const swaps = await tx.q<any>(
      `SELECT sw.id, sw.status, sw.kind, s.day::text AS day FROM shift_swaps sw JOIN schedule_shifts s ON s.id = sw.requester_shift_id
       WHERE sw.tenant_id = :t AND sw.requester_id = $1 AND sw.status IN ('OPEN','PENDING_PARTNER','PENDING_APPROVAL') AND s.day >= $2::date AND s.day <= $3::date`, [w.employeeId, from, to]);
    return { from, to, today: w.today, timezone: w.tz, days: days(from, to).map((day) => ({
      day, shift: shifts.find((s) => s.day === day) ?? null, published: pub.has(day),
      timeOff: off.filter((o) => o.startDay <= day && o.endDay >= day).map((o) => ({ id: o.id, type: o.type, status: o.status }))[0] ?? null,
      swap: swaps.filter((s) => s.day === day).map((s) => ({ id: s.id, status: s.status, kind: s.kind }))[0] ?? null })) };
  }));
});

selfService.get('/home', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const colors = await categoryColors(tx);
    const upcoming = (await myShifts(tx, w.employeeId, w.today, addDays(w.today, 45))).map((s) => colorShift(s, colors));
    const dow = (new Date(`${w.today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    const monday = addDays(w.today, -dow), sunday = addDays(monday, 6);
    const weekShifts = await myShifts(tx, w.employeeId, monday, sunday);
    const weekHours = Math.round(weekShifts.reduce((n, s) => n + s.paidHours, 0) * 10) / 10;
    const unread = (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = :t AND user_id = $1 AND read_at IS NULL', [p.userId]))!.n;
    const pendingTimeOff = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM time_off WHERE tenant_id = :t AND employee_id = $1 AND status = 'REQUESTED'`, [w.employeeId]))!.n;
    const swaps = await tx.one<any>(
      `SELECT count(*) FILTER (WHERE partner_id = $1 AND status = 'PENDING_PARTNER')::int AS incoming, count(*) FILTER (WHERE requester_id = $1 AND status IN ('OPEN','PENDING_PARTNER','PENDING_APPROVAL'))::int AS mine
       FROM shift_swaps WHERE tenant_id = :t`, [w.employeeId]);
    const board = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM shift_swaps sw JOIN employees e ON e.id = sw.requester_id WHERE sw.tenant_id = :t AND sw.status = 'OPEN' AND sw.requester_id <> $1 AND (sw.expires_at IS NULL OR sw.expires_at > now()) AND e.primary_group_id IS NOT DISTINCT FROM $2`, [w.employeeId, w.emp.primaryGroupId]))!.n;
    const offersOpen = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM offer_invites i JOIN offers o ON o.id = i.offer_id WHERE i.tenant_id = :t AND i.employee_id = $1 AND i.status = 'INVITED' AND o.status = 'OPEN' AND o.closes_at > now()`, [w.employeeId]))!.n;
    const publishedToday = (await publishedDays(tx, w.emp.eligibleGroupIds ?? [], w.today, w.today)).has(w.today);
    return { name: `${w.emp.firstName} ${w.emp.lastName}`, today: w.today, timezone: w.tz, todayShift: upcoming.find((s) => s.day === w.today) ?? null, nextShift: upcoming.find((s) => s.day > w.today) ?? null,
      publishedToday, weekHours, unreadNotifications: unread, pendingTimeOff, swapsIncoming: swaps?.incoming ?? 0, swapsMine: swaps?.mine ?? 0, boardOpen: board, offersOpen };
  }));
});

// ---------------------------------------------------------------- time off

const yearOf = (day: string) => day.slice(0, 4);
async function balances(tx: Tx, employeeId: string, pol: Policy, year: string) {
  const rows = await tx.q<any>(
    `SELECT type, sum(LEAST(end_day, $3::date) - GREATEST(start_day, $2::date) + 1)::int AS days FROM time_off
     WHERE tenant_id = :t AND employee_id = $1 AND status IN ('REQUESTED','APPROVED') AND end_day >= $2::date AND start_day <= $3::date GROUP BY type`, [employeeId, `${year}-01-01`, `${year}-12-31`]);
  const used = new Map(rows.map((r) => [r.type, r.days as number]));
  return Object.entries(pol.entitlements).map(([type, entitled]) => ({ type, entitledDays: entitled, usedDays: used.get(type) ?? 0, remainingDays: Math.max(0, entitled - (used.get(type) ?? 0)) }));
}

const toDto = (t: any) => ({ id: t.id, type: t.type, startDate: t.startDay, endDate: t.endDay, days: t.days, status: t.status, reason: t.reason, decidedBy: t.decidedBy, decidedAt: t.decidedAt, autoDecided: t.autoDecided, decisionNote: t.decisionNote, createdAt: t.createdAt });
const OWN_SQL = `SELECT o.*, o.start_day::text AS start_day, o.end_day::text AS end_day, (o.end_day - o.start_day + 1) AS days FROM time_off o WHERE o.tenant_id = :t AND o.employee_id = $1`;

selfService.get('/time-off', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p), pol = await loadSelfPolicy(tx);
    const rows = await tx.q<any>(`${OWN_SQL} ORDER BY o.start_day DESC LIMIT 100`, [w.employeeId]);
    return { requests: rows.map(toDto), balances: await balances(tx, w.employeeId, pol, yearOf(w.today)), rules: { autoApprove: pol.timeOffAutoApprove, minNoticeDays: pol.timeOffMinNoticeDays, maxOffPercent: pol.timeOffMaxOffPercent }, today: w.today };
  }));
});

/** Decide whether a request can be approved on the spot. Blockers refuse it outright; reasons send it to a manager. */
async function assessTimeOff(tx: Tx, w: Me, pol: Policy, b: { type: string; startDate: string; endDate: string }) {
  const blockers: string[] = [], reasons: string[] = [];
  const n = days(b.startDate, b.endDate).length;
  if (b.endDate < b.startDate) blockers.push('The end date is before the start date.');
  if (n > 90) blockers.push('Ask for at most 90 days at a time.');
  if (b.startDate < w.today && b.type !== 'SICK') blockers.push('That date has already passed. Only sick leave can be recorded after the fact.');
  const overlap = await tx.one<any>(`SELECT type, start_day::text AS s, end_day::text AS e FROM time_off WHERE tenant_id = :t AND employee_id = $1 AND status IN ('REQUESTED','APPROVED') AND end_day >= $2::date AND start_day <= $3::date LIMIT 1`, [w.employeeId, b.startDate, b.endDate]);
  if (overlap) blockers.push(`You already have ${overlap.type.toLowerCase()} time off from ${overlap.s} to ${overlap.e} that overlaps these dates.`);
  if (blockers.length) return { blockers, reasons, auto: false, n };

  const sick = b.type === 'SICK';
  if (!pol.timeOffAutoApprove) reasons.push('Requests are approved by a manager.');
  const ahead = Math.round((Date.parse(b.startDate) - Date.parse(w.today)) / 864e5);
  if (!sick && ahead < pol.timeOffMinNoticeDays) reasons.push(`It is only ${Math.max(0, ahead)} day${ahead === 1 ? '' : 's'} away; the rule asks for ${pol.timeOffMinNoticeDays} days' notice.`);
  const ent = pol.entitlements[b.type];
  if (ent !== undefined) {
    const bal = (await balances(tx, w.employeeId, pol, yearOf(b.startDate))).find((x) => x.type === b.type);
    if (bal && n > bal.remainingDays) reasons.push(`You have ${bal.remainingDays} ${b.type.toLowerCase()} day${bal.remainingDays === 1 ? '' : 's'} left and this asks for ${n}.`);
  }
  const scheduled = (await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND s.employee_id = $1 AND s.day >= $2::date AND s.day <= $3::date`, [w.employeeId, b.startDate, b.endDate]))!.n;
  if (scheduled > 0) reasons.push(`You are scheduled to work on ${scheduled} of these days, so a manager has to take you off the schedule.`);
  if (!sick && w.emp.primaryGroupId && n <= 60) {
    const size = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND status = 'ACTIVE' AND primary_group_id = $1`, [w.emp.primaryGroupId]))!.n;
    const cap = Math.max(1, Math.floor((size * pol.timeOffMaxOffPercent) / 100));
    const off = await tx.q<any>(
      `SELECT d::date::text AS day, count(DISTINCT o.employee_id)::int AS n FROM generate_series($2::date, $3::date, interval '1 day') d
       JOIN time_off o ON o.tenant_id = :t AND o.status = 'APPROVED' AND o.start_day <= d::date AND o.end_day >= d::date
       JOIN employees e ON e.id = o.employee_id AND e.primary_group_id = $1 AND e.id <> $4 GROUP BY d`, [w.emp.primaryGroupId, b.startDate, b.endDate, w.employeeId]);
    const full = off.find((r) => r.n + 1 > cap);
    if (full) reasons.push(`Too many colleagues are already off on ${full.day} (${full.n} of at most ${cap} in your group).`);
  }
  return { blockers, reasons, auto: reasons.length === 0, n };
}

selfService.post('/time-off/check', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ type: z.enum(TYPES), startDate: z.string().regex(isoDay), endDate: z.string().regex(isoDay) }), req.body);
  res.json(await withTenant(p.tenantId, async (tx) => { const w = await whoAmI(tx, p), a = await assessTimeOff(tx, w, await loadSelfPolicy(tx), b); return { days: a.n, blockers: a.blockers, willBeApprovedAutomatically: a.auto, reasonsForReview: a.reasons }; }));
});

selfService.post('/time-off', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ type: z.enum(TYPES), startDate: z.string().regex(isoDay), endDate: z.string().regex(isoDay), reason: z.string().max(300).default('') }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p), pol = await loadSelfPolicy(tx), a = await assessTimeOff(tx, w, pol, b);
    if (a.blockers.length) throw bad(a.blockers.join(' '));
    const status = a.auto ? 'APPROVED' : 'REQUESTED';
    const id = (await tx.one<{ id: string }>(
      `INSERT INTO time_off (tenant_id, employee_id, type, start_day, end_day, reason, status, decided_by, decided_at, source, auto_decided, decision_note)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, 'SELF', $9, $10) RETURNING id`,
      [w.employeeId, b.type, b.startDate, b.endDate, b.reason, status, a.auto ? 'Automatic approval' : null, a.auto ? new Date().toISOString() : null, a.auto, a.auto ? 'Within the notice, balance and cover rules' : a.reasons.join(' ')]))!.id;
    const row = (await tx.q<any>(`${OWN_SQL} AND o.id = $2`, [w.employeeId, id]))[0];
    await audit(tx, p, req, { action: 'CREATE', entityType: 'TIME_OFF', entityId: id, entityName: `${w.emp.firstName} ${w.emp.lastName}`, reason: b.reason || undefined, after: { ...toDto(row), source: 'SELF' }, diffSummary: `${b.type.toLowerCase()} ${b.startDate} to ${b.endDate}: ${a.auto ? 'approved automatically' : 'sent for approval'}` });
    if (!a.auto) {
      const managers = (await tx.q<{ id: string }>(`SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role IN ('WFM_ADMIN', 'WFM_MANAGER', 'SCHEDULER')`)).map((r) => r.id);
      await notify(tx, managers, { kind: 'TIME_OFF', title: 'Time off request', body: `${w.emp.firstName} ${w.emp.lastName}: ${b.type.toLowerCase()} ${b.startDate} to ${b.endDate}`, data: { screen: 'time-off', id } });
    }
    return { request: toDto(row), decision: { automatic: a.auto, reasons: a.reasons } };
  });
  if (out.request.status === 'APPROVED') await dropCache(p.tenantId, 'sched:*');
  res.status(201).json(out);
});

selfService.post('/time-off/:id/cancel', requires('self:use'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const cur = (await tx.q<any>(`${OWN_SQL} AND o.id = $2`, [w.employeeId, id]))[0];
    if (!cur) throw notFound('Time-off request');
    if (cur.status === 'CANCELLED' || cur.status === 'REJECTED') throw conflict(`This request is already ${cur.status.toLowerCase()}.`);
    if (cur.status === 'APPROVED' && cur.startDay <= w.today) throw conflict('Approved time off that has started cannot be cancelled here. Ask your manager.');
    await tx.exec(`UPDATE time_off SET status = 'CANCELLED', decided_by = $2, decided_at = now() WHERE tenant_id = :t AND id = $1`, [id, `${w.emp.firstName} ${w.emp.lastName}`]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'TIME_OFF', entityId: id, entityName: `${w.emp.firstName} ${w.emp.lastName}`, before: { status: cur.status }, after: { status: 'CANCELLED' }, diffSummary: 'cancelled by the employee' });
    return toDto((await tx.q<any>(`${OWN_SQL} AND o.id = $2`, [w.employeeId, id]))[0]);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json(out);
});

// ---------------------------------------------------------------- availability

const availDto = (a: any) => ({ dayOfWeek: a.dayOfWeek, startTime: hhmm(a.startSlot), endTime: a.endSlot >= 96 ? '24:00' : hhmm(a.endSlot), kind: a.kind });
selfService.get('/availability', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p), pol = await loadSelfPolicy(tx);
    const rows = await tx.q<any>('SELECT day_of_week, start_slot, end_slot, kind FROM availability WHERE tenant_id = :t AND employee_id = $1 ORDER BY day_of_week, start_slot', [w.employeeId]);
    return { windows: rows.map(availDto), canSetHardLimits: pol.agentCanEditAvailability };
  }));
});
selfService.put('/availability', requires('self:use'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ windows: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), startTime: z.string(), endTime: z.string(), kind: z.enum(['AVAILABLE', 'UNAVAILABLE', 'PREFERRED']) })).max(40) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p), pol = await loadSelfPolicy(tx);
    const list = b.windows.map((x) => ({ ...x, s: slotOf(x.startTime), e: x.endTime === '24:00' ? 96 : slotOf(x.endTime) }));
    for (const x of list) if (Number.isNaN(x.s) || Number.isNaN(x.e) || x.e <= x.s) throw bad(`${x.startTime} to ${x.endTime}: the end must be after the start (HH:MM).`);
    if (!pol.agentCanEditAvailability && list.some((x) => x.kind !== 'PREFERRED')) throw bad('You can add preferred hours. Hours you cannot work are set by your manager.');
    // without the right to set hard limits, only the person's own PREFERRED windows are replaced; limits set by a manager stay
    await tx.exec(pol.agentCanEditAvailability ? 'DELETE FROM availability WHERE tenant_id = :t AND employee_id = $1' : `DELETE FROM availability WHERE tenant_id = :t AND employee_id = $1 AND kind = 'PREFERRED'`, [w.employeeId]);
    for (const x of list) await tx.exec('INSERT INTO availability (tenant_id, employee_id, day_of_week, start_slot, end_slot, kind) VALUES (:t, $1, $2, $3, $4, $5)', [w.employeeId, x.dayOfWeek, x.s, x.e, x.kind]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'AVAILABILITY', entityId: w.employeeId, entityName: `${w.emp.firstName} ${w.emp.lastName}`, after: list.map((x) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][x.dayOfWeek]} ${x.startTime}-${x.endTime} ${x.kind}`), diffSummary: 'changed by the employee' });
    return (await tx.q<any>('SELECT day_of_week, start_slot, end_slot, kind FROM availability WHERE tenant_id = :t AND employee_id = $1 ORDER BY day_of_week, start_slot', [w.employeeId])).map(availDto);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json({ windows: out });
});

// ---------------------------------------------------------------- inbox and devices

const noteDto = (n: any) => ({ id: Number(n.id), kind: n.kind, title: n.title, body: n.body, data: n.data, createdAt: n.createdAt, read: !!n.readAt });
selfService.get('/notifications', requires('self:use'), async (req, res) => {
  const p = me(req), q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(40), before: z.coerce.number().int().optional() }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const rows = await tx.q<any>('SELECT * FROM notifications WHERE tenant_id = :t AND user_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [p.userId, q.before ?? null, q.limit]);
    const unread = (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = :t AND user_id = $1 AND read_at IS NULL', [p.userId]))!.n;
    return { unread, items: rows.map(noteDto) };
  }));
});
selfService.post('/notifications/read', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ ids: z.array(z.number().int()).max(200).optional() }), req.body);
  await withTenant(p.tenantId, (tx) => tx.exec('UPDATE notifications SET read_at = now() WHERE tenant_id = :t AND user_id = $1 AND read_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))', [p.userId, b.ids ?? null]));
  res.json({ ok: true });
});
selfService.post('/push-token', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ token: z.string().min(10).max(300), platform: z.string().max(20).default('unknown') }), req.body);
  await withTenant(p.tenantId, (tx) => tx.exec(
    `INSERT INTO push_tokens (tenant_id, user_id, token, platform) VALUES (:t, $1, $2, $3) ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, tenant_id = EXCLUDED.tenant_id, platform = EXCLUDED.platform, updated_at = now()`, [p.userId, b.token, b.platform]));
  res.json({ ok: true });
});
selfService.delete('/push-token', requires('self:use'), async (req, res) => {
  const p = me(req), token = String(req.query.token ?? '');
  await withTenant(p.tenantId, (tx) => tx.exec('DELETE FROM push_tokens WHERE tenant_id = :t AND user_id = $1 AND token = $2', [p.userId, token]));
  res.json({ ok: true });
});

export { usersOf };
