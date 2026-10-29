/**
 * Rotating rosters: a fixed repeating cycle (4-on-4-off, DuPont, Pitman, "2-2-3"...) assigned once and projected
 * forward indefinitely, independent of any forecast -- the scheduling mode manufacturing, security, healthcare and
 * warehouse crews use, as opposed to the forecast-matched CP-SAT generation the rest of Scheduling does.
 *
 * A pattern holds ONE crew's repeating sequence (a shift template, or none, for each day of the cycle) and a list of
 * crews, each the same sequence offset in time. Materialising writes ordinary rows into schedule_versions /
 * schedule_shifts (kind = 'ROTATION', source = 'ROTATION'), so every existing screen -- the timeline, drag-and-drop
 * editing, publish, RTA adherence, multi-site rollup, audit -- already understands the result with no changes.
 * Publishing, viewing shifts, editing and revision history all reuse the existing /scheduling/versions/:id/* routes.
 *
 * Two things every UKG/SAP-tier product has that a bare cycle-of-days does not: a pattern can skip a day the
 * organisation has marked as a holiday (the same special_events forecasting uses), and a person's crew membership
 * can be effective-dated, so joining or leaving mid-cycle reconciles the already-generated future without
 * rewriting anything already elapsed.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { addDays } from './forecast/service.ts';
import { dowOf, placeActivities, requirementFor, requirementForManual, type PlacedShift } from './scheduleRoutes.ts';
import { loadPolicy } from './policyRoutes.ts';
import { payWeekFor } from './payWeek.ts';
import { paidSlots } from './templateRules.ts';
import { analysePattern, compileWeekly, type TemplateLite, type WeeklyStep } from './rotationPlan.ts';

export const rotations = Router();
const uuid = z.string().uuid();
const mod = (a: number, n: number) => ((a % n) + n) % n;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const rangeDays = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const todayUtc = () => new Date().toISOString().slice(0, 10);

const Crew = z.object({ name: z.string().trim().min(1).max(40), offsetDays: z.number().int().min(0) });
const Step = z.object({ name: z.string().trim().min(1).max(60), weeks: z.number().int().min(1).max(12), days: z.array(uuid.nullable()).length(7) });
const PatternBody = z.object({
  wfmGroupId: uuid, name: z.string().trim().min(1).max(100), cycleDays: z.number().int().min(2).max(84),
  sequence: z.array(uuid.nullable()), crews: z.array(Crew).min(1).max(12), anchorDate: z.string().regex(isoDay),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(), observesHolidays: z.boolean().optional(),
  kind: z.enum(['DAY_CYCLE', 'WEEKLY']).optional(),       // WEEKLY: `steps` are the pattern; sequence and cycleDays are worked out from them
  steps: z.array(Step).min(1).max(12).nullable().optional(),
});

/** A weekly rotation is stored as the day cycle it unrolls to, so the rest of this file only ever sees a sequence. Returns the body to save. */
function resolveKind<T extends { kind?: 'DAY_CYCLE' | 'WEEKLY'; steps?: WeeklyStep[] | null; sequence: (string | null)[]; cycleDays: number }>(b: T): T {
  if (b.kind !== 'WEEKLY') return { ...b, kind: 'DAY_CYCLE', steps: null };
  if (!b.steps?.length) throw bad('A weekly rotation needs at least one weekly template.');
  const sequence = compileWeekly(b.steps);
  if (sequence.length > 84) throw bad(`The weekly templates add up to ${sequence.length / 7} weeks; the longest rotation is 12 weeks.`);
  return { ...b, sequence, cycleDays: sequence.length };
}

