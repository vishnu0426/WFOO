/**
 * Scheduling: shift templates, schedule generation with the CP-SAT engine, validation, coverage, publish and compare.
 *
 * Requirement: the published short-term forecast's "agents on schedule" per 15 minutes. It already includes shrinkage
 * (breaks, meals, absence), so coverage counts everyone on shift. Meals and breaks are then placed inside each shift,
 * staggered to keep the number of people off the phones as even as possible.
 * The hard rules are checked twice: the engine cannot break them, and validate() re-checks the stored result independently.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache, engine, publish } from '../infra.ts';
import { addDays, dayRange, loadGroup, versionRecords, todayIn, synthesizeLongRangeRequirement } from './forecast/service.ts';
import { hhmm } from './workforceRoutes.ts';
import { loadPolicy } from './policyRoutes.ts';
import { loadRuleSets, type RuleSets } from './compliance/routes.ts';
import { checkPerson, limitsFrom, premiumHours, shiftBlocked } from './compliance/rules.ts';

export const scheduling = Router();
const uuid = z.string().uuid();
const SPD = 96;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
export const dowOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }; // Monday = 0
const mondayOf = (day: string) => addDays(day, -dowOf(day));
const slotOf = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Math.min(95, Math.floor((+m[1] * 60 + +m[2]) / 15)) : NaN; };

// ---------------------------------------------------------------- shift templates

const tplDto = (t: any) => ({
  id: t.id, name: t.name, code: t.code, description: t.description, status: t.status, workDays: t.workDays,
  earliestStart: hhmm(t.earliestStart), latestStart: hhmm(t.latestStart), startStepMinutes: t.startStep * 15,
  durationHours: t.lengthSlots / 4, mealMinutes: t.mealSlots * 15, breakCount: t.breakCount, breakMinutes: t.breakSlots * 15, flexMinutes: t.flexSlots * 15,
  paidHours: (t.lengthSlots - t.mealSlots) / 4, version: t.version,
  mealAnchorMinutes: t.mealAnchorSlot != null ? t.mealAnchorSlot * 15 : null,
  breakAnchorMinutes: t.breakAnchorSlots ? (t.breakAnchorSlots as (number | null)[]).map((s) => (s != null ? s * 15 : null)) : null,
});
const TplBody = z.object({
  name: z.string().trim().min(1).max(80), code: z.string().trim().min(1).max(30).optional(), description: z.string().max(300).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7), earliestStart: z.string(), latestStart: z.string(), startStepMinutes: z.number().int().refine((v) => v % 15 === 0 && v >= 15 && v <= 240, 'must be 15 to 240 in steps of 15').optional(),
  durationHours: z.number().min(1).max(14), mealMinutes: z.number().int().min(0).max(120).optional(), breakCount: z.number().int().min(0).max(4).optional(),
  breakMinutes: z.number().int().min(15).max(60).optional(), flexMinutes: z.number().int().min(0).max(120).optional(),
  // where the admin dragged Meal/each Break onto the shift timeline; null (the default) leaves that one to placeActivities()'s own auto-centering
  mealAnchorMinutes: z.number().int().min(0).nullable().optional(),
  breakAnchorMinutes: z.array(z.number().int().min(0).nullable()).max(4).nullable().optional(),
});
const toSlots = (b: z.infer<typeof TplBody>) => {
  const e = slotOf(b.earliestStart), l = slotOf(b.latestStart);
  if (Number.isNaN(e) || Number.isNaN(l)) throw bad('Start times must look like 08:30');
  if (l < e) throw bad('The latest start cannot be before the earliest start');
  const len = Math.round(b.durationHours * 4), meal = Math.round((b.mealMinutes ?? 30) / 15);
  if (meal >= len - 2) throw bad('The meal is too long for this shift');
  const breaks = b.breakCount ?? 2, brk = Math.round((b.breakMinutes ?? 15) / 15);
  const mealAnchor = b.mealAnchorMinutes != null ? Math.round(b.mealAnchorMinutes / 15) : null;
  if (mealAnchor != null && (mealAnchor < 1 || mealAnchor + meal >= len)) throw bad('The meal was dropped outside the shift');
  const breakAnchors = b.breakAnchorMinutes ? b.breakAnchorMinutes.slice(0, breaks).map((m) => (m != null ? Math.round(m / 15) : null)) : null;
  if (breakAnchors) for (const a of breakAnchors) if (a != null && (a < 1 || a + brk >= len)) throw bad('A break was dropped outside the shift');
  return { e, l, step: Math.round((b.startStepMinutes ?? 30) / 15), len, meal, breaks, brk, flex: Math.round((b.flexMinutes ?? 30) / 15), mealAnchor, breakAnchors };
};

scheduling.get('/templates', requires('schedule:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t ORDER BY earliest_start, name'))).map(tplDto));
});
scheduling.post('/templates', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(TplBody, req.body), s = toSlots(b);
  const out = await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>(
      `INSERT INTO shift_templates (tenant_id, name, code, description, work_days, earliest_start, latest_start, start_step, length_slots, meal_slots, break_count, break_slots, flex_slots, meal_anchor_slot, break_anchor_slots)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [b.name, b.code ?? b.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 30), b.description ?? '', [...new Set(b.workDays)].sort(), s.e, s.l, s.step, s.len, s.meal, s.breaks, s.brk, s.flex, s.mealAnchor, s.breakAnchors]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SHIFT_TEMPLATE', entityId: t!.id, entityName: b.name, after: tplDto(t) });
    return tplDto(t);
  });
  res.status(201).json(out);
});
scheduling.put('/templates/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(TplBody, req.body), s = toSlots(b);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM shift_templates WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Shift template');
    const t = await tx.one<any>(
      `UPDATE shift_templates SET name = $2, description = $3, status = coalesce($4, status), work_days = $5, earliest_start = $6, latest_start = $7, start_step = $8, length_slots = $9,
         meal_slots = $10, break_count = $11, break_slots = $12, flex_slots = $13, meal_anchor_slot = $14, break_anchor_slots = $15, version = version + 1 WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name, b.description ?? '', b.status ?? null, [...new Set(b.workDays)].sort(), s.e, s.l, s.step, s.len, s.meal, s.breaks, s.brk, s.flex, s.mealAnchor, s.breakAnchors]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SHIFT_TEMPLATE', entityId: id, entityName: b.name, before: tplDto(before), after: tplDto(t) });
    return tplDto(t);
  });
  res.json(out);
});
scheduling.delete('/templates/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>('SELECT * FROM shift_templates WHERE tenant_id = :t AND id = $1', [id]);
    if (!t) throw notFound('Shift template');
    const [{ n }] = await tx.q<{ n: number }>(`SELECT count(*)::int AS n FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id WHERE s.tenant_id = :t AND s.template_id = $1 AND v.status = 'PUBLISHED'`, [id]);
    if (n > 0) throw conflict('A published schedule uses this template. Set it to inactive instead.');
    await tx.exec('DELETE FROM shift_templates WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'SHIFT_TEMPLATE', entityId: id, entityName: t.name, before: tplDto(t) });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- what the scheduler knows

export interface Ctx { group: any; employees: any[]; templates: any[]; timeOff: any[]; avail: any[]; tz: string; rules: RuleSets; skillBased: boolean; others: { employeeId: string; day: string; startSlot: number; lengthSlots: number; groupName: string }[] }

export async function loadCtx(tx: Tx, groupId: string, from: string, to: string): Promise<Ctx> {
  const group = await loadGroup(tx, groupId);
  const pol = await loadPolicy(tx);
  const rules = await loadRuleSets(tx, groupId);
  // company-wide scheduling policy and the compliance pack that applies to the person: the strictest of them and the employee's own contract wins
  const employees = (await tx.q<any>(
    // a group with required skills draws its pool from everyone who has them all at the required level, in any group; otherwise from its own and eligible people
    `SELECT e.* FROM employees e WHERE e.tenant_id = :t AND (
       (NOT EXISTS (SELECT 1 FROM group_skills gs WHERE gs.wfm_group_id = $1) AND (e.primary_group_id = $1 OR $1 = ANY(e.eligible_group_ids)))
       OR (EXISTS (SELECT 1 FROM group_skills gs WHERE gs.wfm_group_id = $1) AND NOT EXISTS (
             SELECT 1 FROM group_skills gs WHERE gs.wfm_group_id = $1 AND NOT EXISTS (SELECT 1 FROM employee_skills es WHERE es.employee_id = e.id AND es.skill_id = gs.skill_id AND es.proficiency >= gs.min_proficiency))))
     ORDER BY e.last_name, e.first_name, e.employee_number`, [groupId]))
    .map((e) => {
      const law = limitsFrom(rules.forTeam(e.teamId, e.id));
      return {
        ...e,
        minRestHours: Math.max(Number(e.minRestHours), pol.minRestHours ?? 0, law.minRestHours ?? 0),
        maxWeeklyHours: Math.min(Number(e.maxWeeklyHours), pol.maxWeeklyHours ?? Infinity, law.maxWeeklyHours ?? Infinity),
        maxConsecutiveDays: Math.min(e.maxConsecutiveDays, pol.maxConsecutiveDays ?? Infinity, law.maxConsecutiveDays ?? Infinity),
        workDaysPerWeek: Math.min(e.workDaysPerWeek, pol.maxDaysPerWeek ?? Infinity),
      };
    });
  const templates = await tx.q<any>(`SELECT * FROM shift_templates WHERE tenant_id = :t ORDER BY earliest_start, name`);
  const timeOff = await tx.q<any>(`SELECT employee_id, start_day::text AS start_day, end_day::text AS end_day FROM time_off WHERE tenant_id = :t AND status = 'APPROVED' AND end_day >= $1 AND start_day <= $2`, [from, to]);
  const avail = await tx.q<any>(`SELECT employee_id, day_of_week, start_slot, end_slot, kind, effective_from::text AS effective_from, effective_to::text AS effective_to FROM availability WHERE tenant_id = :t`);
  const skillBased = !!(await tx.one('SELECT 1 FROM group_skills WHERE tenant_id = :t AND wfm_group_id = $1 LIMIT 1', [groupId]));
  // what the same people are already doing for other groups: nobody can be in two places at once
  const others = await tx.q<any>(
    `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, g.name AS group_name FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id JOIN wfm_groups g ON g.id = v.wfm_group_id
     WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND v.wfm_group_id <> $1 AND s.day >= $2::date AND s.day <= $3::date`, [groupId, from, to]);
  return { group, employees, templates, timeOff, avail, tz: group.timezone, rules, skillBased, others };
}

const eligible = (e: any, groupId: string, skillBased = false) => e.status === 'ACTIVE' && (skillBased || e.primaryGroupId === groupId || (e.eligibleGroupIds ?? []).includes(groupId));

/** Why a person cannot work a shift starting at `start` (slot) for `len` slots on `day`, or null when they can. */
function blockedReason(ctx: Ctx, e: any, day: string, start: number, len: number): string | null {
  if (ctx.timeOff.some((o) => o.employeeId === e.id && o.startDay <= day && o.endDay >= day)) return 'has approved time off';
  const dow = dowOf(day);
  if (dow >= 5 && !e.allowWeekend) return 'does not work weekends';
  if (start + len > SPD && !e.allowOvernight) return 'is not allowed overnight shifts';
  const end = Math.min(SPD, start + len);
  const w = ctx.avail.filter((a) => a.employeeId === e.id && a.dayOfWeek === dow && (!a.effectiveFrom || a.effectiveFrom <= day) && (!a.effectiveTo || a.effectiveTo >= day));
  const open = w.filter((a) => a.kind === 'AVAILABLE');
  if (open.length && !open.some((a) => a.startSlot <= start && a.endSlot >= end)) return 'is outside their available hours';
  if (w.some((a) => a.kind === 'UNAVAILABLE' && a.startSlot < end && a.endSlot > start)) return 'is during a time they are unavailable';
  const clash = ctx.others.find((o) => o.employeeId === e.id && o.day === day && o.startSlot < start + len && o.startSlot + o.lengthSlots > start);
  if (clash) return `is already scheduled for ${clash.groupName} then`;
  return null;
}
function preferenceFor(ctx: Ctx, e: any, day: string, start: number, len: number): number {
  const dow = dowOf(day), end = Math.min(SPD, start + len);
  const pref = ctx.avail.filter((a) => a.employeeId === e.id && a.dayOfWeek === dow && a.kind === 'PREFERRED' && (!a.effectiveFrom || a.effectiveFrom <= day) && (!a.effectiveTo || a.effectiveTo >= day));
  const overlap = pref.reduce((s, a) => s + Math.max(0, Math.min(end, a.endSlot) - Math.max(start, a.startSlot)), 0);
  return overlap * 2 >= end - start && overlap > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- requirement from the published short-term forecast

/**
 * Requirement per day/slot, primarily from the published short-term forecast. Any requested day that forecast
 * doesn't reach is filled in, if possible, from a published long-term forecast's daily totals -- projected onto
 * intervals using the queue's own historical shape rather than a real interval forecast, so scheduling can reach
 * past the short-term forecast's horizon. Callers must surface `projected` as lower-confidence.
 */
export async function requirementFor(tenantId: string, groupId: string, days: string[], forecastId?: string) {
  const v = await withTenant(tenantId, (tx) => tx.one<any>(
    `SELECT * FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND ($2::uuid IS NULL OR id = $2) AND ($2::uuid IS NOT NULL OR status = 'PUBLISHED') ORDER BY seq DESC LIMIT 1`, [groupId, forecastId ?? null]));
  if (!v && forecastId) throw bad('That forecast was not found for this group');

  const idx = new Map(days.map((d, i) => [d, i]));
  const required = new Array(days.length * SPD).fill(0);
  const covered = new Set<string>();
  if (v) {
    const { records } = await versionRecords(tenantId, v);
    for (const r of records) { const i = idx.get(r.day); if (i !== undefined) { required[i * SPD + r.slot] = r.required; covered.add(r.day); } }
  }

  const projected = new Set<string>();
  const remaining = days.filter((d) => !covered.has(d));
  if (remaining.length) {
    const lv = await withTenant(tenantId, (tx) => tx.one<any>(
      `SELECT id, name FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'LONG' AND status = 'PUBLISHED' ORDER BY seq DESC LIMIT 1`, [groupId]));
    if (lv) {
      const { required: longReq, uncovered: longUncovered } = await synthesizeLongRangeRequirement(tenantId, groupId, lv.id, remaining);
      const longUncoveredSet = new Set(longUncovered);
      remaining.forEach((d, ri) => {
        if (longUncoveredSet.has(d)) return;
        const i = idx.get(d)!;
        for (let slot = 0; slot < SPD; slot++) required[i * SPD + slot] = longReq[ri * SPD + slot];
        covered.add(d); projected.add(d);
      });
    }
  }

  if (!covered.size) throw bad(v
    ? `The forecast "${v.name}" does not cover ${days[0]} to ${days.at(-1)} (it runs ${v.fromDay} to ${v.toDay}), and there is no published long-term forecast to project from either.`
    : 'There is no published short-term or long-term forecast for this group. Publish one under Forecasting first: the schedule is built to match it.');
  return { v, required, uncovered: days.filter((d) => !covered.has(d)), projected: [...projected] };
}

/**
 * Requirement from a manually set weekly coverage template instead of a forecast: a handful of recurring windows
 * (day of week, start/end time, headcount), expanded into the same per-slot array `requirementFor` produces --
 * taking the largest headcount across any windows that cover a slot, 0 where nothing covers it.
 */
export async function requirementForManual(tenantId: string, groupId: string, days: string[]) {
  const windows = await withTenant(tenantId, (tx) => tx.q<any>(
    'SELECT day_of_week, start_slot, end_slot, headcount FROM coverage_windows WHERE tenant_id = :t AND wfm_group_id = $1', [groupId]));
  if (!windows.length) throw bad('No coverage windows are set for this group. Add them under Configuration › WFM Groups before generating without a forecast.');
  const byDow = new Map<number, typeof windows>();
  for (const w of windows) byDow.set(w.dayOfWeek, [...(byDow.get(w.dayOfWeek) ?? []), w]);
  const required = new Array(days.length * SPD).fill(0);
  days.forEach((day, i) => {
    for (const w of byDow.get(dowOf(day)) ?? []) for (let slot = w.startSlot; slot < w.endSlot; slot++) required[i * SPD + slot] = Math.max(required[i * SPD + slot], w.headcount);
  });
  return { required, uncovered: [] as string[], projected: [] as string[] };
}

// ---------------------------------------------------------------- meals and breaks, staggered

export interface PlacedShift { employeeId: string; day: string; dayIdx: number; startSlot: number; length: number; template: any | null }

export function placeActivities(shifts: PlacedShift[], total: number): Map<PlacedShift, { type: 'MEAL' | 'BREAK'; startSlot: number; slots: number }[]> {
  const off = new Array(total + SPD * 2).fill(0);
  const out = new Map<PlacedShift, any[]>();
  const order = [...shifts].sort((a, b) => a.dayIdx - b.dayIdx || a.startSlot - b.startSlot || (a.employeeId < b.employeeId ? -1 : 1));
  for (const s of order) {
    const t = s.template, acts: any[] = [];
    out.set(s, acts);
    if (!t) continue;
    const base = s.dayIdx * SPD + s.startSlot, end = base + s.length;
    const taken = (a: number, n: number) => acts.some((x) => a < x.abs + x.slots && a + n > x.abs);
    const put = (type: 'MEAL' | 'BREAK', center: number, n: number, flex: number) => {
      let best = -1, bestCost = Infinity;
      for (let o = -flex; o <= flex; o++) {
        const a = center + o;
        if (a <= base || a + n >= end || taken(a, n)) continue;
        let cost = 0;
        for (let g = a; g < a + n; g++) cost += off[g] * off[g] + off[g];
        cost += Math.abs(o) * 0.01;
        if (cost < bestCost) { bestCost = cost; best = a; }
      }
      if (best < 0) return;
      for (let g = best; g < best + n; g++) off[g]++;
      acts.push({ type, abs: best, startSlot: best - s.dayIdx * SPD, slots: n });
    };
    // an admin-dragged anchor (from the shift template's timeline) becomes the center of the same flex-window
    // search below, in place of the auto-computed one -- the generator still nudges it to smooth coverage, it just
    // starts from where it was dropped instead of the middle of the shift.
    if (t.mealSlots > 0) put('MEAL', base + (t.mealAnchorSlot ?? Math.round((s.length - t.mealSlots) / 2)), t.mealSlots, t.flexSlots);
    for (let k = 1; k <= t.breakCount; k++) {
      const anchor = t.breakAnchorSlots?.[k - 1];
      put('BREAK', base + (anchor ?? Math.round((s.length * k) / (t.breakCount + 1)) - Math.floor(t.breakSlots / 2)), t.breakSlots, t.flexSlots);
    }
    acts.sort((a, b) => a.abs - b.abs);
  }
  for (const [k, v] of out) out.set(k, v.map(({ abs, ...rest }: any) => rest));
  return out;
}

// ---------------------------------------------------------------- validation (independent of the solver)

export interface ShiftRow { id?: string; employeeId: string; day: string; startSlot: number; lengthSlots: number; templateId: string | null; activities?: { type: string; slots: number }[] }
export function validateShifts(ctx: Ctx, shifts: ShiftRow[]) {
  const v: { type: string; employeeId: string; employeeName: string; day: string; message: string; severity?: 'BLOCK' | 'WARN' }[] = [];
  const byE = new Map<string, ShiftRow[]>();
  for (const s of shifts) byE.set(s.employeeId, [...(byE.get(s.employeeId) ?? []), s]);
  const tpl = new Map(ctx.templates.map((t) => [t.id, t]));
  const paid = (s: ShiftRow) => (s.lengthSlots - (tpl.get(s.templateId!)?.mealSlots ?? 0)) / 4;
  for (const [id, list] of byE) {
    const e = ctx.employees.find((x) => x.id === id);
    if (!e) { v.push({ type: 'ELIGIBILITY', employeeId: id, employeeName: 'Unknown', day: list[0].day, message: 'This person is not eligible for this WFM group' }); continue; }
    const name = `${e.firstName} ${e.lastName}`;
    const add = (type: string, day: string, message: string) => v.push({ type, employeeId: id, employeeName: name, day, message });
    if (!eligible(e, ctx.group.id, ctx.skillBased)) add('ELIGIBILITY', list[0].day, `${name} is ${e.status === 'ACTIVE' ? 'not eligible for this WFM group' : e.status.toLowerCase()}`);
    list.sort((a, b) => (a.day < b.day ? -1 : 1));
    const seen = new Set<string>();
    for (const s of list) {
      if (seen.has(s.day)) add('OVERLAP', s.day, `${name} has two shifts on ${s.day}`);
      seen.add(s.day);
      const why = blockedReason(ctx, e, s.day, s.startSlot, s.lengthSlots);
      if (why) add(why.includes('time off') ? 'TIME_OFF' : why.includes('already scheduled') ? 'DOUBLE_BOOKED' : why.includes('weekend') ? 'WEEKEND' : why.includes('overnight') ? 'OVERNIGHT' : 'AVAILABILITY', s.day, `${name} ${why} on ${s.day}`);
    }
    for (let i = 1; i < list.length; i++) {
      if (list[i].day === addDays(list[i - 1].day, 1)) {
        const gap = SPD + list[i].startSlot - (list[i - 1].startSlot + list[i - 1].lengthSlots);
        if (gap < e.minRestHours * 4) add('REST', list[i].day, `${name} has only ${r1(gap / 4)}h rest before ${list[i].day} (needs ${e.minRestHours}h)`);
      }
    }
    let run = 1;
    for (let i = 1; i < list.length; i++) {
      run = list[i].day === addDays(list[i - 1].day, 1) ? run + 1 : 1;
      if (run === e.maxConsecutiveDays + 1) add('CONSECUTIVE', list[i].day, `${name} works more than ${e.maxConsecutiveDays} days in a row`);
    }
    const weeks = new Map<string, { h: number; n: number }>();
    for (const s of list) { const k = mondayOf(s.day); const w = weeks.get(k) ?? { h: 0, n: 0 }; w.h += paid(s); w.n++; weeks.set(k, w); }
    for (const [wk, w] of weeks) {
      if (w.h > e.maxWeeklyHours + 1e-9) add('WEEKLY_MAX', wk, `${name} works ${r1(w.h)}h in the week of ${wk} (max ${e.maxWeeklyHours}h)`);
      if (w.n > e.workDaysPerWeek) add('DAYS_PER_WEEK', wk, `${name} works ${w.n} days in the week of ${wk} (max ${e.workDaysPerWeek})`);
    }
    // the labour-law pack that applies to this person. Rest, weekly hours and days in a row that a BLOCK rule sets are already part of the limits above.
    const lite = list.map((s) => ({ day: s.day, startSlot: s.startSlot, lengthSlots: s.lengthSlots, mealSlots: tpl.get(s.templateId!)?.mealSlots ?? 0 }));
    for (const f of checkPerson(ctx.rules.forTeam(e.teamId, id), { id, name, nightConsent: !!e.nightShiftConsent }, lite)) {
      if (f.severity === 'BLOCK' && ['MIN_DAILY_REST_HOURS', 'MAX_WEEKLY_HOURS', 'MAX_CONSECUTIVE_DAYS'].includes(f.rule)) continue;
      v.push({ type: `LAW_${f.rule}`, severity: f.severity, employeeId: id, employeeName: name, day: f.day, message: f.message });
    }
  }
  return v;
}

// ---------------------------------------------------------------- stats

export function computeStats(ctx: Ctx, days: string[], required: number[], shifts: ShiftRow[], solver: any, extra: any = {}) {
  const tpl = new Map(ctx.templates.map((t) => [t.id, t]));
  const sched = new Array(days.length * SPD).fill(0);
  const di = new Map(days.map((d, i) => [d, i]));
  let paidH = 0, overtimeH = 0;
  const wk = new Map<string, number>();
  for (const s of shifts) {
    const i = di.get(s.day); if (i === undefined) continue;
    for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++;
    const mealSlots = s.activities ? s.activities.filter((a) => a.type === 'MEAL').reduce((n, a) => n + a.slots, 0) : (tpl.get(s.templateId!)?.mealSlots ?? 0);
    const h = (s.lengthSlots - mealSlots) / 4;
    paidH += h; const k = `${s.employeeId}|${mondayOf(s.day)}`; wk.set(k, (wk.get(k) ?? 0) + h);
  }
  for (const [k, h] of wk) { const e = ctx.employees.find((x) => x.id === k.split('|')[0]); if (e && h > e.weeklyContractHours) overtimeH += h - e.weeklyContractHours; }
  let need = 0, under = 0, over = 0, underIntervals = 0, criticalIntervals = 0;
  for (let g = 0; g < sched.length; g++) {
    need += required[g];
    if (sched[g] < required[g]) { under += required[g] - sched[g]; underIntervals++; if (required[g] > 0 && sched[g] < required[g] * 0.8) criticalIntervals++; }
    else over += sched[g] - required[g];
  }
  const all = validateShifts(ctx, shifts);
  const violations = all.filter((x) => x.severity !== 'WARN');
  let premium = 0;
  const byPerson = new Map<string, ShiftRow[]>();
  for (const s of shifts) byPerson.set(s.employeeId, [...(byPerson.get(s.employeeId) ?? []), s]);
  for (const [id, list] of byPerson) {
    const e = ctx.employees.find((x) => x.id === id);
    if (e) premium += premiumHours(ctx.rules.forTeam(e.teamId, e.id), list.map((s) => ({ day: s.day, startSlot: s.startSlot, lengthSlots: s.lengthSlots, mealSlots: tpl.get(s.templateId!)?.mealSlots ?? 0 }))).hours;
  }
  return {
    solver, coverage: { percent: need ? r1((1 - under / need) * 100) : 100, requiredSlots: need, underSlots: under, overSlots: over, underIntervals, criticalIntervals },
    hours: { paid: r1(paidH), overtime: r1(overtimeH), required: r1(need / 4), premium: r1(premium) }, shifts: shifts.length, people: new Set(shifts.map((s) => s.employeeId)).size,
    violations: violations.length, warnings: all.length - violations.length, ...extra,
  };
}


/** One replay step: what changed and the measured result right after it. Runs in the caller's transaction where it can, so it commits with the change. */
export async function revision(tx: Tx, p: Principal, versionId: string, kind: 'GENERATE' | 'EDIT' | 'PUBLISH', summary: string, reason: string | null, st: any) {
  await tx.exec(
    `INSERT INTO schedule_revisions (tenant_id, version_id, n, actor_name, actor_role, kind, summary, reason, coverage, under_slots, overtime_h, paid_h, shifts, people, violations)
     VALUES (:t, $1, (SELECT coalesce(max(n), 0) + 1 FROM schedule_revisions WHERE tenant_id = :t AND version_id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [versionId, p.name, p.role, kind, summary, reason, st.coverage.percent, st.coverage.underSlots, st.hours.overtime, st.hours.paid, st.shifts, st.people, st.violations]);
}

// ---------------------------------------------------------------- generate

const Weights = z.object({ understaffing: z.number().int().min(0).max(100).default(90), overstaffing: z.number().int().min(0).max(100).default(30), contractHours: z.number().int().min(0).max(100).default(50), preferences: z.number().int().min(0).max(100).default(20), fairness: z.number().int().min(0).max(100).default(30) });
const GenBody = z.object({
  groupId: uuid, from: z.string().regex(isoDay), weeks: z.number().int().min(1).max(4).default(1), forecastVersionId: uuid.optional(), templateIds: z.array(uuid).optional(),
  employeeIds: z.array(uuid).optional(), teamIds: z.array(uuid).optional(), coverageSource: z.enum(['FORECAST', 'MANUAL']).default('FORECAST'),
  weights: Weights.default({ understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 20, fairness: 30 }), timeLimitSec: z.number().int().min(3).max(120).default(30), name: z.string().trim().max(100).optional(),
});

export const verDto = (v: any) => ({ id: v.id, seq: v.seq, wfmGroupId: v.wfmGroupId, groupName: v.groupName ?? null, name: v.name, status: v.status, kind: v.kind ?? 'DEMAND', coverageSource: v.coverageSource ?? 'FORECAST', periodStart: v.periodStart, periodEnd: v.periodEnd, forecastVersionId: v.forecastVersionId, forecastName: v.forecastName ?? null, rev: v.rev, hasChanges: v.status === 'PUBLISHED' && v.rev !== v.publishedRev, settings: v.settings, stats: v.stats, createdBy: v.createdBy, createdAt: v.createdAt, publishedBy: v.publishedBy, publishedAt: v.publishedAt });
const VER_SQL = `SELECT v.*, v.period_start::text AS period_start, v.period_end::text AS period_end, f.name AS forecast_name, g.name AS group_name FROM schedule_versions v LEFT JOIN forecast_versions f ON f.id = v.forecast_version_id LEFT JOIN wfm_groups g ON g.id = v.wfm_group_id WHERE v.tenant_id = :t`;

scheduling.get('/versions', requires('schedule:read'), async (req, res) => {
  const groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>(`${VER_SQL} AND ($1::uuid IS NULL OR v.wfm_group_id = $1) ORDER BY v.seq DESC LIMIT 100`, [groupId]))).map(verDto));
});

scheduling.post('/versions', requires('schedule:generate'), async (req, res) => {
  const p = me(req), b = parse(GenBody, req.body);
  const to = addDays(b.from, b.weeks * 7 - 1), days = dayRange(b.from, to);
  const ctx = await withTenant(p.tenantId, (tx) => loadCtx(tx, b.groupId, b.from, to));
  const templates = ctx.templates.filter((t) => t.status === 'ACTIVE' && (!b.templateIds || b.templateIds.includes(t.id)));
  if (!templates.length) throw bad('There are no active shift templates. Create some under Scheduling › Shift Templates.');
  const people = ctx.employees.filter((e) => eligible(e, b.groupId, ctx.skillBased) && (!b.employeeIds || b.employeeIds.includes(e.id)) && (!b.teamIds || (e.teamId && b.teamIds.includes(e.teamId))));
  if (!people.length) throw bad(b.employeeIds || b.teamIds ? 'No active employees match the people or teams you chose to include.' : 'No active employees are assigned to this WFM group. Add them under Workforce › Employees.');
  const { v: fv, required, uncovered, projected } = b.coverageSource === 'MANUAL'
    ? { v: null as any, ...(await requirementForManual(p.tenantId, b.groupId, days)) }
    : await requirementFor(p.tenantId, b.groupId, days, b.forecastVersionId);

  // candidate shifts: employee x day x template x start, minus everything the rules already forbid
  const options: any[] = [];
  people.forEach((e, ei) => {
    days.forEach((day, d) => {
      const dow = dowOf(day);
      templates.forEach((t, ti) => {
        if (!t.workDays.includes(dow)) return;
        for (let s = t.earliestStart; s <= t.latestStart; s += t.startStep) {
          if (blockedReason(ctx, e, day, s, t.lengthSlots)) continue;
          if (shiftBlocked(ctx.rules.forTeam(e.teamId, e.id), { nightConsent: !!e.nightShiftConsent }, { startSlot: s, lengthSlots: t.lengthSlots, mealSlots: t.mealSlots })) continue;
          options.push({ employee: ei + 1, day: d, template: ti, start_slot: s, length_slots: t.lengthSlots, paid_slots: t.lengthSlots - t.mealSlots, preference: preferenceFor(ctx, e, day, s, t.lengthSlots) });
        }
      });
    });
  });
  if (!options.length) throw bad('Every possible shift is ruled out by availability, time off or template days. Check availability and shift templates.');

  const W = b.weights;
  const res1 = await engine.schedule({
    days: days.length, first_dow: dowOf(b.from), required,
    employees: people.map((e, i) => ({ id: i + 1, max_week_slots: Math.round(e.maxWeeklyHours * 4), min_week_slots: Math.round(e.weeklyContractHours * 4), max_consecutive: e.maxConsecutiveDays, rest_slots: Math.round(e.minRestHours * 4), max_days_week: e.workDaysPerWeek })),
    options, time_limit_sec: b.timeLimitSec, w_under: W.understaffing * 10, w_over: W.overstaffing, w_hours: W.contractHours, w_pref: W.preferences, w_fair: W.fairness, workers: 8,
  }, (b.timeLimitSec + 60) * 1000);
  if (res1.status === 'INFEASIBLE' || res1.status === 'UNKNOWN') throw bad(`The solver found no valid schedule (${res1.status.toLowerCase()}). Relax availability, contract limits or add people.`);

  const chosen: PlacedShift[] = res1.assignments.map((a: any) => ({ employeeId: people[a.employee - 1].id, day: days[a.day], dayIdx: a.day, startSlot: a.start_slot, length: a.length_slots, template: templates[a.template] }));
  const acts = placeActivities(chosen, days.length * SPD);
  const rows: ShiftRow[] = chosen.map((s) => ({ employeeId: s.employeeId, day: s.day, startSlot: s.startSlot, lengthSlots: s.length, templateId: s.template.id }));
  const solver = { status: res1.status, gap: res1.gap, wallSec: res1.wall_sec, variables: res1.variables, constraints: res1.constraints, objective: res1.objective, candidates: options.length, people: people.length };
  const stats = computeStats(ctx, days, required, rows, solver, { uncoveredDays: uncovered, projectedDays: projected });

  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`sv:${b.groupId}`]);
    const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1', [b.groupId]))!.n;
    const name = b.name || `Schedule v${seq} · ${b.weeks} wk from ${b.from}`;
    const v = await tx.one<any>(
      `INSERT INTO schedule_versions (tenant_id, wfm_group_id, seq, name, period_start, period_end, forecast_version_id, coverage_source, settings, stats, created_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [b.groupId, seq, name, b.from, to, fv?.id ?? null, b.coverageSource, JSON.stringify({ weights: W, timeLimitSec: b.timeLimitSec, templateIds: templates.map((t) => t.id) }), JSON.stringify(stats), p.name]);
    if (chosen.length) await tx.exec(
      `INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities)
       SELECT :t, $1, x.e, x.d, x.tp, x.s, x.l, x.a::jsonb FROM unnest($2::uuid[], $3::date[], $4::uuid[], $5::int[], $6::int[], $7::text[]) AS x(e, d, tp, s, l, a)`,
      [v!.id, chosen.map((s) => s.employeeId), chosen.map((s) => s.day), chosen.map((s) => s.template.id), chosen.map((s) => s.startSlot), chosen.map((s) => s.length), chosen.map((s) => JSON.stringify(acts.get(s) ?? []))]);
    await audit(tx, p, req, { action: 'GENERATE', entityType: 'SCHEDULE_VERSION', entityId: v!.id, entityName: name, after: { coverage: stats.coverage.percent, shifts: rows.length, solver: solver.status, gap: solver.gap } });
    await revision(tx, p, v!.id, 'GENERATE', `Schedule generated by the solver (${solver.status})`, null, stats);
    return (await tx.q<any>(`${VER_SQL} AND v.id = $1`, [v!.id]))[0];
  });
  publish(p.tenantId, ['schedule', 'generated'], { id: out.id, name: out.name, by: p.name });
  res.status(201).json(verDto(out));
});

