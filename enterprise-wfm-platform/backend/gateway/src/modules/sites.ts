/**
 * Multi-site and multi-skill.
 *   Sites: where people work, each with a time zone; a WFM group belongs to one.
 *   Group skills: a group can require skills. Its pool is then everyone who has all of them at the required level, in any group,
 *   so cross-trained people serve several groups (the scheduler stops the same person being booked for two groups at once).
 *   Roll-up: every published schedule side by side, by group and by site, with who could be borrowed to cover a gap.
 *   Pooling: what one shared pool would need compared with separate pools, so the value of cross-training is visible.
 */
import { Router } from 'express';
import { assertCapacity } from './licensing/service.ts';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, requireUnscoped } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache } from '../infra.ts';
import { aggregateStaff, dayRange, loadGroup, runStaffing, versionRows, type Group } from './forecast/service.ts';
import { lightLive, loadVersion, POOL_WHERE } from './scheduleRoutes.ts';
import { hhmm } from './workforceRoutes.ts';
import { tzFmt } from '../tzFormat.ts';
import Holidays from 'date-holidays';
import { addHolidays, hasCountry, publicHolidays, countryNames } from './holidays.ts';
import { ensureBuiltIns } from './compliance/routes.ts';
import { BUILT_INS } from './compliance/rules.ts';
import { raw } from '../db.ts';
import { addShiftCoverage } from './shiftCoverage.ts';

export const sitesRoutes = Router();    // mounted at /config
export const rollupRoutes = Router();   // mounted at /scheduling/rollup
export const poolingRoutes = Router();  // mounted at /forecast/pooling
const uuid = z.string().uuid();
const SPD = 96;
const r1 = (v: number) => Math.round(v * 10) / 10;
const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'SITE';

// ---------------------------------------------------------------- sites and regions

const SiteBody = z.object({
  name: z.string().trim().min(1).max(80), timezone: z.string().trim().min(1).max(60), country: z.string().trim().max(60).default(''),
  regionId: uuid.nullable().default(null), address: z.string().trim().max(300).default(''), status: z.enum(['ACTIVE', 'CLOSED']).default('ACTIVE'),
  countryCode: z.string().trim().length(2).or(z.literal('')).default(''), managerId: uuid.nullable().default(null),
});
/** What to set up together with a new site, so it is ready to use rather than empty: the country's public holidays, its labour-law pack, or a copy of another site's. */
const SetupBody = z.object({ addHolidays: z.boolean().default(false), applyPack: z.boolean().default(false), copyFromSiteId: uuid.nullable().default(null) }).default({ addHolidays: false, applyPack: false, copyFromSiteId: null });
const RegionBody = z.object({ name: z.string().trim().min(1).max(80) });
const validZone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const siteDto = (s: any) => ({
  id: s.id, name: s.name, code: s.code, timezone: s.timezone, country: s.country, regionId: s.regionId ?? null, regionName: s.regionName ?? null,
  address: s.address ?? '', status: s.status ?? 'ACTIVE', closedOn: s.closedOn ?? null, groups: s.groups ?? [], people: s.people ?? 0,
  countryCode: s.countryCode ?? '', managerId: s.managerId ?? null, managerName: s.managerName ?? null, packName: s.packName ?? null, holidays: s.holidays ?? 0,
});