async function checkBody(tx: Tx, b: z.infer<typeof PatternBody>) {
  if (b.kind === 'WEEKLY') {
    const pay = (await payWeekFor(tx, b.wfmGroupId)).start, dow = dowOf(b.anchorDate);
    const name = (n: number) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][n];
    if (dow !== pay) throw bad(`A weekly rotation must start on the first day of a pay week, which is ${name(pay)} for this group. ${b.anchorDate} is a ${name(dow)}. Change the anchor date, or the pay week (Configuration › WFM Groups).`);
    if (b.crews.some((c) => c.offsetDays % 7 !== 0)) throw bad('In a weekly rotation a crew starts a whole number of weeks into the rotation, so its offset must be a multiple of 7 days.');
    const stepIds = [...new Set((b.steps ?? []).flatMap((s) => s.days).filter((x): x is string => !!x))];
    if (stepIds.length) {
      const found = await tx.q<{ id: string }>('SELECT id FROM shift_templates WHERE tenant_id = :t AND id = ANY($1::uuid[])', [stepIds]);
      if (found.length !== stepIds.length) throw bad('A weekly template uses a shift template that no longer exists');
    }
  }
  if (b.sequence.length !== b.cycleDays) throw bad(`The sequence must have exactly ${b.cycleDays} entries, one per cycle day (it has ${b.sequence.length}).`);
  const names = new Set(b.crews.map((c) => c.name.toLowerCase()));
  if (names.size !== b.crews.length) throw bad('Crew names must be unique');
  if (b.crews.some((c) => c.offsetDays >= b.cycleDays)) throw bad(`A crew's offset must be less than the cycle length (${b.cycleDays} days)`);
  const ids = [...new Set(b.sequence.filter((x): x is string => !!x))];
  if (ids.length) {
    const found = await tx.q<{ id: string }>('SELECT id FROM shift_templates WHERE tenant_id = :t AND id = ANY($1::uuid[])', [ids]);
    if (found.length !== ids.length) throw bad('The sequence uses a shift template that no longer exists');
  }
}

const patternDto = (p: any, memberCount = 0) => ({
  id: p.id, wfmGroupId: p.wfmGroupId, name: p.name, cycleDays: p.cycleDays, sequence: p.sequence, crews: p.crews,
  anchorDate: p.anchorDate, status: p.status, observesHolidays: p.observesHolidays, versionId: p.versionId, materializedThrough: p.materializedThrough,
  kind: (p.kind ?? 'DAY_CYCLE') as 'DAY_CYCLE' | 'WEEKLY', steps: (p.steps ?? null) as WeeklyStep[] | null,
  memberCount, version: p.version, createdBy: p.createdBy, createdAt: p.createdAt,
});