// ---------------------------------------------------------------- read a version

export async function loadVersion(tx: Tx, id: string) {
  const v = (await tx.q<any>(`${VER_SQL} AND v.id = $1`, [id]))[0];
  if (!v) throw notFound('Schedule version');
  return v;
}
export async function shiftsOf(tx: Tx, versionId: string): Promise<(ShiftRow & { id: string; activities: any[]; source: string })[]> {
  return tx.q<any>('SELECT id, employee_id, day::text AS day, template_id, start_slot, length_slots, activities, source FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 ORDER BY day, start_slot', [versionId]);
}
/** Recompute requirement, coverage and violations from what is stored now (after manual edits or changed employee data). */
export async function liveStats(tenantId: string, v: any) {
  const days = dayRange(v.periodStart, v.periodEnd);
  const { ctx, shifts } = await withTenant(tenantId, async (tx) => ({ ctx: await loadCtx(tx, v.wfmGroupId, v.periodStart, v.periodEnd), shifts: await shiftsOf(tx, v.id) }));
  const { required, uncovered, projected } = v.coverageSource === 'MANUAL'
    ? await requirementForManual(tenantId, v.wfmGroupId, days).catch(() => ({ required: new Array(days.length * SPD).fill(0), uncovered: days, projected: [] as string[] }))
    : await requirementFor(tenantId, v.wfmGroupId, days, v.forecastVersionId ?? undefined).catch(() => ({ required: new Array(days.length * SPD).fill(0), uncovered: days, projected: [] as string[] }));
  const stats = computeStats(ctx, days, required, shifts, v.stats?.solver ?? null, { uncoveredDays: uncovered, projectedDays: projected });
  return { ctx, shifts, days, required, stats, violations: validateShifts(ctx, shifts) };
}

