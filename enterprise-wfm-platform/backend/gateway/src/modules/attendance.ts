/**
 * Time & attendance: punches (clock in / out), independent of RTA agent-state (which tracks live ACD activity, not
 * physical presence). Punches are imported from a time-clock export, compared against the published schedule, and
 * rolled into a payroll export -- regular, overtime and premium hours per person per day, the thing nowhere else in
 * the platform produces even though overtime-premium *hours* are already computed for compliance.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { payWeekFor } from './payWeek.ts';
import { me, requires, requiresAny, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, HttpError, isoDay, notFound, parse } from '../http.ts';
import { parseCsv, parseDay, parseMinute } from './csv.ts';
import { dowOf } from './scheduleRoutes.ts';
import { applyExcuses, classifyDay, EXCUSABLE, graceMinutes, ISSUES, minutesFromDay, nowMinutesFrom, REASONS, weekView, type ExcusableKind, type Issue } from './attendanceMath.ts';
import { loadPolicy } from './policyRoutes.ts';
import { approverLevel, teamLimit } from './approvals.ts';
import { joinedUnpaidMeal, TPL_JOIN_COLS } from './templateRules.ts';
import { addDays } from './forecast/service.ts';

export const attendance = Router();
const uuid = z.string().uuid();
const r1 = (v: number) => Math.round(v * 10) / 10;
const mondayOf = (day: string, weekStart = 0) => addDays(day, -((dowOf(day) - weekStart + 7) % 7));   // first day of the pay week `day` is in
const hoursOf = (inAt: string | Date, outAt: string | Date) => (new Date(outAt).getTime() - new Date(inAt).getTime()) / 3_600_000;

// ---------------------------------------------------------------- CSV import

export const ATTENDANCE_TEMPLATE_CSV = `employee_number,day,clock_in,clock_out
E100,2026-01-05,08:58,17:03
E100,2026-01-06,09:02,17:00
E101,2026-01-05,08:55,13:00
`;

interface PlanRow { line: number; employeeId: string; employeeNumber: string; day: string; clockIn: string; clockOut: string | null; existing: boolean }

async function plan(tx: Tx, csv: string): Promise<{ plan: PlanRow[]; errors: { line: number; message: string }[] }> {
  const matrix = parseCsv(csv);
  if (matrix.length < 2) throw bad('The file has no data rows');
  const header = matrix[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = { emp: header.indexOf('employee_number'), day: header.indexOf('day'), cin: header.indexOf('clock_in'), cout: header.indexOf('clock_out') };
  if (col.emp < 0) throw bad("No 'employee_number' column");
  if (col.day < 0) throw bad("No 'day' column");
  if (col.cin < 0) throw bad("No 'clock_in' column");
  const emps = await tx.q<{ id: string; employeeNumber: string; timezone: string | null }>('SELECT id, employee_number, timezone FROM employees WHERE tenant_id = :t');
  const byNo = new Map(emps.map((e) => [e.employeeNumber.toLowerCase(), e]));
  const errors: { line: number; message: string }[] = [];
  const out: PlanRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i], line = i + 1;
    const fail = (message: string) => errors.push({ line, message });
    const empNo = (row[col.emp] || '').trim();
    const e = byNo.get(empNo.toLowerCase());
    if (!e) { fail(`Unknown employee number '${empNo}'`); continue; }
    const day = parseDay(row[col.day] || '');
    if (!day) { fail(`Bad date '${row[col.day]}'`); continue; }
    const inMin = parseMinute(row[col.cin] || '');
    if (inMin === null) { fail(`Bad clock-in time '${row[col.cin]}'`); continue; }
    const outRaw = col.cout >= 0 ? (row[col.cout] || '').trim() : '';
    const outMin = outRaw ? parseMinute(outRaw) : null;
    if (outRaw && outMin === null) { fail(`Bad clock-out time '${outRaw}'`); continue; }
    const clockIn = `${day}T${String(Math.floor(inMin / 60)).padStart(2, '0')}:${String(inMin % 60).padStart(2, '0')}:00Z`;
    let clockOut: string | null = null;
    if (outMin !== null) {
      const over = outMin <= inMin ? 1 : 0;   // a clock-out earlier than clock-in is the next day (an overnight shift)
      const d2 = over ? addDays(day, 1) : day;
      clockOut = `${d2}T${String(Math.floor(outMin / 60)).padStart(2, '0')}:${String(outMin % 60).padStart(2, '0')}:00Z`;
    }
    out.push({ line, employeeId: e.id, employeeNumber: e.employeeNumber, day, clockIn, clockOut, existing: false });
  }
  if (out.length) {
    const days = out.map((r) => r.day);
    // compare by instant (epoch seconds), not text: casting a timestamptz to text does not round-trip to the same string we built above
    const existing = new Set((await tx.q<{ k: string }>(
      "SELECT employee_id || '|' || day::text || '|' || extract(epoch FROM clock_in)::bigint::text AS k FROM attendance_punches WHERE tenant_id = :t AND day >= $1 AND day <= $2",
      [days.reduce((a, b) => (b < a ? b : a)), days.reduce((a, b) => (b > a ? b : a))])).map((r) => r.k));
    for (const r of out) r.existing = existing.has(`${r.employeeId}|${r.day}|${Math.floor(Date.parse(r.clockIn) / 1000)}`);
  }
  return { plan: out, errors };
}

attendance.post('/import', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const { plan: rows, errors } = await plan(tx, b.csv);
    const fresh = rows.filter((r) => !r.existing);
    const result = { dryRun: b.dryRun, rowsRead: rows.length, newPunches: fresh.length, alreadyImported: rows.length - fresh.length, errors: errors.slice(0, 100), errorCount: errors.length, committed: false };
    if (b.dryRun || !fresh.length) return result;
    await tx.exec(
      `INSERT INTO attendance_punches (tenant_id, workspace_id, employee_id, day, clock_in, clock_out, source, created_by)
       SELECT :t, :w, x.e, x.d::date, x.ci::timestamptz, NULLIF(x.co, '')::timestamptz, 'IMPORT', $5
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS x(e, d, ci, co)
       ON CONFLICT (tenant_id, workspace_id, employee_id, day, clock_in) DO NOTHING`,
      [fresh.map((r) => r.employeeId), fresh.map((r) => r.day), fresh.map((r) => r.clockIn), fresh.map((r) => r.clockOut ?? ''), p.name]);
    await audit(tx, p, req, { action: 'IMPORT', entityType: 'ATTENDANCE', entityId: 'import', entityName: 'Time punches', after: { newPunches: fresh.length } });
    return { ...result, committed: true };
  });
  res.json(out);
});

attendance.get('/template.csv', requires('workforce:read'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', 'attachment; filename="attendance-template.csv"').send(ATTENDANCE_TEMPLATE_CSV);
});

// ---------------------------------------------------------------- punches (list, manual add, delete)

const punchDto = (r: any) => ({ id: r.id, employeeId: r.employeeId, employeeName: r.employeeName, day: r.day, clockIn: r.clockIn, clockOut: r.clockOut, hours: r.clockOut ? r1(hoursOf(r.clockIn, r.clockOut)) : null, source: r.source, note: r.note });

attendance.get('/punches', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ employeeId: uuid.optional(), from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional() }), req.query);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT ap.*, e.first_name || ' ' || e.last_name AS employee_name FROM attendance_punches ap JOIN employees e ON e.id = ap.employee_id
     WHERE ap.tenant_id = :t AND ($1::uuid IS NULL OR ap.employee_id = $1) AND ($2::date IS NULL OR ap.day >= $2) AND ($3::date IS NULL OR ap.day <= $3)
     ORDER BY ap.day DESC, ap.clock_in`, [q.employeeId ?? null, q.from ?? null, q.to ?? null]));
  res.json(rows.map(punchDto));
});

attendance.post('/punches', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ employeeId: uuid, day: z.string().regex(isoDay), clockIn: z.string(), clockOut: z.string().nullable().optional(), note: z.string().max(200).optional() }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const e = await tx.one<any>('SELECT first_name || \' \' || last_name AS name FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!e) throw notFound('Employee');
    const r = await tx.one<any>(
      `INSERT INTO attendance_punches (tenant_id, employee_id, day, clock_in, clock_out, source, note, created_by) VALUES (:t, $1, $2, $3, $4, 'MANUAL', $5, $6) RETURNING *`,
      [b.employeeId, b.day, b.clockIn, b.clockOut ?? null, b.note ?? '', p.name]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'ATTENDANCE', entityId: r!.id, entityName: `${e.name} ${b.day}`, after: b });
    return punchDto({ ...r, employeeName: e.name });
  });
  res.status(201).json(out);
});

attendance.delete('/punches/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('DELETE FROM attendance_punches WHERE tenant_id = :t AND id = $1 RETURNING id, employee_id, day::text AS day', [req.params.id]);
    if (!r) throw notFound('Punch');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'ATTENDANCE', entityId: r.id, entityName: r.day });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- summary and payroll export

export async function summarize(tx: Tx, groupId: string | null, from: string, to: string, scope: { teamIds: string[]; self: string | null } | null = null, now = new Date()) {
  const payStart = (await payWeekFor(tx, groupId)).start;   // overtime is counted per pay week: the group's, else the company's
  const grace = graceMinutes((await loadPolicy(tx)).adherenceGraceSeconds);
  const emps = await tx.q<any>(
    `SELECT id, employee_number, first_name || ' ' || last_name AS name, weekly_contract_hours, team_id FROM employees
     WHERE tenant_id = :t AND ($1::uuid IS NULL OR primary_group_id = $1 OR eligible_group_ids @> ARRAY[$1::uuid])
       AND ($2::uuid[] IS NULL OR team_id = ANY($2::uuid[]) OR id = $3::uuid)`, [groupId, scope ? scope.teamIds : null, scope?.self ?? null]);
  const empIds = emps.map((e) => e.id);
  if (!empIds.length) return { days: [], weeks: [], payStart, graceMinutes: grace };
  const punches = await tx.q<any>(
    `SELECT id, employee_id, day::text AS day, to_char(clock_in AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS clock_in, to_char(clock_out AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS clock_out, source FROM attendance_punches
     WHERE tenant_id = :t AND employee_id = ANY($1::uuid[]) AND day >= $2 AND day <= $3 ORDER BY employee_id, day, clock_in`, [empIds, from, to]);
  const excuses = await tx.q<any>(
    `SELECT id, employee_id, day::text AS day, kind, reason_code, note, paid, level, excused_by, excused_at FROM attendance_exceptions WHERE tenant_id = :t AND employee_id = ANY($1::uuid[]) AND day >= $2 AND day <= $3`, [empIds, from, to]);
  const excByKey = new Map<string, any[]>();
  for (const x of excuses) { const k = `${x.employeeId}|${x.day}`; excByKey.set(k, [...(excByKey.get(k) ?? []), x]); }
  const shifts = await tx.q<any>(
    `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, g.timezone AS tz, ${TPL_JOIN_COLS} FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
     JOIN wfm_groups g ON g.id = v.wfm_group_id
     LEFT JOIN shift_templates t ON t.id = s.template_id WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.employee_id = ANY($1::uuid[]) AND s.day >= $2 AND s.day <= $3`, [empIds, from, to]);
  const empById = new Map(emps.map((e) => [e.id, e]));
  // a person can have more than one shift on a day (a split shift): hours add up, and the day runs from the first start to the last end
  const sched = new Map<string, { hours: number; startMin: number; endMin: number; tz: string }>();
  for (const s of shifts) {
    const k = `${s.employeeId}|${s.day}`, h = (s.lengthSlots - joinedUnpaidMeal(s, s.lengthSlots)) / 4, a = s.startSlot * 15, b = (s.startSlot + s.lengthSlots) * 15, cur = sched.get(k);
    sched.set(k, cur ? { hours: cur.hours + h, startMin: Math.min(cur.startMin, a), endMin: Math.max(cur.endMin, b), tz: cur.tz } : { hours: h, startMin: a, endMin: b, tz: s.tz ?? 'UTC' });
  }
  const punchByKey = new Map<string, any[]>();
  for (const pu of punches) { const k = `${pu.employeeId}|${pu.day}`; punchByKey.set(k, [...(punchByKey.get(k) ?? []), pu]); }
  const hhmm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const dayKeys = new Set<string>([...sched.keys(), ...punchByKey.keys()]);
  const days = [...dayKeys].map((k) => {
    const [employeeId, day] = k.split('|');
    const sc = sched.get(k);
    const ps = punchByKey.get(k) ?? [];
    const r = classifyDay({
      sched: sc ? { hours: r1(sc.hours), startMin: sc.startMin, endMin: sc.endMin } : null,
      punches: ps.map((pu) => ({ inMin: minutesFromDay(pu.clockIn, day), outMin: pu.clockOut ? minutesFromDay(pu.clockOut, day) : null })),
      nowMin: nowMinutesFrom(day, sc?.tz ?? 'UTC', now), graceMin: grace,
    });
    const scheduledHours = r1(sc?.hours ?? 0);
    const e = empById.get(employeeId);
    // only the excuses for a problem the day really has are shown and applied
    const excused = (excByKey.get(k) ?? []).filter((x) => (r.issues as string[]).includes(x.kind));
    const issues = applyExcuses(r.issues, excused.map((x) => x.kind as ExcusableKind));
    const status = r.status === 'MISSED' && excused.some((x) => x.kind === 'missed') ? 'EXCUSED' : r.status;
    return {
      employeeId, employeeNumber: e?.employeeNumber ?? '', name: e?.name ?? '', day, scheduledHours, actualHours: r.actualHours, varianceHours: r1(r.actualHours - scheduledHours), status,
      lateMinutes: r.lateMinutes, earlyLeaveMinutes: r.earlyLeaveMinutes, due: r.due, issues, excused: excused.map((x) => ({ id: x.id as string, kind: x.kind as ExcusableKind, reasonCode: x.reasonCode as string, note: x.note as string, paid: !!x.paid, level: x.level as string, by: x.excusedBy as string, at: x.excusedAt as string })), paidExcuse: excused.some((x) => x.kind === 'missed' && x.paid), shift: sc ? `${hhmm(sc.startMin)}–${hhmm(sc.endMin)}` : null,
      punches: ps.map((pu) => ({ id: pu.id, clockIn: pu.clockIn, clockOut: pu.clockOut, source: pu.source })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || (a.day < b.day ? -1 : 1));

  const weekMap = new Map<string, { employeeId: string; weekStart: string; actualHours: number; scheduledHours: number }>();
  for (const d of days) {
    const wk = mondayOf(d.day, payStart), key = `${d.employeeId}|${wk}`;
    const w = weekMap.get(key) ?? { employeeId: d.employeeId, weekStart: wk, actualHours: 0, scheduledHours: 0 };
    w.actualHours += d.actualHours; w.scheduledHours += d.scheduledHours; weekMap.set(key, w);
  }
  const weeks = [...weekMap.values()].map((w) => { const e = empById.get(w.employeeId); const contract = e?.weeklyContractHours ?? 0; return { ...w, employeeNumber: e?.employeeNumber ?? '', name: e?.name ?? '', actualHours: r1(w.actualHours), scheduledHours: r1(w.scheduledHours), overtimeHours: r1(Math.max(0, w.actualHours - contract)) }; });
  return { days, weeks, payStart, graceMinutes: grace };
}

attendance.get('/summary', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.query);
  res.json(await withTenant(p.tenantId, async (tx) => summarize(tx, q.groupId ?? null, q.from, q.to, await teamLimit(tx, p))));
});

attendance.get('/week', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({
    groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay), issue: z.enum(ISSUES as [Issue, ...Issue[]]).optional(), q: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  }), req.query);
  if (q.to < q.from) throw bad('The end date is before the start date');
  const s = await withTenant(p.tenantId, async (tx) => summarize(tx, q.groupId ?? null, q.from, q.to, await teamLimit(tx, p)));
  res.json({ from: q.from, to: q.to, payStart: s.payStart, graceMinutes: s.graceMinutes, ...weekView(s.days, s.weeks, { issue: q.issue, q: q.q, limit: q.limit, offset: q.offset }) });
});

// ---------------------------------------------------------------- excusing a problem

const ExcuseFields = { reasonCode: z.enum(REASONS), note: z.string().trim().max(300).default(''), paid: z.boolean().default(false) };
const excuseDto = (r: any) => ({ id: r.id, employeeId: r.employeeId, day: r.day, kind: r.kind as ExcusableKind, reasonCode: r.reasonCode as string, note: r.note as string, paid: !!r.paid, level: r.level as string, by: r.excusedBy as string, at: r.excusedAt as string });

/**
 * Excuse problems for people on days, all or nothing. Who may: a manager anywhere, a supervisor for their own team (the same rule as leave). Refused for a day that has not happened
 * yet, and for a day inside a payroll run that is approved or exported (reopen the run first), so a figure that has been paid on does not change underneath it.
 */