rotations.get('/', requires('schedule:read'), async (req, res) => {
  const p = me(req), groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT rp.*, rp.anchor_date::text AS anchor_date, rp.materialized_through::text AS materialized_through, count(rm.id)::int AS member_count
     FROM rotation_patterns rp LEFT JOIN rotation_members rm ON rm.tenant_id = rp.tenant_id AND rm.pattern_id = rp.id
     WHERE rp.tenant_id = :t AND ($1::uuid IS NULL OR rp.wfm_group_id = $1) GROUP BY rp.id ORDER BY rp.name`, [groupId]));
  res.json(rows.map((r) => patternDto(r, r.memberCount)));
});

rotations.post('/', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = resolveKind(parse(PatternBody, req.body));
  const out = await withTenant(p.tenantId, async (tx) => {
    await checkBody(tx, b);
    const r = await tx.one<any>(
      `INSERT INTO rotation_patterns (tenant_id, wfm_group_id, name, cycle_days, sequence, crews, anchor_date, status, observes_holidays, created_by, kind, steps)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *, anchor_date::text AS anchor_date`,
      [b.wfmGroupId, b.name, b.cycleDays, JSON.stringify(b.sequence), JSON.stringify(b.crews), b.anchorDate, b.status ?? 'ACTIVE', b.observesHolidays ?? true, p.name, b.kind, b.steps ? JSON.stringify(b.steps) : null]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'ROTATION_PATTERN', entityId: r!.id, entityName: b.name, after: b });
    return patternDto(r);
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- what a pattern means, before anyone is put on it

/** The weekday a pay week begins on for this group (a weekly rotation has to start on it). */
rotations.get('/pay-week', requires('schedule:read'), async (req, res) => {
  const p = me(req), groupId = parse(uuid, req.query.groupId);
  res.json(await withTenant(p.tenantId, (tx) => payWeekFor(tx, groupId)));
});

const AnalyseBody = PatternBody.partial({ name: true, cycleDays: true, sequence: true });

/** Hours a week, longest run, shortest rest, weekends, and the company limits the pattern breaks. Works on an unsaved pattern, so the screen can show it as the planner edits. */
rotations.post('/analyse', requires('schedule:read'), async (req, res) => {
  const p = me(req), raw = parse(AnalyseBody, req.body);
  const b = resolveKind({ ...raw, sequence: raw.sequence ?? [], cycleDays: raw.cycleDays ?? raw.sequence?.length ?? 0 } as any) as any;
  if (b.sequence.length < 2) throw bad('A pattern needs at least two days.');
  const out = await withTenant(p.tenantId, async (tx) => {
    const g = await tx.one<any>('SELECT fte_hours_week FROM wfm_groups WHERE tenant_id = :t AND id = $1', [b.wfmGroupId]);
    if (!g) throw notFound('WFM group');
    const rows = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
    const templates = new Map<string, TemplateLite>(rows.map((t) => [t.id, { id: t.id, name: t.name, startSlot: t.earliestStart, lengthSlots: t.lengthSlots, paidSlots: paidSlots(t, t.lengthSlots), active: t.status === 'ACTIVE' }]));
    const pol = await loadPolicy(tx);
    const pay = await payWeekFor(tx, b.wfmGroupId);
    const a = analysePattern({
      cycleDays: b.sequence.length, sequence: b.sequence, crews: b.crews, anchorDow: dowOf(b.anchorDate), templates,
      limits: { minRestHours: pol.minRestHours, maxWeeklyHours: pol.maxWeeklyHours, maxConsecutiveDays: pol.maxConsecutiveDays, maxDaysPerWeek: pol.maxDaysPerWeek },
      contractHours: g.fteHoursWeek ? Number(g.fteHoursWeek) : null,
    });
    return { ...a, payWeekStart: pay.start, contractHours: g.fteHoursWeek ? Number(g.fteHoursWeek) : null };
  });
  res.json(out);
});

/** How the saved pattern, with the people in it now, covers the staffing target over the next stretch of days: before generating anything. */
rotations.get('/:id/preview', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ from: z.string().regex(isoDay).optional(), days: z.coerce.number().int().min(1).max(28).default(14), coverageSource: z.enum(['FORECAST', 'MANUAL']).default('FORECAST') }), req.query);
  const data = await withTenant(p.tenantId, async (tx) => {
    const pat = await tx.one<any>('SELECT *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [id]);
    if (!pat) throw notFound('Rotation pattern');
    const memberRows = await tx.q<any>('SELECT employee_id, crew_name, start_cycle_day, effective_from::text AS effective_from, effective_to::text AS effective_to FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [id]);
    if (!memberRows.length) return null;
    const members: Member[] = memberRows.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo, startCycleDay: m.startCycleDay ?? null }));
    const from = q.from ?? (pat.anchorDate > todayUtc() ? pat.anchorDate : todayUtc());
    const days = rangeDays(from, addDays(from, q.days - 1));
    const templates = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
    const holidays = pat.observesHolidays ? await loadHolidays(tx, pat.wfmGroupId, from, addDays(from, q.days - 1)) : new Set<string>();
    const leave = await loadLeave(tx, members.map((m) => m.employeeId), from, addDays(from, q.days - 1));
    return { pat, from, days, placed: expectedShifts(pat, members, templates, holidays, days, leave).placed };
  });
  if (!data) { res.json({ available: false, reason: 'Add people to a crew first: the preview counts the people who are in the pattern.' }); return; }
  let need: { required: number[]; uncovered: string[] };
  try {
    need = q.coverageSource === 'MANUAL' ? await requirementForManual(p.tenantId, data.pat.wfmGroupId, data.days) : await requirementFor(p.tenantId, data.pat.wfmGroupId, data.days);
  } catch (e: any) { res.json({ available: false, reason: e?.message ?? 'There is no staffing target for these days.' }); return; }
  const SPD = 96, sched = new Array(data.days.length * SPD).fill(0);
  for (const s of data.placed) for (let g = s.dayIdx * SPD + s.startSlot; g < Math.min(sched.length, s.dayIdx * SPD + s.startSlot + s.length); g++) sched[g]++;
  const gaps = need.uncovered ?? [];
  const r1 = (n: number) => Math.round(n * 10) / 10;
  let req4 = 0, have4 = 0, short4 = 0, over4 = 0, worst: { day: string; time: string; short: number } | null = null;
  const daily = data.days.map((day, i) => {
    let rq = 0, hv = 0, sh = 0, ov = 0;
    for (let sl = 0; sl < SPD; sl++) {
      const g = i * SPD + sl, r = need.required[g], h = sched[g];
      rq += r; hv += h;
      if (h < r) { sh += r - h; if (!gaps.includes(day) && (!worst || r - h > worst.short)) worst = { day, time: `${String(Math.floor(sl / 4)).padStart(2, '0')}:${String((sl % 4) * 15).padStart(2, '0')}`, short: r - h }; } else ov += h - r;
    }
    if (!gaps.includes(day)) { req4 += rq; have4 += hv; short4 += sh; over4 += ov; }
    return { day, requiredHours: r1(rq / 4), scheduledHours: r1(hv / 4), shortHours: r1(sh / 4), overHours: r1(ov / 4), coveragePercent: rq ? r1((1 - sh / rq) * 100) : 100, noTarget: gaps.includes(day) };
  });
  const heat = data.days.map((day, i) => ({ day, hours: Array.from({ length: 24 }, (_, h) => {
    let n = 0, hv = Infinity;
    for (let k = 0; k < 4; k++) { const g = i * SPD + h * 4 + k; n = Math.max(n, need.required[g]); hv = Math.min(hv, sched[g]); }
    return { need: n, have: hv };
  }) }));
  res.json({
    available: true, from: data.from, days: data.days.length, people: new Set(data.placed.map((s) => s.employeeId)).size, uncoveredDays: gaps,
    summary: { requiredHours: r1(req4 / 4), scheduledHours: r1(have4 / 4), shortHours: r1(short4 / 4), overHours: r1(over4 / 4), coveragePercent: req4 ? r1((1 - short4 / req4) * 100) : 100, worstShort: worst },
    daily, heat,
  });
});

// ---------------------------------------------------------------- one employee's rotation membership (the profile screen)
//
// Deliberately not PUT /:id/members (which replaces a whole pattern's crew list): a profile edits one person, and must
// never risk clobbering everyone else's membership. An employee is in at most one pattern from this screen -- setting a
// new one always clears any other pattern they were in, matching the single "Rotation pattern" field the profile shows.

rotations.get('/member', requires('schedule:read'), async (req, res) => {
  const p = me(req), employeeId = parse(uuid, req.query.employeeId);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT rm.pattern_id, rm.crew_name, rm.start_cycle_day, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to, rp.name AS pattern_name
     FROM rotation_members rm JOIN rotation_patterns rp ON rp.id = rm.pattern_id WHERE rm.tenant_id = :t AND rm.employee_id = $1 LIMIT 1`, [employeeId]));
  const r = rows[0];
  res.json(r ? { patternId: r.patternId, patternName: r.patternName, crewName: r.crewName, startCycleDay: r.startCycleDay ?? null, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo } : null);
});

