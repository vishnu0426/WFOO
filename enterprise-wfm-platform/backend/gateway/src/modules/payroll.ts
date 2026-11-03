/**
 * Payroll export. A pay period's worked time becomes pay codes: regular, overtime, night, weekend, holiday and each kind of paid leave. The run is checked
 * (missing clock-outs block it), approved (locked), then exported as CSV for the payroll system. What counts as night, when overtime starts, whether premium
 * hours replace regular pay or sit on top of it, and how hours are rounded are settings, not code.
 *
 * Hours come from clock punches, from the published schedule, or from punches where a person has some (the default). A day belongs to the day a shift starts, in the
 * time zone of the person's WFM group. The arithmetic (`splitPay`) is kept apart from the lookups so it can be tested on its own.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { addDays, dayRange } from './forecast/service.ts';
import { payWeekFor } from './payWeek.ts';
import { shiftDelta } from './clockChange.ts';
import { joinedUnpaidMeal, TPL_JOIN_COLS } from './templateRules.ts';
import { nightMinutes, roundHours, splitPay, type DayHours } from './payMath.ts';
import { tzFmt } from '../tzFormat.ts';
export { nightMinutes, roundHours, splitPay, type DayHours, type Category, type Split } from './payMath.ts';

export const payroll = Router();
const uuid = z.string().uuid();
const SPD = 96;
const r2 = (n: number) => Math.round(n * 100) / 100;
const dowOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;     // Monday = 0
const mondayOf = (day: string, weekStart = 0) => addDays(day, -((dowOf(day) - weekStart + 7) % 7));
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };

// ---------------------------------------------------------------- settings

export interface PaySettings {
  payCodes: Record<string, string>; paidLeave: string[]; nightFrom: string; nightTo: string; dailyOvertimeAfter: number | null; weeklyOvertimeAfter: number | null;
  stacking: 'EXCLUSIVE' | 'STACKED'; rounding: 'NONE' | 'TENTH' | 'QUARTER'; hoursSource: 'ACTUAL' | 'SCHEDULED' | 'ACTUAL_ELSE_SCHEDULED';
  dstPay: 'SCHEDULED' | 'WORKED';        // scheduled hours over a daylight-saving change: as scheduled, or as really elapsed
}
export async function loadPaySettings(tx: Tx): Promise<PaySettings> {
  await tx.exec('INSERT INTO payroll_settings (tenant_id) VALUES (:t) ON CONFLICT (tenant_id) DO NOTHING');
  const r = (await tx.one<any>('SELECT * FROM payroll_settings WHERE tenant_id = :t'))!;
  return { payCodes: r.payCodes, paidLeave: r.paidLeave, nightFrom: r.nightFrom, nightTo: r.nightTo, dailyOvertimeAfter: r.dailyOvertimeAfter === null ? null : Number(r.dailyOvertimeAfter), weeklyOvertimeAfter: r.weeklyOvertimeAfter === null ? null : Number(r.weeklyOvertimeAfter), stacking: r.stacking, rounding: r.rounding, hoursSource: r.hoursSource, dstPay: r.dstPay ?? 'SCHEDULED' };
}
const LEAVE_TYPES = ['VACATION', 'SICK', 'HOLIDAY', 'PERSONAL', 'TRAINING', 'LEAVE', 'OTHER'] as const;
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must look like 22:00');
const SettingsBody = z.object({
  payCodes: z.record(z.string().regex(/^[A-Z_]+$/), z.string().trim().min(1).max(20)), paidLeave: z.array(z.enum(LEAVE_TYPES)), nightFrom: clock, nightTo: clock,
  dailyOvertimeAfter: z.number().gt(0).max(24).nullable(), weeklyOvertimeAfter: z.number().gt(0).max(168).nullable(),
  stacking: z.enum(['EXCLUSIVE', 'STACKED']), rounding: z.enum(['NONE', 'TENTH', 'QUARTER']), hoursSource: z.enum(['ACTUAL', 'SCHEDULED', 'ACTUAL_ELSE_SCHEDULED']), dstPay: z.enum(['SCHEDULED', 'WORKED']).optional(),
});
payroll.get('/settings', requires('workforce:read'), async (req, res) => { res.json(await withTenant(me(req).tenantId, loadPaySettings)); });
payroll.put('/settings', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(SettingsBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await loadPaySettings(tx);
    await tx.exec(
      `UPDATE payroll_settings SET pay_codes = $1, paid_leave = $2, night_from = $3, night_to = $4, daily_overtime_after = $5, weekly_overtime_after = $6, stacking = $7, rounding = $8, hours_source = $9, dst_pay = $10, updated_at = now() WHERE tenant_id = :t`,
      [JSON.stringify(b.payCodes), b.paidLeave, b.nightFrom, b.nightTo, b.dailyOvertimeAfter, b.weeklyOvertimeAfter, b.stacking, b.rounding, b.hoursSource, b.dstPay ?? before.dstPay]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'PAYROLL_SETTINGS', entityId: 'payroll', entityName: 'Payroll settings', before, after: b });
    return loadPaySettings(tx);
  });
  res.json(out);
});

// ---------------------------------------------------------------- gathering a period

const partsIn = (ts: string, tz: string) => {
  const f = tzFmt('en-CA', tz, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts));
  const g = (t: string) => f.find((x) => x.type === t)!.value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, minute: Number(g('hour')) * 60 + Number(g('minute')) };
};

interface Line { employeeId: string; employeeNumber: string; name: string; department: string; category: string; payCode: string; hours: number; supplement?: boolean }

export async function computeRun(tx: Tx, groupId: string | null, from: string, to: string) {
  if (to < from) throw bad('The end date is before the start date');
  if (dayRange(from, to, 400).length > 62) throw bad('Run up to 62 days (two months) at a time.');
  const st = await loadPaySettings(tx);
  const weekStart = (await payWeekFor(tx, groupId)).start;
  const emps = await tx.q<any>(
    `SELECT e.id, e.employee_number, e.first_name || ' ' || e.last_name AS name, e.weekly_contract_hours, e.work_days_per_week, coalesce(t.name, '') AS department, coalesce(g.timezone, 'UTC') AS tz
       FROM employees e LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN wfm_groups g ON g.id = e.primary_group_id
      WHERE e.tenant_id = :t AND e.status <> 'ONBOARDING' AND ($1::uuid IS NULL OR e.primary_group_id = $1 OR e.eligible_group_ids @> ARRAY[$1::uuid]) ORDER BY e.last_name, e.first_name`, [groupId]);
  const ids = emps.map((e) => e.id), warnings: { kind: string; employeeNumber?: string; name?: string; day?: string; text: string }[] = [];
  if (!ids.length) return { st, lines: [] as Line[], daily: [] as any[], warnings, totals: { people: 0, hours: 0 } };
  const lo = addDays(from, -1), hi = addDays(to, 1);        // punches are looked up a day either side: the local day depends on the zone
  const punches = await tx.q<any>(`SELECT employee_id, clock_in::text AS clock_in, clock_out::text AS clock_out FROM attendance_punches WHERE tenant_id = :t AND employee_id = ANY($1::uuid[]) AND day >= $2 AND day <= $3 ORDER BY clock_in`, [ids, lo, hi]);
  const shifts = await tx.q<any>(
    `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, ${TPL_JOIN_COLS} FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id LEFT JOIN shift_templates t ON t.id = s.template_id
      WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.employee_id = ANY($1::uuid[]) AND s.day >= $2 AND s.day <= $3`, [ids, from, to]);
  const holidays = new Set((await tx.q<{ d: string }>(`SELECT d::date::text AS d FROM special_events e, generate_series(e.start_day, e.end_day, interval '1 day') d WHERE e.tenant_id = :t AND e.kind = 'holiday' AND e.start_day <= $2::date AND e.end_day >= $1::date AND (e.wfm_group_id IS NULL OR $3::uuid IS NULL OR e.wfm_group_id = $3)`, [from, to, groupId])).map((r) => r.d));
  const leave = await tx.q<any>(`SELECT employee_id, type, start_day::text AS start_day, end_day::text AS end_day FROM time_off WHERE tenant_id = :t AND status = 'APPROVED' AND employee_id = ANY($1::uuid[]) AND end_day >= $2::date AND start_day <= $3::date`, [ids, from, to]);

  const punchBy = new Map<string, any[]>(), shiftBy = new Map<string, any[]>();
  for (const x of punches) punchBy.set(x.employeeId, [...(punchBy.get(x.employeeId) ?? []), x]);
  for (const x of shifts) shiftBy.set(x.employeeId, [...(shiftBy.get(x.employeeId) ?? []), x]);

  const lines: Line[] = [], daily: any[] = [];
  for (const e of emps) {
    const byDay = new Map<string, { hours: number; night: number }>();
    const add = (day: string, minutes: number, night: number) => { if (day < from || day > to) return; const c = byDay.get(day) ?? { hours: 0, night: 0 }; c.hours += minutes / 60; c.night += night / 60; byDay.set(day, c); };
    const punched = new Set<string>();
    if (st.hoursSource !== 'SCHEDULED') {
      for (const pu of punchBy.get(e.id) ?? []) {
        const a = partsIn(pu.clockIn, e.tz);
        if (a.day < from || a.day > to) continue;
        if (!pu.clockOut) { warnings.push({ kind: 'OPEN_PUNCH', employeeNumber: e.employeeNumber, name: e.name, day: a.day, text: `${e.name} clocked in on ${a.day} and never clocked out.` }); continue; }
        const dur = Math.round((Date.parse(pu.clockOut) - Date.parse(pu.clockIn)) / 60000);
        if (dur <= 0 || dur > 20 * 60) { warnings.push({ kind: 'ODD_PUNCH', employeeNumber: e.employeeNumber, name: e.name, day: a.day, text: `${e.name} has a ${Math.round(dur / 60)} hour punch on ${a.day}; check it.` }); if (dur <= 0) continue; }
        add(a.day, dur, nightMinutes(a.minute, a.minute + dur, st.nightFrom, st.nightTo));
        punched.add(a.day);
      }
    }
    if (st.hoursSource !== 'ACTUAL') {
      const anyPunch = (punchBy.get(e.id) ?? []).length > 0;
      for (const s of shiftBy.get(e.id) ?? []) {
        if (st.hoursSource === 'ACTUAL_ELSE_SCHEDULED' && (punched.has(s.day) || anyPunch)) continue;      // a person who clocks has their punches counted, not the schedule
        const unpaid = joinedUnpaidMeal(s, s.lengthSlots);
        const clockShift = st.dstPay === 'WORKED' ? shiftDelta(s.day, s.startSlot, s.lengthSlots, e.tz).deltaMinutes : 0;      // an hour less when the clocks go forward in the shift, an hour more when they go back
        add(s.day, (s.lengthSlots - unpaid) * 15 + clockShift, nightMinutes(s.startSlot * 15, (s.startSlot + s.lengthSlots) * 15, st.nightFrom, st.nightTo));
      }
    }
    // pay weeks: overtime is counted per week, so a period that starts mid-week still counts the days before it that fall in the same week
    const weeks = new Map<string, DayHours[]>();
    for (const [day, c] of byDay) { const wk = mondayOf(day, weekStart); weeks.set(wk, [...(weeks.get(wk) ?? []), { day, hours: c.hours, nightHours: c.night, weekend: dowOf(day) >= 5, holiday: holidays.has(day) }]); }
    const contract = Number(e.weeklyContractHours) || 0, weeklyLimit = st.weeklyOvertimeAfter ?? contract;
    const tot: Record<string, number> = {}, supp: Record<string, number> = { NIGHT: 0, WEEKEND: 0 };
    for (const days of weeks.values()) {
      const sp = splitPay(days, weeklyLimit > 0 ? weeklyLimit : 1e9, st.dailyOvertimeAfter, st.stacking);
      for (const [k, v] of Object.entries(sp.totals)) tot[k] = (tot[k] ?? 0) + v;
      supp.NIGHT += sp.supplements.NIGHT; supp.WEEKEND += sp.supplements.WEEKEND;
      for (const d of sp.daily) daily.push({ employeeNumber: e.employeeNumber, name: e.name, day: d.day, payCode: st.payCodes[d.category] ?? d.category, hours: d.hours });
    }
    // paid leave: a day of the person's usual hours for each weekday (Monday to Friday) of approved leave of a paid kind
    const perDay = contract > 0 ? contract / Math.max(1, e.workDaysPerWeek) : 0;
    for (const l of leave.filter((x) => x.employeeId === e.id)) {
      if (!st.paidLeave.includes(l.type)) continue;
      const days = dayRange(l.startDay < from ? from : l.startDay, l.endDay > to ? to : l.endDay, 400).filter((d) => dowOf(d) < 5 && !holidays.has(d));
      const h = days.length * perDay;
      if (h > 0) { const key = `LEAVE:${l.type}`; tot[key] = (tot[key] ?? 0) + h; for (const d of days) daily.push({ employeeNumber: e.employeeNumber, name: e.name, day: d, payCode: st.payCodes[l.type === 'HOLIDAY' ? 'HOLIDAY_LEAVE' : l.type] ?? l.type, hours: r2(perDay) }); }
    }
    const push = (category: string, code: string | undefined, hours: number, supplement = false) => { const h = roundHours(hours, st.rounding); if (h > 0) lines.push({ employeeId: e.id, employeeNumber: e.employeeNumber, name: e.name, department: e.department, category, payCode: code ?? category, hours: h, ...(supplement ? { supplement: true } : {}) }); };
    for (const k of ['REGULAR', 'OVERTIME', 'NIGHT', 'WEEKEND', 'HOLIDAY']) push(k, st.payCodes[k], tot[k] ?? 0);
    for (const [k, v] of Object.entries(tot)) if (k.startsWith('LEAVE:')) push(k, st.payCodes[k.slice(6) === 'HOLIDAY' ? 'HOLIDAY_LEAVE' : k.slice(6)], v);
    if (st.stacking === 'STACKED') { push('NIGHT_SUPPLEMENT', st.payCodes.NIGHT, supp.NIGHT, true); push('WEEKEND_SUPPLEMENT', st.payCodes.WEEKEND, supp.WEEKEND, true); }
    if (!byDay.size && !leave.some((x) => x.employeeId === e.id) && st.hoursSource !== 'SCHEDULED' && contract > 0 && (shiftBy.get(e.id) ?? []).length) warnings.push({ kind: 'NO_TIME', employeeNumber: e.employeeNumber, name: e.name, text: `${e.name} was scheduled but has no punches and no hours were counted.` });
  }
  const sum = lines.filter((l) => !l.supplement).reduce((n, l) => n + l.hours, 0);
  return { st, lines, daily, warnings, totals: { people: new Set(lines.map((l) => l.employeeId)).size, hours: r2(sum), overtime: r2(lines.filter((l) => l.category === 'OVERTIME').reduce((n, l) => n + l.hours, 0)) } };
}

// ---------------------------------------------------------------- runs

const runDto = (r: any, full = false) => ({
  id: r.id, groupId: r.wfmGroupId, groupName: r.groupName ?? null, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status, totals: r.totals, warningCount: (r.warnings ?? []).length,
  createdBy: r.createdBy, createdAt: r.createdAt, approvedBy: r.approvedBy, approvedAt: r.approvedAt, approvalNote: r.approvalNote, exportedAt: r.exportedAt, exportedBy: r.exportedBy,
  ...(full ? { warnings: r.warnings, lines: r.lines, settings: r.settings } : {}),
});
const RUN_SQL = `SELECT r.*, r.period_start::text AS period_start, r.period_end::text AS period_end, g.name AS group_name FROM payroll_runs r LEFT JOIN wfm_groups g ON g.id = r.wfm_group_id WHERE r.tenant_id = :t`;

/** What a pay period comes to, without saving anything. */
payroll.get('/preview', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid.optional(), from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.query);
  const r = await withTenant(p.tenantId, (tx) => computeRun(tx, q.groupId ?? null, q.from, q.to));
  res.json({ totals: r.totals, warnings: r.warnings, lines: r.lines });
});

