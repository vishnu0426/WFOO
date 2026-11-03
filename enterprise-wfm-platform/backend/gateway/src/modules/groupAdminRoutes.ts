/**
 * WFM group administration beyond the plain create/edit: a one-request summary for the list, what depends on a group before it is switched off or
 * deleted, its people with search and paging, its change history, cloning a group, and creating many groups and queues from one file.
 * Mounted at /config BEFORE the plain group routes, so "/groups/summary" is not read as a group id.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, notFound, parse } from '../http.ts';
import { dropCache } from '../infra.ts';
import { loadGroups } from './configRoutes.ts';
import { parseCsv } from './csv.ts';
import { diffFields, GROUP_FILE_TEMPLATE, parseGroupFile } from './groupRules.ts';

export const groupAdmin = Router();
const uuid = z.string().uuid();
const code = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'GROUP';
const ALIVE = `e.status <> 'TERMINATED'`;

// ---------------------------------------------------------------- the list: one request for every group's numbers

groupAdmin.get('/groups/summary', requires('config:read'), async (req, res) => {
  // Set-based: each table is read once and grouped, instead of four lookups per group (a thousand groups over fifty thousand people was a million row checks).
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `WITH people AS (SELECT group_id AS gid, greatest(people, 0) AS n, greatest(primary_people, 0) AS pn FROM group_people WHERE tenant_id = :t),
          qs AS (SELECT wfm_group_id AS gid, count(*)::int AS n FROM queues WHERE tenant_id = :t AND wfm_group_id IS NOT NULL GROUP BY wfm_group_id),
          fc AS (SELECT DISTINCT ON (f.wfm_group_id) f.wfm_group_id AS gid, json_build_object('name', f.name, 'seq', f.seq, 'kind', f.kind, 'fromDay', f.from_day::text, 'toDay', f.to_day::text) AS j
                 FROM forecast_versions f WHERE f.tenant_id = :t AND f.status = 'PUBLISHED' ORDER BY f.wfm_group_id, f.published_at DESC NULLS LAST),
          sc AS (SELECT DISTINCT ON (v.wfm_group_id) v.wfm_group_id AS gid, json_build_object('name', v.name, 'periodStart', v.period_start::text, 'periodEnd', v.period_end::text, 'coverage', v.stats #>> '{coverage,percent}') AS j
                 FROM schedule_versions v WHERE v.tenant_id = :t AND v.status = 'PUBLISHED' ORDER BY v.wfm_group_id, v.period_end DESC)
     SELECT g.id, coalesce(qs.n, 0) AS queues, coalesce(people.n, 0) AS people, coalesce(people.pn, 0) AS primary_people, fc.j AS forecast, sc.j AS schedule
     FROM wfm_groups g LEFT JOIN people ON people.gid = g.id LEFT JOIN qs ON qs.gid = g.id LEFT JOIN fc ON fc.gid = g.id LEFT JOIN sc ON sc.gid = g.id
     WHERE g.tenant_id = :t`));
  res.json(Object.fromEntries(rows.map((r) => [r.id, {
    queues: r.queues, people: r.people, primaryPeople: r.primaryPeople, forecast: r.forecast,
    schedule: r.schedule ? { ...r.schedule, coverage: r.schedule.coverage == null ? null : Math.round(Number(r.schedule.coverage) * 10) / 10 } : null,
  }])));
});

groupAdmin.get('/groups/import-template', requires('config:read'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wfm-groups-template.csv"');
  res.send(GROUP_FILE_TEMPLATE);
});

// ---------------------------------------------------------------- what depends on a group

export async function impactOf(tx: Tx, id: string) {
  const one = async (sql: string) => (await tx.one<{ n: number }>(sql, [id]))!.n;
  return {
    queues: await one('SELECT count(*)::int AS n FROM queues WHERE tenant_id = :t AND wfm_group_id = $1'),
    people: await one(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id = :t AND e.eligible_group_ids @> ARRAY[$1::uuid] AND ${ALIVE}`),
    primaryPeople: await one(`SELECT count(*)::int AS n FROM employees e WHERE e.tenant_id = :t AND e.primary_group_id = $1 AND ${ALIVE}`),
    forecastVersions: await one(`SELECT count(*)::int AS n FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status <> 'ARCHIVED'`),
    publishedSchedules: await one(`SELECT count(*)::int AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND period_end >= current_date`),
    scheduleVersions: await one(`SELECT count(*)::int AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status <> 'ARCHIVED'`),
    rotationPatterns: await one('SELECT count(*)::int AS n FROM rotation_patterns WHERE tenant_id = :t AND wfm_group_id = $1'),
    historyIntervals: await one('SELECT coalesce(sum(intervals), 0)::int AS n FROM interval_daily WHERE tenant_id = :t AND queue_id IN (SELECT id FROM queues WHERE tenant_id = :t AND wfm_group_id = $1)'),
  };
}

groupAdmin.get('/groups/:id/impact', requires('config:read'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  res.json(await withTenant(me(req).tenantId, async (tx) => { if (!(await loadGroups(tx, id))[0]) throw notFound('WFM group'); return impactOf(tx, id); }));
});

/** Deleting is only for a group nothing was ever built on; anything else is switched off (archived) instead, which keeps its history. */
groupAdmin.delete('/groups/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), reason = parse(z.string().trim().min(3, 'Say why you are deleting this group.').max(300), req.query.reason);
  await withTenant(p.tenantId, async (tx) => {
    const [g] = await loadGroups(tx, id);
    if (!g) throw notFound('WFM group');
    const i = await impactOf(tx, id);
    const used = [['queue', i.queues], ['person', i.people], ['forecast', i.forecastVersions], ['schedule', i.scheduleVersions], ['rotation pattern', i.rotationPatterns]].filter(([, n]) => (n as number) > 0).map(([w, n]) => `${n} ${w}${n === 1 ? '' : 's'}`);
    if (used.length) throw conflict(`${g.name} still has ${used.join(', ')}, so it cannot be deleted. Switch it off instead: that keeps its history and stops new forecasts and schedules.`);
    await tx.exec('DELETE FROM wfm_groups WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'WFM_GROUP', entityId: id, entityName: g.name, before: g, reason });
  });
  await dropCache(p.tenantId, 'fv:*');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- its people, with search and paging

groupAdmin.get('/groups/:id/members', requires('config:read'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const q = parse(z.object({ q: z.string().trim().max(80).default(''), teamId: z.string().max(40).default(''), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    if (!(await loadGroups(tx, id))[0]) throw notFound('WFM group');
    const where = `e.tenant_id = :t AND e.eligible_group_ids @> ARRAY[$1::uuid] AND ${ALIVE}
      AND ($2::text = '' OR concat_ws(' ', e.first_name, e.last_name, e.employee_number) ILIKE '%' || $2 || '%')
      AND ($3::text = '' OR ($3 = 'none' AND e.team_id IS NULL) OR e.team_id::text = $3)`;
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE ${where}`, [id, q.q, q.teamId]))!.n;
    const items = await tx.q<any>(
      `SELECT e.id, e.employee_number, e.first_name, e.last_name, e.team_id, t.name AS team_name, e.employment_type, e.status, (e.primary_group_id = $1) AS is_primary
       FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE ${where} ORDER BY e.last_name, e.first_name LIMIT $4 OFFSET $5`, [id, q.q, q.teamId, q.limit, q.offset]);
    const teams = await tx.q<any>(
      `SELECT e.team_id AS id, coalesce(t.name, 'No team') AS name, count(*)::int AS n FROM employees e LEFT JOIN teams t ON t.id = e.team_id
       WHERE e.tenant_id = :t AND e.eligible_group_ids @> ARRAY[$1::uuid] AND ${ALIVE} GROUP BY e.team_id, t.name ORDER BY name`, [id]);
    return {
      total, limit: q.limit, offset: q.offset,
      items: items.map((e) => ({ id: e.id, employeeNumber: e.employeeNumber, name: `${e.firstName} ${e.lastName}`, teamId: e.teamId, teamName: e.teamName, employmentType: e.employmentType, status: e.status, primary: !!e.isPrimary })),
      teams: teams.map((t) => ({ id: t.id ?? 'none', name: t.name, count: t.n })),
    };
  });
  res.json(out);
});

/** Add whole teams and/or named people to a group in one request. Someone with no primary group gets this one; nobody's existing primary group changes. */
const AddBody = z.object({ teamIds: z.array(uuid).max(200).default([]), employeeIds: z.array(uuid).max(5000).default([]) })
  .refine((b) => b.teamIds.length + b.employeeIds.length > 0, { message: 'Choose at least one team or person.' });
groupAdmin.post('/groups/:id/members', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(AddBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [g] = await loadGroups(tx, id);
    if (!g) throw notFound('WFM group');
    const match = `e.tenant_id = :t AND e.status <> 'TERMINATED' AND (e.team_id = ANY($2::uuid[]) OR e.id = ANY($3::uuid[]))`;
    const chosen = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM employees e WHERE ${match} AND $1::uuid IS NOT NULL`, [id, b.teamIds, b.employeeIds]))!.n;
    const rows = await tx.q<{ id: string; prim: boolean }>(
      `UPDATE employees e SET eligible_group_ids = array_append(e.eligible_group_ids, $1::uuid), primary_group_id = coalesce(e.primary_group_id, $1::uuid), version = e.version + 1, updated_at = now()
       WHERE ${match} AND NOT (e.eligible_group_ids @> ARRAY[$1::uuid]) RETURNING e.id, (e.primary_group_id = $1::uuid) AS prim`, [id, b.teamIds, b.employeeIds]);
    const result = { added: rows.length, alreadyIn: chosen - rows.length, madePrimary: rows.filter((r) => r.prim).length };
    if (rows.length) await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: id, entityName: g.name, diffSummary: `Added ${rows.length} ${rows.length === 1 ? 'person' : 'people'}${b.teamIds.length ? ` (${b.teamIds.length} team${b.teamIds.length === 1 ? '' : 's'} chosen)` : ''}` });
    return result;
  });
  res.json(out);
});