scheduling.get('/versions/:id', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const live = await liveStats(p.tenantId, v);
  res.json({ ...verDto(v), stats: live.stats, violations: live.violations.slice(0, 200) });
});

scheduling.get('/versions/:id/shifts', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional(), employeeId: uuid.optional() }), req.query);
  const rows = await withTenant(p.tenantId, async (tx) => {
    await loadVersion(tx, id);
    return tx.q<any>(
      `SELECT s.id, s.employee_id, e.first_name || ' ' || e.last_name AS employee_name, e.employee_number, s.day::text AS day, s.template_id, t.name AS template_name, s.start_slot, s.length_slots, s.activities, s.source
       FROM schedule_shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_templates t ON t.id = s.template_id
       WHERE s.tenant_id = :t AND s.version_id = $1 AND ($2::date IS NULL OR s.day >= $2) AND ($3::date IS NULL OR s.day <= $3) AND ($4::uuid IS NULL OR s.employee_id = $4)
       ORDER BY e.last_name, e.first_name, s.day`, [id, q.from ?? null, q.to ?? null, q.employeeId ?? null]);
  });
  res.json(rows.map((s) => ({ id: s.id, employeeId: s.employeeId, employeeName: s.employeeName, employeeNumber: s.employeeNumber, day: s.day, templateId: s.templateId, templateName: s.templateName,
    startTime: hhmm(s.startSlot), endTime: hhmm(s.startSlot + s.lengthSlots), startSlot: s.startSlot, lengthSlots: s.lengthSlots, overnight: s.startSlot + s.lengthSlots > SPD,
    activities: (s.activities ?? []).map((a: any) => ({ ...a, startTime: hhmm(a.startSlot), endTime: hhmm(a.startSlot + a.slots) })), source: s.source })));
});

