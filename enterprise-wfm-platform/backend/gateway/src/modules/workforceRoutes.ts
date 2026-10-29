/**
 * Workforce: employees, teams, skills, weekly availability and time off.
 * Everything the scheduler needs to know about a person lives here; the scheduler reads it, it never writes it.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache } from '../infra.ts';
import { parseCsv } from './csv.ts';
import { reconcileForEmployee } from './rotations.ts';
import { notify, usersOf } from '../notify.ts';

export const workforce = Router();
const uuid = z.string().uuid();
export const slotOf = (hhmm: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm); return m ? Math.min(96, Math.floor((+m[1] * 60 + +m[2]) / 15)) : NaN; };
export const hhmm = (slot: number) => `${String(Math.floor(slot / 4) % 24).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;
const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'X';

// ---------------------------------------------------------------- employees

const EmpFields = z.object({
  employeeNumber: z.string().trim().min(1).max(40), firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
  email: z.string().email().nullable().optional(), phone: z.string().max(40).optional(), extension: z.string().trim().max(20).nullable().optional(), timezone: z.string().max(60).nullable().optional(),
  status: z.enum(['ONBOARDING', 'ACTIVE', 'LEAVE', 'SUSPENDED', 'TERMINATED']).optional(), hireDate: z.string().regex(isoDay).nullable().optional(),
  teamId: uuid.nullable().optional(), location: z.string().max(80).optional(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY']).optional(),
  weeklyContractHours: z.number().min(0).max(80).optional(), maxWeeklyHours: z.number().gt(0).max(84).optional(),
  workDaysPerWeek: z.number().int().min(1).max(7).optional(), minRestHours: z.number().min(0).max(24).optional(),
  maxConsecutiveDays: z.number().int().min(1).max(14).optional(), allowWeekend: z.boolean().optional(), allowOvernight: z.boolean().optional(), nightShiftConsent: z.boolean().optional(),
  primaryGroupId: uuid.nullable().optional(), eligibleGroupIds: z.array(uuid).max(50).optional(),
  preferredTemplateId: uuid.nullable().optional(),
  // same start and end time every day: DEFAULT follows the company setting. fixedStartSlot assigns the person's usual start (15-minute slot of the day).
  shiftConsistency: z.enum(['DEFAULT', 'REQUIRE', 'PREFER', 'OFF']).optional(), fixedStartSlot: z.number().int().min(0).max(95).nullable().optional(),
});
const EmpCreate = EmpFields;
const EmpPatch = EmpFields.partial();
type EmpInput = z.infer<typeof EmpFields>;

const COLS: Record<keyof EmpInput, string> = {
  employeeNumber: 'employee_number', firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', extension: 'extension', timezone: 'timezone', status: 'status', hireDate: 'hire_date',
  teamId: 'team_id', location: 'location', employmentType: 'employment_type', weeklyContractHours: 'weekly_contract_hours', maxWeeklyHours: 'max_weekly_hours',
  workDaysPerWeek: 'work_days_per_week', minRestHours: 'min_rest_hours', maxConsecutiveDays: 'max_consecutive_days', allowWeekend: 'allow_weekend', allowOvernight: 'allow_overnight', nightShiftConsent: 'night_shift_consent',
  primaryGroupId: 'primary_group_id', eligibleGroupIds: 'eligible_group_ids', preferredTemplateId: 'preferred_template_id',
  shiftConsistency: 'shift_consistency', fixedStartSlot: 'fixed_start_slot',
};
const CASTS: Partial<Record<keyof EmpInput, string>> = { eligibleGroupIds: '::uuid[]', teamId: '::uuid', primaryGroupId: '::uuid', hireDate: '::date', preferredTemplateId: '::uuid' };

const empDto = (e: any, skills: any[] = []) => ({
  id: e.id, employeeNumber: e.employeeNumber, firstName: e.firstName, lastName: e.lastName, name: `${e.firstName} ${e.lastName}`, email: e.email, phone: e.phone, extension: e.extension, timezone: e.timezone,
  status: e.status, hireDate: e.hireDate, teamId: e.teamId, teamName: e.teamName ?? null, location: e.location, employmentType: e.employmentType,
  weeklyContractHours: e.weeklyContractHours, maxWeeklyHours: e.maxWeeklyHours, workDaysPerWeek: e.workDaysPerWeek, minRestHours: e.minRestHours,
  maxConsecutiveDays: e.maxConsecutiveDays, allowWeekend: e.allowWeekend, allowOvernight: e.allowOvernight, nightShiftConsent: e.nightShiftConsent,
  primaryGroupId: e.primaryGroupId, primaryGroupName: e.primaryGroupName ?? null, eligibleGroupIds: e.eligibleGroupIds, version: e.version,
  preferredTemplateId: e.preferredTemplateId, preferredTemplateName: e.preferredTemplateName ?? null,
  shiftConsistency: (e.shiftConsistency ?? 'DEFAULT') as 'DEFAULT' | 'REQUIRE' | 'PREFER' | 'OFF', fixedStartSlot: (e.fixedStartSlot ?? null) as number | null,
  skills: skills.filter((s) => s.employeeId === e.id).map((s) => ({ skillId: s.skillId, name: s.name, code: s.code, proficiency: s.proficiency })),
});

async function loadEmployees(tx: Tx, f: { id?: string; groupId?: string; teamId?: string; status?: string; q?: string } = {}) {
  const rows = await tx.q<any>(
    `SELECT e.*, t.name AS team_name, g.name AS primary_group_name, st.name AS preferred_template_name, e.hire_date::text AS hire_date FROM employees e
     LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN wfm_groups g ON g.id = e.primary_group_id LEFT JOIN shift_templates st ON st.id = e.preferred_template_id
     WHERE e.tenant_id = :t AND ($1::uuid IS NULL OR e.id = $1) AND ($2::uuid IS NULL OR e.primary_group_id = $2 OR $2 = ANY(e.eligible_group_ids))
       AND ($3::uuid IS NULL OR e.team_id = $3) AND ($4::text IS NULL OR e.status = $4)
       AND ($5::text IS NULL OR (e.first_name || ' ' || e.last_name || ' ' || e.employee_number) ILIKE '%' || $5 || '%')
     ORDER BY e.last_name, e.first_name LIMIT 2000`, [f.id ?? null, f.groupId ?? null, f.teamId ?? null, f.status ?? null, f.q ?? null]);
  const skills = await tx.q<any>('SELECT es.employee_id, es.skill_id, es.proficiency, s.name, s.code FROM employee_skills es JOIN skills s ON s.id = es.skill_id WHERE es.tenant_id = :t');
  return rows.map((r) => empDto(r, skills));
}

/** Rules that span fields, checked on the merged record. */
function checkEmployee(e: { weeklyContractHours: number; maxWeeklyHours: number; primaryGroupId: string | null; eligibleGroupIds: string[] }) {
  if (e.weeklyContractHours > e.maxWeeklyHours) throw bad('The weekly contract hours cannot exceed the maximum weekly hours');
}

