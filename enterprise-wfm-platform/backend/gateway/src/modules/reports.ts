/**
 * Scheduled reports. A report is a table (columns and rows) worked out from data the platform already holds; it can be run now and downloaded, or put on a timetable
 * (daily, weekly, monthly at a local hour) so the CSV arrives by email and every run is kept. Dates are named ("last week", "next 7 days") and worked out on the day
 * a report runs, in the report's time zone.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../db.ts';
import { me, requires, permissionsFor, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { publish } from '../infra.ts';
import { dayRange } from './forecast/service.ts';
import { summarize } from './attendance.ts';
import { computeRun } from './payroll.ts';
import { liveStats, loadVersion } from './scheduleRoutes.ts';
import { payWeekFor } from './payWeek.ts';
import { nextRun, RANGES, resolveRange, type Range } from './reportTime.ts';
import { queueMessage } from './channels.ts';
import { toPdf } from './reportPdf.ts';

export const reports = Router();
const uuid = z.string().uuid();
const SPD = 96;
const r1 = (n: number) => Math.round(n * 10) / 10;
const hhmm = (slot: number) => `${String(Math.floor(slot / 4) % 24).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;

type Table = { columns: string[]; rows: (string | number)[][] };
interface Def { id: string; label: string; help: string; needs: string; run: (tx: Tx, tenantId: string, groupId: string | null, from: string, to: string) => Promise<Table> }

export const REPORTS: Def[] = [
  { id: 'ROSTER', label: 'Roster', help: 'Who works when: one row per shift in the published schedule.', needs: 'schedule:read',
    run: async (tx, _t, groupId, from, to) => {
      const rows = await tx.q<any>(
        `SELECT e.employee_number, e.first_name || ' ' || e.last_name AS name, coalesce(tm.name, '') AS team, g.name AS grp, s.day::text AS day, s.start_slot, s.length_slots, coalesce(t.name, '') AS template
           FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id JOIN employees e ON e.id = s.employee_id LEFT JOIN teams tm ON tm.id = e.team_id LEFT JOIN wfm_groups g ON g.id = v.wfm_group_id LEFT JOIN shift_templates t ON t.id = s.template_id
          WHERE s.tenant_id = :t AND v.status = 'PUBLISHED' AND (v.publish_through IS NULL OR s.day <= v.publish_through) AND s.day >= $1::date AND s.day <= $2::date AND ($3::uuid IS NULL OR v.wfm_group_id = $3)
          ORDER BY s.day, s.start_slot, e.last_name`, [from, to, groupId]);
      return { columns: ['Date', 'Employee number', 'Name', 'Team', 'Group', 'Start', 'End', 'Shift'], rows: rows.map((r) => [r.day, r.employeeNumber, r.name, r.team, r.grp, hhmm(r.startSlot), hhmm(r.startSlot + r.lengthSlots), r.template]) };
    } },
  { id: 'COVERAGE', label: 'Coverage against the forecast', help: 'For each day: hours the forecast needs, hours scheduled and the share covered. Needs a WFM group with a published schedule.', needs: 'schedule:read',
    run: async (tx, tenantId, groupId, from, to) => {
      if (!groupId) throw bad('Choose a WFM group for the coverage report.');
      const v = await tx.one<any>(`SELECT id FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND kind = 'DEMAND' AND period_start <= $3::date AND period_end >= $2::date ORDER BY seq DESC LIMIT 1`, [groupId, from, to]);
      if (!v) throw bad('There is no published schedule for that group over these dates.');
      const live = await liveStats(tenantId, await loadVersion(tx, v.id));
      const idx = new Map((live.days as string[]).map((d, i) => [d, i])), sched = new Array(live.days.length * SPD).fill(0);
      for (const s of live.shifts as any[]) { const i = idx.get(s.day); if (i === undefined) continue; for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++; }
      const rows = dayRange(from, to, 400).filter((d) => idx.has(d)).map((d) => {
        const i = idx.get(d)!; let need = 0, have = 0, short = 0;
        for (let g = i * SPD; g < (i + 1) * SPD; g++) { need += live.required[g]; have += sched[g]; if (sched[g] < live.required[g]) short++; }
        return [d, r1(need / 4), r1(have / 4), need ? r1((1 - Math.max(0, need - Math.min(have, need)) / need) * 100) : 100, short];
      });
      return { columns: ['Date', 'Hours needed', 'Hours scheduled', 'Covered %', 'Quarter-hours short'], rows };
    } },
  { id: 'ATTENDANCE', label: 'Attendance', help: 'Scheduled against worked hours for each person and day, with missed and unscheduled days.', needs: 'workforce:read',
    run: async (tx, _t, groupId, from, to) => {
      const s = await summarize(tx, groupId, from, to);
      return { columns: ['Date', 'Employee number', 'Name', 'Scheduled hours', 'Worked hours', 'Difference', 'Status'], rows: s.days.map((d: any) => [d.day, d.employeeNumber, d.name, d.scheduledHours, d.actualHours, d.varianceHours, d.status]) };
    } },
  { id: 'PAYROLL_PREVIEW', label: 'Payroll hours (preview)', help: 'Hours by pay code for each person, worked out with the payroll settings. A preview: approve a payroll run to lock and export one.', needs: 'workforce:read',
    run: async (tx, _t, groupId, from, to) => {
      const c = await computeRun(tx, groupId, from, to);
      return { columns: ['Employee number', 'Name', 'Department', 'Pay code', 'Hours'], rows: c.lines.map((l) => [l.employeeNumber, l.name, l.department, l.payCode, l.hours]) };
    } },
  { id: 'TIME_OFF', label: 'Time off', help: 'Requests and approved leave that touch the dates.', needs: 'workforce:read',
    run: async (tx, _t, groupId, from, to) => {
      const rows = await tx.q<any>(
        `SELECT e.employee_number, e.first_name || ' ' || e.last_name AS name, o.type, o.start_day::text AS s, o.end_day::text AS e, o.status, (o.end_day - o.start_day + 1) AS days
           FROM time_off o JOIN employees e ON e.id = o.employee_id WHERE o.tenant_id = :t AND o.end_day >= $1::date AND o.start_day <= $2::date AND ($3::uuid IS NULL OR e.primary_group_id = $3) ORDER BY o.start_day, e.last_name`, [from, to, groupId]);
      return { columns: ['Employee number', 'Name', 'Type', 'From', 'To', 'Days', 'Status'], rows: rows.map((r) => [r.employeeNumber, r.name, r.type, r.s, r.e, r.days, r.status]) };
    } },
];

/** Payroll is a data export, not a document to read, so it stays CSV only. */
const pdfOk = (id: string) => id !== 'PAYROLL_PREVIEW';
const LOGO = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO = 300_000;                                                          // characters of the data URL: a small logo, not a photograph
async function branding(orgId: string): Promise<{ name: string; logo: string | null }> {
  const [t] = await raw<{ name: string; logo: string | null }>('SELECT name, logo FROM tenants WHERE id = $1', [orgId]);
  return { name: t?.name ?? '', logo: t?.logo ?? null };
}
const logoBuffer = (dataUrl: string | null) => (dataUrl && LOGO.test(dataUrl) ? Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64') : null);
const stamp = (d: Date, tz: string) => { try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(d) + ` (${tz})`; } catch { return d.toISOString(); } };
async function makePdf(orgId: string, def: Def, name: string, table: Table, from: string, to: string, tz: string): Promise<string> {
  const b = await branding(orgId);
  const bytes = await toPdf({ title: name || def.label, subtitle: `${def.label} · ${from} to ${to}`, orgName: b.name, logo: logoBuffer(b.logo), columns: table.columns, rows: table.rows, generatedAt: stamp(new Date(), tz) });
  return bytes.toString('base64');
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return typeof v === 'string' && /^[=+\-@]/.test(s) ? `'${s}` : s; };                  // a name that starts with = would be run as a formula by a spreadsheet
const esc = (v: unknown) => { const s = csvCell(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (t: Table) => [t.columns.map(esc).join(','), ...t.rows.map((r) => r.map(esc).join(','))].join('\n');

const tzOf = async (tx: Tx, groupId: string | null) => (await tx.one<{ timezone: string }>(groupId ? 'SELECT timezone FROM wfm_groups WHERE tenant_id = :t AND id = $1' : 'SELECT timezone FROM tenants WHERE id = :t', groupId ? [groupId] : []))?.timezone ?? 'UTC';

// ---------------------------------------------------------------- run now

reports.get('/catalog', requires('workforce:read'), (_req, res) => {
  res.json({ reports: REPORTS.map((r) => ({ id: r.id, label: r.label, help: r.help, pdf: pdfOk(r.id) })), ranges: RANGES.map((r) => ({ id: r.toString(), label: r.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) })) });
});

const RunBody = z.object({ report: z.enum(REPORTS.map((r) => r.id) as [string, ...string[]]), groupId: uuid.nullable().default(null), range: z.enum(RANGES).optional(), from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional() })
  .refine((b) => b.range || (b.from && b.to), { message: 'Give a named range or both dates' });

async function allowed(p: Principal, def: Def) {
  if (p.scopes) { if (!p.scopes.includes(def.needs)) throw bad(`Your key cannot read this report (needs ${def.needs}).`); return; }
  if (!(await permissionsFor(p.tenantId, p.role)).has(def.needs)) throw bad(`Your role cannot run this report (needs ${def.needs}).`);
}

reports.post('/run', requires('workforce:read'), async (req, res) => {
  const p = me(req), b = parse(RunBody, req.body), def = REPORTS.find((r) => r.id === b.report)!;
  await allowed(p, def);
  const out = await withTenant(p.tenantId, async (tx) => {
    const { from, to } = b.range ? resolveRange(b.range as Range, new Date(), await tzOf(tx, b.groupId), (await payWeekFor(tx, b.groupId)).start) : { from: b.from!, to: b.to! };
    if (to < from) throw bad('The end date is before the start date');
    return { from, to, table: await def.run(tx, p.tenantId, b.groupId, from, to) };
  });
  if (req.query.format === 'pdf') {
    if (!pdfOk(def.id)) throw bad('Payroll reports are CSV only.');
    const pdf = await makePdf(p.tenantId, def, def.label, out.table, out.from, out.to, await withTenant(p.tenantId, (tx) => tzOf(tx, b.groupId)));
    return void res.setHeader('Content-Type', 'application/pdf').setHeader('Content-Disposition', `attachment; filename="${def.id.toLowerCase()}-${out.from}-to-${out.to}.pdf"`).send(Buffer.from(pdf, 'base64'));
  }
  if (req.query.format === 'csv') return void res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="${def.id.toLowerCase()}-${out.from}-to-${out.to}.csv"`).send(toCsv(out.table));
  res.json({ report: def.id, label: def.label, from: out.from, to: out.to, columns: out.table.columns, total: out.table.rows.length, rows: out.table.rows.slice(0, 500) });
});

// ---------------------------------------------------------------- the logo on PDF reports

reports.get('/branding', requires('workforce:read'), async (req, res) => { const b = await branding(me(req).tenantId); res.json({ name: b.name, logo: b.logo }); });
reports.put('/branding', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ logo: z.string().nullable() }), req.body);
  if (b.logo !== null) {
    if (!LOGO.test(b.logo)) throw bad('The logo must be a PNG or JPEG picture.');
    if (b.logo.length > MAX_LOGO) throw bad('The logo is too large. Use a small picture, under about 200 KB.');
  }
  await raw('UPDATE tenants SET logo = $2 WHERE id = $1', [p.tenantId, b.logo]);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'ORGANISATION_LOGO', entityId: p.tenantId, entityName: 'Logo on PDF reports', after: { hasLogo: b.logo !== null } }));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- timetable

const Recipients = z.object({ emails: z.array(z.string().email()).max(30).default([]), roles: z.array(z.enum(['WFM_ADMIN', 'WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST'])).max(6).default([]) });
const ScheduleBody = z.object({
  name: z.string().trim().min(2).max(80), report: z.enum(REPORTS.map((r) => r.id) as [string, ...string[]]), groupId: uuid.nullable().default(null), range: z.enum(RANGES),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']), dayOfWeek: z.number().int().min(0).max(6).nullable().default(null), dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
  hour: z.number().int().min(0).max(23), timezone: z.string().max(60).optional(), recipients: Recipients, enabled: z.boolean().default(true), format: z.enum(['CSV', 'PDF', 'BOTH']).default('CSV'),
})
  .refine((b) => b.format === 'CSV' || pdfOk(b.report), { message: 'Payroll reports are CSV only', path: ['format'] }).refine((b) => b.frequency !== 'WEEKLY' || b.dayOfWeek !== null, { message: 'Say which day of the week', path: ['dayOfWeek'] }).refine((b) => b.frequency !== 'MONTHLY' || b.dayOfMonth !== null, { message: 'Say which day of the month', path: ['dayOfMonth'] })
  .refine((b) => b.recipients.emails.length + b.recipients.roles.length > 0, { message: 'Say who should get it', path: ['recipients'] });
const sDto = (r: any) => ({ id: r.id, name: r.name, report: r.report, groupId: r.wfmGroupId, groupName: r.groupName ?? null, range: r.rangeName, frequency: r.frequency, dayOfWeek: r.dayOfWeek, dayOfMonth: r.dayOfMonth, hour: r.hour, timezone: r.timezone, recipients: r.recipients, enabled: r.enabled, format: r.format, nextRunAt: r.nextRunAt, lastRunAt: r.lastRunAt, createdBy: r.createdBy });
const S_SQL = `SELECT s.*, g.name AS group_name FROM report_schedules s LEFT JOIN wfm_groups g ON g.id = s.wfm_group_id WHERE s.org_id = $1`;

reports.get('/schedules', requires('workforce:read'), async (req, res) => { res.json((await raw<any>(`${S_SQL} ORDER BY s.created_at DESC`, [me(req).tenantId])).map(sDto)); });

reports.post('/schedules', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(ScheduleBody, req.body), def = REPORTS.find((r) => r.id === b.report)!;
  await allowed(p, def);
  const tz = b.timezone ?? (await withTenant(p.tenantId, (tx) => tzOf(tx, b.groupId)));
  const next = nextRun(new Date(), { frequency: b.frequency, dayOfWeek: b.dayOfWeek, dayOfMonth: b.dayOfMonth, hour: b.hour, timezone: tz });
  const [row] = await raw<any>(
    `INSERT INTO report_schedules (org_id, name, report, wfm_group_id, range_name, frequency, day_of_week, day_of_month, hour, timezone, recipients, enabled, next_run_at, created_by, created_actor, format) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [p.tenantId, b.name, b.report, b.groupId, b.range, b.frequency, b.dayOfWeek, b.dayOfMonth, b.hour, tz, JSON.stringify(b.recipients), b.enabled, next, p.name, JSON.stringify(p), b.format]);
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'CREATE', entityType: 'REPORT_SCHEDULE', entityId: row.id, entityName: b.name, after: sDto(row) }));
  res.status(201).json(sDto(row));
});