/** Reconcile one pattern's already-materialized shifts, from today (never earlier than the anchor) through however far it has been materialized, against its current DB membership. */
async function reconcilePattern(tx: Tx, p: any, req: any, patternId: string) {
  const pat = await tx.one<any>('SELECT *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [patternId]);
  if (!pat) return null;
  const lower = pat.anchorDate > todayUtc() ? pat.anchorDate : todayUtc();
  const from = pat.materializedThrough && pat.materializedThrough >= lower ? lower : null;
  if (!from || !pat.versionId) return null;
  const to = pat.materializedThrough as string;
  const memberRows = await tx.q<any>('SELECT employee_id, crew_name, start_cycle_day, effective_from::text AS effective_from, effective_to::text AS effective_to FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [patternId]);
  const members: Member[] = memberRows.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo, startCycleDay: m.startCycleDay ?? null }));
  const templates = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
  const holidays = pat.observesHolidays ? await loadHolidays(tx, pat.wfmGroupId, from, to) : new Set<string>();
  const leave = await loadLeave(tx, members.map((m) => m.employeeId), from, to);
  const { placed, byKey } = expectedShifts(pat, members, templates, holidays, rangeDays(from, to), leave);
  const resync = await writeShifts(tx, pat.versionId, placed, byKey, from, to);
  if (resync.added || resync.removed) await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROTATION_PATTERN', entityId: patternId, entityName: pat.name, diffSummary: `Membership change reconciled: ${resync.added} shift${resync.added === 1 ? '' : 's'} updated, ${resync.removed} removed, from ${from} to ${to}` });
  return resync;
}

/** Time off was approved, cancelled or changed: bring the generated rotation shifts of every pattern this person is in back in line, from today on. Past days are never touched. */
export async function reconcileForEmployee(tx: Tx, p: any, req: any, employeeId: string) {
  const rows = await tx.q<{ patternId: string }>('SELECT DISTINCT pattern_id FROM rotation_members WHERE tenant_id = :t AND employee_id = $1', [employeeId]);
  for (const r of rows) await reconcilePattern(tx, p, req, r.patternId);
}

