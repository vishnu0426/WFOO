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
import { addDays, dayRange, loadGroup, versionRecords, riskRequired, todayIn, synthesizeLongRangeRequirement } from './forecast/service.ts';
import { hhmm } from './workforceRoutes.ts';
import { loadPolicy } from './policyRoutes.ts';
import { payWeekFor } from './payWeek.ts';
import { loadRuleSets, type RuleSets } from './compliance/routes.ts';
import { checkPerson, limitsFrom, premiumHours, shiftBlocked } from './compliance/rules.ts';
import { analyseShortage, buildReport, crewSizeNote, evaluateSchedule, explainInterval, optimizeBreaks, staleReasons, type QShift } from './scheduleQuality.ts';
import { loadSkillWork, splitBySkill } from './skillRequirements.ts';
import { boundaryFrom, historyNote, mergeCarry, netRequired, spillOver, type Boundary, type PriorState } from './boundaryHistory.ts';
import { contractFit, contractFitNote, weeklyCapHours } from './contractFit.ts';
import { checkTemplate, lengthsOf, offeredLengths, paidSlots, rulesFor, startsFor, unpaidMeal, whyNotOffered, type DayWindow, type LengthRule } from './templateRules.ts';

export const scheduling = Router();
const uuid = z.string().uuid();
const SPD = 96;
/** The earlier-days fields the solver takes for one person; all zero when there is no history. */
const priorFields = (st?: PriorState) => st ? { prior_run: st.run, prior_has_end: st.endSlot !== null, prior_end_slot: st.endSlot ?? 0, prior_week_slots: st.weekSlots, prior_week_days: st.weekDays, prior_lead_days: st.leadDays } : {};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
export const dowOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }; // Monday = 0
export const mondayOf = (day: string, weekStart = 0) => addDays(day, -((dowOf(day) - weekStart + 7) % 7));   // first day of the pay week that `day` is in; weeks start on Monday unless the schedule says otherwise
const slotOf = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? Math.min(95, Math.floor((+m[1] * 60 + +m[2]) / 15)) : NaN; };

// ---------------------------------------------------------------- shift templates

const tplDto = (t: any) => ({
  id: t.id, name: t.name, code: t.code, description: t.description, status: t.status, workDays: t.workDays,
  earliestStart: hhmm(t.earliestStart), latestStart: hhmm(t.latestStart), startStepMinutes: t.startStep * 15,
  durationHours: t.lengthSlots / 4, mealMinutes: t.mealSlots * 15, breakCount: t.breakCount, breakMinutes: t.breakSlots * 15, flexMinutes: t.flexSlots * 15,
  paidHours: paidSlots(t, t.lengthSlots) / 4, version: t.version,
  // variable length, meal and breaks by length, a window per weekday, who it is offered to, the dates it is in force
  minDurationHours: t.minLengthSlots != null && t.minLengthSlots < t.lengthSlots ? t.minLengthSlots / 4 : null, lengthStepMinutes: (t.lengthStep ?? 2) * 15, mealPaid: !!t.mealPaid,
  paidHoursMin: paidSlots(t, lengthsOf(t)[0]) / 4,
  dayWindows: t.dayWindows ? Object.fromEntries(Object.entries(t.dayWindows as Record<string, DayWindow>).map(([d, w]) => [d, { earliest: hhmm(w.earliest), latest: hhmm(w.latest) }])) : null,
  lengthRules: (t.lengthRules as LengthRule[] | null)?.map((r) => ({ fromHours: r.fromSlots / 4, mealMinutes: r.mealSlots * 15, breakCount: r.breakCount, breakMinutes: r.breakSlots * 15 })) ?? null,
  groupIds: t.groupIds?.length ? t.groupIds : null, employmentTypes: t.employmentTypes?.length ? t.employmentTypes : null, skillIds: t.skillIds?.length ? t.skillIds : null,
  effectiveFrom: t.effectiveFrom ?? null, effectiveTo: t.effectiveTo ?? null,
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
  // variable length: the shortest shift (hours) and the gap between offered lengths; durationHours is then the longest
  minDurationHours: z.number().min(1).max(14).nullable().optional(), lengthStepMinutes: z.number().int().refine((v) => v % 15 === 0 && v >= 15 && v <= 240, 'must be 15 to 240 in steps of 15').optional(),
  mealPaid: z.boolean().optional(),
  dayWindows: z.record(z.string().regex(/^[0-6]$/), z.object({ earliest: z.string(), latest: z.string() })).nullable().optional(),
  lengthRules: z.array(z.object({ fromHours: z.number().min(0).max(14), mealMinutes: z.number().int().min(0).max(120), breakCount: z.number().int().min(0).max(4), breakMinutes: z.number().int().min(15).max(60) })).max(6).nullable().optional(),
  groupIds: z.array(uuid).max(200).nullable().optional(), employmentTypes: z.array(z.string().min(1).max(30)).max(10).nullable().optional(), skillIds: z.array(uuid).max(50).nullable().optional(),
  effectiveFrom: z.string().regex(isoDay).nullable().optional(), effectiveTo: z.string().regex(isoDay).nullable().optional(),
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
  const minLen = b.minDurationHours != null ? Math.round(b.minDurationHours * 4) : null;
  const dayWindows = b.dayWindows && Object.keys(b.dayWindows).length ? Object.fromEntries(Object.entries(b.dayWindows).map(([d, w]) => {
    const we = slotOf(w.earliest), wl = slotOf(w.latest);
    if (Number.isNaN(we) || Number.isNaN(wl)) throw bad('Start times must look like 08:30');
    return [d, { earliest: we, latest: wl }];
  })) : null;
  const lengthRules = b.lengthRules?.length ? b.lengthRules.map((r) => ({ fromSlots: Math.round(r.fromHours * 4), mealSlots: Math.round(r.mealMinutes / 15), breakCount: r.breakCount, breakSlots: Math.round(r.breakMinutes / 15) })).sort((x, y) => x.fromSlots - y.fromSlots) : null;
  const flexible = {
    minLen: minLen != null && minLen < len ? minLen : null, lengthStep: Math.round((b.lengthStepMinutes ?? 30) / 15), mealPaid: b.mealPaid ?? false, dayWindows, lengthRules,
    groupIds: b.groupIds?.length ? b.groupIds : null, employmentTypes: b.employmentTypes?.length ? b.employmentTypes : null, skillIds: b.skillIds?.length ? b.skillIds : null,
    effectiveFrom: b.effectiveFrom ?? null, effectiveTo: b.effectiveTo ?? null,
  };
  const problem = checkTemplate({ workDays: b.workDays, earliestStart: e, latestStart: l, startStep: 2, lengthSlots: len, minLengthSlots: minLen, mealSlots: meal, breakCount: breaks, breakSlots: brk, dayWindows, lengthRules, effectiveFrom: flexible.effectiveFrom, effectiveTo: flexible.effectiveTo });
  if (problem) throw bad(problem);
  return { e, l, step: Math.round((b.startStepMinutes ?? 30) / 15), len, meal, breaks, brk, flex: Math.round((b.flexMinutes ?? 30) / 15), mealAnchor, breakAnchors, ...flexible };
};
type Slots = ReturnType<typeof toSlots>;
/** The new template columns, in the order the INSERT and UPDATE statements list them. */
const flexParams = (s: Slots) => [s.minLen, s.lengthStep, s.dayWindows ? JSON.stringify(s.dayWindows) : null, s.lengthRules ? JSON.stringify(s.lengthRules) : null, s.mealPaid, s.groupIds, s.employmentTypes, s.skillIds, s.effectiveFrom, s.effectiveTo];

scheduling.get('/templates', requires('schedule:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t ORDER BY earliest_start, name'))).map(tplDto));
});
scheduling.post('/templates', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(TplBody, req.body), s = toSlots(b);
  const out = await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>(
      `INSERT INTO shift_templates (tenant_id, name, code, description, work_days, earliest_start, latest_start, start_step, length_slots, meal_slots, break_count, break_slots, flex_slots, meal_anchor_slot, break_anchor_slots,
         min_length_slots, length_step, day_windows, length_rules, meal_paid, group_ids, employment_types, skill_ids, effective_from, effective_to)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19, $20, $21, $22, $23, $24) RETURNING *`,
      [b.name, b.code ?? b.name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 30), b.description ?? '', [...new Set(b.workDays)].sort(), s.e, s.l, s.step, s.len, s.meal, s.breaks, s.brk, s.flex, s.mealAnchor, s.breakAnchors, ...flexParams(s)]);
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
         meal_slots = $10, break_count = $11, break_slots = $12, flex_slots = $13, meal_anchor_slot = $14, break_anchor_slots = $15,
         min_length_slots = $16, length_step = $17, day_windows = $18::jsonb, length_rules = $19::jsonb, meal_paid = $20, group_ids = $21, employment_types = $22, skill_ids = $23, effective_from = $24, effective_to = $25,
         version = version + 1 WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name, b.description ?? '', b.status ?? null, [...new Set(b.workDays)].sort(), s.e, s.l, s.step, s.len, s.meal, s.breaks, s.brk, s.flex, s.mealAnchor, s.breakAnchors, ...flexParams(s)]);
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