scheduling.get('/versions/:id/coverage', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ day: z.string().regex(isoDay).optional(), grain: z.enum(['15', '60']).default('60') }), req.query);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const live = await liveStats(p.tenantId, v);
  const sched = new Array(live.days.length * SPD).fill(0), di = new Map(live.days.map((d, i) => [d, i]));
  for (const s of live.shifts) { const i = di.get(s.day)!; for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++; }
  const projectedSet = new Set<string>(live.stats.projectedDays ?? []);
  const daily = live.days.map((day, i) => {
    let need = 0, under = 0, have = 0;
    for (let s = 0; s < SPD; s++) { const g = i * SPD + s; need += live.required[g]; have += sched[g]; under += Math.max(0, live.required[g] - sched[g]); }
    return { day, requiredHours: r1(need / 4), scheduledHours: r1(have / 4), coveragePercent: need ? r1((1 - under / need) * 100) : 100, shifts: live.shifts.filter((s) => s.day === day).length, projected: projectedSet.has(day) };
  });
  let slots: any[] = [];
  const day = q.day ?? live.days[0], i = di.get(day);
  if (i !== undefined) {
    const step = q.grain === '15' ? 1 : 4;
    for (let s = 0; s < SPD; s += step) {
      let need = 0, have = Infinity;   // an hour needs its busiest quarter and is only as covered as its weakest
      for (let k = 0; k < step; k++) { need = Math.max(need, live.required[i * SPD + s + k]); have = Math.min(have, sched[i * SPD + s + k]); }
      slots.push({ day, slot: s, time: hhmm(s), required: need, scheduled: have, delta: have - need });
    }
  }
  res.json({ versionId: id, day, daily, slots, uncoveredDays: live.stats.uncoveredDays, projectedDays: live.stats.projectedDays ?? [], projected: projectedSet.has(day) });
});