export async function excuseItems(tx: Tx, p: Principal, req: Request | null, items: { employeeId: string; day: string; kind: ExcusableKind }[], o: { reasonCode: string; note: string; paid: boolean }) {
  if (o.reasonCode === 'OTHER' && o.note.trim().length < 3) throw bad('Say what happened when the reason is "Other"');
  const seen = new Set<string>(), uniq = items.filter((i) => { const k = `${i.employeeId}|${i.day}|${i.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) return { excused: 0 };
  const ids = [...new Set(uniq.map((i) => i.employeeId))];
  const emps = new Map((await tx.q<any>('SELECT id, first_name || \' \' || last_name AS name, primary_group_id FROM employees WHERE tenant_id = :t AND id = ANY($1::uuid[])', [ids])).map((e) => [e.id as string, e]));
  for (const id of ids) if (!emps.has(id)) throw notFound('Employee');
  const horizon = addDays(new Date().toISOString().slice(0, 10), 1);
  const future = uniq.find((i) => i.day > horizon);
  if (future) throw bad(`${future.day} has not happened yet, so there is nothing to excuse.`);
  let level: 'MANAGER' | 'SUPERVISOR' = 'MANAGER';
  for (const id of ids) { const l = await approverLevel(tx, p, id, 'workforce:write'); if (l === 'SUPERVISOR') level = 'SUPERVISOR'; }
  await assertNotLocked(tx, uniq.map((i) => ({ day: i.day, groupId: emps.get(i.employeeId).primaryGroupId })));
  await tx.exec(
    `INSERT INTO attendance_exceptions (tenant_id, employee_id, day, kind, reason_code, note, paid, level, excused_by, excused_by_id)
     SELECT :t, e, d::date, k, $4, $5, $6, $7, $8, $9 FROM unnest($1::uuid[], $2::text[], $3::text[]) AS x(e, d, k)
     ON CONFLICT (tenant_id, employee_id, day, kind) DO UPDATE SET reason_code = EXCLUDED.reason_code, note = EXCLUDED.note, paid = EXCLUDED.paid, level = EXCLUDED.level,
       excused_by = EXCLUDED.excused_by, excused_by_id = EXCLUDED.excused_by_id, excused_at = now()`,
    [uniq.map((i) => i.employeeId), uniq.map((i) => i.day), uniq.map((i) => i.kind), o.reasonCode, o.note, o.paid, level, p.name, p.userId]);
  await audit(tx, p, req, { action: 'CREATE', entityType: 'ATTENDANCE_EXCEPTION', entityId: ids.length === 1 ? ids[0] : 'many', entityName: ids.length === 1 ? `${emps.get(ids[0]).name}, ${uniq.length} day${uniq.length === 1 ? '' : 's'}` : `${ids.length} people, ${uniq.length} problems`,
    reason: o.reasonCode, after: { reasonCode: o.reasonCode, note: o.note, paid: o.paid, level, items: uniq.slice(0, 100) } });
  return { excused: uniq.length };
}

/** A pay period that is approved or exported is closed to changes. */
async function assertNotLocked(tx: Tx, days: { day: string; groupId: string | null }[]) {
  const lo = days.reduce((a, b) => (b.day < a ? b.day : a), days[0].day), hi = days.reduce((a, b) => (b.day > a ? b.day : a), days[0].day);
  const runs = await tx.q<any>(`SELECT wfm_group_id, period_start::text AS s, period_end::text AS e FROM payroll_runs WHERE tenant_id = :t AND status IN ('APPROVED', 'EXPORTED') AND period_end >= $1::date AND period_start <= $2::date`, [lo, hi]);
  for (const d of days) {
    const r = runs.find((x) => x.s <= d.day && x.e >= d.day && (!x.wfmGroupId || x.wfmGroupId === d.groupId));
    if (r) throw new HttpError(409, 'PAY_PERIOD_LOCKED', `Payroll for ${r.s} to ${r.e} is already approved, so ${d.day} is closed. Reopen that payroll run first.`);
  }
}

attendance.post('/exceptions', requiresAny('workforce:write', 'requests:approve'), async (req, res) => {
  const p = me(req), b = parse(z.object({ items: z.array(z.object({ employeeId: uuid, day: z.string().regex(isoDay), kind: z.enum(EXCUSABLE as [ExcusableKind, ...ExcusableKind[]]) })).min(1).max(500), ...ExcuseFields }), req.body);
  res.status(201).json(await withTenant(p.tenantId, (tx) => excuseItems(tx, p, req, b.items, b)));
});

/**
 * Excuse every person-day of one kind that the screen is showing under a filter (a clock outage that hit the whole floor): the server finds them itself, so it covers every page and not
 * only the one on screen.
 */
attendance.post('/exceptions/by-filter', requiresAny('workforce:write', 'requests:approve'), async (req, res) => {
  const p = me(req), b = parse(z.object({ groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay), issue: z.enum(EXCUSABLE as [ExcusableKind, ...ExcusableKind[]]), q: z.string().max(80).optional(), ...ExcuseFields }), req.body);
  if (b.to < b.from) throw bad('The end date is before the start date');
  const out = await withTenant(p.tenantId, async (tx) => {
    const s = await summarize(tx, b.groupId ?? null, b.from, b.to, await teamLimit(tx, p));
    const q = (b.q ?? '').trim().toLowerCase();
    const items = s.days.filter((d) => d.issues.includes(b.issue) && (!q || `${d.name} ${d.employeeNumber}`.toLowerCase().includes(q))).map((d) => ({ employeeId: d.employeeId, day: d.day, kind: b.issue }));
    if (!items.length) return { matched: 0, excused: 0 };
    if (items.length > 2000) throw bad(`That is ${items.length} days at once. Narrow it to one group or a search, or excuse them in smaller sets.`);
    return { matched: items.length, ...(await excuseItems(tx, p, req, items, b)) };
  });
  res.status(201).json(out);
});

attendance.get('/exceptions', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ employeeId: uuid.optional(), from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional() }), req.query);
  const rows = await withTenant(p.tenantId, async (tx) => {
    const lim = await teamLimit(tx, p);
    return tx.q<any>(
      `SELECT x.*, x.day::text AS day, e.first_name || ' ' || e.last_name AS employee_name, e.employee_number FROM attendance_exceptions x JOIN employees e ON e.id = x.employee_id
        WHERE x.tenant_id = :t AND ($1::uuid IS NULL OR x.employee_id = $1) AND ($2::date IS NULL OR x.day >= $2) AND ($3::date IS NULL OR x.day <= $3)
          AND ($4::uuid[] IS NULL OR e.team_id = ANY($4::uuid[]) OR e.id = $5::uuid) ORDER BY x.day DESC, e.employee_number LIMIT 1000`, [q.employeeId ?? null, q.from ?? null, q.to ?? null, lim ? lim.teamIds : null, lim?.self ?? null]);
  });
  res.json(rows.map((r) => ({ ...excuseDto(r), employeeName: r.employeeName, employeeNumber: r.employeeNumber })));
});

attendance.delete('/exceptions/:id', requiresAny('workforce:write', 'requests:approve'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('SELECT x.*, x.day::text AS day, e.primary_group_id FROM attendance_exceptions x JOIN employees e ON e.id = x.employee_id WHERE x.tenant_id = :t AND x.id = $1', [id]);
    if (!r) throw notFound('Excuse');
    await approverLevel(tx, p, r.employeeId, 'workforce:write');
    await assertNotLocked(tx, [{ day: r.day, groupId: r.primaryGroupId }]);
    await tx.exec('DELETE FROM attendance_exceptions WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'ATTENDANCE_EXCEPTION', entityId: id, entityName: `${r.day} ${r.kind}`, before: excuseDto(r) });
  });
  res.json({ ok: true });
});

attendance.get('/payroll-export.csv', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.query);
  const { days, weeks, payStart } = await withTenant(p.tenantId, async (tx) => summarize(tx, q.groupId ?? null, q.from, q.to, await teamLimit(tx, p)));
  const otByWeek = new Map(weeks.map((w) => [`${w.employeeId}|${w.weekStart}`, w]));
  const rows = ['employee_number,name,day,scheduled_hours,actual_hours,regular_hours,overtime_hours,status'];
  for (const d of days) {
    const w = otByWeek.get(`${d.employeeId}|${mondayOf(d.day, payStart)}`);
    // weekly overtime (actual hours over the person's weekly contract) apportioned across the week's days by each day's share of actual hours
    const ot = w && w.actualHours > 0 ? r1((d.actualHours / w.actualHours) * w.overtimeHours) : 0;
    const reg = d.status === 'EXCUSED' && d.paidExcuse ? d.scheduledHours : r1(d.actualHours - ot);   // an excused missed day marked as paid is paid at the scheduled hours
    rows.push([d.employeeNumber, `"${d.name}"`, d.day, d.scheduledHours, d.actualHours, reg, ot, d.status].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="payroll-${q.from}-to-${q.to}.csv"`).send(rows.join('\n'));
});