export interface Ctx { group: any; employees: any[]; templates: any[]; timeOff: any[]; avail: any[]; tz: string; rules: RuleSets; skillBased: boolean; weekStart: number; others: { employeeId: string; day: string; startSlot: number; lengthSlots: number; groupName: string }[] }

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
  return { group, employees, templates, timeOff, avail, tz: group.timezone, rules, skillBased, weekStart: (await payWeekFor(tx, groupId)).start, others };
}

const eligible = (e: any, groupId: string, skillBased = false) => e.status === 'ACTIVE' && (skillBased || e.primaryGroupId === groupId || (e.eligibleGroupIds ?? []).includes(groupId));

/** Why a person cannot work a shift starting at `start` (slot) for `len` slots on `day`, or null when they can. */
export function blockedReason(ctx: Ctx, e: any, day: string, start: number, len: number): string | null {
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
export async function requirementFor(tenantId: string, groupId: string, days: string[], forecastId?: string, confidence = 50) {
  const v = await withTenant(tenantId, (tx) => tx.one<any>(
    `SELECT * FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND ($2::uuid IS NULL OR id = $2) AND ($2::uuid IS NOT NULL OR status = 'PUBLISHED') ORDER BY seq DESC LIMIT 1`, [groupId, forecastId ?? null]));
  if (!v && forecastId) throw bad('That forecast was not found for this group');

  const idx = new Map(days.map((d, i) => [d, i]));
  const required = new Array(days.length * SPD).fill(0);
  const covered = new Set<string>();
  if (v) {
    const { records } = await versionRecords(tenantId, v);
    // planning to a confidence level above 50 raises each interval to what the staffing model needs at the forecast's upper volume
    const risk = confidence > 50 ? await riskRequired(tenantId, v, confidence) : null;
    for (const r of records) { const i = idx.get(r.day); if (i !== undefined) { required[i * SPD + r.slot] = Math.max(r.required, risk?.get(`${r.day}|${r.slot}`) ?? 0); covered.add(r.day); } }
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
    const r = rulesFor(t, s.length);          // meal and breaks for this shift's own length
    if (r.mealSlots > 0) put('MEAL', base + (t.mealAnchorSlot ?? Math.round((s.length - r.mealSlots) / 2)), r.mealSlots, t.flexSlots);
    for (let k = 1; k <= r.breakCount; k++) {
      const anchor = t.breakAnchorSlots?.[k - 1];
      put('BREAK', base + (anchor ?? Math.round((s.length * k) / (r.breakCount + 1)) - Math.floor(r.breakSlots / 2)), r.breakSlots, t.flexSlots);
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
  const paid = (s: ShiftRow) => paidSlots(tpl.get(s.templateId!), s.lengthSlots) / 4;
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
    for (const s of list) { const k = mondayOf(s.day, ctx.weekStart); const w = weeks.get(k) ?? { h: 0, n: 0 }; w.h += paid(s); w.n++; weeks.set(k, w); }
    for (const [wk, w] of weeks) {
      if (w.h > e.maxWeeklyHours + 1e-9) add('WEEKLY_MAX', wk, `${name} works ${r1(w.h)}h in the week of ${wk} (max ${e.maxWeeklyHours}h)`);
      if (w.n > e.workDaysPerWeek) add('DAYS_PER_WEEK', wk, `${name} works ${w.n} days in the week of ${wk} (max ${e.workDaysPerWeek})`);
    }
    // the labour-law pack that applies to this person. Rest, weekly hours and days in a row that a BLOCK rule sets are already part of the limits above.
    const lite = list.map((s) => ({ day: s.day, startSlot: s.startSlot, lengthSlots: s.lengthSlots, mealSlots: rulesFor(tpl.get(s.templateId!) ?? ({ workDays: [], earliestStart: 0, latestStart: 0, startStep: 1, lengthSlots: s.lengthSlots, mealSlots: 0, breakCount: 0, breakSlots: 1 } as any), s.lengthSlots).mealSlots }));
    for (const f of checkPerson(ctx.rules.forTeam(e.teamId, id), { id, name, nightConsent: !!e.nightShiftConsent }, lite, ctx.weekStart)) {
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
    const t = tpl.get(s.templateId!);
    const mealSlots = t?.mealPaid ? 0 : s.activities ? s.activities.filter((a) => a.type === 'MEAL').reduce((n, a) => n + a.slots, 0) : unpaidMeal(t, s.lengthSlots);
    const h = (s.lengthSlots - mealSlots) / 4;
    paidH += h; const k = `${s.employeeId}|${mondayOf(s.day, ctx.weekStart)}`; wk.set(k, (wk.get(k) ?? 0) + h);
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
    if (e) premium += premiumHours(ctx.rules.forTeam(e.teamId, e.id), list.map((s) => ({ day: s.day, startSlot: s.startSlot, lengthSlots: s.lengthSlots, mealSlots: unpaidMeal(tpl.get(s.templateId!), s.lengthSlots) })), ctx.weekStart).hours;
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
  weights: Weights.default({ understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 20, fairness: 30 }),
  // everyone keeps one usual start and end time for the whole period (within a tolerance). PREFER trades it off against coverage, REQUIRE never does.
  // Left out, the company default (Configuration > Scheduling Rules) applies. A person's own setting always wins over it.
  consistentTimes: z.object({ mode: z.enum(['OFF', 'PREFER', 'REQUIRE']), startToleranceMin: z.number().int().min(0).max(240).default(0), endToleranceMin: z.number().int().min(0).max(240).default(0) }).optional(),
  optimizeBreaks: z.boolean().default(true), breakSlackMin: z.number().int().min(0).max(240).optional(),
  timeLimitSec: z.number().int().min(3).max(120).default(30), name: z.string().trim().max(100).optional(),
  // count what people worked in the 7 days before `from` in the previous published schedule (rest, days in a row, the week's hours, shifts running past midnight)
  useHistory: z.boolean().default(true),
  // assume the week repeats: the last night's shifts past midnight cover the first hours, for a first schedule with nothing before it. One-week schedules only.
  assumeRepeat: z.boolean().default(false),
  // fill the gaps another schedule leaves (a rotation roster): its people count as covering the need, and the people in its crews are not scheduled again
  fillFromVersionId: uuid.optional(),
  weekStart: z.number().int().min(0).max(6).optional(),   // weekday a pay week begins on: Monday 0 ... Sunday 6. Omitted: the group's setting, else the company's, else Monday
  // how sure to be of having enough people: 50 plans to the central forecast, 90 to its upper (P90) volume. Forecast-based schedules only.
  confidence: z.number().int().min(50).max(95).default(50),

});

/** Why a schedule no longer matches the forecast it was built from: edited, withdrawn or replaced by a newer published one. Archived schedules are history, never stale. */
const staleOf = (v: any): string[] => v.status === 'ARCHIVED' || v.kind === 'ROTATION' || !v.forecastVersionId ? [] : staleReasons({ settings: v.settings, forecastId: v.forecastVersionId, forecastRevNow: v.forecastRevNow ?? null, forecastStatusNow: v.forecastStatusNow ?? null, newerPublishedForecast: v.newerForecast ?? null });
export const verDto = (v: any) => ({ id: v.id, seq: v.seq, wfmGroupId: v.wfmGroupId, groupName: v.groupName ?? null, name: v.name, status: v.status, kind: v.kind ?? 'DEMAND', coverageSource: v.coverageSource ?? 'FORECAST', periodStart: v.periodStart, periodEnd: v.periodEnd, forecastVersionId: v.forecastVersionId, forecastName: v.forecastName ?? null, rev: v.rev, hasChanges: v.status === 'PUBLISHED' && v.rev !== v.publishedRev, settings: v.settings, stats: v.stats, createdBy: v.createdBy, createdAt: v.createdAt, publishedBy: v.publishedBy, publishedAt: v.publishedAt, stale: staleOf(v), acknowledged: v.ack ?? null });
const VER_SQL = `SELECT v.*, v.period_start::text AS period_start, v.period_end::text AS period_end, f.name AS forecast_name, g.name AS group_name,
    f.rev AS forecast_rev_now, f.status AS forecast_status_now,
    (SELECT json_build_object('id', n.id, 'name', n.name) FROM forecast_versions n WHERE n.tenant_id = v.tenant_id AND n.wfm_group_id = v.wfm_group_id AND n.kind = 'SHORT' AND n.status = 'PUBLISHED' AND f.id IS NOT NULL AND n.id <> f.id AND n.seq > f.seq ORDER BY n.seq DESC LIMIT 1) AS newer_forecast
  FROM schedule_versions v LEFT JOIN forecast_versions f ON f.id = v.forecast_version_id LEFT JOIN wfm_groups g ON g.id = v.wfm_group_id WHERE v.tenant_id = :t`;

// What the staffing target for these dates looks like, before spending solver time: hours needed, which days have no target, and the busiest hour.
scheduling.get('/readiness', requires('schedule:read'), async (req, res) => {
  const p = me(req);
  const groupId = parse(uuid, req.query.groupId), from = parse(z.string().regex(isoDay), req.query.from);
  const weeks = parse(z.coerce.number().int().min(1).max(4), req.query.weeks ?? 1);
  const manual = req.query.coverageSource === 'MANUAL';
  const days = dayRange(from, addDays(from, weeks * 7 - 1));
  const payWeek = await withTenant(p.tenantId, (tx) => payWeekFor(tx, groupId));
  try {
    const r = manual ? await requirementForManual(p.tenantId, groupId, days) : await requirementFor(p.tenantId, groupId, days, undefined, parse(z.coerce.number().int().min(50).max(95), req.query.confidence ?? 50));
    let peak = 0;
    for (const v of r.required) peak = Math.max(peak, v);
    res.json({ requiredHours: r.required.reduce((n: number, v: number) => n + v, 0) / 4, peakPeople: peak, uncoveredDays: r.uncovered, projectedDays: r.projected, problem: null, payWeek });
  } catch (e: any) {
    res.json({ requiredHours: null, peakPeople: null, uncoveredDays: [], projectedDays: [], problem: e?.message ?? 'The staffing target could not be worked out.', payWeek });
  }
});

scheduling.get('/versions', requires('schedule:read'), async (req, res) => {
  const groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>(`${VER_SQL} AND ($1::uuid IS NULL OR v.wfm_group_id = $1) ORDER BY v.seq DESC LIMIT 100`, [groupId]))).map(verDto));
});

