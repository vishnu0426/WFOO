/**
 * The independent check of a stored schedule. The engine's validator (engine/validator.py) shares nothing with the solvers; here it is given the schedule as it is saved (the
 * shifts with their meals and breaks), each person's limits, everything else the person is committed to (shifts for other groups, approved leave) and the requirement, and
 * says whether the roster obeys every rule. Publishing needs it to pass, whoever made the roster: a solver, a rotation, or a person by hand.
 */
import { engine } from '../infra.ts';
import { HttpError } from '../http.ts';
import { cleanWeekend, weekendMask } from './payWeek.ts';
import { restAdjust } from './clockChange.ts';
import { loadPolicy } from './policyRoutes.ts';
import { withTenant } from '../db.ts';

const SPD = 96;
const dowOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

export interface Finding { severity: 'HARD' | 'SOFT'; code: string; employeeId: string | null; employeeName: string | null; day: string | null; message: string; shiftId: string | null }
export interface Verdict {
  valid: boolean; status: 'VALIDATED' | 'VALIDATED_WITH_WARNINGS' | 'INVALID'; coverageStatus: 'ADEQUATE' | 'UNDERSTAFFED'; hardViolations: number; softWarnings: number;
  coveragePercent: number; underHours: number; findings: Finding[]; days: { day: string; coveragePercent: number; underHours: number }[]; fairnessSpreadHours: number;
}