async function writeEmployee(tx: Tx, id: string | null, b: Partial<EmpInput>): Promise<string> {
  const data: Record<string, unknown> = { ...b };
  if (b.primaryGroupId) data.eligibleGroupIds = [...new Set([...(b.eligibleGroupIds ?? []), b.primaryGroupId])];
  const keys = (Object.keys(data) as (keyof EmpInput)[]).filter((k) => k in COLS && data[k] !== undefined);
  const params = keys.map((k) => data[k]);
  if (!id) {
    const cols = keys.map((k) => COLS[k]);
    const r = await tx.one<{ id: string }>(`INSERT INTO employees (tenant_id, ${cols.join(', ')}) VALUES (:t, ${keys.map((k, i) => `$${i + 1}${CASTS[k] ?? ''}`).join(', ')}) RETURNING id`, params);
    return r!.id;
  }
  if (keys.length) await tx.exec(`UPDATE employees SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}${CASTS[k] ?? ''}`).join(', ')}, updated_at = now(), version = version + 1 WHERE tenant_id = :t AND id = $1`, [id, ...params]);
  return id;
}

const EMPLOYEE_TEMPLATE = [
  'employee_number,first_name,last_name,email,team,wfm_group,employment_type,weekly_hours,max_weekly_hours,days_per_week,status,hire_date,skills',
  'E1001,Asha,Rao,asha.rao@example.com,Alpha,Billing Support,FULL_TIME,40,40,5,ACTIVE,2024-03-01,Billing:4; Chat:3',
  'E1002,Ben,Cole,ben.cole@example.com,Alpha,Billing Support,PART_TIME,20,24,4,ACTIVE,2025-01-15,Billing:3',
].join('\n') + '\n';

workforce.get('/employees/template', requires('workforce:read'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="employees-template.csv"');
  res.send(EMPLOYEE_TEMPLATE);
});

workforce.get('/employees', requires('workforce:read'), async (req, res) => {
  const q = parse(z.object({ groupId: uuid.optional(), teamId: uuid.optional(), status: z.string().optional(), q: z.string().max(80).optional() }), req.query);
  res.json(await withTenant(me(req).tenantId, (tx) => loadEmployees(tx, q)));
});
workforce.get('/employees/:id', requires('workforce:read'), async (req, res) => {
  const [e] = await withTenant(me(req).tenantId, (tx) => loadEmployees(tx, { id: parse(uuid, req.params.id) }));
  if (!e) throw notFound('Employee');
  res.json(e);
});

// ---------------------------------------------------------------- attrition (for headcount planning)

/** A real trailing-12-month attrition estimate, from the audit trail's own status-change history, not a guess: terminations of people who belonged to this group, divided by today's headcount. */
workforce.get('/attrition', requires('workforce:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid }), req.query);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [{ n: currentHeadcount }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND primary_group_id = $1 AND status = $2', [q.groupId, 'ACTIVE']);
    const [{ n: terminatedTrailing12mo }] = await tx.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log a JOIN employees e ON e.id::text = a.entity_id
       WHERE a.tenant_id = :t AND a.entity_type = 'EMPLOYEE' AND a.action = 'UPDATE' AND e.primary_group_id = $1
         AND (a.after ->> 'status') = 'TERMINATED' AND (a.before ->> 'status') IS DISTINCT FROM 'TERMINATED' AND a.at >= now() - interval '12 months'`,
      [q.groupId]);
    return { currentHeadcount, terminatedTrailing12mo, estimatedAnnualPct: currentHeadcount > 0 ? Math.round((terminatedTrailing12mo / currentHeadcount) * 1000) / 10 : 0 };
  });
  res.json(out);
});