scheduling.post('/versions', requires('schedule:generate'), async (req, res) => {
  const p = me(req), b = parse(GenBody, req.body);
  const to = addDays(b.from, b.weeks * 7 - 1), days = dayRange(b.from, to);
  if (b.assumeRepeat && b.weeks !== 1) throw bad('"Assume the week repeats" works for one-week schedules');
  const { ctx: baseCtx, pol, skillRows } = await withTenant(p.tenantId, async (tx) => ({
    ctx: await loadCtx(tx, b.groupId, b.from, to), pol: await loadPolicy(tx),
    skillRows: await tx.q<{ employeeId: string; skillId: string }>('SELECT employee_id, skill_id FROM employee_skills WHERE tenant_id = :t'),
  }));
  const weekStart = b.weekStart ?? baseCtx.weekStart;   // asked for, else the group's pay week, else the company's
  const ctx = { ...baseCtx, weekStart };
  // same start and end every day: the request wins, else the company default; a person's own setting then wins over both
  const consist = b.consistentTimes ?? pol.scheduling.consistentTimes;
  const startTol = Math.round(consist.startToleranceMin / 15), endTol = Math.round(consist.endToleranceMin / 15);
  const modeOf = (e: any): 'OFF' | 'PREFER' | 'REQUIRE' => (e.shiftConsistency === 'DEFAULT' || !e.shiftConsistency ? consist.mode : e.shiftConsistency);
  const templates = ctx.templates.filter((t) => t.status === 'ACTIVE' && (!b.templateIds || b.templateIds.includes(t.id)));
  if (!templates.length) throw bad('There are no active shift templates. Create some under Scheduling › Shift Templates.');
  // the schedule being filled in: whose shifts already cover the need, and who is in its rotation crews (they are not scheduled a second time)
  let fill: { id: string; name: string; headcount: [number, number][]; crew: Set<string> } | null = null;
  if (b.fillFromVersionId) {
    const loaded = await withTenant(p.tenantId, async (tx) => {
      const v = await loadVersion(tx, b.fillFromVersionId!);
      if (v.wfmGroupId !== b.groupId) throw bad('That schedule belongs to another WFM group');
      return { v, shifts: await shiftsOf(tx, v.id), crew: await tx.q<{ employeeId: string }>('SELECT rm.employee_id FROM rotation_members rm JOIN rotation_patterns rp ON rp.id = rm.pattern_id WHERE rm.tenant_id = :t AND rp.version_id = $1', [v.id]) };
    });
    const di = new Map(days.map((d, i) => [d, i])), cover = new Map<number, number>(), prevDay = addDays(b.from, -1);
    for (const sh of loaded.shifts) {
      const i = di.get(sh.day);
      if (i !== undefined) for (let g = i * SPD + sh.startSlot; g < Math.min(days.length * SPD, i * SPD + sh.startSlot + sh.lengthSlots); g++) cover.set(g, (cover.get(g) ?? 0) + 1);
      else if (sh.day === prevDay && sh.startSlot + sh.lengthSlots > SPD) for (let g = 0; g < Math.min(days.length * SPD, sh.startSlot + sh.lengthSlots - SPD); g++) cover.set(g, (cover.get(g) ?? 0) + 1);
    }
    fill = { id: loaded.v.id, name: loaded.v.name, headcount: [...cover].sort((x, y) => x[0] - y[0]), crew: new Set(loaded.crew.map((r) => r.employeeId)) };
  }
  const people = ctx.employees.filter((e) => eligible(e, b.groupId, ctx.skillBased) && (!b.employeeIds || b.employeeIds.includes(e.id)) && (!b.teamIds || (e.teamId && b.teamIds.includes(e.teamId))) && (b.employeeIds || !fill || !fill.crew.has(e.id)));
  if (!people.length) throw bad(b.employeeIds || b.teamIds ? 'No active employees match the people or teams you chose to include.' : fill ? `Everyone in this group is in a crew of "${fill.name}", so nobody is left to fill its gaps. Add people to the group, or choose who to include.` : 'No active employees are assigned to this WFM group. Add them under Workforce › Employees.');
  // what the chosen people worked just before this schedule starts, from the published schedule(s)
  let boundary: Boundary | null = null, previousName: string | null = null;
  if (b.useHistory) {
    const rows = await withTenant(p.tenantId, (tx) => tx.q<{ employeeId: string; day: string; startSlot: number; lengthSlots: number; templateId: string | null; name: string }>(
      `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, s.template_id, v.name FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
        WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND s.day >= $1::date - 7 AND s.day < $1::date AND s.employee_id = ANY($2::uuid[])`, [b.from, people.map((e) => e.id)]));
    const tplById = new Map(ctx.templates.map((t) => [t.id, t]));
    boundary = boundaryFrom(rows.map((r) => ({ employeeId: r.employeeId, day: r.day, startSlot: r.startSlot, lengthSlots: r.lengthSlots, paidSlots: paidSlots(tplById.get(r.templateId ?? ''), r.lengthSlots) })), b.from, (dowOf(b.from) - weekStart + 7) % 7, days.length * SPD);
    previousName = rows[0]?.name ?? null;
  }
  const { v: fv, required: requiredGross, uncovered, projected } = b.coverageSource === 'MANUAL'
    ? { v: null as any, ...(await requirementForManual(p.tenantId, b.groupId, days)) }
    : await requirementFor(p.tenantId, b.groupId, days, b.forecastVersionId, b.confidence);
  // earlier shifts that run past midnight into the first day still cover its first hours
  // people already scheduled (the day before, or in the schedule being filled in) count as covering their hours
  const baseCarry = mergeCarry(boundary?.carryOver ?? [], fill?.headcount ?? []);
  const required = netRequired(requiredGross, baseCarry);

  // requirement per skill, when the group's queues need different skills: coverage is then judged skill by skill
  let skillSplit: { id: string; name: string; required: number[] }[] | null = null;
  if (fv && b.coverageSource !== 'MANUAL') {
    const work = await withTenant(p.tenantId, (tx) => loadSkillWork(tx, b.groupId, fv.id, days));
    if (work) skillSplit = splitBySkill(required, work.skills.map((s) => s.work)).map((req, i) => ({ id: work.skills[i].id, name: work.skills[i].name, required: req }));
  }
  const skillIdx = new Map((skillSplit ?? []).map((s, i) => [s.id, i + 1]));
  const skillsOf = new Map<string, number[]>();
  for (const r of skillRows) { const k = skillIdx.get(r.skillId); if (k) skillsOf.set(r.employeeId, [...(skillsOf.get(r.employeeId) ?? []), k]); }

  // candidate shifts: employee x day x template x start, minus everything the rules already forbid. What rules a person out is counted for the report.
  let options: any[] = [];
  const optionsByPerson = new Map<string, number>(), blockedByPerson = new Map<string, Map<string, number>>();
  const noun = (why: string) => why.includes('time off') ? 'approved time off' : why.includes('weekend') ? 'no weekend work' : why.includes('overnight') ? 'no overnight shifts'
    : why.includes('outside their available') ? 'availability' : why.includes('unavailable') ? 'times they are unavailable' : why.includes('already scheduled') ? 'a shift in another group' : 'their availability';
  const tally = (id: string, why: string) => { const m = blockedByPerson.get(id) ?? new Map<string, number>(); m.set(why, (m.get(why) ?? 0) + 1); blockedByPerson.set(id, m); };
  const skillsByPerson = new Map<string, string[]>();
  for (const r of skillRows) skillsByPerson.set(r.employeeId, [...(skillsByPerson.get(r.employeeId) ?? []), r.skillId]);
  // every length and start time is one more candidate shift per person and day; past about 120,000 the solver needs more memory than it should have, so the choices are thinned
  const buildOptions = (maxLengths: number, startStride: number) => {
  options = []; optionsByPerson.clear(); blockedByPerson.clear();
  const lengthsByTemplate = new Map(templates.map((t) => [t.id, offeredLengths(t, maxLengths)]));
  people.forEach((e, ei) => {
    // an assigned usual start time applies unless the person is set to vary freely
    const fixed = e.fixedStartSlot != null && e.shiftConsistency !== 'OFF' ? (e.fixedStartSlot as number) : null;
    const who = { groupIds: [e.primaryGroupId, ...(e.eligibleGroupIds ?? [])].filter(Boolean) as string[], employmentType: e.employmentType as string, skillIds: skillsByPerson.get(e.id) ?? [] };
    days.forEach((day, d) => {
      const dow = dowOf(day);
      templates.forEach((t, ti) => {
        if (!t.workDays.includes(dow)) { tally(e.id, 'shift templates that do not run on their days'); return; }
        const notOffered = whyNotOffered(t, who, day);
        if (notOffered) { tally(e.id, notOffered); return; }
        for (const len of lengthsByTemplate.get(t.id)!) {
          const meal = rulesFor(t, len).mealSlots, paid = paidSlots(t, len);
          for (const s of startsFor(t, dow).filter((_, k) => k % startStride === 0)) {
            if (fixed !== null && Math.abs(s - fixed) > startTol) { tally(e.id, 'their assigned start time'); continue; }
            const why = blockedReason(ctx, e, day, s, len);
            if (why) { tally(e.id, noun(why)); continue; }
            if (shiftBlocked(ctx.rules.forTeam(e.teamId, e.id), { nightConsent: !!e.nightShiftConsent }, { startSlot: s, lengthSlots: len, mealSlots: meal })) { tally(e.id, 'a labour-law rule'); continue; }
            options.push({ employee: ei + 1, day: d, template: ti, start_slot: s, length_slots: len, paid_slots: paid, preference: preferenceFor(ctx, e, day, s, len) });
            optionsByPerson.set(e.id, (optionsByPerson.get(e.id) ?? 0) + 1);
          }
        }
      });
    });
  });
  };
  const MAX_CANDIDATES = 120_000;
  let thinned: string | null = null;
  for (const [maxLengths, stride] of [[5, 1], [3, 1], [3, 2], [2, 2], [1, 2], [1, 4]] as const) {
    buildOptions(maxLengths, stride);
    if (options.length <= MAX_CANDIDATES) { if (maxLengths < 5 || stride > 1) thinned = `${(options.length).toLocaleString('en-US')} candidate shifts after keeping ${maxLengths === 1 ? 'only the longest length' : `${maxLengths} lengths per template`}${stride > 1 ? ` and every ${stride === 2 ? 'second' : 'fourth'} start time` : ''}`; break; }
  }
  if (options.length > MAX_CANDIDATES) throw bad(`There are ${options.length.toLocaleString('en-US')} possible shifts, more than the solver can take. Choose fewer people, fewer templates or shorter start windows.`);
  if (!options.length) throw bad('Every possible shift is ruled out by availability, time off or template days. Check availability and shift templates.');

  // part-time, contract and temporary staff are held to their contract plus a tolerance; say so plainly when their shift lengths cannot make it
  const tolerance = pol.scheduling.partTimeToleranceHours ?? null;
  const capHoursOf = (e: any) => weeklyCapHours({ employmentType: e.employmentType, contractHours: Number(e.weeklyContractHours), maxHours: Number(e.maxWeeklyHours) }, tolerance);
  const paidByPerson = new Map<number, Set<number>>();
  for (const o of options) { const set = paidByPerson.get(o.employee) ?? new Set<number>(); set.add(o.paid_slots); paidByPerson.set(o.employee, set); }
  const misfits: { name: string; contractHours: number; closestHours: number | null }[] = [];
  people.forEach((e, i) => {
    const contract = Number(e.weeklyContractHours);
    if (e.employmentType === 'FULL_TIME' || !(contract > 0) || !paidByPerson.has(i + 1)) return;
    const f = contractFit([...paidByPerson.get(i + 1)!], e.workDaysPerWeek, Math.round(contract * 4), Math.round(capHoursOf(e) * 4));
    if (!f.ok) misfits.push({ name: `${e.firstName} ${e.lastName}`, contractHours: contract, closestHours: f.closest === null ? null : f.closest / 4 });
  });

  const W = b.weights;
  const res1 = await engine.schedule({
    days: days.length, first_dow: dowOf(b.from), week_start: weekStart, required,
    employees: people.map((e, i) => ({
      id: i + 1, max_week_slots: Math.round(capHoursOf(e) * 4), min_week_slots: Math.round(e.weeklyContractHours * 4), max_consecutive: e.maxConsecutiveDays, rest_slots: Math.round(e.minRestHours * 4), max_days_week: e.workDaysPerWeek,
      consist_mode: { DEFAULT: 0, OFF: 1, PREFER: 2, REQUIRE: 3 }[(e.shiftConsistency ?? 'DEFAULT') as 'DEFAULT'], skill_ids: skillsOf.get(e.id) ?? [],
      ...priorFields(boundary?.byEmployee.get(e.id)),
    })),
    options, time_limit_sec: b.timeLimitSec, w_under: W.understaffing * 10, w_over: W.overstaffing, w_hours: W.contractHours, w_pref: W.preferences, w_fair: W.fairness, workers: 8,
    consistency_mode: { OFF: 0, PREFER: 1, REQUIRE: 2 }[consist.mode], start_tol_slots: startTol, end_tol_slots: endTol, w_consist: 200,
    skill_requirements: (skillSplit ?? []).map((s, i) => ({ id: i + 1, required: s.required })), wrap: b.assumeRepeat,
  }, (b.timeLimitSec + 60 + 45 * b.weeks) * 1000);   // preparing each week's model takes time on top of the search
  if (res1.status === 'INFEASIBLE') throw bad('The rules cannot all be met with these people. Relax availability, contract limits or add people.');
  if (res1.status !== 'OPTIMAL' && res1.status !== 'FEASIBLE') throw bad(`The solver did not return a schedule in the ${b.timeLimitSec} seconds it was given (${res1.status.toLowerCase()}). Try a longer solver time, fewer people or fewer shift templates.`);

  const chosen: PlacedShift[] = res1.assignments.map((a: any) => ({ employeeId: people[a.employee - 1].id, day: days[a.day], dayIdx: a.day, startSlot: a.start_slot, length: a.length_slots, template: templates[a.template] }));
  // when the week is assumed to repeat, what the last night's shifts leave running past midnight covers the first hours: the requirement shown and judged is net of it
  const repeatSpill = b.assumeRepeat ? spillOver(chosen, days.length - 1, days.length * SPD) : [];
  const requiredFinal = netRequired(required, repeatSpill);
  const carryOver = mergeCarry(baseCarry, repeatSpill);
  const acts = placeActivities(chosen, days.length * SPD);
  // meals and breaks: move each within its slack to where the phones need people most
  const slackMin = b.breakSlackMin ?? pol.scheduling.breakSlackMin;
  let breakResult: { shiftsChanged: number; phoneShortfallBefore: number; phoneShortfallAfter: number } | null = null;
  if (b.optimizeBreaks && slackMin >= 0) {
    const q: (QShift & { placed: PlacedShift })[] = chosen.map((s) => ({ employeeId: s.employeeId, day: s.day, startSlot: s.startSlot, lengthSlots: s.length, templateId: s.template.id, activities: acts.get(s) ?? [], placed: s }));
    const r = optimizeBreaks({ days, shifts: q, required: requiredFinal, shrinkage: ctx.group.shrinkage ?? 0, slackSlots: Math.round(slackMin / 15), flexOf: (s) => (s as any).placed.template?.flexSlots ?? 0 });
    for (const m of r.moved) acts.set((m.shift as any).placed, m.activities as any);
    breakResult = { shiftsChanged: r.shiftsChanged, phoneShortfallBefore: r.phoneShortfallBefore, phoneShortfallAfter: r.phoneShortfallAfter };
  }
  const rows: ShiftRow[] = chosen.map((s) => ({ employeeId: s.employeeId, day: s.day, startSlot: s.startSlot, lengthSlots: s.length, templateId: s.template.id }));
  const solver = { status: res1.status, gap: res1.gap, wallSec: res1.wall_sec, variables: res1.variables, constraints: res1.constraints, objective: res1.objective, candidates: options.length, people: people.length };
  const stats = computeStats(ctx, days, requiredFinal, rows, solver, { uncoveredDays: uncovered, projectedDays: projected });
  const modeText = { OFF: 'Off', PREFER: 'Preferred', REQUIRE: 'Required' };
  const personal = people.filter((e) => e.shiftConsistency && e.shiftConsistency !== 'DEFAULT').length, fixedN = people.filter((e) => e.fixedStartSlot != null).length;
  const report = buildReport({
    pool: people, requested: { employeeIds: b.employeeIds, teamIds: b.teamIds }, poolSize: people.length, shifts: rows.map((r, i) => ({ ...r, activities: acts.get(chosen[i]) ?? [] })), optionsByPerson, blockedByPerson,
    uncoveredDays: uncovered, projectedDays: projected, coveragePercent: stats.coverage.percent, targetCoverage: pol.scheduling.targetCoverage, violations: stats.violations, solverStatus: res1.status,
    allEmployees: ctx.employees, groupId: b.groupId, templatesUsed: templates.length,
    consistencyNote: consist.mode !== 'OFF' || personal || fixedN ? `Company setting: ${modeText[consist.mode]}${consist.mode !== 'OFF' ? `, start may vary ${consist.startToleranceMin} min, end ${consist.endToleranceMin} min` : ''}. ${personal} ${personal === 1 ? 'person has' : 'people have'} their own setting and ${fixedN} ${fixedN === 1 ? 'has' : 'have'} an assigned start time.` : null,
    historyNote: boundary ? historyNote(boundary, previousName) : null,
    thinNote: thinned ? `The choices were thinned to keep the problem a size the solver handles well: ${thinned}. Fewer people, fewer templates or narrower start windows keep every option.` : null,
    repeatNote: b.assumeRepeat ? `Assuming the week repeats: ${repeatSpill.length ? `the shifts that run past the last midnight cover the first hours of Monday${repeatSpill[0] ? ` (up to ${Math.max(...repeatSpill.map((x) => x[1]))} people)` : ''}` : 'no shift runs past the last midnight, so the first hours get no help'}. Check this against the week before when you publish.` : null,
    crewNote: crewSizeNote({ people: people.length, contractHours: people.reduce((n, e) => n + Number(e.weeklyContractHours), 0) * b.weeks, requiredSlots: requiredFinal.reduce((n, x) => n + x, 0) }),
    contractNote: contractFitNote(misfits, tolerance),
    skillNote: skillSplit ? `Requirement split between ${skillSplit.map((s) => s.name).join(', ')} by workload; each skill is covered by the people who hold it.` : null,
  });

  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`sv:${b.groupId}`]);
    const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1', [b.groupId]))!.n;
    const name = b.name || `Schedule v${seq} · ${b.weeks} wk from ${b.from}`;
    const v = await tx.one<any>(
      `INSERT INTO schedule_versions (tenant_id, wfm_group_id, seq, name, period_start, period_end, forecast_version_id, coverage_source, settings, stats, created_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [b.groupId, seq, name, b.from, to, fv?.id ?? null, b.coverageSource, JSON.stringify({ weights: W, consistentTimes: consist, timeLimitSec: b.timeLimitSec, templateIds: templates.map((t) => t.id), forecastRev: fv?.rev ?? null, carryOver, assumeRepeat: b.assumeRepeat, weekStart, fillsFrom: fill ? { versionId: fill.id, name: fill.name, people: fill.crew.size } : null, confidence: b.coverageSource === 'MANUAL' ? 50 : b.confidence, history: boundary ? { people: boundary.people, shifts: boundary.shifts, carriedPeople: boundary.carriedPeople } : null, breakSlackMin: slackMin, breaks: breakResult, skills: skillSplit?.map((s) => ({ id: s.id, name: s.name })) ?? null, report }), JSON.stringify(stats), p.name]);
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
  const { ctx, shifts } = await withTenant(tenantId, async (tx) => ({ ctx: { ...(await loadCtx(tx, v.wfmGroupId, v.periodStart, v.periodEnd)), weekStart: v.settings?.weekStart ?? 0 }, shifts: await shiftsOf(tx, v.id) }));
  const gross = v.coverageSource === 'MANUAL'
    ? await requirementForManual(tenantId, v.wfmGroupId, days).catch(() => ({ required: new Array(days.length * SPD).fill(0), uncovered: days, projected: [] as string[] }))
    : await requirementFor(tenantId, v.wfmGroupId, days, v.forecastVersionId ?? undefined, v.settings?.confidence ?? 50).catch(() => ({ required: new Array(days.length * SPD).fill(0), uncovered: days, projected: [] as string[] }));
  const { uncovered, projected } = gross;
  const required = netRequired(gross.required, v.settings?.carryOver);   // shifts from the previous schedule that run past midnight into the first day
  const stats = computeStats(ctx, days, required, shifts, v.stats?.solver ?? null, { uncoveredDays: uncovered, projectedDays: projected });
  return { ctx, shifts, days, required, gross: gross.required as number[], stats, violations: validateShifts(ctx, shifts) };
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
  const q = parse(z.object({ day: z.string().regex(isoDay).optional(), grain: z.enum(['15', '30', '60']).default('60'), compare: uuid.optional() }), req.query);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const live = await liveStats(p.tenantId, v);
  const sched = new Array(live.days.length * SPD).fill(0), di = new Map(live.days.map((d, i) => [d, i]));
  for (const s of live.shifts) { const i = di.get(s.day)!; for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++; }
  // the need is netted against the previous schedule's overnight shifts, so judge it gross and count those people as covering it
  for (const [g, n] of (v.settings?.carryOver ?? []) as [number, number][]) if (g < sched.length) sched[g] += n;
  live.required = live.gross;
  const projectedSet = new Set<string>(live.stats.projectedDays ?? []);
  const daily = live.days.map((day, i) => {
    let need = 0, under = 0, have = 0;
    for (let s = 0; s < SPD; s++) { const g = i * SPD + s; need += live.required[g]; have += sched[g]; under += Math.max(0, live.required[g] - sched[g]); }
    return { day, requiredHours: r1(need / 4), scheduledHours: r1(have / 4), coveragePercent: need ? r1((1 - under / need) * 100) : 100, shifts: live.shifts.filter((s) => s.day === day).length, projected: projectedSet.has(day) };
  });
  let slots: any[] = [];
  const day = q.day ?? live.days[0], i = di.get(day);
  if (i !== undefined) {
    const step = q.grain === '15' ? 1 : q.grain === '30' ? 2 : 4;
    for (let s = 0; s < SPD; s += step) {
      let need = 0, have = Infinity;   // an hour needs its busiest quarter and is only as covered as its weakest
      for (let k = 0; k < step; k++) { need = Math.max(need, live.required[i * SPD + s + k]); have = Math.min(have, sched[i * SPD + s + k]); }
      slots.push({ day, slot: s, time: hhmm(s), required: need, scheduled: have, delta: have - need });
    }
  }
  // the whole period at a glance: hour by hour, an hour needs its busiest quarter and is only as covered as its weakest
  const heat = live.days.map((d, di2) => ({ day: d, hours: Array.from({ length: 24 }, (_, h) => {
    let need = 0, have = Infinity;
    for (let k = 0; k < 4; k++) { const g = di2 * SPD + h * 4 + k; need = Math.max(need, live.required[g]); have = Math.min(have, sched[g]); }
    return { need, have };
  }) }));
  let reqH = 0, haveH = 0, shortH = 0, overH = 0, worstShort: { day: string; time: string; short: number } | null = null, worstOver: { day: string; time: string; over: number } | null = null;
  for (let g = 0; g < sched.length; g++) {
    const need = live.required[g], have = sched[g], d = live.days[Math.floor(g / SPD)], t = hhmm(g % SPD);
    reqH += need; haveH += have;
    if (have < need) { shortH += need - have; if (!worstShort || need - have > worstShort.short) worstShort = { day: d, time: t, short: need - have }; }
    else if (have > need) { overH += have - need; if (!worstOver || have - need > worstOver.over) worstOver = { day: d, time: t, over: have - need }; }
  }
  const summary = { requiredHours: r1(reqH / 4), scheduledHours: r1(haveH / 4), shortHours: r1(shortH / 4), overHours: r1(overH / 4), coveragePercent: reqH ? r1((1 - shortH / reqH) * 100) : 100, worstShort, worstOver };
  // another version of the same group on the same day, for a side-by-side look
  let compare: { id: string; name: string; seq: number; scheduled: number[] } | null = null;
  if (q.compare && q.compare !== id && i !== undefined) {
    const other = await withTenant(p.tenantId, (tx) => loadVersion(tx, q.compare!));
    if (other.wfmGroupId !== v.wfmGroupId) throw bad('That schedule belongs to another WFM group');
    const theirs = await withTenant(p.tenantId, (tx) => shiftsOf(tx, q.compare!));
    const per = new Array(SPD).fill(0), prev = addDays(day, -1);
    for (const sh of theirs) {
      if (sh.day === day) for (let g = sh.startSlot; g < Math.min(SPD, sh.startSlot + sh.lengthSlots); g++) per[g]++;
      else if (sh.day === prev && sh.startSlot + sh.lengthSlots > SPD) for (let g = 0; g < sh.startSlot + sh.lengthSlots - SPD; g++) per[g]++;   // a night shift from the day before
    }
    const step2 = q.grain === '15' ? 1 : q.grain === '30' ? 2 : 4;
    compare = { id: other.id, name: other.name, seq: other.seq, scheduled: Array.from({ length: SPD / step2 }, (_, k) => Math.min(...per.slice(k * step2, k * step2 + step2))) };
  }
  res.json({ versionId: id, day, grain: q.grain, daily, slots, heat, summary, compare, shrinkage: live.ctx.group.shrinkage ?? 0, uncoveredDays: live.stats.uncoveredDays, projectedDays: live.stats.projectedDays ?? [], projected: projectedSet.has(day) });
});

/** Click an interval: who is working it, and for everyone who is not, why not. */
scheduling.get('/versions/:id/interval', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ day: z.string().regex(isoDay), slot: z.coerce.number().int().min(0).max(SPD - 1) }), req.query);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const live = await liveStats(p.tenantId, v);
  if (!live.days.includes(q.day)) throw bad('That day is outside this schedule');
  const names = new Map(live.ctx.employees.map((e: any) => [e.id, e.name as string]));
  res.json(explainInterval({ ctx: live.ctx, days: live.days, shifts: toQ(live.shifts), required: live.gross, helpers: qHelpers, day: q.day, slot: q.slot, nameOf: (eid) => names.get(eid) ?? 'Unknown' }));
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

// ---------------------------------------------------------------- quality: generation report, evaluation, shortage, break placement

const qHelpers = { blockedReason, dowOf, mondayOf, addDays };
const toQ = (shifts: any[]): QShift[] => shifts.map((s) => ({ employeeId: s.employeeId, day: s.day, startSlot: s.startSlot, lengthSlots: s.lengthSlots, templateId: s.templateId, activities: s.activities ?? [] }));
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** What happened in the generation run: the status, who was and was not scheduled, and why. Versions made before reports existed have none. */
scheduling.get('/versions/:id/report', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const r = v.settings?.report;
  res.json(r ? { available: true, versionId: id, name: v.name, ...r, consistentTimes: v.settings.consistentTimes ?? null, breaks: v.settings.breaks ?? null } : { available: false, versionId: id, name: v.name });
});
scheduling.get('/versions/:id/report.csv', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const r = v.settings?.report;
  if (!r) throw notFound('Generation report');
  const lines = [['section', 'level_or_employee_number', 'subject_or_name', 'detail'].map(csvCell).join(',')];
  lines.push(['status', '', r.status, `${r.people.scheduled} of ${r.people.inPool} people scheduled`].map(csvCell).join(','));
  for (const e of r.exceptions) lines.push(['exception', e.level, e.subject, `${e.message}${e.people?.length ? ` People: ${e.people.map((x: any) => x.name).join('; ')}` : ''}`].map(csvCell).join(','));
  for (const u of r.unscheduled ?? []) lines.push(['not scheduled', u.employeeNumber, u.name, u.reason].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="schedule-report-${v.seq}.csv"`);
  res.send(lines.join('\r\n') + '\r\n');
});