async function loadSites(tx: Tx, id?: string) {
  const sites = await tx.q<any>(
    `SELECT s.*, s.closed_on::text AS closed_on, r.name AS region_name, m.first_name || ' ' || m.last_name AS manager_name, p.name AS pack_name,
            (SELECT count(*)::int FROM special_events e WHERE e.tenant_id = s.tenant_id AND e.site_id = s.id AND e.kind = 'holiday') AS holidays
     FROM sites s LEFT JOIN regions r ON r.id = s.region_id AND r.tenant_id = s.tenant_id LEFT JOIN employees m ON m.id = s.manager_id
     LEFT JOIN compliance_assignments ca ON ca.tenant_id = s.tenant_id AND ca.scope_type = 'SITE' AND ca.scope_id = s.id LEFT JOIN compliance_packs p ON p.id = ca.pack_id
     WHERE s.tenant_id = :t ${id ? 'AND s.id = $1' : ''} ORDER BY s.name`, id ? [id] : []);
  const groups = await tx.q<any>('SELECT id, name, site_id FROM wfm_groups WHERE tenant_id = :t AND site_id IS NOT NULL ORDER BY name');
  // a person is at the site their primary group belongs to
  const people = new Map((await tx.q<any>(
    `SELECT g.site_id, count(*)::int AS n FROM employees e JOIN wfm_groups g ON g.id = e.primary_group_id AND g.tenant_id = e.tenant_id
     WHERE e.tenant_id = :t AND e.status = 'ACTIVE' AND g.site_id IS NOT NULL GROUP BY g.site_id`)).map((r) => [r.siteId, r.n as number]));
  return sites.map((s) => siteDto({ ...s, people: people.get(s.id) ?? 0, groups: groups.filter((g) => g.siteId === s.id).map((g) => ({ id: g.id, name: g.name })) }));
}
async function ensureManager(tx: Tx, id: string | null) {
  if (id && !(await tx.one(`SELECT 1 FROM employees WHERE tenant_id = :t AND id = $1 AND status <> 'TERMINATED'`, [id]))) throw notFound('Manager');
}
async function ensureRegion(tx: Tx, regionId: string | null) {
  if (regionId && !(await tx.one('SELECT 1 FROM regions WHERE tenant_id = :t AND id = $1', [regionId]))) throw notFound('Region');
}
const dupSite = (e: any) => { throw e.code === '23505' ? conflict('A site with that name already exists.') : e; };