workforce.post('/employees', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(EmpCreate, req.body);
  checkEmployee({ weeklyContractHours: b.weeklyContractHours ?? 40, maxWeeklyHours: b.maxWeeklyHours ?? 40, primaryGroupId: b.primaryGroupId ?? null, eligibleGroupIds: b.eligibleGroupIds ?? [] });
  const out = await withTenant(p.tenantId, async (tx) => {
    const id = await writeEmployee(tx, null, b);
    const [e] = await loadEmployees(tx, { id });
    await audit(tx, p, req, { action: 'CREATE', entityType: 'EMPLOYEE', entityId: id, entityName: e.name, after: e });
    return e;
  });
  res.status(201).json(out);
});

workforce.put('/employees/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(EmpPatch, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [before] = await loadEmployees(tx, { id });
    if (!before) throw notFound('Employee');
    checkEmployee({ weeklyContractHours: b.weeklyContractHours ?? before.weeklyContractHours, maxWeeklyHours: b.maxWeeklyHours ?? before.maxWeeklyHours, primaryGroupId: null, eligibleGroupIds: [] });
    await writeEmployee(tx, id, b);
    const [after] = await loadEmployees(tx, { id });
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'EMPLOYEE', entityId: id, entityName: after.name, before, after });
    return after;
  });
  res.json(out);
});

// ---------------------------------------------------------------- bulk edit (select many people, change the same things on all of them)

const BulkBody = z.object({
  ids: z.array(uuid).min(1).max(500),
  // fields that make sense to apply to many people at once: never identity fields such as name, number, email or extension
  changes: EmpPatch.omit({ employeeNumber: true, firstName: true, lastName: true, email: true, phone: true, extension: true }).default({}),
  eligibleGroups: z.object({ add: z.array(uuid).max(50).default([]), remove: z.array(uuid).max(50).default([]) }).optional(),
  skills: z.object({ add: z.array(z.object({ skillId: uuid, proficiency: z.number().int().min(1).max(5) })).max(60).default([]), remove: z.array(uuid).max(60).default([]) }).optional(),
  reason: z.string().trim().min(3, 'is required').max(300),
});

workforce.post('/employees/bulk', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(BulkBody, req.body);
  const ids = [...new Set(b.ids)];
  const g = b.eligibleGroups, sk = b.skills;
  const touchesGroups = !!(g && (g.add.length || g.remove.length));
  const touchesSkills = !!(sk && (sk.add.length || sk.remove.length));
  if (!Object.values(b.changes).some((v) => v !== undefined) && !touchesGroups && !touchesSkills) throw bad('Choose at least one thing to change');
  const out = await withTenant(p.tenantId, async (tx) => {
    const all = await loadEmployees(tx);
    const byId = new Map(all.map((e) => [e.id, e]));
    const updated: string[] = [], skipped: { id: string; name: string; reason: string }[] = [];
    for (const id of ids) {
      const before = byId.get(id);
      if (!before) { skipped.push({ id, name: 'Unknown', reason: 'Employee not found' }); continue; }
      try { checkEmployee({ weeklyContractHours: b.changes.weeklyContractHours ?? before.weeklyContractHours, maxWeeklyHours: b.changes.maxWeeklyHours ?? before.maxWeeklyHours, primaryGroupId: null, eligibleGroupIds: [] }); }
      catch (e: any) { skipped.push({ id, name: before.name, reason: e.message }); continue; }
      const data: Partial<EmpInput> = { ...b.changes };
      // a person who is eligible for a group is always eligible for their primary group; changing either never wipes the rest of the list
      if (touchesGroups || b.changes.primaryGroupId !== undefined || b.changes.eligibleGroupIds !== undefined) {
        const next = new Set<string>(b.changes.eligibleGroupIds ?? before.eligibleGroupIds ?? []);
        for (const x of g?.add ?? []) next.add(x);
        for (const x of g?.remove ?? []) next.delete(x);
        const primary = b.changes.primaryGroupId !== undefined ? b.changes.primaryGroupId : before.primaryGroupId;
        if (primary) next.add(primary);
        data.eligibleGroupIds = [...next];
      }
      if (Object.keys(data).length) {
        // writeEmployee adds the primary group to whatever eligible list it is given, which is already complete here
        await writeEmployee(tx, id, data);
      }
      if (touchesSkills) {
        if (sk!.remove.length) await tx.exec('DELETE FROM employee_skills WHERE tenant_id = :t AND employee_id = $1 AND skill_id = ANY($2::uuid[])', [id, sk!.remove]);
        if (sk!.add.length) await tx.exec(
          `INSERT INTO employee_skills (tenant_id, employee_id, skill_id, proficiency) SELECT :t, $1, s, p FROM unnest($2::uuid[], $3::int[]) AS x(s, p)
           ON CONFLICT (employee_id, skill_id) DO UPDATE SET proficiency = EXCLUDED.proficiency`, [id, sk!.add.map((s) => s.skillId), sk!.add.map((s) => s.proficiency)]);
      }
      const [after] = await loadEmployees(tx, { id });
      await audit(tx, p, req, { action: 'UPDATE', entityType: 'EMPLOYEE', entityId: id, entityName: after.name, reason: b.reason, before, after, diffSummary: `bulk edit of ${ids.length} people` });
      updated.push(id);
    }
    return { updated: updated.length, skipped };
  });
  res.json(out);
});

