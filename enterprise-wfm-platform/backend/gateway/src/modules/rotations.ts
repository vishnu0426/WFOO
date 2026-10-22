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
import { placeActivities, type PlacedShift } from './scheduleRoutes.ts';

export const rotations = Router();
const uuid = z.string().uuid();
const mod = (a: number, n: number) => ((a % n) + n) % n;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const rangeDays = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const todayUtc = () => new Date().toISOString().slice(0, 10);

const Crew = z.object({ name: z.string().trim().min(1).max(40), offsetDays: z.number().int().min(0) });
const PatternBody = z.object({
  wfmGroupId: uuid, name: z.string().trim().min(1).max(100), cycleDays: z.number().int().min(2).max(84),
  sequence: z.array(uuid.nullable()), crews: z.array(Crew).min(1).max(12), anchorDate: z.string().regex(isoDay),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(), observesHolidays: z.boolean().optional(),
});

async function checkBody(tx: Tx, b: z.infer<typeof PatternBody>) {
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
  const p = me(req), b = parse(PatternBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    await checkBody(tx, b);
    const r = await tx.one<any>(
      `INSERT INTO rotation_patterns (tenant_id, wfm_group_id, name, cycle_days, sequence, crews, anchor_date, status, observes_holidays, created_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *, anchor_date::text AS anchor_date`,
      [b.wfmGroupId, b.name, b.cycleDays, JSON.stringify(b.sequence), JSON.stringify(b.crews), b.anchorDate, b.status ?? 'ACTIVE', b.observesHolidays ?? true, p.name]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'ROTATION_PATTERN', entityId: r!.id, entityName: b.name, after: b });
    return patternDto(r);
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- one employee's rotation membership (the profile screen)
//
// Deliberately not PUT /:id/members (which replaces a whole pattern's crew list): a profile edits one person, and must
// never risk clobbering everyone else's membership. An employee is in at most one pattern from this screen -- setting a
// new one always clears any other pattern they were in, matching the single "Rotation pattern" field the profile shows.

rotations.get('/member', requires('schedule:read'), async (req, res) => {
  const p = me(req), employeeId = parse(uuid, req.query.employeeId);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT rm.pattern_id, rm.crew_name, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to, rp.name AS pattern_name
     FROM rotation_members rm JOIN rotation_patterns rp ON rp.id = rm.pattern_id WHERE rm.tenant_id = :t AND rm.employee_id = $1 LIMIT 1`, [employeeId]));
  const r = rows[0];
  res.json(r ? { patternId: r.patternId, patternName: r.patternName, crewName: r.crewName, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo } : null);
});

/** Reconcile one pattern's already-materialized shifts, from today (never earlier than the anchor) through however far it has been materialized, against its current DB membership. */
async function reconcilePattern(tx: Tx, p: any, req: any, patternId: string) {
  const pat = await tx.one<any>('SELECT *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [patternId]);
  if (!pat) return null;
  const lower = pat.anchorDate > todayUtc() ? pat.anchorDate : todayUtc();
  const from = pat.materializedThrough && pat.materializedThrough >= lower ? lower : null;
  if (!from || !pat.versionId) return null;
  const to = pat.materializedThrough as string;
  const memberRows = await tx.q<any>('SELECT employee_id, crew_name, effective_from::text AS effective_from, effective_to::text AS effective_to FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [patternId]);
  const members: Member[] = memberRows.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo }));
  const templates = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
  const holidays = pat.observesHolidays ? await loadHolidays(tx, pat.wfmGroupId, from, to) : new Set<string>();
  const { placed, byKey } = expectedShifts(pat, members, templates, holidays, rangeDays(from, to));
  const resync = await writeShifts(tx, pat.versionId, placed, byKey, from, to);
  if (resync.added || resync.removed) await audit(tx, p, req, { action: 'UPDATE', entityType: 'ROTATION_PATTERN', entityId: patternId, entityName: pat.name, diffSummary: `Membership change reconciled: ${resync.added} shift${resync.added === 1 ? '' : 's'} updated, ${resync.removed} removed, from ${from} to ${to}` });
  return resync;
}

const MemberBody = z.object({
  employeeId: uuid, patternId: uuid.nullable(), crewName: z.string().trim().min(1).max(40).optional(),
  effectiveFrom: z.string().regex(isoDay).nullable().optional(), effectiveTo: z.string().regex(isoDay).nullable().optional(),
});

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
    }
    const before = await tx.q<{ patternId: string }>('SELECT pattern_id FROM rotation_members WHERE tenant_id = :t AND employee_id = $1', [b.employeeId]);
    await tx.exec('DELETE FROM rotation_members WHERE tenant_id = :t AND employee_id = $1', [b.employeeId]);
    if (b.patternId) {
      await tx.exec('INSERT INTO rotation_members (tenant_id, pattern_id, employee_id, crew_name, effective_from, effective_to) VALUES (:t, $1, $2, $3, $4, $5)',
        [b.patternId, b.employeeId, b.crewName, b.effectiveFrom ?? null, b.effectiveTo ?? null]);
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
    const merged = { ...before, ...b };
    await checkBody(tx, { wfmGroupId: before.wfmGroupId, name: merged.name, cycleDays: merged.cycleDays, sequence: merged.sequence, crews: merged.crews, anchorDate: merged.anchorDate, status: merged.status });
    const r = await tx.one<any>(
      `UPDATE rotation_patterns SET name = $2, cycle_days = $3, sequence = $4, crews = $5, anchor_date = $6, status = $7, observes_holidays = $8, version = version + 1
       WHERE tenant_id = :t AND id = $1 RETURNING *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through`,
      [id, merged.name, merged.cycleDays, JSON.stringify(merged.sequence), JSON.stringify(merged.crews), merged.anchorDate, merged.status, merged.observesHolidays ?? true]);
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

interface Member { employeeId: string; crewName: string; effectiveFrom: string | null; effectiveTo: string | null }

/** What the pattern says should happen for each person and day in `days`, skipping people outside their effective dates and, when the pattern observes them, holidays. */
function expectedShifts(pat: any, members: Member[], templates: any[], holidays: Set<string>, days: string[]) {
  const tplById = new Map(templates.map((t) => [t.id, t]));
  const crewOffset = new Map((pat.crews as { name: string; offsetDays: number }[]).map((c) => [c.name, c.offsetDays]));
  const sequence: (string | null)[] = pat.sequence;
  const placed: PlacedShift[] = [];
  const byKey = new Map<string, PlacedShift>();
  for (const m of members) {
    const off = crewOffset.get(m.crewName) ?? 0;
    days.forEach((day, dayIdx) => {
      if (m.effectiveFrom && day < m.effectiveFrom) return;
      if (m.effectiveTo && day > m.effectiveTo) return;
      if (pat.observesHolidays && holidays.has(day)) return;
      const cycleIdx = mod(daysBetween(pat.anchorDate, day) + off, pat.cycleDays);
      const tplId = sequence[cycleIdx];
      if (!tplId) return;
      const t = tplById.get(tplId);
      if (!t || t.status !== 'ACTIVE') return;
      const ps: PlacedShift = { employeeId: m.employeeId, day, dayIdx, startSlot: t.earliestStart, length: t.lengthSlots, template: t };
      placed.push(ps); byKey.set(`${m.employeeId}|${day}`, ps);
    });
  }
  return { placed, byKey };
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
    `SELECT rm.employee_id, rm.crew_name, rm.effective_from::text AS effective_from, rm.effective_to::text AS effective_to, e.first_name || ' ' || e.last_name AS name, e.employee_number FROM rotation_members rm
     JOIN employees e ON e.id = rm.employee_id WHERE rm.tenant_id = :t AND rm.pattern_id = $1 ORDER BY rm.crew_name, e.last_name, e.first_name`, [id]));
  res.json(rows.map((r) => ({ employeeId: r.employeeId, name: r.name, employeeNumber: r.employeeNumber, crewName: r.crewName, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo })));
});

const MembersBody = z.object({ members: z.array(z.object({
  employeeId: uuid, crewName: z.string().trim().min(1), effectiveFrom: z.string().regex(isoDay).nullable().optional(), effectiveTo: z.string().regex(isoDay).nullable().optional(),
})).max(2000) });

rotations.put('/:id/members', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(MembersBody, req.body);
  for (const m of b.members) if (m.effectiveFrom && m.effectiveTo && m.effectiveTo < m.effectiveFrom) throw bad(`An end date cannot be before the start date`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const pat = await tx.one<any>('SELECT *, anchor_date::text AS anchor_date, materialized_through::text AS materialized_through FROM rotation_patterns WHERE tenant_id = :t AND id = $1', [id]);
    if (!pat) throw notFound('Rotation pattern');
    const crewNames = new Set((pat.crews as { name: string }[]).map((c) => c.name));
    for (const m of b.members) if (!crewNames.has(m.crewName)) throw bad(`'${m.crewName}' is not a crew in this pattern`);
    const emps = new Set(b.members.map((m) => m.employeeId));
    if (emps.size !== b.members.length) throw bad('A person can only be in one crew of this pattern');
    await tx.exec('DELETE FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [id]);
    if (b.members.length) await tx.exec(
      'INSERT INTO rotation_members (tenant_id, pattern_id, employee_id, crew_name, effective_from, effective_to) SELECT :t, $1, x.e, x.c, x.f::date, x.u::date FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) AS x(e, c, f, u)',
      [id, b.members.map((m) => m.employeeId), b.members.map((m) => m.crewName), b.members.map((m) => m.effectiveFrom ?? null), b.members.map((m) => m.effectiveTo ?? null)]);
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
      const members: Member[] = b.members.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom ?? null, effectiveTo: m.effectiveTo ?? null }));
      const { placed, byKey } = expectedShifts(pat, members, templates, holidays, rangeDays(from, to));
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
    const memberRows = await tx.q<any>('SELECT employee_id, crew_name, effective_from::text AS effective_from, effective_to::text AS effective_to FROM rotation_members WHERE tenant_id = :t AND pattern_id = $1', [id]);
    if (!memberRows.length) throw bad('Add people to a crew first (Manage crew members).');
    const members: Member[] = memberRows.map((m) => ({ employeeId: m.employeeId, crewName: m.crewName, effectiveFrom: m.effectiveFrom, effectiveTo: m.effectiveTo }));
    const from = pat.materializedThrough ? addDays(pat.materializedThrough, 1) : pat.anchorDate;
    if (from > b.through) throw bad(pat.materializedThrough ? `Already generated through ${pat.materializedThrough}.` : `The date must be on or after the anchor date (${pat.anchorDate}).`);
    const spanDays = daysBetween(from, b.through) + 1;
    if (spanDays > 366) throw bad('Generate at most a year (366 days) at a time. Run it again to extend further.');

    const templates = await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t');
    const days = rangeDays(from, b.through);
    const holidays = pat.observesHolidays ? await loadHolidays(tx, pat.wfmGroupId, from, b.through) : new Set<string>();
    const { placed, byKey } = expectedShifts(pat, members, templates, holidays, days);

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
    await audit(tx, p, req, { action: 'GENERATE', entityType: 'ROTATION_PATTERN', entityId: id, entityName: pat.name, after: { through: b.through, shiftsPlaced: added, days: days.length, holidaysSkipped: holidays.size } });
    return { versionId, shiftsPlaced: added, days: days.length, holidaysSkipped: holidays.size, from, through: b.through };
  });
  res.status(201).json(out);
});