/** Estimated service level per interval, with a score for the whole schedule. Measured on what is stored now, so manual edits count. */
scheduling.get('/versions/:id/evaluation', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const detail = req.query.detail === '1';
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  if (!v.forecastVersionId) { res.json({ available: false, reason: 'This schedule was built from manual coverage windows, so there is no forecast volume to estimate service level from.' }); return; }
  const fRow = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT * FROM forecast_versions WHERE tenant_id = :t AND id = $1', [v.forecastVersionId]));
  if (!fRow) { res.json({ available: false, reason: 'The forecast this schedule was built from no longer exists.' }); return; }
  const [live, { records }] = await Promise.all([liveStats(p.tenantId, v), versionRecords(p.tenantId, fRow)]);
  const g = live.ctx.group;
  const ev = evaluateSchedule({
    days: live.days, shifts: toQ(live.shifts), required: live.required, records, serviceLevel: Number(g.serviceLevel), answerSec: Number(g.answerSec), shrinkage: Number(g.shrinkage ?? 0),
    coverage: { percent: live.stats.coverage.percent, requiredSlots: live.stats.coverage.requiredSlots, overSlots: live.stats.coverage.overSlots },
    violations: live.stats.violations, overtimeHours: live.stats.hours.overtime, paidHours: live.stats.hours.paid,
  });
  const { intervals, ...rest } = ev;
  res.json({ available: true, versionId: id, forecast: v.forecastName, ...rest, ...(detail ? { intervals } : {}) });
});