payroll.get('/runs', requires('workforce:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>(`${RUN_SQL} ORDER BY r.period_start DESC, r.created_at DESC LIMIT 100`))).map((r) => runDto(r)));
});
payroll.get('/runs/:id', requires('workforce:read'), async (req, res) => {
  const r = (await withTenant(me(req).tenantId, (tx) => tx.q<any>(`${RUN_SQL} AND r.id = $1`, [parse(uuid, req.params.id)])))[0];
  if (!r) throw notFound('Payroll run');
  res.json(runDto(r, true));
});

async function save(tx: Tx, id: string | null, groupId: string | null, from: string, to: string, by: string) {
  const c = await computeRun(tx, groupId, from, to);
  const vals = [JSON.stringify(c.st), JSON.stringify(c.lines), JSON.stringify(c.daily), JSON.stringify(c.warnings), JSON.stringify(c.totals)];
  if (id) { await tx.exec(`UPDATE payroll_runs SET settings = $2, lines = $3, daily = $4, warnings = $5, totals = $6, created_at = now(), created_by = $7 WHERE tenant_id = :t AND id = $1`, [id, ...vals, by]); return id; }
  return (await tx.one<{ id: string }>(`INSERT INTO payroll_runs (tenant_id, wfm_group_id, period_start, period_end, settings, lines, daily, warnings, totals, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [groupId, from, to, ...vals, by]))!.id;
}

payroll.post('/runs', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ groupId: uuid.nullable().default(null), from: z.string().regex(isoDay), to: z.string().regex(isoDay) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const id = await save(tx, null, b.groupId, b.from, b.to, p.name);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'PAYROLL_RUN', entityId: id, entityName: `${b.from} to ${b.to}` });
    return (await tx.q<any>(`${RUN_SQL} AND r.id = $1`, [id]))[0];
  });
  res.status(201).json(runDto(out, true));
});

payroll.post('/runs/:id/recalculate', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const r = (await tx.q<any>(`${RUN_SQL} AND r.id = $1`, [id]))[0];
    if (!r) throw notFound('Payroll run');
    if (r.status !== 'DRAFT') throw conflict('An approved run is locked. Only a draft can be recalculated.');
    await save(tx, id, r.wfmGroupId, r.periodStart, r.periodEnd, p.name);
    return (await tx.q<any>(`${RUN_SQL} AND r.id = $1`, [id]))[0];
  });
  res.json(runDto(out, true));
});

payroll.post('/runs/:id/approve', requires('schedule:approve'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(z.object({ note: z.string().trim().max(300).default('') }), req.body ?? {});
  const out = await withTenant(p.tenantId, async (tx) => {
    const r = (await tx.q<any>(`${RUN_SQL} AND r.id = $1`, [id]))[0];
    if (!r) throw notFound('Payroll run');
    if (r.status !== 'DRAFT') throw conflict(`This run is already ${r.status.toLowerCase()}.`);
    const open = (r.warnings as any[]).filter((w) => w.kind === 'OPEN_PUNCH');
    if (open.length) throw conflict(`${open.length} clock-in${open.length === 1 ? ' has' : 's have'} no clock-out (first: ${open[0].name} on ${open[0].day}). Fix the punches and recalculate before approving.`);
    const other = await tx.one<any>(`SELECT period_start::text AS s, period_end::text AS e FROM payroll_runs WHERE tenant_id = :t AND id <> $1 AND status IN ('APPROVED', 'EXPORTED') AND period_start <= $3::date AND period_end >= $2::date AND (wfm_group_id IS NULL OR $4::uuid IS NULL OR wfm_group_id = $4) LIMIT 1`, [id, r.periodStart, r.periodEnd, r.wfmGroupId]);
    if (other) throw conflict(`An approved run for ${other.s} to ${other.e} already covers some of these days, so approving this one would pay them twice.`);
    if ((r.warnings as any[]).length && b.note.length < 3) throw conflict(`${(r.warnings as any[]).length} warning${(r.warnings as any[]).length === 1 ? '' : 's'} are open (first: ${r.warnings[0].text}) Say why it is fine to approve.`);
    await tx.exec(`UPDATE payroll_runs SET status = 'APPROVED', approved_by = $2, approved_at = now(), approval_note = $3 WHERE tenant_id = :t AND id = $1`, [id, p.name, b.note || null]);
    await audit(tx, p, req, { action: 'APPROVE', entityType: 'PAYROLL_RUN', entityId: id, entityName: `${r.periodStart} to ${r.periodEnd}`, reason: b.note || undefined, after: r.totals });
    return (await tx.q<any>(`${RUN_SQL} AND r.id = $1`, [id]))[0];
  });
  res.json(runDto(out, true));
});

payroll.delete('/runs/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('SELECT status FROM payroll_runs WHERE tenant_id = :t AND id = $1', [id]);
    if (!r) throw notFound('Payroll run');
    if (r.status !== 'DRAFT') throw conflict('An approved run cannot be deleted.');
    await tx.exec('DELETE FROM payroll_runs WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'PAYROLL_RUN', entityId: id });
  });
  res.json({ ok: true });
});

const csv = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The file for the payroll system. Only an approved run can be exported; the first export is recorded. */
payroll.get('/runs/:id/export.csv', requires('schedule:approve'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), layout = req.query.layout === 'daily' ? 'daily' : 'summary';
  const r = await withTenant(p.tenantId, async (tx) => {
    const row = (await tx.q<any>(`${RUN_SQL} AND r.id = $1`, [id]))[0];
    if (!row) throw notFound('Payroll run');
    if (row.status === 'DRAFT') throw conflict('Approve the run before exporting it.');
    if (row.status === 'APPROVED') { await tx.exec(`UPDATE payroll_runs SET status = 'EXPORTED', exported_at = now(), exported_by = $2 WHERE tenant_id = :t AND id = $1`, [id, p.name]); await audit(tx, p, req, { action: 'EXPORT', entityType: 'PAYROLL_RUN', entityId: id, entityName: `${row.periodStart} to ${row.periodEnd}` }); }
    return row;
  });
  const rows = layout === 'daily'
    ? ['employee_number,name,date,pay_code,hours', ...(r.daily as any[]).sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber) || (a.day < b.day ? -1 : 1)).map((d) => [d.employeeNumber, d.name, d.day, d.payCode, d.hours].map(csv).join(','))]
    : ['employee_number,name,department,pay_code,hours,period_start,period_end,supplement', ...(r.lines as Line[]).map((l) => [l.employeeNumber, l.name, l.department, l.payCode, l.hours, r.periodStart, r.periodEnd, l.supplement ? 'Y' : ''].map(csv).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="payroll-${r.periodStart}-to-${r.periodEnd}-${layout}.csv"`).send(rows.join('\n'));
});