/** What the validator is asked, from the schedule as saved. `live` is what the schedule screens already load; `tenantId` is for the policy. */
export async function validationRequest(tenantId: string, live: { ctx: any; shifts: any[]; days: string[]; required: number[] }) {
  const pol = await withTenant(tenantId, (tx) => loadPolicy(tx));
  const { ctx, shifts, days } = live;
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const people = new Map<string, number>();
  const idOf = (id: string) => { let n = people.get(id); if (n === undefined) { n = people.size + 1; people.set(id, n); } return n; };
  const tpl = new Map<string, any>(ctx.templates.map((t: any) => [t.id, t]));
  for (const s of shifts) idOf(s.employeeId);
  const ofPerson = new Map<string, any>(ctx.employees.map((e: any) => [e.id, e]));
  const outShifts = shifts.filter((s) => dayIdx.has(s.day)).map((s: any) => {
    const t = s.templateId ? tpl.get(s.templateId) : null;
    return {
      employee: idOf(s.employeeId), day: dayIdx.get(s.day)!, start_slot: s.startSlot, length_slots: s.lengthSlots, unsocial: ctx.holidays?.has(s.day) ?? false, ref: s.id ?? '',
      activities: (s.activities ?? []).map((a: any) => (a.type === 'MEAL' && t?.mealPaid ? { type: 'MEAL', start_slot: a.startSlot, slots: a.slots, explicit: true, paid: true, productive: false } : { type: a.type, start_slot: a.startSlot, slots: a.slots })),
    };
  });
  // everything else each of these people is committed to: shifts for other groups (already on this group's clock) and approved leave
  const commitments: any[] = [];
  for (const o of ctx.others ?? []) {
    const i = dayIdx.get(o.day) ?? Math.round((Date.parse(o.day) - Date.parse(days[0])) / 86400000);
    if (people.has(o.employeeId) && i >= -7 && i < days.length + 7) commitments.push({ employee: people.get(o.employeeId), day: i, start_slot: o.startSlot, length_slots: o.lengthSlots, paid_slots: o.paidSlots ?? 0, kind: 'SHIFT', label: o.groupName });
  }
  for (const t of ctx.timeOff ?? []) {
    if (t.loan || !people.has(t.employeeId)) continue;
    for (const [d, i] of dayIdx) if (d >= t.startDay && d <= t.endDay) commitments.push({ employee: people.get(t.employeeId), day: i, start_slot: 0, length_slots: SPD, kind: 'LEAVE', label: 'on approved time off' });
  }
  const employees = [...people].map(([id, n]) => {
    const e = ofPerson.get(id) ?? {};
    return {
      limits: { id: n, consist_mode: ({ DEFAULT: 0, OFF: 1, PREFER: 2, REQUIRE: 3 } as Record<string, number>)[e.shiftConsistency ?? 'DEFAULT'] ?? 0, max_week_slots: Math.round(Number(e.maxWeeklyHours ?? 0) * 4), min_week_slots: Math.round(Number(e.weeklyContractHours ?? 0) * 4), max_consecutive: e.maxConsecutiveDays ?? 0, rest_slots: Math.round(Number(e.minRestHours ?? 0) * 4), max_days_week: e.workDaysPerWeek ?? 0 },
      allow_overnight: e.allowOvernight !== false, allow_weekend: e.allowWeekend !== false, name: `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim() || id,
    };
  });
  const adjust = restAdjust(days, ctx.tz ?? 'UTC');
  return {
    request: {
      days: days.length, first_dow: dowOf(days[0]), week_start: ctx.weekStart ?? 0, weekend_mask: weekendMask(cleanWeekend(pol.scheduling.weekendDays)), employees, shifts: outShifts, commitments,
      required: live.required, dst_rest_adjust: adjust.some((v) => v !== 0) ? adjust : [], target_coverage: pol.scheduling.targetCoverage / 100,
      // the company's rule on usual start and end times; a person who must have them is held to them (their own setting, above, overrides this one)
      consistency_mode: { OFF: 0, PREFER: 1, REQUIRE: 2 }[pol.scheduling.consistentTimes.mode as 'OFF'] ?? 0, start_tol_slots: Math.round(pol.scheduling.consistentTimes.startToleranceMin / 15), end_tol_slots: Math.round(pol.scheduling.consistentTimes.endToleranceMin / 15),
    },
    nameOf: (n: number) => { const e = employees[n - 1]; return e ? { id: [...people].find(([, k]) => k === n)![0], name: e.name } : { id: null, name: null }; },
  };
}

/** Run the independent check on a saved schedule. */
export async function independentCheck(tenantId: string, live: { ctx: any; shifts: any[]; days: string[]; required: number[] }): Promise<Verdict> {
  const { request, nameOf } = await validationRequest(tenantId, live);
  const r: any = await engine.validate(request, 120_000);
  return {
    valid: r.valid, status: r.status, coverageStatus: r.coverage_status, hardViolations: r.hard_violations, softWarnings: r.soft_warnings, coveragePercent: r.coverage_percent,
    underHours: Math.round((r.under_slots / 4) * 10) / 10, fairnessSpreadHours: r.fairness_spread_hours,
    findings: r.findings.map((f: any) => { const who = f.employee ? nameOf(f.employee) : { id: null, name: null }; return { severity: f.severity, code: f.code, employeeId: who.id, employeeName: who.name, day: live.days[f.day] ?? null, message: f.message, shiftId: f.ref || null }; }),
    days: r.days.map((d: any) => ({ day: live.days[d.day], coveragePercent: d.coverage_percent, underHours: Math.round((d.under_slots / 4) * 10) / 10 })),
  };
}

/**
 * The gate in front of publishing. A roster that breaks a rule is refused with the first few reasons. If the check cannot run (the engine is down) publishing waits for it: 503
 * VALIDATION_UNAVAILABLE, because a check that did not run is not a pass. VALIDATION_FAIL_OPEN=true lets an operator who accepts that risk publish anyway (logged either way).
 */
export async function requireValid(tenantId: string, live: { ctx: any; shifts: any[]; days: string[]; required: number[] }, window?: { from: string; to: string }, check: typeof independentCheck = independentCheck): Promise<Verdict | null> {
  let v: Verdict;
  try { v = await check(tenantId, live); } catch (e: any) {
    console.error('[validator] could not run the independent check:', e?.message ?? e);
    // publishing needs the check: a check that did not run is not a pass. VALIDATION_FAIL_OPEN=true restores the old behaviour for an operator who accepts that (it is logged either way)
    if (process.env.VALIDATION_FAIL_OPEN === 'true') return null;
    throw new HttpError(503, 'VALIDATION_UNAVAILABLE', 'The schedule could not be checked just now (the validation service did not answer), so it was not published. Try again in a moment.');
  }
  // publishing part of a long plan: only the days being published are judged (the weeks after are drafts)
  const hard = v.findings.filter((f) => f.severity === 'HARD' && (!window || !f.day || (f.day >= window.from && f.day <= window.to)));
  if (hard.length) {
    throw new HttpError(409, 'VALIDATION_FAILED', `The independent check found ${hard.length} rule violation${hard.length === 1 ? '' : 's'}${window ? ` in ${window.from} to ${window.to}` : ''}. First: ${hard[0].message}`, hard.slice(0, 20));
  }
  return v;
}