workforce.delete('/employees/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const [e] = await loadEmployees(tx, { id });
    if (!e) throw notFound('Employee');
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM schedule_shifts WHERE tenant_id = :t AND employee_id = $1', [id]);
    if (n > 0) throw conflict(`${e.name} appears in ${n} scheduled shifts. Set their status to Terminated instead of deleting them.`);
    await tx.exec('DELETE FROM employees WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'EMPLOYEE', entityId: id, entityName: e.name, before: e });
  });
  res.json({ ok: true });
});

workforce.put('/employees/:id/skills', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const list = parse(z.object({ skills: z.array(z.object({ skillId: uuid, proficiency: z.number().int().min(1).max(5) })).max(60) }), req.body).skills;
  const out = await withTenant(p.tenantId, async (tx) => {
    const [before] = await loadEmployees(tx, { id });
    if (!before) throw notFound('Employee');
    await tx.exec('DELETE FROM employee_skills WHERE tenant_id = :t AND employee_id = $1', [id]);
    if (list.length) await tx.exec(
      `INSERT INTO employee_skills (tenant_id, employee_id, skill_id, proficiency) SELECT :t, $1, s, p FROM unnest($2::uuid[], $3::int[]) AS x(s, p)`, [id, list.map((s) => s.skillId), list.map((s) => s.proficiency)]);
    const [after] = await loadEmployees(tx, { id });
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'EMPLOYEE', entityId: id, entityName: after.name, before: before.skills, after: after.skills, diffSummary: 'skills changed' });
    return after;
  });
  res.json(out);
});

// ---------------------------------------------------------------- employee CSV import (always a dry run first)

const HEAD: Record<string, string[]> = {
  employeeNumber: ['employee_number', 'employee_id', 'id', 'number', 'emp_no'], firstName: ['first_name', 'firstname', 'first'], lastName: ['last_name', 'lastname', 'last', 'surname'],
  email: ['email'], extension: ['extension', 'ext', 'agent_extension', 'agent_ext'], team: ['team', 'team_name'], group: ['wfm_group', 'group', 'primary_group'], employmentType: ['employment_type', 'type'], weeklyHours: ['weekly_hours', 'contract_hours', 'weekly_contract_hours'],
  maxWeeklyHours: ['max_weekly_hours', 'max_hours'], daysPerWeek: ['days_per_week', 'work_days_per_week'], status: ['status'], hireDate: ['hire_date', 'start_date'], skills: ['skills'],
};