const MemberBody = z.object({
  employeeId: uuid, patternId: uuid.nullable(), crewName: z.string().trim().min(1).max(40).optional(),
  effectiveFrom: z.string().regex(isoDay).nullable().optional(), effectiveTo: z.string().regex(isoDay).nullable().optional(),
  startCycleDay: z.number().int().min(0).max(83).nullable().optional(),
});

/** A starting position has to be a day of this pattern's cycle (a whole week of it, for a weekly rotation). */
function checkStart(pat: { cycleDays: number; kind?: string }, start: number | null | undefined) {
  if (start == null) return;
  if (start >= pat.cycleDays) throw bad(`The starting day must be within the cycle: day 1 to day ${pat.cycleDays}.`);
  if (pat.kind === 'WEEKLY' && start % 7 !== 0) throw bad('In a weekly rotation a person starts at the beginning of a week of the rotation.');
}

rotations.put('/member', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(MemberBody, req.body);
  if (b.patternId && !b.crewName) throw bad('Choose a crew');
  if (b.effectiveFrom && b.effectiveTo && b.effectiveTo < b.effectiveFrom) throw bad('An end date cannot be before the start date');
  const out = await withTenant(p.tenantId, async (tx) => {
    const emp = await tx.one<any>('SELECT first_name, last_name FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!emp) throw notFound('Employee');
    const empName = `${emp.firstName} ${emp.lastName}`;
    let pat: any = null;
    if (b.patternId) {
      pat = await tx.one<any>('SELECT * FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [b.patternId]);
      if (!pat) throw notFound('Rotation pattern');
      const crewNames = new Set((pat.crews as { name: string }[]).map((c) => c.name));
      if (!crewNames.has(b.crewName!)) throw bad(`'${b.crewName}' is not a crew in this pattern`);
      checkStart(pat, b.startCycleDay);
    }
    const before = await tx.q<{ patternId: string }>('SELECT pattern_id FROM rotation_members WHERE tenant_id = :t AND employee_id = $1', [b.employeeId]);
    await tx.exec('DELETE FROM rotation_members WHERE tenant_id = :t AND employee_id = $1', [b.employeeId]);
    if (b.patternId) {
      await tx.exec('INSERT INTO rotation_members (tenant_id, pattern_id, employee_id, crew_name, effective_from, effective_to, start_cycle_day) VALUES (:t, $1, $2, $3, $4, $5, $6)',
        [b.patternId, b.employeeId, b.crewName, b.effectiveFrom ?? null, b.effectiveTo ?? null, b.startCycleDay ?? null]);
      await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROTATION_PATTERN', entityId: b.patternId, entityName: pat.name, diffSummary: `${empName} assigned to crew "${b.crewName}"` });
    } else if (before.length) {
      await audit(tx, p, req, { action: 'UPDATE', entityType: 'EMPLOYEE', entityId: b.employeeId, entityName: empName, diffSummary: 'Removed from their rotation pattern' });
    }
    // reconcile every pattern touched (the one left, and/or the one joined) so already-generated shifts reflect the change without waiting for the next Materialize
    const touched = new Set([...before.map((r) => r.patternId), ...(b.patternId ? [b.patternId] : [])]);
    for (const patternId of touched) await reconcilePattern(tx, p, req, patternId);
    return { ok: true };
  });
  res.json(out);
});

rotations.put('/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(PatternBody.partial({ wfmGroupId: true }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Rotation pattern');
    const merged = resolveKind({ ...before, ...b } as any) as any;
    await checkBody(tx, { wfmGroupId: before.wfmGroupId, name: merged.name, cycleDays: merged.cycleDays, sequence: merged.sequence, crews: merged.crews, anchorDate: merged.anchorDate, status: merged.status, kind: merged.kind, steps: merged.steps });
    const r = await tx.one<any>(
      `UPDATE rotation_patterns SET name = $2, cycle_days = $3, sequence = $4, crews = $5, anchor_date = $6, status = $7, observes_holidays = $8, kind = $9, steps = $10, version = version + 1
       WHERE tenant_id = :t AND id = $1 RETURNING *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through`,
      [id, merged.name, merged.cycleDays, JSON.stringify(merged.sequence), JSON.stringify(merged.crews), merged.anchorDate, merged.status, merged.observesHolidays ?? true, merged.kind, merged.steps ? JSON.stringify(merged.steps) : null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROTATION_PATTERN', entityId: id, entityName: merged.name, before, after: b });
    return patternDto(r);
  });
  res.json(out);
});