// ---------------------------------------------------------------- who changed what

groupAdmin.get('/groups/:id/history', requires('config:read'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const rows = await withTenant(me(req).tenantId, async (tx) => {
    if (!(await loadGroups(tx, id))[0]) throw notFound('WFM group');
    return tx.q<any>(
      `SELECT id, at, actor_name, action, entity_type, entity_name, reason, diff_summary, before, after FROM audit_log
       WHERE tenant_id = :t AND ((entity_type = 'WFM_GROUP' AND entity_id = $1::text) OR (entity_type = 'QUEUE' AND entity_id IN (SELECT id::text FROM queues WHERE tenant_id = :t AND wfm_group_id = $2::uuid)))
       ORDER BY id DESC LIMIT 60`, [id, id]);
  });
  res.json(rows.map((r) => ({
    id: String(r.id), at: r.at, actor: r.actorName, action: r.action, what: r.entityType === 'QUEUE' ? `Queue ${r.entityName ?? ''}`.trim() : 'Group settings', reason: r.reason ?? null, summary: r.diffSummary ?? null,
    changes: r.action === 'UPDATE' ? diffFields(r.before, r.after).slice(0, 12) : [],
  })));
});

// ---------------------------------------------------------------- clone

const CloneBody = z.object({ name: z.string().trim().min(1).max(80), queues: z.boolean().default(true), shrinkage: z.boolean().default(true), coverage: z.boolean().default(true) });
groupAdmin.post('/groups/:id/clone', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(CloneBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const src = await tx.one<any>('SELECT * FROM wfm_groups WHERE tenant_id = :t AND id = $1', [id]);
    if (!src) throw notFound('WFM group');
    if (await tx.one('SELECT 1 FROM wfm_groups WHERE tenant_id = :t AND lower(name) = lower($1)', [b.name])) throw conflict(`A WFM group named "${b.name}" already exists. Choose another name.`);
    let newCode = code(b.name);
    for (let n = 2; await tx.one('SELECT 1 FROM wfm_groups WHERE tenant_id = :t AND code = $1', [newCode]); n++) newCode = `${code(b.name).slice(0, 26)}-${n}`;
    const g = await tx.one<{ id: string }>(
      `INSERT INTO wfm_groups (tenant_id, name, code, description, timezone, service_level, answer_sec, shrinkage, occupancy_cap, method, patience_sec, blended, model, fte_hours_week, pay_week_start, site_id, manager_id)
       SELECT tenant_id, $2, $3, description, timezone, service_level, answer_sec, shrinkage, occupancy_cap, method, patience_sec, blended, model, fte_hours_week, pay_week_start, site_id, manager_id
       FROM wfm_groups WHERE tenant_id = :t AND id = $1 RETURNING id`, [id, b.name, newCode]);
    const gid = g!.id;
    if (b.shrinkage) await tx.exec('INSERT INTO shrinkage_categories (tenant_id, wfm_group_id, name, pct, sort) SELECT tenant_id, $2, name, pct, sort FROM shrinkage_categories WHERE tenant_id = :t AND wfm_group_id = $1', [id, gid]);
    if (b.coverage) await tx.exec('INSERT INTO coverage_windows (tenant_id, wfm_group_id, day_of_week, start_slot, end_slot, headcount) SELECT tenant_id, $2, day_of_week, start_slot, end_slot, headcount FROM coverage_windows WHERE tenant_id = :t AND wfm_group_id = $1', [id, gid]);
    let queues = 0;
    if (b.queues) {
      // queue names and codes are unique across the organisation, so the copy carries the new group's name; aliases stay with the originals
      for (const q of await tx.q<any>('SELECT * FROM queues WHERE tenant_id = :t AND wfm_group_id = $1 ORDER BY name', [id])) {
        let name = `${q.name} (${b.name})`.slice(0, 80), qc = code(name);
        for (let n = 2; await tx.one('SELECT 1 FROM queues WHERE tenant_id = :t AND (lower(name) = lower($1) OR code = $2)', [name, qc]); n++) { name = `${q.name} (${b.name}) ${n}`.slice(0, 80); qc = code(name); }
        await tx.exec(
          `INSERT INTO queues (tenant_id, wfm_group_id, name, code, channel, aht_default, concurrency, open_slot, close_slot, sla_target_seconds, sla_target_percent, turnaround_hours, skill_id, volume_basis, abandon_repeat_pct)
           VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [gid, name, qc, q.channel, q.ahtDefault, q.concurrency, q.openSlot, q.closeSlot, q.slaTargetSeconds, q.slaTargetPercent, q.turnaroundHours, q.skillId, q.volumeBasis, q.abandonRepeatPct]);
        queues++;
      }
    }
    const [dto] = await loadGroups(tx, gid);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'WFM_GROUP', entityId: gid, entityName: b.name, after: dto, diffSummary: `Copied from ${src.name}${queues ? ` with ${queues} queue${queues === 1 ? '' : 's'}` : ''}` });
    return { ...dto, copiedQueues: queues };
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- many groups and queues from one file

const ImportBody = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });
groupAdmin.post('/groups/import', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(ImportBody, req.body);
  const file = parseGroupFile(parseCsv(b.csv));
  const problems = [...file.errors];
  const result = await withTenant(p.tenantId, async (tx) => {
    const sites = new Map((await tx.q<any>('SELECT id, name FROM sites WHERE tenant_id = :t')).map((s) => [s.name.toLowerCase(), s.id as string]));
    const haveGroups = new Set((await tx.q<any>('SELECT name FROM wfm_groups WHERE tenant_id = :t')).map((g) => g.name.toLowerCase()));
    const taken = new Set((await tx.q<any>('SELECT lower(a) AS a FROM queues q, LATERAL unnest(ARRAY[q.name, q.code] || q.aliases) AS a WHERE q.tenant_id = :t')).map((r) => r.a as string));
    const inFile = new Set<string>();
    for (const g of file.groups) {
      if (haveGroups.has(g.name.toLowerCase())) problems.push({ line: g.line, message: `A WFM group named "${g.name}" already exists.` });
      if (g.site && !sites.has(g.site.toLowerCase())) problems.push({ line: g.line, message: `There is no site called "${g.site}". Create the site first, or leave the column empty.` });
      for (const q of g.queues) for (const n of [q.name, ...q.aliases]) {
        const k = n.toLowerCase();
        if (taken.has(k)) problems.push({ line: q.line, message: `"${n}" is already the name, code or alias of a queue.` });
        else if (inFile.has(k)) problems.push({ line: q.line, message: `"${n}" appears twice in this file.` });
        inFile.add(k);
      }
    }
    const summary = file.groups.map((g) => ({ name: g.name, site: g.site, queues: g.queues.length, line: g.line }));
    if (b.dryRun || problems.length) return { committed: false, groups: summary };
    const tz = (await tx.one<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = :t'))?.timezone ?? 'UTC';
    for (const g of file.groups) {
      let gc = code(g.name);
      for (let n = 2; await tx.one('SELECT 1 FROM wfm_groups WHERE tenant_id = :t AND code = $1', [gc]); n++) gc = `${code(g.name).slice(0, 26)}-${n}`;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO wfm_groups (tenant_id, name, code, description, timezone, service_level, answer_sec, shrinkage, occupancy_cap, site_id)
         VALUES (:t, $1, $2, $3, $4, coalesce($5::numeric, 80)/100.0, coalesce($6::int, 20), coalesce($7::numeric, 30)/100.0, coalesce($8::numeric, 85)/100.0, $9::uuid) RETURNING id`,
        [g.name, gc, g.description, g.timezone ?? tz, g.serviceLevelGoal ?? null, g.serviceLevelThresholdSec ?? null, g.shrinkagePercent ?? null, g.targetOccupancy ?? null, g.site ? sites.get(g.site.toLowerCase()) : null]);
      for (const q of g.queues) {
        let qc = code(q.name);
        for (let n = 2; await tx.one('SELECT 1 FROM queues WHERE tenant_id = :t AND code = $1', [qc]); n++) qc = `${code(q.name).slice(0, 26)}-${n}`;
        await tx.exec(`INSERT INTO queues (tenant_id, wfm_group_id, name, code, channel, aht_default, concurrency, aliases) VALUES (:t, $1, $2, $3, $4, $5, $6, $7::text[])`,
          [row!.id, q.name, qc, q.channel, q.ahtDefault, q.channel === 'CHAT' ? 2 : 1, q.aliases]);
      }
      await audit(tx, p, req, { action: 'IMPORT', entityType: 'WFM_GROUP', entityId: row!.id, entityName: g.name, diffSummary: `Created from a file with ${g.queues.length} queue${g.queues.length === 1 ? '' : 's'}` });
    }
    return { committed: true, groups: summary };
  });
  if (result.committed) await dropCache(p.tenantId, 'fv:*');
  res.status(problems.length ? 200 : result.committed ? 201 : 200).json({ ...result, errors: problems.sort((a, c) => a.line - c.line).slice(0, 200), errorCount: problems.length });
});