workforce.post('/employees/import', requires('workforce:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true), stopOnError: z.boolean().default(false), columnMap: z.record(z.string(), z.number().int()).optional() }), req.body);
  const matrix = parseCsv(b.csv);
  if (matrix.length < 2) throw bad('The file has a header but no data rows');
  const header = matrix[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  // auto-detected by header name, overridable per column by dragging a header onto a target in the mapper -- so an
  // import adapts to any file's own column names instead of only ones that happen to match the built-in aliases
  const columnMap: Record<string, number> = {};
  for (const k of Object.keys(HEAD)) { const override = b.columnMap?.[k]; columnMap[k] = override !== undefined ? override : header.findIndex((h) => HEAD[k].includes(h)); }
  const col = (k: string) => columnMap[k] ?? -1;
  const mapped = col('employeeNumber') >= 0 && col('firstName') >= 0 && col('lastName') >= 0;
  const headers = matrix[0], headerSample = matrix[1] ?? [];
  if (!mapped) {
    if (!b.dryRun) throw bad('Map employee number, first name and last name to a column first');
    return res.json({ dryRun: b.dryRun, rows: matrix.length - 1, diff: { new: 0, updated: 0, unchanged: 0 }, errors: [], errorCount: 0, sample: [], committed: false, headers, headerSample, columnMap, mapped: false });
  }

  const out = await withTenant(p.tenantId, async (tx) => {
    const teams = await tx.q<any>('SELECT id, name, code FROM teams WHERE tenant_id = :t');
    const groups = await tx.q<any>('SELECT id, name, code FROM wfm_groups WHERE tenant_id = :t');
    const skills = await tx.q<any>('SELECT id, name, code FROM skills WHERE tenant_id = :t');
    const existing = new Map((await loadEmployees(tx)).map((e) => [e.employeeNumber.toLowerCase(), e]));
    const find = (list: any[], v: string) => list.find((x) => x.name.toLowerCase() === v.toLowerCase() || x.code.toLowerCase() === v.toLowerCase());
    const errors: { line: number; message: string }[] = [];
    const plan: { input: EmpInput; skillList: { skillId: string; proficiency: number }[]; action: 'NEW' | 'UPDATE' | 'UNCHANGED'; line: number; name: string }[] = [];
    const seen = new Set<string>();
    matrix.slice(1).forEach((r, i) => {
      const line = i + 2, get = (k: string) => (col(k) >= 0 ? (r[col(k)] ?? '').trim() : '');
      const fail = (m: string) => errors.push({ line, message: m });
      const number = get('employeeNumber');
      if (!number) return fail('Employee number is empty');
      if (seen.has(number.toLowerCase())) return fail(`Employee number ${number} appears twice in the file`);
      seen.add(number.toLowerCase());
      const input: any = { employeeNumber: number, firstName: get('firstName'), lastName: get('lastName') };
      if (!input.firstName || !input.lastName) return fail('First and last name are required');
      if (get('email')) input.email = get('email');
      if (get('extension')) input.extension = get('extension');
      if (get('team')) { const t = find(teams, get('team')); if (!t) return fail(`Unknown team '${get('team')}'. Create it first.`); input.teamId = t.id; }
      if (get('group')) { const g = find(groups, get('group')); if (!g) return fail(`Unknown WFM group '${get('group')}'. Create it first.`); input.primaryGroupId = g.id; input.eligibleGroupIds = [g.id]; }
      if (get('employmentType')) { const v = get('employmentType').toUpperCase().replace(/[\s-]+/g, '_'); if (!['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY'].includes(v)) return fail(`Unknown employment type '${get('employmentType')}'`); input.employmentType = v; }
      if (get('status')) { const v = get('status').toUpperCase(); if (!['ONBOARDING', 'ACTIVE', 'LEAVE', 'SUSPENDED', 'TERMINATED'].includes(v)) return fail(`Unknown status '${get('status')}'`); input.status = v; }
      for (const [k, f] of [['weeklyHours', 'weeklyContractHours'], ['maxWeeklyHours', 'maxWeeklyHours'], ['daysPerWeek', 'workDaysPerWeek']] as const) {
        if (get(k)) { const n = Number(get(k)); if (!Number.isFinite(n) || n <= 0) return fail(`${HEAD[k][0]} must be a number above zero`); input[f] = n; }
      }
      if (input.weeklyContractHours !== undefined && input.maxWeeklyHours === undefined) input.maxWeeklyHours = Math.max(input.weeklyContractHours, 40);
      if (get('hireDate')) { if (!isoDay.test(get('hireDate'))) return fail('hire_date must look like 2026-03-31'); input.hireDate = get('hireDate'); }
      const skillList: { skillId: string; proficiency: number }[] = [];
      for (const part of get('skills').split(/[;|]/).map((s) => s.trim()).filter(Boolean)) {
        const [n, lvl] = part.split(':').map((s) => s.trim()); const s = find(skills, n);
        if (!s) { fail(`Unknown skill '${n}'. Create it first.`); return; }
        skillList.push({ skillId: s.id, proficiency: Math.min(5, Math.max(1, Number(lvl) || 3)) });
      }
      const parsed = EmpFields.safeParse(input);
      if (!parsed.success) return fail(parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; '));
      try { checkEmployee({ weeklyContractHours: input.weeklyContractHours ?? 40, maxWeeklyHours: input.maxWeeklyHours ?? 40, primaryGroupId: null, eligibleGroupIds: [] }); } catch (e: any) { return fail(e.message); }
      const cur = existing.get(number.toLowerCase());
      const changed = !cur || (Object.keys(input) as string[]).some((k) => {
        const a = (cur as any)[k], v = input[k];
        return Array.isArray(v) ? JSON.stringify([...v].sort()) !== JSON.stringify([...(a ?? [])].sort()) : (a ?? null) !== v;
      }) || (skillList.length > 0 && JSON.stringify(skillList.map((s) => `${s.skillId}:${s.proficiency}`).sort()) !== JSON.stringify(cur!.skills.map((s: any) => `${s.skillId}:${s.proficiency}`).sort()));
      plan.push({ input: parsed.data, skillList, action: !cur ? 'NEW' : changed ? 'UPDATE' : 'UNCHANGED', line, name: `${input.firstName} ${input.lastName}` });
    });
    const diff = { new: plan.filter((x) => x.action === 'NEW').length, updated: plan.filter((x) => x.action === 'UPDATE').length, unchanged: plan.filter((x) => x.action === 'UNCHANGED').length };
    const result = { dryRun: b.dryRun, rows: matrix.length - 1, diff, errors: errors.slice(0, 100), errorCount: errors.length, sample: plan.slice(0, 30).map((x) => ({ line: x.line, name: x.name, employeeNumber: x.input.employeeNumber, action: x.action })), committed: false, headers, headerSample, columnMap, mapped: true };
    if (b.dryRun) return { ...result, stopOnError: b.stopOnError };
    if (b.stopOnError && errors.length) throw bad(`Nothing was imported: ${errors.length} row${errors.length === 1 ? ' has' : 's have'} a problem and you chose to stop on any error. First: line ${errors[0].line}, ${errors[0].message}`, errors.slice(0, 20));
    // rows with a problem were never added to `plan`, so they're simply left out here -- a good row isn't held back
    // by someone else's file having a bad one. Their line numbers are still in `errors` so they can be fixed and re-imported.
    for (const x of plan) {
      if (x.action === 'UNCHANGED') continue;
      const cur = existing.get(x.input.employeeNumber.toLowerCase());
      const id = await writeEmployee(tx, cur?.id ?? null, x.input);
      if (x.skillList.length) {
        await tx.exec('DELETE FROM employee_skills WHERE tenant_id = :t AND employee_id = $1', [id]);
        await tx.exec('INSERT INTO employee_skills (tenant_id, employee_id, skill_id, proficiency) SELECT :t, $1, s, p FROM unnest($2::uuid[], $3::int[]) AS y(s, p)', [id, x.skillList.map((s) => s.skillId), x.skillList.map((s) => s.proficiency)]);
      }
    }
    await audit(tx, p, req, { action: 'IMPORT', entityType: 'EMPLOYEE_IMPORT', entityId: p.userId, entityName: 'Employee file', diffSummary: `${diff.new} added, ${diff.updated} changed, ${diff.unchanged} unchanged`, reason: 'Committed after dry run' });
    return { ...result, committed: true };
  });
  res.json(out);
});

// ---------------------------------------------------------------- teams and skills

const teamDto = (t: any) => ({ id: t.id, name: t.name, code: t.code, description: t.description, location: t.location, managerId: t.managerId, managerName: t.managerName ?? null, status: t.status, memberCount: t.memberCount ?? 0 });
const TeamBody = z.object({ name: z.string().trim().min(1).max(80), code: z.string().trim().min(1).max(30).optional(), description: z.string().max(300).optional(), location: z.string().max(80).optional(), managerId: uuid.nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() });

workforce.get('/teams', requires('workforce:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `SELECT t.*, e.first_name || ' ' || e.last_name AS manager_name, (SELECT count(*)::int FROM employees x WHERE x.team_id = t.id AND x.status <> 'TERMINATED') AS member_count
     FROM teams t LEFT JOIN employees e ON e.id = t.manager_id WHERE t.tenant_id = :t ORDER BY t.name`));
  res.json(rows.map(teamDto));
});
workforce.post('/teams', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(TeamBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>('INSERT INTO teams (tenant_id, name, code, description, location, manager_id) VALUES (:t, $1, $2, $3, $4, $5) RETURNING *', [b.name, b.code ?? code(b.name), b.description ?? '', b.location ?? '', b.managerId ?? null]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'TEAM', entityId: t!.id, entityName: b.name, after: teamDto(t) });
    return teamDto(t);
  });
  res.status(201).json(out);
});
workforce.put('/teams/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(TeamBody.partial(), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM teams WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Team');
    const t = await tx.one<any>(
      `UPDATE teams SET name = coalesce($2, name), description = coalesce($3, description), location = coalesce($4, location), status = coalesce($5, status),
         manager_id = CASE WHEN $6::boolean THEN $7::uuid ELSE manager_id END WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name ?? null, b.description ?? null, b.location ?? null, b.status ?? null, b.managerId !== undefined, b.managerId ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'TEAM', entityId: id, entityName: t!.name, before: teamDto(before), after: teamDto(t) });
    return teamDto(t);
  });
  res.json(out);
});
workforce.delete('/teams/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const t = await tx.one<any>('SELECT * FROM teams WHERE tenant_id = :t AND id = $1', [id]);
    if (!t) throw notFound('Team');
    const [{ n }] = await tx.q<{ n: number }>('SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND team_id = $1', [id]);
    if (n > 0) throw conflict(`${n} people are in this team. Move them first.`);
    await tx.exec('DELETE FROM teams WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'TEAM', entityId: id, entityName: t.name, before: teamDto(t) });
  });
  res.json({ ok: true });
});