rotations.delete('/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('SELECT rp.*, v.status AS version_status FROM rotation_patterns rp LEFT JOIN schedule_versions v ON v.id = rp.version_id WHERE rp.tenant_id = :t AND rp.id = $1', [id]);
    if (!r) throw notFound('Rotation pattern');
    if (r.versionStatus === 'PUBLISHED') throw conflict('This pattern\'s roster is published. Set the pattern to inactive instead of deleting it.');
    await tx.exec('DELETE FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'ROTATION_PATTERN', entityId: id, entityName: r.name });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- holidays and the expected shift for a day

async function loadHolidays(tx: Tx, groupId: string, from: string, to: string): Promise<Set<string>> {
  const rows = await tx.q<{ startDay: string; endDay: string }>(
    `SELECT start_day::text AS start_day, end_day::text AS end_day FROM special_events
     WHERE tenant_id = :t AND kind = 'holiday' AND (wfm_group_id IS NULL OR wfm_group_id = $1) AND start_day <= $3 AND end_day >= $2`,
    [groupId, from, to]);
  const out = new Set<string>();
  for (const r of rows) for (const d of rangeDays(r.startDay < from ? from : r.startDay, r.endDay > to ? to : r.endDay)) out.add(d);
  return out;
}

/** Days people are away on approved time off, as "employeeId|day": a rotation does not put them on a shift those days. */
async function loadLeave(tx: Tx, employeeIds: string[], from: string, to: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!employeeIds.length) return out;
  const rows = await tx.q<{ employeeId: string; startDay: string; endDay: string }>(
    `SELECT employee_id, start_day::text AS start_day, end_day::text AS end_day FROM time_off
     WHERE tenant_id = :t AND status = 'APPROVED' AND employee_id = ANY($1::uuid[]) AND start_day <= $3 AND end_day >= $2`, [employeeIds, from, to]);
  for (const r of rows) for (const d of rangeDays(r.startDay < from ? from : r.startDay, r.endDay > to ? to : r.endDay)) out.add(`${r.employeeId}|${d}`);
  return out;
}

interface Member { employeeId: string; crewName: string; effectiveFrom: string | null; effectiveTo: string | null; startCycleDay?: number | null }

/** What the pattern says should happen for each person and day in `days`, skipping people outside their effective dates, days of approved time off and, when the pattern observes them, holidays. */
function expectedShifts(pat: any, members: Member[], templates: any[], holidays: Set<string>, days: string[], leave: Set<string> = new Set()) {
  const tplById = new Map(templates.map((t) => [t.id, t]));
  const crewOffset = new Map((pat.crews as { name: string; offsetDays: number }[]).map((c) => [c.name, c.offsetDays]));
  const sequence: (string | null)[] = pat.sequence;
  const placed: PlacedShift[] = [];
  const byKey = new Map<string, PlacedShift>();
  let leaveSkipped = 0;
  for (const m of members) {
    const off = crewOffset.get(m.crewName) ?? 0;
    days.forEach((day, dayIdx) => {
      if (m.effectiveFrom && day < m.effectiveFrom) return;
      if (m.effectiveTo && day > m.effectiveTo) return;
      if (pat.observesHolidays && holidays.has(day)) return;
      // a person with a starting position is on that day of the cycle on the day they join (else the anchor date); everyone else follows their crew
      const cycleIdx = m.startCycleDay != null
        ? mod(daysBetween(m.effectiveFrom ?? pat.anchorDate, day) + m.startCycleDay, pat.cycleDays)
        : mod(daysBetween(pat.anchorDate, day) + off, pat.cycleDays);
      const tplId = sequence[cycleIdx];
      if (!tplId) return;
      const t = tplById.get(tplId);
      if (!t || t.status !== 'ACTIVE') return;
      if (leave.has(`${m.employeeId}|${day}`)) { leaveSkipped++; return; }   // approved time off: no shift that day
      const ps: PlacedShift = { employeeId: m.employeeId, day, dayIdx, startSlot: t.earliestStart, length: t.lengthSlots, template: t };
      placed.push(ps); byKey.set(`${m.employeeId}|${day}`, ps);
    });
  }
  return { placed, byKey, leaveSkipped };
}

/** Write `placed` into the version (never overwriting a hand-edited shift) and remove rotation-source shifts the pattern no longer expects, within [from, to] only. */
async function writeShifts(tx: Tx, versionId: string, placed: PlacedShift[], byKey: Map<string, PlacedShift>, from: string, to: string) {
  const acts = placeActivities(placed, rangeDays(from, to).length * 96);
  const existing = await tx.q<{ employeeId: string; day: string; source: string }>(
    'SELECT employee_id, day::text AS day, source FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day >= $2 AND day <= $3', [versionId, from, to]);
  const manualKeys = new Set(existing.filter((e) => e.source !== 'ROTATION').map((e) => `${e.employeeId}|${e.day}`));
  const toWrite = placed.filter((s) => !manualKeys.has(`${s.employeeId}|${s.day}`));
  if (toWrite.length) await tx.exec(
    `INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source)
     SELECT :t, $1, x.e, x.d, x.tp, x.s, x.l, x.a::jsonb, 'ROTATION' FROM unnest($2::uuid[], $3::date[], $4::uuid[], $5::int[], $6::int[], $7::text[]) AS x(e, d, tp, s, l, a)
     ON CONFLICT (version_id, employee_id, day) DO UPDATE SET template_id = EXCLUDED.template_id, start_slot = EXCLUDED.start_slot, length_slots = EXCLUDED.length_slots, activities = EXCLUDED.activities, source = 'ROTATION'`,
    [versionId, toWrite.map((s) => s.employeeId), toWrite.map((s) => s.day), toWrite.map((s) => s.template!.id), toWrite.map((s) => s.startSlot), toWrite.map((s) => s.length), toWrite.map((s) => JSON.stringify(acts.get(s) ?? []))]);
  const toRemove = existing.filter((e) => e.source === 'ROTATION' && !byKey.has(`${e.employeeId}|${e.day}`));
  if (toRemove.length) await tx.exec(
    `DELETE FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND source = 'ROTATION' AND (employee_id, day) IN (SELECT * FROM unnest($2::uuid[], $3::date[]))`,
    [versionId, toRemove.map((e) => e.employeeId), toRemove.map((e) => e.day)]);
  return { added: toWrite.length, removed: toRemove.length };
}

// ---------------------------------------------------------------- crew membership

rotations.get('/:id/members', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT rm.employee_id, rm.crew_name, rm.start_cycle_day, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to, e.first_name || ' ' || e.last_name AS name, e.employee_number FROM rotation_members rm
     JOIN employees e ON e.id = rm.employee_id WHERE rm.tenant_id = :t AND rm.pattern_id = $1 ORDER BY rm.crew_name, e.last_name, e.first_name`, [id]));
  res.json(rows.map((r) => ({ employeeId: r.employeeId, name: r.name, employeeNumber: r.employeeNumber, crewName: r.crewName, startCycleDay: r.startCycleDay ?? null, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo })));
});

const MembersBody = z.object({ members: z.array(z.object({
  employeeId: uuid, crewName: z.string().trim().min(1), effectiveFrom: z.string().regex(isoDay).nullable().optional(), effectiveTo: z.string().regex(isoDay).nullable().optional(),
  startCycleDay: z.number().int().min(0).max(83).nullable().optional(),
})).max(2000) });

rotations.put('/:id/members', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(MembersBody, req.body);
  for (const m of b.members) if (m.effectiveFrom && m.effectiveTo && m.effectiveTo < m.effectiveFrom) throw bad(`An end date cannot be before the start date`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const pat = await tx.one<any>('SELECT *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [id]);
    if (!pat) throw notFound('Rotation pattern');
    const crewNames = new Set((pat.crews as { name: string }[]).map((c) => c.name));
    for (const m of b.members) { if (!crewNames.has(m.crewName)) throw bad(`'${m.crewName}' is not a crew in this pattern`); checkStart(pat, m.startCycleDay); }
    const emps = new Set(b.members.map((m) => m.employeeId));
    if (emps.size !== b.members.length) throw bad('A person can only be in one crew of this pattern');
    await tx.exec('DELETE FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [id]);
    if (b.members.length) await tx.exec(
      'INSERT INTO rotation_members (tenant_id, pattern_id, employee_id, crew_name, effective_from, effective_to, start_cycle_day) SELECT :t, $1, x.e, x.c, x.f::date, x.u::date, x.s FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::int[]) AS x(e, c, f, u, s)',
      [id, b.members.map((m) => m.employeeId), b.members.map((m) => m.crewName), b.members.map((m) => m.effectiveFrom ?? null), b.members.map((m) => m.effectiveTo ?? null), b.members.map((m) => m.startCycleDay ?? null)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROTATION_PATTERN', entityId: id, entityName: pat.name, diffSummary: `Crew membership set: ${b.members.length} people` });

    // reconcile what is already generated, from today (never earlier than the anchor) through however far the pattern has been materialized,
    // so a join or leave date takes effect without waiting for the next "Generate"
    let resync: { added: number; removed: number } | null = null;
    const lower = pat.anchorDate > todayUtc() ? pat.anchorDate : todayUtc();
    const from = pat.materializedThrough && pat.materializedThrough >= lower ? lower : null;
    if (from && pat.versionId) {
      const to = pat.materializedThrough as string;
      const templates = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
      const holidays = pat.observesHolidays ? await loadHolidays(tx, pat.wfmGroupId, from, to) : new Set<string>();
      const members: Member[] = b.members.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom ?? null, effectiveTo: m.effectiveTo ?? null, startCycleDay: m.startCycleDay ?? null }));
      const leave = await loadLeave(tx, members.map((m) => m.employeeId), from, to);
      const { placed, byKey } = expectedShifts(pat, members, templates, holidays, rangeDays(from, to), leave);
      resync = await writeShifts(tx, pat.versionId, placed, byKey, from, to);
      if (resync.added || resync.removed) await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROTATION_PATTERN', entityId: id, entityName: pat.name, diffSummary: `Membership change reconciled: ${resync.added} shift${resync.added === 1 ? '' : 's'} updated, ${resync.removed} removed, from ${from} to ${to}` });
    }
    return { ok: true, resync };
  });
  res.json(out);
});

// ---------------------------------------------------------------- materialize: turn the pattern into real shifts

rotations.post('/:id/materialize', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ through: z.string().regex(isoDay) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`rot:${id}`]);
    const pat = await tx.one<any>('SELECT *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [id]);
    if (!pat) throw notFound('Rotation pattern');
    const memberRows = await tx.q<any>('SELECT employee_id, crew_name, start_cycle_day, effective_from::text AS effective_from, effective_to::text AS effective_to FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [id]);
    if (!memberRows.length) throw bad('Add people to a crew first (Manage crew members).');
    const members: Member[] = memberRows.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo, startCycleDay: m.startCycleDay ?? null }));
    const from = pat.materializedThrough ? addDays(pat.materializedThrough, 1) : pat.anchorDate;
    if (from > b.through) throw bad(pat.materializedThrough ? `Already generated through ${pat.materializedThrough}.` : `The date must be on or after the anchor date (${pat.anchorDate}).`);
    const spanDays = daysBetween(from, b.through) + 1;
    if (spanDays > 366) throw bad('Generate at most a year (366 days) at a time. Run it again to extend further.');

    const templates = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
    const days = rangeDays(from, b.through);
    const holidays = pat.observesHolidays ? await loadHolidays(tx, pat.wfmGroupId, from, b.through) : new Set<string>();
    const leave = await loadLeave(tx, members.map((m) => m.employeeId), from, b.through);
    const { placed, byKey, leaveSkipped } = expectedShifts(pat, members, templates, holidays, days, leave);

    let versionId = pat.versionId as string | null;
    if (!versionId) {
      const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1', [pat.wfmGroupId]))!.n;
      const v = await tx.one<{ id: string }>(
        `INSERT INTO schedule_versions (tenant_id, wfm_group_id, seq, name, status, kind, period_start, period_end, settings, stats, created_by)
         VALUES (:t, $1, $2, $3, 'DRAFT', 'ROTATION', $4, $5, '{}', '{}', $6) RETURNING id`,
        [pat.wfmGroupId, seq, pat.name, from, b.through, p.name]);
      versionId = v!.id;
    } else {
      await tx.exec(`UPDATE schedule_versions SET period_end = GREATEST(period_end, $2::date), rev = rev + 1 WHERE tenant_id = :t AND id = $1`, [versionId, b.through]);
    }
    const { added } = await writeShifts(tx, versionId, placed, byKey, from, b.through);
    await tx.exec('UPDATE rotation_patterns SET version_id = $2, materialized_through = $3 WHERE tenant_id = :t AND id = $1', [id, versionId, b.through]);
    await audit(tx, p, req, { action: 'GENERATE', entityType: 'ROTATION_PATTERN', entityId: id, entityName: pat.name, after: { through: b.through, shiftsPlaced: added, days: days.length, holidaysSkipped: holidays.size, leaveShiftsSkipped: leaveSkipped } });
    return { versionId, shiftsPlaced: added, days: days.length, holidaysSkipped: holidays.size, leaveShiftsSkipped: leaveSkipped, from, through: b.through };
  });
  res.status(201).json(out);
});