scheduling.get('/versions/:id/validate', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const { violations } = await liveStats(p.tenantId, v);
  const blocking = violations.filter((x) => x.severity !== 'WARN');
  res.json({ ok: blocking.length === 0, count: blocking.length, warnings: violations.length - blocking.length, violations: violations.slice(0, 500) });
});


/** Replay: every change to this version in order, with the measured result after each. Versions made before revisions were recorded fall back to the audit ledger (no numbers). */
scheduling.get('/versions/:id/revisions', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    let rows = await tx.q<any>('SELECT n, at, actor_name, actor_role, kind, summary, reason, coverage, under_slots, overtime_h, paid_h, shifts, people, violations FROM schedule_revisions WHERE tenant_id = :t AND version_id = $1 ORDER BY n', [id]);
    if (!rows.length) {
      const a = await tx.q<any>(`SELECT at, actor_name, actor_role, action, reason, diff_summary, after FROM audit_log WHERE tenant_id = :t AND entity_type = 'SCHEDULE_VERSION' AND entity_id = $1 ORDER BY id`, [id]);
      rows = a.map((r, i) => ({ n: i + 1, at: r.at, actorName: r.actorName, actorRole: r.actorRole, kind: r.action === 'GENERATE' ? 'GENERATE' : r.action === 'PUBLISH' ? 'PUBLISH' : 'EDIT',
        summary: r.diffSummary ?? (r.action === 'GENERATE' ? 'Schedule generated by the solver' : r.action === 'PUBLISH' ? 'Published' : r.action), reason: r.reason, coverage: r.after?.coverage ?? null, underSlots: null, overtimeH: null, paidH: null, shifts: r.after?.shifts ?? null, people: null, violations: null }));
    }
    return { version: verDto(v), revisions: rows.map((r) => ({ n: r.n, at: r.at, actorName: r.actorName, actorRole: r.actorRole, kind: r.kind, summary: r.summary, reason: r.reason,
      coverage: r.coverage == null ? null : Number(r.coverage), underSlots: r.underSlots, overtimeHours: r.overtimeH == null ? null : Number(r.overtimeH), paidHours: r.paidH == null ? null : Number(r.paidH), shifts: r.shifts, people: r.people, violations: r.violations })) };
  });
  res.json(out);
});