/** Where the schedule is short of the requirement and, for each gap, why nobody could cover it and what could be done. */
scheduling.get('/versions/:id/shortage', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const [live, pol] = await Promise.all([liveStats(p.tenantId, v), withTenant(p.tenantId, (tx) => loadPolicy(tx))]);
  res.json({ versionId: id, ...analyseShortage({ ctx: live.ctx, days: live.days, shifts: toQ(live.shifts), required: live.required, helpers: qHelpers, targetCoverage: pol.scheduling.targetCoverage, coveragePercent: live.stats.coverage.percent }) });
});

/** Re-place the meals and breaks of a draft inside their slack. Shifts, order and lengths stay as they are. */
scheduling.post('/versions/:id/optimize-breaks', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ slackMinutes: z.number().int().min(0).max(240).optional(), reason: z.string().trim().min(3, 'is required: say why the breaks are being moved') }), req.body);
  const { v, open } = await withTenant(p.tenantId, async (tx) => { const v = await editable(tx, id); return { v, open: await openFrom(tx, v) }; });
  const [live, pol] = await Promise.all([liveStats(p.tenantId, v), withTenant(p.tenantId, (tx) => loadPolicy(tx))]);
  const slack = b.slackMinutes ?? pol.scheduling.breakSlackMin;
  const tpl = new Map(live.ctx.templates.map((t) => [t.id, t]));
  const q = live.shifts.map((s) => ({ ...toQ([s])[0], id: s.id as string }));
  const r = optimizeBreaks({ days: live.days, shifts: q, required: live.required, shrinkage: live.ctx.group.shrinkage ?? 0, slackSlots: Math.round(slack / 15), flexOf: (s) => tpl.get(s.templateId!)?.flexSlots ?? 0 });
  // in a published schedule, days that are over stay as they were
  const dayOf = new Map(live.shifts.map((s) => [s.id as string, s.day]));
  const moved = open ? r.moved.filter((m) => (dayOf.get((m.shift as any).id) ?? open) >= open) : r.moved;
  if (moved.length) await withTenant(p.tenantId, async (tx) => {
    await tx.exec(
      `UPDATE schedule_shifts s SET activities = x.a::jsonb FROM unnest($1::uuid[], $2::text[]) AS x(id, a) WHERE s.tenant_id = :t AND s.id = x.id`,
      [moved.map((m) => (m.shift as any).id), moved.map((m) => JSON.stringify(m.activities))]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason: b.reason, diffSummary: `meals and breaks moved on ${moved.length} shifts (slack ${slack} min)` });
  });
  const after = await refreshStats(p.tenantId, id);
  if (moved.length) await withTenant(p.tenantId, (tx) => revision(tx, p, id, 'EDIT', `Meals and breaks re-placed on ${moved.length} shifts`, b.reason, after.stats));
  res.json({ shiftsChanged: r.shiftsChanged, phoneShortfallBefore: r.phoneShortfallBefore, phoneShortfallAfter: r.phoneShortfallAfter, slackMinutes: slack });
});

