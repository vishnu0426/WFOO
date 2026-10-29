/**
 * Time & attendance: punches (clock in / out), independent of RTA agent-state (which tracks live ACD activity, not
 * physical presence). Punches are imported from a time-clock export, compared against the published schedule, and
 * rolled into a payroll export -- regular, overtime and premium hours per person per day, the thing nowhere else in
 * the platform produces even though overtime-premium *hours* are already computed for compliance.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, isoDay, notFound, parse } from '../http.ts';
import { parseCsv, parseDay, parseMinute } from './csv.ts';
import { dowOf } from './scheduleRoutes.ts';
import { addDays } from './forecast/service.ts';

export const attendance = Router();
const uuid = z.string().uuid();
const r1 = (v: number) => Math.round(v * 10) / 10;
const mondayOf = (day: string) => addDays(day, -dowOf(day));
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

async function summarize(tx: Tx, groupId: string | null, from: string, to: string) {
  const emps = await tx.q<any>(
    `SELECT id, employee_number, first_name || ' ' || last_name AS name, weekly_contract_hours FROM employees
     WHERE tenant_id = :t AND ($1::uuid IS NULL OR primary_group_id = $1 OR $1 = ANY(eligible_group_ids))`, [groupId]);
  const empIds = emps.map((e) => e.id);
  if (!empIds.length) return { days: [], weeks: [] };
  const punches = await tx.q<any>(
    `SELECT employee_id, day::text AS day, clock_in::text AS clock_in, clock_out::text AS clock_out FROM attendance_punches
     WHERE tenant_id = :t AND employee_id = ANY($1::uuid[]) AND day >= $2 AND day <= $3 ORDER BY employee_id, day, clock_in`, [empIds, from, to]);
  const shifts = await tx.q<any>(
    `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, t.meal_slots FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
     LEFT JOIN shift_templates t ON t.id = s.template_id WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND s.employee_id = ANY($1::uuid[]) AND s.day >= $2 AND s.day <= $3`, [empIds, from, to]);
  const empById = new Map(emps.map((e) => [e.id, e]));
  const schedByKey = new Map(shifts.map((s) => [`${s.employeeId}|${s.day}`, r1(((s.lengthSlots - (s.mealSlots ?? 0)) / 4))]));
  const punchByKey = new Map<string, any[]>();
  for (const pu of punches) { const k = `${pu.employeeId}|${pu.day}`; punchByKey.set(k, [...(punchByKey.get(k) ?? []), pu]); }

  const dayKeys = new Set<string>([...schedByKey.keys(), ...punchByKey.keys()]);
  const days = [...dayKeys].map((k) => {
    const [employeeId, day] = k.split('|');
    const scheduledHours = schedByKey.get(k) ?? 0;
    const ps = punchByKey.get(k) ?? [];
    const actualHours = r1(ps.reduce((s, pu) => s + (pu.clockOut ? hoursOf(pu.clockIn, pu.clockOut) : 0), 0));
    const open = ps.some((pu) => !pu.clockOut);
    const status = !ps.length && scheduledHours > 0 ? 'MISSED' : ps.length && scheduledHours === 0 ? 'UNSCHEDULED' : open ? 'OPEN' : 'MATCHED';
    const e = empById.get(employeeId);
    return { employeeId, employeeNumber: e?.employeeNumber ?? '', name: e?.name ?? '', day, scheduledHours, actualHours, varianceHours: r1(actualHours - scheduledHours), status, punches: ps.map((pu) => ({ clockIn: pu.clockIn, clockOut: pu.clockOut })) };
  }).sort((a, b) => a.name.localeCompare(b.name) || (a.day < b.day ? -1 : 1));

  const weekMap = new Map<string, { employeeId: string; weekStart: string; actualHours: number; scheduledHours: number }>();
  for (const d of days) {
    const wk = mondayOf(d.day), key = `${d.employeeId}|${wk}`;
    const w = weekMap.get(key) ?? { employeeId: d.employeeId, weekStart: wk, actualHours: 0, scheduledHours: 0 };
    w.actualHours += d.actualHours; w.scheduledHours += d.scheduledHours; weekMap.set(key, w);
  }
  const weeks = [...weekMap.values()].map((w) => { const e = empById.get(w.employeeId); const contract = e?.weeklyContractHours ?? 0; return { ...w, employeeNumber: e?.employeeNumber ?? '', name: e?.name ?? '', actualHours: r1(w.actualHours), scheduledHours: r1(w.scheduledHours), overtimeHours: r1(Math.max(0, w.actualHours - contract)) }; });
  return { days, weeks };
}

attendance.get('/summary', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.query);
  res.json(await withTenant(p.tenantId, (tx) => summarize(tx, q.groupId ?? null, q.from, q.to)));
});

attendance.get('/payroll-export.csv', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.query);
  const { days, weeks } = await withTenant(p.tenantId, (tx) => summarize(tx, q.groupId ?? null, q.from, q.to));
  const otByWeek = new Map(weeks.map((w) => [`${w.employeeId}|${w.weekStart}`, w]));
  const rows = ['employee_number,name,day,scheduled_hours,actual_hours,regular_hours,overtime_hours,status'];
  for (const d of days) {
    const w = otByWeek.get(`${d.employeeId}|${mondayOf(d.day)}`);
    // weekly overtime (actual hours over the person's weekly contract) apportioned across the week's days by each day's share of actual hours
    const ot = w && w.actualHours > 0 ? r1((d.actualHours / w.actualHours) * w.overtimeHours) : 0;
    const reg = r1(d.actualHours - ot);
    rows.push([d.employeeNumber, `"${d.name}"`, d.day, d.scheduledHours, d.actualHours, reg, ot, d.status].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="payroll-${q.from}-to-${q.to}.csv"`).send(rows.join('\n'));
});