// ---------------------------------------------------------------- manual edits (draft only)

async function editable(tx: Tx, id: string) {
  const v = await loadVersion(tx, id);
  if (v.status === 'ARCHIVED') throw conflict('An archived schedule cannot be changed. Generate a new version to make changes.');
  return v;
}
export async function refreshStats(tenantId: string, id: string) {
  const v = await withTenant(tenantId, (tx) => loadVersion(tx, id));
  const live = await liveStats(tenantId, v);
  await withTenant(tenantId, (tx) => tx.exec('UPDATE schedule_versions SET stats = $2, rev = rev + 1 WHERE tenant_id = :t AND id = $1', [id, JSON.stringify(live.stats)]));
  return live;
}

scheduling.post('/versions/:id/shifts', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ employeeId: uuid, day: z.string().regex(isoDay), templateId: uuid, startTime: z.string(), reason: z.string().trim().min(3, 'is required: say why the schedule is being changed') }), req.body);
  const start = slotOf(b.startTime);
  if (Number.isNaN(start)) throw bad('Start time must look like 08:30');
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await editable(tx, id);
    if (b.day < v.periodStart || b.day > v.periodEnd) throw bad(`The day must be inside the schedule period (${v.periodStart} to ${v.periodEnd})`);
    const t = await tx.one<any>('SELECT * FROM shift_templates WHERE tenant_id = :t AND id = $1', [b.templateId]);
    if (!t) throw notFound('Shift template');
    const emp = await tx.one<any>('SELECT first_name || \' \' || last_name AS name FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!emp) throw notFound('Employee');
    const acts = placeActivities([{ employeeId: b.employeeId, day: b.day, dayIdx: 0, startSlot: start, length: t.lengthSlots, template: t }], SPD).values().next().value ?? [];
    const s = await tx.one<any>(
      `INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, 'MANUAL')
       ON CONFLICT (version_id, employee_id, day) DO UPDATE SET template_id = EXCLUDED.template_id, start_slot = EXCLUDED.start_slot, length_slots = EXCLUDED.length_slots, activities = EXCLUDED.activities, source = 'MANUAL' RETURNING id`,
      [id, b.employeeId, b.day, b.templateId, start, t.lengthSlots, JSON.stringify(acts)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason: b.reason, diffSummary: `${emp.name} ${b.day}: ${t.name} from ${b.startTime}` });
    return { id: s!.id, note: `${emp.name} ${b.day}: ${t.name} from ${b.startTime}` };
  });
  const live = await refreshStats(p.tenantId, id);
  await withTenant(p.tenantId, (tx) => revision(tx, p, id, 'EDIT', out.note, b.reason, live.stats));
  res.status(201).json({ id: out.id, coverage: live.stats.coverage.percent, violations: live.violations.filter((x) => x.employeeId === b.employeeId && x.day === b.day) });
});