/**
 * Checks a planner should look at before publishing: coverage under the company target, and a forecast that has changed since. With
 * "enforce publish checks" on, publishing needs a reason when any is open; otherwise they are returned as warnings. Returns the record of who
 * accepted them, or null.
 */
async function publishChecks(p: Principal, v: any, live: { stats: any }, ackReason: unknown) {
  const pol = await withTenant(p.tenantId, (tx) => loadPolicy(tx));
  const issues: string[] = [];
  if (live.stats.coverage.percent < pol.scheduling.targetCoverage) issues.push(`Coverage is ${live.stats.coverage.percent}% against a target of ${pol.scheduling.targetCoverage}%.`);
  issues.push(...staleOf(v));
  const reason = typeof ackReason === 'string' ? ackReason.trim() : '';
  if (issues.length && pol.scheduling.enforcePublishChecks && reason.length < 3) throw new HttpError(409, 'CHECKS_NOT_ACKNOWLEDGED', `${issues[0]}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''} Give a reason to publish anyway.`, issues);
  return { issues, ack: issues.length && reason.length >= 3 ? { by: p.name, at: new Date().toISOString(), reason, issues } : null };
}

// ---------------------------------------------------------------- manual edits (draft only)

/**
 * A published schedule is the record of what was planned, so days that are already over are locked in it: they cannot be added to, changed or
 * removed. Today and later can still be corrected (with a reason). Returns the first day that is still open, or null for a draft.
 */