const skillDto = (s: any) => ({ id: s.id, name: s.name, code: s.code, category: s.category, type: s.type, status: s.status, requiresCertification: s.requiresCertification, description: s.description, holders: s.holders ?? 0 });
const SkillBody = z.object({ name: z.string().trim().min(1).max(80), code: z.string().trim().min(1).max(30).optional(), category: z.enum(['CHANNELS', 'LANGUAGES', 'PRODUCTS', 'TIERS']).optional(), type: z.enum(['CORE', 'SECONDARY', 'SPECIALTY']).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(), requiresCertification: z.boolean().optional(), description: z.string().max(300).optional() });

workforce.get('/skills', requires('workforce:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT s.*, (SELECT count(*)::int FROM employee_skills es WHERE es.skill_id = s.id) AS holders FROM skills s WHERE s.tenant_id = :t ORDER BY s.name'));
  res.json(rows.map(skillDto));
});
workforce.post('/skills', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(SkillBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const s = await tx.one<any>('INSERT INTO skills (tenant_id, name, code, category, type, requires_certification, description) VALUES (:t, $1, $2, coalesce($3, \'PRODUCTS\'), coalesce($4, \'CORE\'), coalesce($5, false), $6) RETURNING *',
      [b.name, b.code ?? code(b.name), b.category ?? null, b.type ?? null, b.requiresCertification ?? null, b.description ?? '']);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SKILL', entityId: s!.id, entityName: b.name, after: skillDto(s) });
    return skillDto(s);
  });
  res.status(201).json(out);
});
workforce.put('/skills/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(SkillBody.partial(), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT * FROM skills WHERE tenant_id = :t AND id = $1', [id]);
    if (!before) throw notFound('Skill');
    const s = await tx.one<any>(
      `UPDATE skills SET name = coalesce($2, name), category = coalesce($3, category), type = coalesce($4, type), status = coalesce($5, status),
         requires_certification = coalesce($6, requires_certification), description = coalesce($7, description) WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [id, b.name ?? null, b.category ?? null, b.type ?? null, b.status ?? null, b.requiresCertification ?? null, b.description ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SKILL', entityId: id, entityName: s!.name, before: skillDto(before), after: skillDto(s) });
    return skillDto(s);
  });
  res.json(out);
});
workforce.delete('/skills/:id', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const s = await tx.one<any>('SELECT * FROM skills WHERE tenant_id = :t AND id = $1', [id]);
    if (!s) throw notFound('Skill');
    await tx.exec('DELETE FROM skills WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'SKILL', entityId: id, entityName: s.name, before: skillDto(s) });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- weekly availability

const availDto = (a: any) => ({ id: a.id, dayOfWeek: a.dayOfWeek, startTime: hhmm(a.startSlot), endTime: a.endSlot >= 96 ? '24:00' : hhmm(a.endSlot), kind: a.kind, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo });
const Window = z.object({ dayOfWeek: z.number().int().min(0).max(6), startTime: z.string(), endTime: z.string(), kind: z.enum(['AVAILABLE', 'UNAVAILABLE', 'PREFERRED']), effectiveFrom: z.string().regex(isoDay).nullable().optional(), effectiveTo: z.string().regex(isoDay).nullable().optional() });

workforce.get('/employees/:id/availability', requires('workforce:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT id, day_of_week, start_slot, end_slot, kind, effective_from::text AS effective_from, effective_to::text AS effective_to FROM availability WHERE tenant_id = :t AND employee_id = $1 ORDER BY day_of_week, start_slot', [parse(uuid, req.params.id)]));
  res.json(rows.map(availDto));
});
workforce.get('/availability', requires('workforce:read'), async (req, res) => {
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT id, employee_id, day_of_week, start_slot, end_slot, kind, effective_from::text AS effective_from, effective_to::text AS effective_to FROM availability WHERE tenant_id = :t ORDER BY employee_id, day_of_week, start_slot'));
  res.json(rows.map((r) => ({ ...availDto(r), employeeId: r.employeeId })));
});
workforce.put('/employees/:id/availability', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const list = parse(z.object({ windows: z.array(Window).max(60) }), req.body).windows.map((w) => ({ ...w, s: slotOf(w.startTime), e: w.endTime === '24:00' ? 96 : slotOf(w.endTime) }));
  for (const w of list) if (Number.isNaN(w.s) || Number.isNaN(w.e) || w.e <= w.s) throw bad(`Window ${w.startTime}-${w.endTime}: the end must be after the start (HH:MM)`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [emp] = await loadEmployees(tx, { id });
    if (!emp) throw notFound('Employee');
    await tx.exec('DELETE FROM availability WHERE tenant_id = :t AND employee_id = $1', [id]);
    for (const w of list) await tx.exec('INSERT INTO availability (tenant_id, employee_id, day_of_week, start_slot, end_slot, kind, effective_from, effective_to) VALUES (:t, $1, $2, $3, $4, $5, $6, $7)', [id, w.dayOfWeek, w.s, w.e, w.kind, w.effectiveFrom ?? null, w.effectiveTo ?? null]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'AVAILABILITY', entityId: id, entityName: emp.name, after: list.map((w) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][w.dayOfWeek]} ${w.startTime}-${w.endTime} ${w.kind}`) });
    return tx.q<any>('SELECT id, day_of_week, start_slot, end_slot, kind, effective_from::text AS effective_from, effective_to::text AS effective_to FROM availability WHERE tenant_id = :t AND employee_id = $1 ORDER BY day_of_week, start_slot', [id]);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json(out.map(availDto));
});