reports.put('/schedules/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(ScheduleBody, req.body);
  const tz = b.timezone ?? (await withTenant(p.tenantId, (tx) => tzOf(tx, b.groupId)));
  const next = b.enabled ? nextRun(new Date(), { frequency: b.frequency, dayOfWeek: b.dayOfWeek, dayOfMonth: b.dayOfMonth, hour: b.hour, timezone: tz }) : null;
  const [row] = await raw<any>(
    `UPDATE report_schedules SET name = $3, report = $4, wfm_group_id = $5, range_name = $6, frequency = $7, day_of_week = $8, day_of_month = $9, hour = $10, timezone = $11, recipients = $12, enabled = $13, next_run_at = $14, format = $15 WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, p.tenantId, b.name, b.report, b.groupId, b.range, b.frequency, b.dayOfWeek, b.dayOfMonth, b.hour, tz, JSON.stringify(b.recipients), b.enabled, next, b.format]);
  if (!row) throw notFound('Report schedule');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'REPORT_SCHEDULE', entityId: id, entityName: b.name, after: sDto(row) }));
  res.json(sDto(row));
});

reports.delete('/schedules/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const [row] = await raw<any>('DELETE FROM report_schedules WHERE id = $1 AND org_id = $2 RETURNING name', [id, p.tenantId]);
  if (!row) throw notFound('Report schedule');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'DELETE', entityType: 'REPORT_SCHEDULE', entityId: id, entityName: row.name }));
  res.json({ ok: true });
});

reports.post('/schedules/:id/run-now', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const [s] = await raw<any>(`${S_SQL} AND s.id = $2`, [p.tenantId, id]);
  if (!s) throw notFound('Report schedule');
  res.json(await runSchedule(s));
});

reports.get('/schedules/:id/runs', requires('workforce:read'), async (req, res) => {
  const rows = await raw<any>(`SELECT r.id, r.status, r.row_count, r.error, r.ran_at, r.sent_to, r.period_start::text AS period_start, r.period_end::text AS period_end, (r.file IS NOT NULL) AS has_csv, (r.pdf IS NOT NULL) AS has_pdf FROM report_runs r WHERE r.schedule_id = $1 AND r.org_id = $2 ORDER BY r.ran_at DESC LIMIT 30`, [parse(uuid, req.params.id), me(req).tenantId]);
  res.json(rows.map((r) => ({ id: r.id, status: r.status, rows: r.rowCount, error: r.error, ranAt: r.ranAt, sentTo: r.sentTo, from: r.periodStart, to: r.periodEnd, hasCsv: r.hasCsv, hasPdf: r.hasPdf })));
});
reports.get('/runs/:id/download', requires('workforce:read'), async (req, res) => {
  const [r] = await raw<any>('SELECT report, file, pdf, period_start::text AS period_start, period_end::text AS period_end FROM report_runs WHERE id = $1 AND org_id = $2', [parse(uuid, req.params.id), me(req).tenantId]);
  if (req.query.format === 'pdf') {
    if (!r || !r.pdf) throw notFound('PDF file');
    return void res.setHeader('Content-Type', 'application/pdf').setHeader('Content-Disposition', `attachment; filename="${r.report.toLowerCase()}-${r.periodStart}-to-${r.periodEnd}.pdf"`).send(Buffer.from(r.pdf, 'base64'));
  }
  if (!r || !r.file) throw notFound('Report file');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="${r.report.toLowerCase()}-${r.periodStart}-to-${r.periodEnd}.csv"`).send(r.file);
});

