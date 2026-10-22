/**
 * Multi-site and multi-skill.
 *   Sites: where people work, each with a time zone; a WFM group belongs to one.
 *   Group skills: a group can require skills. Its pool is then everyone who has all of them at the required level, in any group,
 *   so cross-trained people serve several groups (the scheduler stops the same person being booked for two groups at once).
 *   Roll-up: every published schedule side by side, by group and by site, with who could be borrowed to cover a gap.
 *   Pooling: what one shared pool would need compared with separate pools, so the value of cross-training is visible.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache } from '../infra.ts';
import { aggregateStaff, dayRange, loadGroup, runStaffing, versionRows, type Group } from './forecast/service.ts';
import { liveStats, loadVersion } from './scheduleRoutes.ts';
import { hhmm } from './workforceRoutes.ts';

export const sitesRoutes = Router();    // mounted at /config
export const rollupRoutes = Router();   // mounted at /scheduling/rollup
export const poolingRoutes = Router();  // mounted at /forecast/pooling
const uuid = z.string().uuid();
const SPD = 96;
const r1 = (v: number) => Math.round(v * 10) / 10;
const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'SITE';

// ---------------------------------------------------------------- sites

const SiteBody = z.object({ name: z.string().trim().min(1).max(80), timezone: z.string().trim().min(1).max(60), country: z.string().trim().max(60).default('') });
const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const siteDto = (s: any) => ({ id: s.id, name: s.name, code: s.code, timezone: s.timezone, country: s.country, groups: s.groups ?? [] });

async function loadSites(tx: Tx) {
  const sites = await tx.q<any>('SELECT * FROM sites WHERE tenant_id = :t ORDER BY name');
  const groups = await tx.q<any>('SELECT id, name, site_id FROM wfm_groups WHERE tenant_id = :t AND site_id IS NOT NULL ORDER BY name');
  return sites.map((s) => siteDto({ ...s, groups: groups.filter((g) => g.siteId === s.id).map((g) => ({ id: g.id, name: g.name })) }));
}

sitesRoutes.get('/sites', requires('config:read'), async (req, res) => { res.json(await withTenant(me(req).tenantId, loadSites)); });
sitesRoutes.post('/sites', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(SiteBody, req.body);
  if (!validZone(b.timezone)) throw bad(`"${b.timezone}" is not a time zone name. Use names like Asia/Kolkata or Europe/London.`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const s = await tx.one<any>('INSERT INTO sites (tenant_id, name, code, timezone, country) VALUES (:t, $1, $2, $3, $4) RETURNING *', [b.name, code(b.name), b.timezone, b.country]).catch((e) => { throw e.code === '23505' ? conflict('A site with that name already exists.') : e; });
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SITE', entityId: s!.id, entityName: b.name, after: siteDto(s) });
    return siteDto(s);
  });
  res.status(201).json(out);
});
sitesRoutes.put('/sites/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(SiteBody, req.body);
  if (!validZone(b.timezone)) throw bad(`"${b.timezone}" is not a time zone name.`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const s = await tx.one<any>('UPDATE sites SET name = $2, timezone = $3, country = $4 WHERE tenant_id = :t AND id = $1 RETURNING *', [id, b.name, b.timezone, b.country]).catch((e) => { throw e.code === '23505' ? conflict('A site with that name already exists.') : e; });
    if (!s) throw notFound('Site');
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SITE', entityId: id, entityName: b.name, after: siteDto(s) });
    return siteDto(s);
  });
  res.json(out);
});
sitesRoutes.delete('/sites/:id', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const s = await tx.one<any>('DELETE FROM sites WHERE tenant_id = :t AND id = $1 RETURNING *', [id]);
    if (!s) throw notFound('Site');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'SITE', entityId: id, entityName: s.name, diffSummary: 'its groups now belong to no site' });
  });
  res.json({ ok: true });
});
sitesRoutes.put('/groups/:id/site', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(z.object({ siteId: uuid.nullable() }), req.body);
  await withTenant(p.tenantId, async (tx) => {
    if (b.siteId && !(await tx.one('SELECT 1 FROM sites WHERE tenant_id = :t AND id = $1', [b.siteId]))) throw notFound('Site');
    const g = await tx.one<any>('UPDATE wfm_groups SET site_id = $2, updated_at = now() WHERE tenant_id = :t AND id = $1 RETURNING name', [id, b.siteId]);
    if (!g) throw notFound('WFM group');
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: id, entityName: g.name, diffSummary: b.siteId ? 'assigned to a site' : 'removed from its site' });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- group skills and the pool they define

sitesRoutes.get('/groups/:id/skills', requires('config:read'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  res.json(await withTenant(me(req).tenantId, async (tx) => (await tx.q<any>('SELECT gs.skill_id, s.name, s.code, gs.min_proficiency FROM group_skills gs JOIN skills s ON s.id = gs.skill_id WHERE gs.tenant_id = :t AND gs.wfm_group_id = $1 ORDER BY s.name', [id]))
    .map((r) => ({ skillId: r.skillId, name: r.name, code: r.code, minProficiency: r.minProficiency }))));
});
sitesRoutes.put('/groups/:id/skills', requires('config:write'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ skills: z.array(z.object({ skillId: uuid, minProficiency: z.number().int().min(1).max(5) })).max(20) }), req.body);
  await withTenant(p.tenantId, async (tx) => {
    const g = await tx.one<any>('SELECT name FROM wfm_groups WHERE tenant_id = :t AND id = $1', [id]);
    if (!g) throw notFound('WFM group');
    const before = await tx.q<any>('SELECT skill_id, min_proficiency FROM group_skills WHERE tenant_id = :t AND wfm_group_id = $1', [id]);
    await tx.exec('DELETE FROM group_skills WHERE tenant_id = :t AND wfm_group_id = $1', [id]);
    for (const s of b.skills) {
      if (!(await tx.one('SELECT 1 FROM skills WHERE tenant_id = :t AND id = $1', [s.skillId]))) throw notFound('Skill');
      await tx.exec('INSERT INTO group_skills (tenant_id, wfm_group_id, skill_id, min_proficiency) VALUES (:t, $1, $2, $3) ON CONFLICT DO NOTHING', [id, s.skillId, s.minProficiency]);
    }
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: id, entityName: g.name, before: before, after: b.skills, diffSummary: `required skills: ${b.skills.length}` });
  });
  await dropCache(p.tenantId, 'sched:*');
  res.json({ ok: true });
});

/** Who is in the group's pool and why, and who is left out for lack of a skill. */
sitesRoutes.get('/groups/:id/pool', requires('config:read'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  res.json(await withTenant(me(req).tenantId, async (tx) => {
    const g = await tx.one<any>('SELECT id, name FROM wfm_groups WHERE tenant_id = :t AND id = $1', [id]);
    if (!g) throw notFound('WFM group');
    const req_ = await tx.q<any>('SELECT gs.skill_id, s.name, gs.min_proficiency FROM group_skills gs JOIN skills s ON s.id = gs.skill_id WHERE gs.tenant_id = :t AND gs.wfm_group_id = $1', [id]);
    const emps = await tx.q<any>(`SELECT e.id, e.employee_number, e.first_name, e.last_name, e.primary_group_id, e.eligible_group_ids, pg.name AS home FROM employees e LEFT JOIN wfm_groups pg ON pg.id = e.primary_group_id WHERE e.tenant_id = :t AND e.status = 'ACTIVE'`);
    const has = await tx.q<any>('SELECT employee_id, skill_id, proficiency FROM employee_skills WHERE tenant_id = :t');
    const level = new Map(has.map((h) => [`${h.employeeId}|${h.skillId}`, h.proficiency as number]));
    const people = emps.map((e) => {
      const primary = e.primaryGroupId === id, listed = primary || (e.eligibleGroupIds ?? []).includes(id);
      const missing = req_.filter((r) => (level.get(`${e.id}|${r.skillId}`) ?? 0) < r.minProficiency).map((r) => `${r.name} ${r.minProficiency}+`);
      const inPool = req_.length ? missing.length === 0 : listed;
      return { employeeId: e.id, name: `${e.firstName} ${e.lastName}`, employeeNumber: e.employeeNumber, homeGroup: e.home ?? null, primary, listed, inPool, missing };
    }).filter((p) => p.listed || p.inPool);
    const pool = people.filter((p) => p.inPool);
    return { groupId: id, groupName: g.name, skillBased: req_.length > 0, requires: req_.map((r) => ({ skillId: r.skillId, name: r.name, minProficiency: r.minProficiency })),
      counts: { inPool: pool.length, fromOtherGroups: pool.filter((p) => !p.primary).length, leftOut: people.length - pool.length }, people: people.sort((a, b) => Number(b.inPool) - Number(a.inPool) || a.name.localeCompare(b.name)) };
  }));
});