// ---------------------------------------------------------------- time off

const toDto = (t: any) => ({ id: t.id, employeeId: t.employeeId, employeeName: t.employeeName, type: t.type, startDate: t.startDay, endDate: t.endDay, days: t.days, status: t.status, reason: t.reason, decidedBy: t.decidedBy, decidedAt: t.decidedAt, createdAt: t.createdAt });
const TO_SQL = `SELECT o.*, o.start_day::text AS start_day, o.end_day::text AS end_day, (o.end_day - o.start_day + 1) AS days, e.first_name || ' ' || e.last_name AS employee_name
                FROM time_off o JOIN employees e ON e.id = o.employee_id WHERE o.tenant_id = :t`;

workforce.get('/time-off', requires('workforce:read'), async (req, res) => {
  const q = parse(z.object({ employeeId: uuid.optional(), status: z.string().optional(), from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional() }), req.query);
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `${TO_SQL} AND ($1::uuid IS NULL OR o.employee_id = $1) AND ($2::text IS NULL OR o.status = $2) AND ($3::date IS NULL OR o.end_day >= $3) AND ($4::date IS NULL OR o.start_day <= $4) ORDER BY o.start_day DESC LIMIT 500`,
    [q.employeeId ?? null, q.status ?? null, q.from ?? null, q.to ?? null]));
  res.json(rows.map(toDto));
});
workforce.post('/time-off', requires('workforce:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ employeeId: uuid, type: z.enum(['VACATION', 'SICK', 'PERSONAL', 'HOLIDAY', 'TRAINING', 'LEAVE', 'OTHER']).default('VACATION'), startDate: z.string().regex(isoDay), endDate: z.string().regex(isoDay), reason: z.string().max(300).optional(), approve: z.boolean().optional() }), req.body);
  if (b.endDate < b.startDate) throw bad('The end date is before the start date');
  const out = await withTenant(p.tenantId, async (tx) => {
    const [emp] = await loadEmployees(tx, { id: b.employeeId });
    if (!emp) throw notFound('Employee');
    const id = (await tx.one<{ id: string }>(
      `INSERT INTO time_off (tenant_id, employee_id, type, start_day, end_day, reason, status, decided_by, decided_at) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [b.employeeId, b.type, b.startDate, b.endDate, b.reason ?? '', b.approve ? 'APPROVED' : 'REQUESTED', b.approve ? p.name : null, b.approve ? new Date().toISOString() : null]))!.id;
    const t = (await tx.q<any>(`${TO_SQL} AND o.id = $1`, [id]))[0];
    await audit(tx, p, req, { action: 'CREATE', entityType: 'TIME_OFF', entityId: id, entityName: emp.name, after: toDto(t) });
    if (b.approve) await reconcileForEmployee(tx, p, req, b.employeeId);   // approved leave takes the person off their generated rotation shifts
    return toDto(t);
  });
  await dropCache(me(req).tenantId, 'sched:*');
  res.status(201).json(out);
});
workforce.post('/time-off/:id/decide', requires('workforce:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ status: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']), reason: z.string().max(300).optional() }), req.body);
  if (b.status === 'REJECTED' && (b.reason ?? '').trim().length < 3) throw bad('Give a reason when rejecting a request');
  const out = await withTenant(p.tenantId, async (tx) => {
    const cur = (await tx.q<any>(`${TO_SQL} AND o.id = $1`, [id]))[0];
    if (!cur) throw notFound('Time-off request');
    await tx.exec('UPDATE time_off SET status = $2, decided_by = $3, decided_at = now(), reason = CASE WHEN $4 <> \'\' THEN $4 ELSE reason END WHERE tenant_id = :t AND id = $1', [id, b.status, p.name, b.reason ?? '']);
    const t = (await tx.q<any>(`${TO_SQL} AND o.id = $1`, [id]))[0];
    await audit(tx, p, req, { action: b.status === 'APPROVED' ? 'APPROVE' : b.status === 'REJECTED' ? 'REJECT' : 'UPDATE', entityType: 'TIME_OFF', entityId: id, entityName: cur.employeeName, reason: b.reason, before: { status: cur.status }, after: { status: b.status } });
    if (b.status !== 'CANCELLED') await notify(tx, await usersOf(tx, [cur.employeeId]), { kind: 'TIME_OFF', title: `Time off ${b.status === 'APPROVED' ? 'approved' : 'declined'}`, body: `${cur.startDay} to ${cur.endDay}${b.reason ? `: ${b.reason}` : ''}`, data: { screen: 'time-off', id } });
    await reconcileForEmployee(tx, p, req, cur.employeeId);   // approving takes the person off their rotation shifts; cancelling puts them back
    return toDto(t);
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json(out);
});