sitesRoutes.get('/sites', requires('config:read'), async (req, res) => { res.json(await withTenant(me(req).tenantId, (tx) => loadSites(tx))); });
sitesRoutes.post('/sites', requires('config:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), b = parse(SiteBody.extend({ setup: SetupBody }), req.body);
  if (!validZone(b.timezone)) throw bad(`"${b.timezone}" is not a time zone name. Use names like Asia/Kolkata or Europe/London.`);
  const out = await withTenant(p.tenantId, async (tx) => {
    await ensureRegion(tx, b.regionId);
    await ensureManager(tx, b.managerId);
    if (b.status === 'ACTIVE') await assertCapacity(tx, p.tenantId, 'SITES', 1);
    const s = await tx.one<any>(
      `INSERT INTO sites (tenant_id, name, code, timezone, country, region_id, address, status, closed_on, country_code, manager_id) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'CLOSED' THEN current_date END, $8, $9) RETURNING id`,
      [b.name, code(b.name), b.timezone, b.country, b.regionId, b.address, b.status, b.countryCode.toUpperCase(), b.managerId]).catch(dupSite);
    const setup = { holidaysAdded: 0, packName: null as string | null, copied: null as string | null };
    const src = b.setup.copyFromSiteId ? await tx.one<any>('SELECT id, name FROM sites WHERE tenant_id = :t AND id = $1', [b.setup.copyFromSiteId]) : null;
    if (src) {
      // a copy of another site's calendar and labour-law pack
      setup.holidaysAdded = await tx.exec(
        `INSERT INTO special_events (tenant_id, site_id, name, kind, start_day, end_day, uplift_pct, lead_days, lag_days)
         SELECT tenant_id, $2::uuid, name, kind, start_day, end_day, uplift_pct, lead_days, lag_days FROM special_events WHERE tenant_id = :t AND site_id = $1 AND kind = 'holiday'`, [src.id, s!.id]);
      await tx.exec(
        `INSERT INTO compliance_assignments (tenant_id, workspace_id, scope_type, scope_id, scope_key, pack_id)
         SELECT tenant_id, workspace_id, 'SITE', $2::uuid, $2::text, pack_id FROM compliance_assignments WHERE tenant_id = :t AND scope_type = 'SITE' AND scope_id = $1`, [src.id, s!.id]);
      setup.copied = src.name;
    } else {
      const cc = b.countryCode.toUpperCase();
      if (b.setup.addHolidays && cc && hasCountry(cc)) {
        const year = new Date().getUTCFullYear();
        setup.holidaysAdded = await addHolidays(tx, [...publicHolidays(cc, year), ...publicHolidays(cc, year + 1)], s!.id);
      }
      if (b.setup.applyPack && cc) {
        const [tpl] = await raw<any>('SELECT compliance_pack FROM wfm.country_templates WHERE upper(code) = $1', [cc]);
        if (tpl?.compliancePack) {
          await ensureBuiltIns(tx);
          const pack = await tx.one<any>('SELECT id, name FROM compliance_packs WHERE tenant_id = :t AND code = $1', [tpl.compliancePack]);
          if (pack) {
            await tx.exec(`INSERT INTO compliance_assignments (tenant_id, workspace_id, scope_type, scope_id, scope_key, pack_id) VALUES (:t, :w, 'SITE', $1::uuid, $1::text, $2) ON CONFLICT (tenant_id, workspace_id, scope_type, scope_key) DO UPDATE SET pack_id = EXCLUDED.pack_id`, [s!.id, pack.id]);
            setup.packName = pack.name;
          }
        }
      }
    }
    const [dto] = await loadSites(tx, s!.id);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SITE', entityId: s!.id, entityName: b.name, after: { ...dto, setup } });
    return { ...dto, setup };
  });
  res.status(201).json(out);
});
sitesRoutes.put('/sites/:id', requires('config:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), id = parse(uuid, req.params.id), b = parse(SiteBody, req.body);
  if (!validZone(b.timezone)) throw bad(`"${b.timezone}" is not a time zone name.`);
  const out = await withTenant(p.tenantId, async (tx) => {
    const [before] = await loadSites(tx, id);
    if (!before) throw notFound('Site');
    await ensureRegion(tx, b.regionId);
    await ensureManager(tx, b.managerId);
    if (b.status === 'CLOSED' && before.status !== 'CLOSED') {
      // a site closes only when nothing is still running there: the history stays, the groups must be moved on first
      const live = await tx.q<any>(`SELECT name FROM wfm_groups WHERE tenant_id = :t AND site_id = $1 AND status = 'ACTIVE' ORDER BY name`, [id]);
      if (live.length) throw conflict(`${live.map((g) => g.name).join(', ')} still ${live.length === 1 ? 'belongs' : 'belong'} to ${before.name}. Move ${live.length === 1 ? 'it' : 'them'} to another site or switch ${live.length === 1 ? 'it' : 'them'} off first.`);
    }
    if (b.status === 'ACTIVE' && before.status === 'CLOSED') await assertCapacity(tx, p.tenantId, 'SITES', 1);
    await tx.one<any>(
      `UPDATE sites SET name = $2, timezone = $3, country = $4, region_id = $5, address = $6, status = $7, country_code = $8, manager_id = $9,
         closed_on = CASE WHEN $7 = 'CLOSED' THEN coalesce(closed_on, current_date) ELSE NULL END WHERE tenant_id = :t AND id = $1 RETURNING id`,
      [id, b.name, b.timezone, b.country, b.regionId, b.address, b.status, b.countryCode.toUpperCase(), b.managerId]).catch(dupSite);
    const [after] = await loadSites(tx, id);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SITE', entityId: id, entityName: b.name, before, after, diffSummary: b.status !== before.status ? (b.status === 'CLOSED' ? 'site closed' : 'site reopened') : undefined });
    return after;
  });
  res.json(out);
});
sitesRoutes.delete('/sites/:id', requires('config:write'), async (req, res) => {
  requireUnscoped(req);
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
    if (b.siteId) {
      const site = await tx.one<any>('SELECT status FROM sites WHERE tenant_id = :t AND id = $1', [b.siteId]);
      if (!site) throw notFound('Site');
      if (site.status === 'CLOSED') throw bad('That site is closed. Reopen it first, or choose another.');
    }
    const g = await tx.one<any>('UPDATE wfm_groups SET site_id = $2, updated_at = now() WHERE tenant_id = :t AND id = $1 RETURNING name', [id, b.siteId]);
    if (!g) throw notFound('WFM group');
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: id, entityName: g.name, diffSummary: b.siteId ? 'assigned to a site' : 'removed from its site' });
  });
  res.json({ ok: true });
});