const ACTIVITY_TYPES = ['MEAL', 'BREAK', 'TRAINING', 'COACHING'] as const;
const ActivitiesBody = z.object({
  activities: z.array(z.object({ type: z.enum(ACTIVITY_TYPES), startSlot: z.number().int().min(0).max(95), slots: z.number().int().min(1).max(16) })).max(12),
  reason: z.string().trim().min(3, 'is required: say why the schedule is being changed'),
});
/** Edit the meal, break, training and coaching blocks inside one shift. Draft only; the shift's own start and length never change. */
scheduling.put('/versions/:id/shifts/:shiftId/activities', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), shiftId = parse(uuid, req.params.shiftId), b = parse(ActivitiesBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await editable(tx, id);
    const s = await tx.one<any>(
      `SELECT s.id, s.start_slot, s.length_slots, s.day::text AS day, e.first_name || ' ' || e.last_name AS name FROM schedule_shifts s JOIN employees e ON e.id = s.employee_id WHERE s.tenant_id = :t AND s.version_id = $1 AND s.id = $2`, [id, shiftId]);
    if (!s) throw notFound('Shift');
    const acts = [...b.activities].sort((x, y) => x.startSlot - y.startSlot);
    for (const [i, a] of acts.entries()) {
      if (a.startSlot < s.startSlot || a.startSlot + a.slots > s.startSlot + s.lengthSlots) throw bad(`${a.type.toLowerCase()} must sit inside the shift`);
      if (i > 0 && a.startSlot < acts[i - 1].startSlot + acts[i - 1].slots) throw bad('Two activities cannot overlap');
    }
    await tx.exec('UPDATE schedule_shifts SET activities = $2::jsonb WHERE tenant_id = :t AND id = $1', [shiftId, JSON.stringify(acts)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason: b.reason, diffSummary: `${s.name} ${s.day}: ${acts.length} activit${acts.length === 1 ? 'y' : 'ies'} edited` });
    return { note: `${s.name} ${s.day}: activities edited` };
  });
  const live = await refreshStats(p.tenantId, id);
  await withTenant(p.tenantId, (tx) => revision(tx, p, id, 'EDIT', out.note, b.reason, live.stats));
  res.json({ ok: true, coverage: live.stats.coverage.percent });
});

