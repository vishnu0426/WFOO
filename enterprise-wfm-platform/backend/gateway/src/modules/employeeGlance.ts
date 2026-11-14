/**
 * GET /workforce/employees/:id/glance : "where is this person this week, and are they OK?" in one call, for the employee side panel.
 *
 * This week's shifts (from the published schedule, with the meal taken out of paid time), time off, today's status against the schedule (the same judgement the Adherence screen
 * uses), adherence over the last seven finished days (minutes over minutes), and leave balances (the same figures the person sees in the app). The arithmetic is in the pure
 * functions at the top, with tests.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me, requires } from '../auth.ts';
import { notFound, parse } from '../http.ts';
import { teamLimit } from './approvals.ts';
import { loadEmployees } from './workforceRoutes.ts';
import { balances, loadSelfPolicy } from './selfService.ts';
import { loadGroup, todayIn, addDays } from './forecast/service.ts';
import { payWeekFor } from './payWeek.ts';
import { weekOf } from './forecast/accuracyTrend.ts';
import { adherenceFor } from './intradayRoutes.ts';
import { groupAdherencePercent, round1 } from './overviewMath.ts';

export const glance = Router();
const SPD = 96;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface Activity { type: string; startSlot: number; slots: number }

/** Paid quarter hours of a shift: its length less an unpaid meal or split-shift gap (a paid meal stays in). */
export function paidSlotsOf(lengthSlots: number, activities: Activity[] | null | undefined, mealPaid: boolean): number {
  const unpaid = (activities ?? []).filter((a) => a.type === 'SPLIT_GAP' || (a.type === 'MEAL' && !mealPaid)).reduce((n, a) => n + a.slots, 0);
  return Math.max(0, lengthSlots - unpaid);
}

const hhmm = (slot: number) => `${String(Math.floor(((slot % SPD) * 15) / 60)).padStart(2, '0')}:${String(((slot % SPD) * 15) % 60).padStart(2, '0')}`;

export interface WeekShift { day: string; startSlot: number; lengthSlots: number; activities: Activity[] | null; mealPaid: boolean; scheduleName: string; groupName: string | null }
export interface WeekLeave { type: string; startDay: string; endDay: string; status: string }

/** The seven days of the pay week with what the person has on each, and the week's paid hours against their contract. */
export function weekView(from: string, shifts: WeekShift[], leave: WeekLeave[], contractHours: number, maxHours: number) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  let paid = 0;
  const rows = days.map((day, i) => {
    const s = shifts.find((x) => x.day === day) ?? null;
    const off = leave.find((l) => l.startDay <= day && day <= l.endDay) ?? null;
    const p = s ? paidSlotsOf(s.lengthSlots, s.activities, s.mealPaid) : 0;
    paid += p;
    return {
      day, name: DAY_NAMES[(new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7], shift: s ? { start: hhmm(s.startSlot), end: hhmm(s.startSlot + s.lengthSlots), overnight: s.startSlot + s.lengthSlots > SPD, paidHours: p / 4, scheduleName: s.scheduleName, groupName: s.groupName } : null,
      timeOff: off ? { type: off.type, status: off.status } : null,
    };
  });
  const paidHours = paid / 4;
  return { days: rows, paidHours: round1(paidHours), contractHours, maxHours, overMax: maxHours > 0 && paidHours > maxHours + 1e-9, belowContract: contractHours > 0 && paidHours + 1e-9 < contractHours };
}

glance.get('/employees/:id/glance', requires('workforce:read'), async (req, res) => {
  const p = me(req), id = parse(z.string().uuid(), req.params.id);
  const base = await withTenant(p.tenantId, async (tx) => {
    const lim = await teamLimit(tx, p);
    const [e] = await loadEmployees(tx, { id, ...(lim ? { scopeTeamIds: lim.teamIds, scopeSelf: lim.self } : {}) });
    if (!e) throw notFound('Employee');
    const group = e.primaryGroupId ? await loadGroup(tx, e.primaryGroupId) : null;
    const today: string = todayIn(group?.timezone ?? 'UTC');
    const weekStart = (await payWeekFor(tx, e.primaryGroupId ?? null)).start;
    const from = weekOf(today, weekStart), to = addDays(from, 6);
    const shifts = await tx.q<any>(
      `SELECT s.day::text AS day, s.start_slot, s.length_slots, s.activities, coalesce(t.meal_paid, false) AS meal_paid, v.name AS schedule_name, g.name AS group_name
       FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id LEFT JOIN shift_templates t ON t.id = s.template_id LEFT JOIN wfm_groups g ON g.id = v.wfm_group_id
       WHERE s.tenant_id = :t AND s.employee_id = $1 AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.day BETWEEN $2::date AND $3::date ORDER BY s.day`, [id, from, to]);
    const leave = await tx.q<any>(
      `SELECT type, start_day::text AS start_day, end_day::text AS end_day, status FROM time_off WHERE tenant_id = :t AND employee_id = $1 AND status IN ('REQUESTED','APPROVED') AND end_day >= $2::date AND start_day <= $3::date ORDER BY start_day`,
      [id, from, addDays(today, 30)]);
    const hist = await tx.one<{ sched: number | null; adh: number | null; days: number }>(
      `SELECT sum(scheduled_min)::int AS sched, sum(adherent_min)::int AS adh, count(*)::int AS days FROM adherence_daily WHERE tenant_id = :t AND employee_id = $1 AND day >= $2::date AND day < $3::date`, [id, addDays(today, -7), today]);
    const bal = await balances(tx, id, await loadSelfPolicy(tx), today.slice(0, 4), Number(today.slice(5, 7)));
    return { e, group, today, from, to, shifts, leave, hist, bal };
  });
  const { e, group, today, from, to } = base;
  const week = weekView(from, base.shifts.map((s: any) => ({ day: s.day, startSlot: s.startSlot, lengthSlots: s.lengthSlots, activities: s.activities, mealPaid: !!s.mealPaid, scheduleName: s.scheduleName, groupName: s.groupName })),
    base.leave.map((l: any) => ({ type: l.type, startDay: l.startDay, endDay: l.endDay, status: l.status })), Number(e.weeklyContractHours), Number(e.maxWeeklyHours));
  const row = group ? await adherenceFor(p.tenantId, group.id, today, id).catch(() => null) : null;
  const sched = base.hist?.sched ?? 0, adh = base.hist?.adh ?? 0;
  res.json({
    employeeId: id, today, week: { from, to, ...week },
    now: row ? { status: row.status, scheduled: row.scheduled, actual: row.actual, state: row.state ?? null, outMinutes: row.outMinutes, shift: row.shift ?? null, dayPercent: row.dayPercent } : null,
    adherenceLast7: sched > 0 ? { percent: groupAdherencePercent([{ scheduledMin: sched, adherentMin: adh }]), scheduledMin: sched, adherentMin: adh, days: base.hist?.days ?? 0 } : null,
    balances: base.bal, upcomingTimeOff: base.leave.map((l: any) => ({ type: l.type, startDay: l.startDay, endDay: l.endDay, status: l.status })).filter((l: WeekLeave) => l.endDay >= today),
  });
});