async function openFrom(tx: Tx, v: any): Promise<string | null> {
  if (v.status !== 'PUBLISHED') return null;
  const g = await tx.one<{ timezone: string }>('SELECT timezone FROM wfm_groups WHERE tenant_id = :t AND id = $1', [v.wfmGroupId]);
  return todayIn(g?.timezone ?? 'UTC');
}
const lockPast = (open: string | null, day: string) => {
  if (open && day < open) throw conflict(`${day} is over. Days that have passed are locked in a published schedule, so the record of what was scheduled stays as it was.`);
};
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
  const b = parse(z.object({ employeeId: uuid, day: z.string().regex(isoDay), templateId: uuid, startTime: z.string(), lengthHours: z.number().min(1).max(14).optional(), reason: z.string().trim().min(3, 'is required: say why the schedule is being changed') }), req.body);
  const start = slotOf(b.startTime);
  if (Number.isNaN(start)) throw bad('Start time must look like 08:30');
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await editable(tx, id);
    lockPast(await openFrom(tx, v), b.day);
    if (b.day < v.periodStart || b.day > v.periodEnd) throw bad(`The day must be inside the schedule period (${v.periodStart} to ${v.periodEnd})`);
    const t = await tx.one<any>('SELECT * FROM shift_templates WHERE tenant_id = :t AND id = $1', [b.templateId]);
    if (!t) throw notFound('Shift template');
    const emp = await tx.one<any>('SELECT first_name || \' \' || last_name AS name FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!emp) throw notFound('Employee');
    // a variable-length template offers several lengths; without one asked for, the longest
    const len = b.lengthHours != null ? Math.round(b.lengthHours * 4) : t.lengthSlots;
    if (!lengthsOf(t).includes(len)) throw bad(`${t.name} offers ${lengthsOf(t).map((l: number) => `${l / 4} h`).join(', ')}`);
    const acts = placeActivities([{ employeeId: b.employeeId, day: b.day, dayIdx: 0, startSlot: start, length: len, template: t }], SPD).values().next().value ?? [];
    const s = await tx.one<any>(
      `INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, 'MANUAL')
       ON CONFLICT (version_id, employee_id, day) DO UPDATE SET template_id = EXCLUDED.template_id, start_slot = EXCLUDED.start_slot, length_slots = EXCLUDED.length_slots, activities = EXCLUDED.activities, source = 'MANUAL' RETURNING id`,
      [id, b.employeeId, b.day, b.templateId, start, len, JSON.stringify(acts)]);
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
    lockPast(await openFrom(tx, v), s.day);
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
    lockPast(await openFrom(tx, v), s.day);
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
  const checks = await publishChecks(p, v0, live, req.body?.acknowledgeReason);
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec(`UPDATE schedule_versions SET status = 'ARCHIVED' WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND id <> $2 AND kind = $5 AND period_start <= $4 AND period_end >= $3`, [v0.wfmGroupId, id, v0.periodStart, v0.periodEnd, v0.kind ?? 'DEMAND']);
    await tx.exec(`UPDATE schedule_versions SET status = 'PUBLISHED', published_by = $2, published_at = now(), published_rev = rev, stats = $3, ack = $4::jsonb WHERE tenant_id = :t AND id = $1`, [id, p.name, JSON.stringify(live.stats), checks.ack ? JSON.stringify(checks.ack) : null]);
    await audit(tx, p, req, { action: 'PUBLISH', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v0.name, after: { coverage: live.stats.coverage.percent } });
    await revision(tx, p, id, 'PUBLISH', 'Published: this schedule now drives adherence', null, live.stats);
    return loadVersion(tx, id);
  });
  await dropCache(p.tenantId, 'sched:*');
  publish(p.tenantId, ['schedule', 'publish'], { id, name: out.name, by: p.name });
  res.json({ ...verDto(out), checks: checks.issues });
});