/** One person's shifts across every schedule version in a date range -- published history and drafts, labelled with the version they belong to. */
scheduling.get('/employees/:employeeId/shifts', requires('schedule:read'), async (req, res) => {
  const p = me(req), employeeId = parse(uuid, req.params.employeeId);
  const q = parse(z.object({ from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.query);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT s.id, s.day::text AS day, s.start_slot, s.length_slots, s.activities, s.source, v.id AS version_id, v.name AS version_name, v.status AS version_status, v.seq AS version_seq, t.name AS template_name
     FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id LEFT JOIN shift_templates t ON t.id = s.template_id
     WHERE s.tenant_id = :t AND s.employee_id = $1 AND s.day >= $2::date AND s.day <= $3::date ORDER BY s.day, s.start_slot, v.seq`, [employeeId, q.from, q.to]));
  res.json(rows.map((r) => ({
    id: r.id, day: r.day, startTime: hhmm(r.startSlot), endTime: hhmm(r.startSlot + r.lengthSlots), startSlot: r.startSlot, lengthSlots: r.lengthSlots,
    templateName: r.templateName, source: r.source, versionId: r.versionId, versionName: r.versionName, versionStatus: r.versionStatus, versionSeq: r.versionSeq,
    activities: (r.activities ?? []).map((a: any) => ({ type: a.type, startSlot: a.startSlot, slots: a.slots, startTime: hhmm(a.startSlot), endTime: hhmm(a.startSlot + a.slots) })),
  })));
});

scheduling.delete('/versions/:id/shifts/:shiftId', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), shiftId = parse(uuid, req.params.shiftId);
  const reason = String(req.query.reason ?? '').trim();
  if (reason.length < 3) throw bad('A reason is required to remove a shift');
  const note = await withTenant(p.tenantId, async (tx) => {
    const v = await editable(tx, id);
    const s = await tx.one<any>('SELECT s.day::text AS day, e.first_name || \' \' || e.last_name AS name FROM schedule_shifts s JOIN employees e ON e.id = s.employee_id WHERE s.tenant_id = :t AND s.version_id = $1 AND s.id = $2', [id, shiftId]);
    if (!s) throw notFound('Shift');
    await tx.exec('DELETE FROM schedule_shifts WHERE tenant_id = :t AND id = $1', [shiftId]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason, diffSummary: `removed ${s.name} on ${s.day}` });
    return `Removed ${s.name} on ${s.day}`;
  });
  const live = await refreshStats(p.tenantId, id);
  await withTenant(p.tenantId, (tx) => revision(tx, p, id, 'EDIT', note, reason, live.stats));
  res.json({ ok: true, coverage: live.stats.coverage.percent });
});

// ---------------------------------------------------------------- publish, delete, compare, my shifts

scheduling.post('/versions/:id/publish', requires('schedule:publish'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v0 = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  if (v0.status !== 'DRAFT') throw conflict(`Only a draft can be published (this one is ${v0.status.toLowerCase()}).`);
  const live = await liveStats(p.tenantId, v0);
  const blocking = live.violations.filter((x) => x.severity !== 'WARN');
  if (blocking.length) throw new HttpError(409, 'RULE_VIOLATIONS', `${blocking.length} rule violations must be fixed before publishing. First: ${blocking[0].message}`, blocking.slice(0, 20));
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec(`UPDATE schedule_versions SET status = 'ARCHIVED' WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND id <> $2 AND kind = $5 AND period_start <= $4 AND period_end >= $3`, [v0.wfmGroupId, id, v0.periodStart, v0.periodEnd, v0.kind ?? 'DEMAND']);
    await tx.exec(`UPDATE schedule_versions SET status = 'PUBLISHED', published_by = $2, published_at = now(), published_rev = rev, stats = $3 WHERE tenant_id = :t AND id = $1`, [id, p.name, JSON.stringify(live.stats)]);
    await audit(tx, p, req, { action: 'PUBLISH', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v0.name, after: { coverage: live.stats.coverage.percent } });
    await revision(tx, p, id, 'PUBLISH', 'Published: this schedule now drives adherence', null, live.stats);
    return loadVersion(tx, id);
  });
  await dropCache(p.tenantId, 'sched:*');
  publish(p.tenantId, ['schedule', 'publish'], { id, name: out.name, by: p.name });
  res.json(verDto(out));
});

/** Re-check a published schedule after direct edits and re-stamp it as the live version. Blocks on rule violations, like publish. */
scheduling.post('/versions/:id/republish', requires('schedule:publish'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v0 = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  if (v0.status !== 'PUBLISHED') throw conflict(`Only a published schedule can be republished (this one is ${v0.status.toLowerCase()}).`);
  const live = await liveStats(p.tenantId, v0);
  const blocking = live.violations.filter((x) => x.severity !== 'WARN');
  if (blocking.length) throw new HttpError(409, 'RULE_VIOLATIONS', `${blocking.length} rule violations must be fixed before republishing. First: ${blocking[0].message}`, blocking.slice(0, 20));
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec(`UPDATE schedule_versions SET published_by = $2, published_at = now(), published_rev = rev, stats = $3 WHERE tenant_id = :t AND id = $1`, [id, p.name, JSON.stringify(live.stats)]);
    await audit(tx, p, req, { action: 'PUBLISH', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v0.name, diffSummary: 'Republished after edits' });
    await revision(tx, p, id, 'PUBLISH', 'Republished after direct edits', null, live.stats);
    return loadVersion(tx, id);
  });
  await dropCache(p.tenantId, 'sched:*');
  publish(p.tenantId, ['schedule', 'publish'], { id, name: out.name, by: p.name });
  res.json(verDto(out));
});

scheduling.delete('/versions/:id', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    if (v.status === 'PUBLISHED') throw conflict('A published schedule cannot be deleted. Publish a newer one first; this one is then archived.');
    await tx.exec('DELETE FROM schedule_versions WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name });
  });
  res.json({ ok: true });
});

scheduling.get('/compare', requires('schedule:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ a: uuid, b: uuid }), req.query);
  const load = async (id: string) => {
    const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
    const live = await liveStats(p.tenantId, v);
    const di = new Map(live.days.map((d, i) => [d, i]));
    const sched = new Array(live.days.length * SPD).fill(0);
    for (const s of live.shifts) { const i = di.get(s.day)!; for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++; }
    const daily = live.days.map((day, i) => { let need = 0, under = 0; for (let s = 0; s < SPD; s++) { need += live.required[i * SPD + s]; under += Math.max(0, live.required[i * SPD + s] - sched[i * SPD + s]); } return { day, coveragePercent: need ? r1((1 - under / need) * 100) : 100 }; });
    return { version: verDto({ ...v, stats: live.stats }), daily, shifts: live.shifts.map((s) => `${s.employeeId}|${s.day}|${s.startSlot}|${s.lengthSlots}`) };
  };
  const [A, B] = await Promise.all([load(q.a), load(q.b)]);
  const setA = new Set(A.shifts), setB = new Set(B.shifts);
  const sa = A.version.stats, sb = B.version.stats;
  res.json({
    a: { version: A.version, daily: A.daily }, b: { version: B.version, daily: B.daily },
    delta: { coveragePercent: r1(sb.coverage.percent - sa.coverage.percent), paidHours: r1(sb.hours.paid - sa.hours.paid), overtimeHours: r1(sb.hours.overtime - sa.hours.overtime), violations: sb.violations - sa.violations, shifts: sb.shifts - sa.shifts },
    shiftsChanged: { onlyInA: [...setA].filter((x) => !setB.has(x)).length, onlyInB: [...setB].filter((x) => !setA.has(x)).length, same: [...setA].filter((x) => setB.has(x)).length },
  });
});

/** The signed-in person's own published shifts (agents see only their schedule). */
scheduling.get('/mine', requires('schedule:read'), async (req, res) => {
  const p = me(req);
  const q = parse(z.object({ from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional() }), req.query);
  const rows = await withTenant(p.tenantId, async (tx) => {
    const u = await tx.one<any>('SELECT employee_id FROM users WHERE tenant_id = :t AND id = $1', [p.userId]);
    if (!u?.employeeId) return [];
    return tx.q<any>(
      `SELECT s.day::text AS day, s.start_slot, s.length_slots, s.activities, t.name AS template_name, v.name AS version_name FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
       LEFT JOIN shift_templates t ON t.id = s.template_id WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND s.employee_id = $1 AND ($2::date IS NULL OR s.day >= $2) AND ($3::date IS NULL OR s.day <= $3) ORDER BY s.day`,
      [u.employeeId, q.from ?? null, q.to ?? null]);
  });
  res.json(rows.map((s) => ({ day: s.day, startTime: hhmm(s.startSlot), endTime: hhmm(s.startSlot + s.lengthSlots), template: s.templateName, schedule: s.versionName, activities: (s.activities ?? []).map((a: any) => ({ ...a, startTime: hhmm(a.startSlot), endTime: hhmm(a.startSlot + a.slots) })) })));
});

export { todayIn };