// regions: a level above sites
sitesRoutes.get('/regions', requires('config:read'), async (req, res) => {
  res.json(await withTenant(me(req).tenantId, async (tx) => (await tx.q<any>(
    `SELECT r.id, r.name, (SELECT count(*)::int FROM sites s WHERE s.tenant_id = r.tenant_id AND s.region_id = r.id) AS site_count FROM regions r WHERE r.tenant_id = :t ORDER BY lower(r.name)`))
    .map((r) => ({ id: r.id, name: r.name, siteCount: r.siteCount }))));
});
sitesRoutes.post('/regions', requires('config:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), b = parse(RegionBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('INSERT INTO regions (tenant_id, name) VALUES (:t, $1) RETURNING id, name', [b.name]).catch((e) => { throw e.code === '23505' ? conflict('A region with that name already exists.') : e; });
    await audit(tx, p, req, { action: 'CREATE', entityType: 'REGION', entityId: r!.id, entityName: b.name });
    return { id: r!.id, name: r!.name, siteCount: 0 };
  });
  res.status(201).json(out);
});
sitesRoutes.put('/regions/:id', requires('config:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), id = parse(uuid, req.params.id), b = parse(RegionBody, req.body);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('UPDATE regions SET name = $2 WHERE tenant_id = :t AND id = $1 RETURNING id', [id, b.name]).catch((e) => { throw e.code === '23505' ? conflict('A region with that name already exists.') : e; });
    if (!r) throw notFound('Region');
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'REGION', entityId: id, entityName: b.name });
  });
  res.json({ ok: true });
});
sitesRoutes.delete('/regions/:id', requires('config:write'), async (req, res) => {
  requireUnscoped(req);
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const r = await tx.one<any>('DELETE FROM regions WHERE tenant_id = :t AND id = $1 RETURNING name', [id]);
    if (!r) throw notFound('Region');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'REGION', entityId: id, entityName: r.name, diffSummary: 'its sites now belong to no region' });
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
  const parts = tzFmt('en-GB', tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
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
  // Each group needs its requirement, its shifts and how many people are free each day: not every person's rules and a check of every shift, which is what made this
  // screen take as long as the groups are big. The free count is one query per group.
  const freeByDay = async (groupId: string, versionId: string, from: string, to: string) => {
    const rows = await withTenant(p.tenantId, (tx) => tx.q<{ day: string; free: number }>(
      `SELECT d::date::text AS day, count(*)::int AS free
         FROM generate_series($2::date, $3::date, interval '1 day') d, employees e
        WHERE e.tenant_id = :t AND e.status = 'ACTIVE' AND ${POOL_WHERE}
          AND NOT EXISTS (SELECT 1 FROM schedule_shifts s WHERE s.tenant_id = :t AND s.employee_id = e.id AND s.day = d::date AND s.version_id = $4)
          AND NOT EXISTS (SELECT 1 FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id WHERE s.tenant_id = :t AND s.employee_id = e.id AND s.day = d::date
                            AND v.status = 'PUBLISHED' AND v.wfm_group_id <> $1 AND (v.publish_through IS NULL OR s.day <= v.publish_through))
          AND NOT EXISTS (SELECT 1 FROM time_off t WHERE t.tenant_id = :t AND t.employee_id = e.id AND t.status = 'APPROVED' AND t.start_day <= d::date AND t.end_day >= d::date)
        GROUP BY d ORDER BY d`, [groupId, from, to, versionId]));
    return new Map(rows.map((r) => [r.day, r.free]));
  };
  const loaded: { row: any; v: any; live: Awaited<ReturnType<typeof lightLive>> & { free: Map<string, number> } }[] = [];
  for (const row of list) {
    const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, row.id));
    const [light, free] = await Promise.all([lightLive(p.tenantId, v), freeByDay(v.wfmGroupId, v.id, v.periodStart, v.periodEnd)]);
    loaded.push({ row, v, live: { ...light, free } });
  }
  // the chart day: the one asked for if any schedule covers it, otherwise the first day that has data, so the chart is never blank
  const chartDay = q.day && loaded.some((l) => l.live.days.includes(q.day!)) ? q.day : days.find((d) => loaded.some((l) => l.live.days.includes(d))) ?? null;
  for (const { row, v, live } of loaded) {
    const idx = new Map(live.days.map((d, i) => [d, i]));
    const sched = new Array(live.days.length * SPD).fill(0);
    for (const s of live.shifts) { const i = idx.get(s.day); if (i === undefined) continue; addShiftCoverage(sched, i, s); }
    const per = days.filter((d) => idx.has(d)).map((d) => {
      const i = idx.get(d)!;
      let need = 0, have = 0, under = 0, underIntervals = 0;
      for (let s = 0; s < SPD; s++) { const g = i * SPD + s, r = live.required[g]; need += r; have += sched[g]; if (sched[g] < r) { under += r - sched[g]; underIntervals++; } }
      const free = live.free.get(d) ?? 0;
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

/**
 * Which groups can be pooled on a day, and which belong together: each active group with its site, channels and people, whether it has a published short-term forecast covering the day
 * (the comparison cannot be made without one), and the pairs of groups that already share people (a person whose main group is one and who may also work in the other).
 */
poolingRoutes.get('/candidates', requires('forecast:read'), async (req, res) => {
  const q = parse(z.object({ day: z.string().regex(isoDay) }), req.query);
  res.json(await withTenant(me(req).tenantId, async (tx) => {
    const groups = await tx.q<any>(
      `SELECT g.id, g.name, g.site_id, s.name AS site_name,
              (SELECT count(*)::int FROM queues x WHERE x.tenant_id = g.tenant_id AND x.wfm_group_id = g.id) AS queues,
              coalesce((SELECT array_agg(DISTINCT x.channel ORDER BY x.channel) FROM queues x WHERE x.tenant_id = g.tenant_id AND x.wfm_group_id = g.id), '{}') AS channels,
              (SELECT count(*)::int FROM employees e WHERE e.tenant_id = g.tenant_id AND e.primary_group_id = g.id AND e.status = 'ACTIVE') AS people,
              v.name AS forecast_name
       FROM wfm_groups g LEFT JOIN sites s ON s.id = g.site_id AND s.tenant_id = g.tenant_id
       LEFT JOIN LATERAL (SELECT f.name FROM forecast_versions f WHERE f.tenant_id = g.tenant_id AND f.wfm_group_id = g.id AND f.kind = 'SHORT' AND f.status = 'PUBLISHED' AND f.from_day <= $1::date AND f.to_day >= $1::date ORDER BY f.seq DESC LIMIT 1) v ON true
       WHERE g.tenant_id = :t AND g.status = 'ACTIVE' ORDER BY g.name`, [q.day]);
    const shared = await tx.q<any>(
      `SELECT least(e.primary_group_id::text, x::text) AS a, greatest(e.primary_group_id::text, x::text) AS b, count(*)::int AS n
       FROM employees e, unnest(e.eligible_group_ids) AS x WHERE e.tenant_id = :t AND e.status = 'ACTIVE' AND e.primary_group_id IS NOT NULL AND x <> e.primary_group_id GROUP BY 1, 2 ORDER BY n DESC LIMIT 200`);
    return {
      day: q.day,
      groups: groups.map((g) => ({ id: g.id, name: g.name, siteId: g.siteId ?? null, siteName: g.siteName ?? null, queues: g.queues, channels: g.channels as string[], people: g.people, ready: !!g.forecastName, forecastName: g.forecastName ?? null })),
      sharedPairs: shared.map((x) => ({ a: x.a, b: x.b, people: x.n })),
    };
  }));
});

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



/** What the form can fill in for a country: its time zones, its holidays, and the week and labour-law pack the platform suggests for it. */
sitesRoutes.get('/country-defaults', requires('config:read'), async (req, res) => {
  const code = String(req.query.country ?? '').toUpperCase();
  if (!hasCountry(code)) throw bad('Choose a country from the list.');
  let zones: string[] = [];
  try { zones = (new Holidays(code).getTimezones() as string[]) ?? []; } catch { zones = []; }
  const [tpl] = await raw<any>('SELECT * FROM wfm.country_templates WHERE upper(code) = $1', [code]);
  const year = new Date().getUTCFullYear();
  const pack = tpl?.compliancePack ? BUILT_INS.find((x) => x.code === tpl.compliancePack) : undefined;
  res.json({
    code, name: countryNames()[code], timezones: zones, timezone: tpl?.timezone ?? zones[0] ?? null, currency: tpl?.currency ?? null,
    payWeekStart: tpl?.payWeekStart ?? null, weekendDays: tpl?.weekendDays ?? null, compliancePack: pack ? { code: pack.code, name: pack.name } : null, holidaysThisYear: publicHolidays(code, year).length,
  });
});

/** The whole structure in one call: regions, sites, groups with their people and the teams those people are in. Limited people see only the groups they have access to. */
sitesRoutes.get('/structure', requires('config:read'), async (req, res) => {
  res.json(await withTenant(me(req).tenantId, async (tx) => {
    const sites = await loadSites(tx);
    const regions = await tx.q<any>(`SELECT r.id, r.name FROM regions r WHERE r.tenant_id = :t ORDER BY lower(r.name)`);
    const groups = await tx.q<any>(
      `SELECT g.id, g.name, g.status, g.site_id, g.timezone, (SELECT count(*)::int FROM queues q WHERE q.tenant_id = g.tenant_id AND q.wfm_group_id = g.id) AS queues,
              (SELECT count(*)::int FROM employees e WHERE e.tenant_id = g.tenant_id AND e.primary_group_id = g.id AND e.status = 'ACTIVE') AS people
       FROM wfm_groups g WHERE g.tenant_id = :t ORDER BY g.name`);
    const teams = await tx.q<any>(
      `SELECT e.primary_group_id AS group_id, coalesce(t.name, 'No team') AS team, count(*)::int AS n FROM employees e LEFT JOIN teams t ON t.id = e.team_id
       WHERE e.tenant_id = :t AND e.status = 'ACTIVE' AND e.primary_group_id IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC`);
    const [{ n: unplaced }] = await tx.q<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id = :t AND status = 'ACTIVE' AND primary_group_id IS NULL`);
    const teamRows = await tx.q<any>(
      `SELECT t.id, t.name, t.site_id, t.status, m.first_name || ' ' || m.last_name AS supervisor, (SELECT count(*)::int FROM employees x WHERE x.team_id = t.id AND x.status = 'ACTIVE') AS people
       FROM teams t LEFT JOIN employees m ON m.id = t.manager_id WHERE t.tenant_id = :t AND t.status = 'ACTIVE' ORDER BY t.name`);
    // where each team's people actually work: the site of their main group
    const teamPlaces = await tx.q<any>(
      `SELECT g.site_id, e.team_id, count(*)::int AS n FROM employees e JOIN wfm_groups g ON g.id = e.primary_group_id AND g.tenant_id = e.tenant_id
       WHERE e.tenant_id = :t AND e.status = 'ACTIVE' AND e.team_id IS NOT NULL AND g.site_id IS NOT NULL GROUP BY 1, 2`);
    return {
      regions: regions.map((r) => ({ id: r.id, name: r.name })), sites,
      groups: groups.map((g) => ({ id: g.id, name: g.name, status: g.status, siteId: g.siteId ?? null, timezone: g.timezone, queues: g.queues, people: g.people, teams: teams.filter((t) => t.groupId === g.id).map((t) => ({ name: t.team, n: t.n })) })),
      unplacedPeople: unplaced,
      teams: teamRows.map((t) => ({ id: t.id, name: t.name, siteId: t.siteId ?? null, supervisor: t.supervisor ?? null, people: t.people })),
      teamPlaces: teamPlaces.map((x) => ({ siteId: x.siteId, teamId: x.teamId, people: x.n })),
    };
  }));
});