/** Run one schedule now: make the report, keep the file, email it, and set the next time. Failures are recorded, never thrown at the timer. */
export async function runSchedule(s: any) {
  const def = REPORTS.find((r) => r.id === s.report)!;
  const actor = s.createdActor as Principal, now = new Date();
  let status: 'OK' | 'FAILED' = 'OK', error: string | null = null, file: string | null = null, pdf: string | null = null, rows = 0, sent = 0, range = { from: '', to: '' };
  try {
    range = resolveRange(s.rangeName as Range, now, s.timezone, (await withTenant(s.orgId, (tx) => payWeekFor(tx, s.wfmGroupId))).start);
    const table = await withTenant(s.orgId, (tx) => def.run(tx, s.orgId, s.wfmGroupId, range.from, range.to));
    const wantCsv = s.format !== 'PDF' || !pdfOk(def.id), wantPdf = s.format !== 'CSV' && pdfOk(def.id);
    rows = table.rows.length;
    if (wantCsv) file = toCsv(table);
    if (wantPdf) pdf = await makePdf(s.orgId, def, s.name, table, range.from, range.to, s.timezone);
    const base = `${def.id.toLowerCase()}-${range.from}-to-${range.to}`;
    const attachments = [...(file ? [{ name: `${base}.csv`, type: 'text/csv', content: file }] : []), ...(pdf ? [{ name: `${base}.pdf`, type: 'application/pdf', content: pdf, encoding: 'base64' as const }] : [])];
    const emails = new Set<string>(s.recipients.emails ?? []);
    if (s.recipients.roles?.length) for (const u of await withTenant(s.orgId, (tx) => tx.q<{ email: string | null }>(`SELECT email FROM users WHERE tenant_id = :t AND status = 'ACTIVE' AND email IS NOT NULL AND role = ANY($1::text[])`, [s.recipients.roles]))) if (u.email) emails.add(u.email);
    for (const to of emails) {
      await queueMessage(s.orgId, { channel: 'EMAIL', to, subject: `${s.name}: ${range.from} to ${range.to}`, body: `${def.label}, ${range.from} to ${range.to}\n${rows} row${rows === 1 ? '' : 's'}.\n\n${attachments.length === 1 ? 'The file is' : 'The files are'} attached. ${attachments.length === 1 ? 'It is' : 'They are'} also kept under Administration, Alerts and reports.`, attachment: attachments, ref: `report:${s.name}` });
      sent++;
    }
  } catch (e: any) { status = 'FAILED'; error = String(e?.message ?? e).slice(0, 500); }
  const next = s.enabled ? nextRun(now, { frequency: s.frequency, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, hour: s.hour, timezone: s.timezone }) : null;
  const [run] = await raw<any>(`INSERT INTO report_runs (org_id, schedule_id, report, period_start, period_end, status, row_count, error, file, pdf, sent_to) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [s.orgId, s.id, s.report, range.from || null, range.to || null, status, rows, error, file, pdf, sent]);
  await raw('UPDATE report_schedules SET last_run_at = now(), next_run_at = $2 WHERE id = $1', [s.id, next]);
  await raw(`DELETE FROM report_runs WHERE schedule_id = $1 AND id NOT IN (SELECT id FROM report_runs WHERE schedule_id = $1 ORDER BY ran_at DESC LIMIT 60)`, [s.id]);   // keep the last 60 runs
  if (status === 'OK') publish(s.orgId, ['report', 'ready'], { schedule: s.name, report: s.report, from: range.from, to: range.to, rows, runId: run.id });
  void actor;
  return { status, error, rows, sentTo: sent, from: range.from, to: range.to, runId: run.id };
}

let busy = false, timer: ReturnType<typeof setInterval> | null = null;
async function runDue() {
  if (busy) return;
  busy = true;
  try {
    const due = await raw<any>(`UPDATE report_schedules SET next_run_at = now() + interval '15 minutes' WHERE id IN (SELECT id FROM report_schedules WHERE enabled AND next_run_at <= now() ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 5) RETURNING *`);
    for (const s of due) { try { await runSchedule(s); } catch (e) { console.error('[reports]', s.name, (e as Error).message); } }
  } catch (e) { console.error('[reports]', (e as Error).message); } finally { busy = false; }
}
/** Check the timetable every 30 seconds. Several gateways can run this: each schedule is taken by one. */
export function startReportTimer() { if (timer) return; timer = setInterval(runDue, 30_000); timer.unref(); }
export const stopReportTimer = () => { if (timer) clearInterval(timer); timer = null; };
void conflict;