/** Re-check a published schedule after direct edits and re-stamp it as the live version. Blocks on rule violations, like publish. */
scheduling.post('/versions/:id/republish', requires('schedule:publish'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const v0 = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  if (v0.status !== 'PUBLISHED') throw conflict(`Only a published schedule can be republished (this one is ${v0.status.toLowerCase()}).`);
  const live = await liveStats(p.tenantId, v0);
  const blocking = live.violations.filter((x) => x.severity !== 'WARN');
  if (blocking.length) throw new HttpError(409, 'RULE_VIOLATIONS', `${blocking.length} rule violations must be fixed before republishing. First: ${blocking[0].message}`, blocking.slice(0, 20));
  const checks = await publishChecks(p, v0, live, req.body?.acknowledgeReason);
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec(`UPDATE schedule_versions SET published_by = $2, published_at = now(), published_rev = rev, stats = $3, ack = coalesce($4::jsonb, ack) WHERE tenant_id = :t AND id = $1`, [id, p.name, JSON.stringify(live.stats), checks.ack ? JSON.stringify(checks.ack) : null]);
    await audit(tx, p, req, { action: 'PUBLISH', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v0.name, diffSummary: 'Republished after edits' });
    await revision(tx, p, id, 'PUBLISH', 'Republished after direct edits', null, live.stats);
    return loadVersion(tx, id);
  });
  await dropCache(p.tenantId, 'sched:*');
  publish(p.tenantId, ['schedule', 'publish'], { id, name: out.name, by: p.name });
  res.json({ ...verDto(out), checks: checks.issues });
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