// ---------------------------------------------------------------- multi-site roll-up

const offsetMin = (tz: string, day: string) => {
  const [y, m, d] = day.split('-').map(Number), at = new Date(Date.UTC(y, m - 1, d, 12));
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  let diff = (+parts.find((x) => x.type === 'hour')!.value * 60 + +parts.find((x) => x.type === 'minute')!.value) - 12 * 60;
  if (diff > 720) diff -= 1440; if (diff < -720) diff += 1440;
  return diff;
};

rollupRoutes.get('/', requires('schedule:read'), async (req, res) => {
  const p = me(req);
  const q = parse(z.object({ from: z.string().regex(isoDay), to: z.string().regex(isoDay), day: z.string().regex(isoDay).optional() }), req.query);
  if (q.to < q.from || dayRange(q.from, q.to, 60).length > 42) throw bad('Ask for up to six weeks at a time.');
  const list = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT DISTINCT ON (v.wfm_group_id) v.id, v.wfm_group_id, g.name AS group_name, coalesce(s.timezone, g.timezone) AS timezone, g.site_id, s.name AS site_name FROM schedule_versions v JOIN wfm_groups g ON g.id = v.wfm_group_id LEFT JOIN sites s ON s.id = g.site_id
     WHERE v.tenant_id = :t AND v.status = 'PUBLISHED' AND v.period_start <= $2::date AND v.period_end >= $1::date ORDER BY v.wfm_group_id, v.seq DESC`, [q.from, q.to]));
  const days = dayRange(q.from, q.to, 60);
  const groups: any[] = [];
  const loaded: { row: any; v: any; live: Awaited<ReturnType<typeof liveStats>> }[] = [];
  for (const row of list) { const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, row.id)); loaded.push({ row, v, live: await liveStats(p.tenantId, v) }); }
  // the chart day: the one asked for if any schedule covers it, otherwise the first day that has data, so the chart is never blank
  const chartDay = q.day && loaded.some((l) => l.live.days.includes(q.day!)) ? q.day : days.find((d) => loaded.some((l) => l.live.days.includes(d))) ?? null;
  for (const { row, v, live } of loaded) {
    const idx = new Map(live.days.map((d, i) => [d, i]));
    const sched = new Array(live.days.length * SPD).fill(0);
    for (const s of live.shifts) { const i = idx.get(s.day); if (i === undefined) continue; for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++; }
    const busyElsewhere = (d: string) => new Set(live.ctx.others.filter((o) => o.day === d).map((o) => o.employeeId));
    const per = days.filter((d) => idx.has(d)).map((d) => {
      const i = idx.get(d)!;
      let need = 0, have = 0, under = 0, underIntervals = 0;
      for (let s = 0; s < SPD; s++) { const g = i * SPD + s, r = live.required[g]; need += r; have += sched[g]; if (sched[g] < r) { under += r - sched[g]; underIntervals++; } }
      const working = new Set(live.shifts.filter((s) => s.day === d).map((s) => s.employeeId)), off = busyElsewhere(d);
      const free = live.ctx.employees.filter((e: any) => e.status === 'ACTIVE' && !working.has(e.id) && !off.has(e.id) && !live.ctx.timeOff.some((o: any) => o.employeeId === e.id && o.startDay <= d && o.endDay >= d)).length;
      return { day: d, requiredHours: r1(need / 4), scheduledHours: r1(have / 4), coveragePercent: need ? r1((1 - under / need) * 100) : 100, underIntervals, underSlots: r1(under), needSlots: r1(need), available: free };
    });
    const series = chartDay && idx.has(chartDay) ? (() => {
      const i = idx.get(chartDay)!, off = offsetMin(row.timezone, chartDay), [y, m, d] = chartDay.split('-').map(Number);
      const byHour = new Map<string, { required: number; scheduled: number }>();
      for (let s = 0; s < SPD; s++) {
        const at = new Date(Date.UTC(y, m - 1, d) + s * 15 * 60000 - off * 60000), k = at.toISOString().slice(0, 13);
        const c = byHour.get(k) ?? { required: 0, scheduled: 0 };
        c.required += live.required[i * SPD + s] / 4; c.scheduled += sched[i * SPD + s] / 4; byHour.set(k, c);
      }
      return [...byHour].map(([hour, c]) => ({ hour, required: r1(c.required), scheduled: r1(c.scheduled) }));
    })() : null;
    groups.push({ groupId: row.wfmGroupId, groupName: row.groupName, siteId: row.siteId, siteName: row.siteName ?? 'No site', timezone: row.timezone, scheduleName: v.name, days: per, series });
  }
  const sum = (g: any[]) => {
    const need = g.reduce((t, x) => t + x.days.reduce((a: number, d: any) => a + d.needSlots, 0), 0), under = g.reduce((t, x) => t + x.days.reduce((a: number, d: any) => a + d.underSlots, 0), 0);
    return { requiredHours: r1(g.reduce((t, x) => t + x.days.reduce((a: number, d: any) => a + d.requiredHours, 0), 0)), scheduledHours: r1(g.reduce((t, x) => t + x.days.reduce((a: number, d: any) => a + d.scheduledHours, 0), 0)), coveragePercent: need ? r1((1 - under / need) * 100) : 100 };
  };
  const sites = [...new Set(groups.map((g) => g.siteName))].map((name) => {
    const gs = groups.filter((g) => g.siteName === name);
    const merged = new Map<string, { required: number; scheduled: number }>();
    for (const g of gs) for (const s of g.series ?? []) { const c = merged.get(s.hour) ?? { required: 0, scheduled: 0 }; c.required += s.required; c.scheduled += s.scheduled; merged.set(s.hour, c); }
    return { siteName: name, timezone: [...new Set(gs.map((g) => g.timezone))].join(', '), groups: gs.map((g) => g.groupName), ...sum(gs), series: chartDay ? [...merged].sort().map(([hour, c]) => ({ hour, required: r1(c.required), scheduled: r1(c.scheduled) })) : null };
  });
  res.json({ from: q.from, to: q.to, day: chartDay, total: sum(groups), sites, groups });
});

// ---------------------------------------------------------------- pooling benefit

poolingRoutes.get('/', requires('forecast:read'), async (req, res) => {
  const p = me(req);
  const q = parse(z.object({ groupIds: z.string().min(1), day: z.string().regex(isoDay) }), req.query);
  const ids = [...new Set(q.groupIds.split(',').map((x) => x.trim()).filter(Boolean))];
  if (ids.length < 2 || ids.length > 8 || ids.some((i) => !uuid.safeParse(i).success)) throw bad('Pick between two and eight WFM groups to compare.');
  const loaded = await withTenant(p.tenantId, async (tx) => {
    const out: { group: Group; rows: any[]; name: string }[] = [];
    for (const id of ids) {
      const group = await loadGroup(tx, id);
      const v = await tx.one<any>(`SELECT id, name FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND status = 'PUBLISHED' AND from_day <= $2::date AND to_day >= $2::date ORDER BY seq DESC LIMIT 1`, [id, q.day]);
      if (!v) throw bad(`${group.name} has no published short-term forecast covering ${q.day}.`);
      const rows = (await versionRows(tx, v.id, { from: q.day, to: q.day })).map((r) => ({ queueId: r.queueId, day: r.day, slot: r.slot, vol: r.vol, aht: r.aht }));
      out.push({ group, rows, name: group.name });
    }
    return out;
  });
  const separate = new Map<string, { required: number; base: number }>();
  let workTotal = 0, shrinkWork = 0;
  for (const g of loaded) {
    const agg = aggregateStaff(await runStaffing(g.group, g.rows));
    for (const [k, v] of agg) { const c = separate.get(k) ?? { required: 0, base: 0 }; c.required += v.required; c.base += v.base; separate.set(k, c); }
    const work = g.rows.reduce((t, r) => t + r.vol * r.aht, 0);
    workTotal += work; shrinkWork += work * g.group.shrinkage;
  }
  const first = loaded[0].group;
  const merged: Group = { ...first, queues: loaded.flatMap((g) => g.group.queues), shrinkage: workTotal ? shrinkWork / workTotal : first.shrinkage };
  const pooled = aggregateStaff(await runStaffing(merged, loaded.flatMap((g) => g.rows)));
  const slots = Array.from({ length: SPD }, (_, s) => { const k = `${q.day}|${s}`; return { slot: s, time: hhmm(s), separate: r1(separate.get(k)?.required ?? 0), pooled: r1(pooled.get(k)?.required ?? 0) }; });
  const sepH = r1(slots.reduce((t, s) => t + s.separate, 0) / 4), poolH = r1(slots.reduce((t, s) => t + s.pooled, 0) / 4);
  res.json({
    day: q.day, groups: loaded.map((g) => ({ id: g.group.id, name: g.name, queues: g.group.queues.length, contacts: Math.round(g.rows.reduce((t, r) => t + r.vol, 0)) })),
    separateHours: sepH, pooledHours: poolH, savingHours: r1(sepH - poolH), savingPercent: sepH ? r1(((sepH - poolH) / sepH) * 100) : 0,
    peakSeparate: Math.max(0, ...slots.map((s) => s.separate)), peakPooled: Math.max(0, ...slots.map((s) => s.pooled)),
    targets: { serviceLevel: first.serviceLevel, answerSec: first.answerSec, from: first.name },
    note: 'Both sides use the same service target (the first group\'s) and are worked out with the same staffing engine. Pooling helps most when the groups are cross-trained enough to share agents in the moment.', slots,
  });
});

