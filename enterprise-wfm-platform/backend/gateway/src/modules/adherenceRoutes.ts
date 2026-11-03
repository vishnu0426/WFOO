/**
 * Real-time adherence for groups of any size. The screen no longer downloads every person: it asks for a summary (totals, teams, the staffing chart), then a page
 * of people at a time with the filter, sort and search done here, and one person's timeline only when it is opened. All of it is sliced from one shared,
 * seconds-old judgement of the group (see adherenceCache.ts), so ten supervisors cost the same as one.
 */
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, isoDay, notFound, parse, safeCsvCell } from '../http.ts';
import { loadGroup, todayIn } from './forecast/service.ts';
import { adherenceFor, adherenceForMany, computeLite, intraday, summarise, teamStats, type AgentRow } from './intradayRoutes.ts';
import { cached } from './adherenceCache.ts';

const uuid = z.string().uuid();
const STATUSES = ['IN', 'OUT', 'UNSCHEDULED', 'IGNORED', 'UNKNOWN', 'NOT_STARTED', 'SHIFT_ENDED'] as const;
export const NO_TEAM = '~none';

const csv = <T extends z.ZodTypeAny>(item: T) => z.string().optional().transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined)).pipe(z.array(item).max(20).optional());
/** One value or a repeated one (?team=A&team=B): team names may contain commas, so they are not comma-separated. */
const many = z.union([z.string(), z.array(z.string()).max(200)]).optional().transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));

const SORTS = ['name', 'employeeNumber', 'team', 'status', 'outMinutes', 'dayPercent', 'shift', 'actual'] as const;
const Filters = z.object({
  groupId: uuid, day: z.string().regex(isoDay).optional(),
  status: csv(z.enum(STATUSES)), team: many, q: z.string().max(80).optional(), scope: z.enum(['all', 'mine']).default('all'),
  sort: z.enum(SORTS).optional(), dir: z.enum(['asc', 'desc']).optional(),
});
type F = z.infer<typeof Filters>;

const STATUS_RANK: Record<string, number> = { OUT: 0, UNSCHEDULED: 1, UNKNOWN: 2, IN: 3, IGNORED: 4, NOT_STARTED: 5, SHIFT_ENDED: 6 };
const KEY: Record<(typeof SORTS)[number], (r: AgentRow) => string | number> = {
  name: (r) => r.name.toLowerCase(), employeeNumber: (r) => r.employeeNumber.toLowerCase(), team: (r) => (r.team ?? '').toLowerCase(), status: (r) => STATUS_RANK[r.status] ?? 9,
  outMinutes: (r) => r.outSeconds, dayPercent: (r) => r.dayPercent ?? -1, shift: (r) => r.shift ?? '', actual: (r) => r.actual.toLowerCase(),
};

/** The teams this person manages: what "my teams" means. */
async function myTeams(tenantId: string, userId: string): Promise<string[]> {
  return withTenant(tenantId, async (tx) => (await tx.q<{ name: string }>(
    `SELECT t.name FROM teams t JOIN users u ON u.employee_id IN (t.manager_id, t.deputy_id) WHERE t.tenant_id = :t AND u.id = $1 ORDER BY t.name`, [userId])).map((r) => r.name));
}

async function resolveDay(tenantId: string, groupId: string, day?: string) {
  return day ?? await withTenant(tenantId, async (tx) => todayIn((await loadGroup(tx, groupId)).timezone));
}

/** The group's judgement for the day (shared and a few seconds old), cut down to what this person's scope and filters leave. */
async function view(tenantId: string, userId: string, f: F) {
  const day = await resolveDay(tenantId, f.groupId, f.day);
  const { value, ageMs } = await cached(`${tenantId}|${f.groupId}|${day}`, day, () => computeLite(tenantId, f.groupId, day));
  const mine = await myTeams(tenantId, userId);
  let scoped = value.agents;
  if (f.scope === 'mine') { const set = new Set(mine); scoped = scoped.filter((r) => r.team !== null && set.has(r.team)); }
  return { value, ageMs, mine, day, scoped };
}

function filtered(rows: AgentRow[], f: F): AgentRow[] {
  const status = f.status?.length ? new Set<string>(f.status) : null, teams = f.team?.length ? new Set(f.team) : null, q = f.q?.trim().toLowerCase();
  let out = rows.filter((r) => (!status || status.has(r.status)) && (!teams || teams.has(r.team ?? NO_TEAM)) && (!q || r.name.toLowerCase().includes(q) || r.employeeNumber.toLowerCase().includes(q)));
  if (f.sort) {
    const key = KEY[f.sort], sign = f.dir === 'desc' ? -1 : 1;
    out = [...out].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sign || a.name.localeCompare(b.name); });
  }
  return out;
}

/** A row for a list: everything the grid shows, nothing it does not. */
const listRow = (r: AgentRow) => ({ ...r, timeline: undefined, exceptions: undefined });

// ---------------------------------------------------------------- summary, list, one person, export

intraday.get('/adherence/summary', requires('intraday:read'), async (req, res) => {
  const p = me(req), f = parse(Filters, req.query);
  const v = await view(p.tenantId, p.userId, f);
  const { agents, summary: _all, teams: _teams, ...meta } = v.value;
  const present = new Set(agents.map((r) => r.team));      // "my teams" are the ones I manage that have people in this group

  res.json({
    ...meta, day: v.day, summary: summarise(v.scoped), teams: teamStats(v.scoped), scope: f.scope, myTeams: v.mine.filter((t) => present.has(t)), ageSeconds: Math.round(v.ageMs / 1000),
    // the staffing chart and the unmapped-state list are for the whole group, whatever the scope
  });
});

intraday.get('/adherence/agents', requires('intraday:read'), async (req, res) => {
  const p = me(req), f = parse(Filters, req.query);
  const page = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const v = await view(p.tenantId, p.userId, f);
  const rows = filtered(v.scoped, f);
  res.setHeader('X-Total-Count', String(rows.length));
  res.json(rows.slice(page.offset, page.offset + page.limit).map(listRow));
});

/** A page of people WITH their timelines, for the timeline chart: the same filters and order as the list, and only these few judged in full. */
intraday.get('/adherence/timelines', requires('intraday:read'), async (req, res) => {
  const p = me(req), f = parse(Filters, req.query);
  const page = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
  const v = await view(p.tenantId, p.userId, f);
  const rows = filtered(v.scoped, f);
  const ids = rows.slice(page.offset, page.offset + page.limit).map((r) => r.employeeId);
  res.setHeader('X-Total-Count', String(rows.length));
  res.json({ day: v.day, asOf: v.value.asOf, total: rows.length, people: await adherenceForMany(p.tenantId, f.groupId, v.day, ids) });
});

intraday.get('/adherence/agents/:employeeId', requires('intraday:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.employeeId), q = parse(z.object({ groupId: uuid, day: z.string().regex(isoDay).optional() }), req.query);
  const day = await resolveDay(p.tenantId, q.groupId, q.day);
  const row = await adherenceFor(p.tenantId, q.groupId, day, id);
  if (!row) throw notFound('Person (not active in this group, or no shift or events that day)');
  res.json({ day, ...row });
});

const EXPORT_MAX = 200_000;
intraday.get('/adherence/export.csv', requires('intraday:read'), async (req, res) => {
  const p = me(req), f = parse(Filters, req.query);
  const v = await view(p.tenantId, p.userId, f);
  const rows = filtered(v.scoped, f);
  if (rows.length > EXPORT_MAX) throw bad(`That is ${rows.length.toLocaleString('en-US')} people. A file holds at most ${EXPORT_MAX.toLocaleString('en-US')}: narrow it with a team or status first.`);
  const head = ['Date', 'Employee number', 'Name', 'Team', 'Shift', 'Scheduled now', 'Actual now', 'State', 'Reason', 'Since', 'Status', 'Out of adherence (min)', 'Day adherence %', 'Scheduled minutes', 'Adherent minutes'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push([v.day, r.employeeNumber, r.name, r.team ?? '', r.shift ?? '', r.scheduled, r.actual, r.state ?? '', r.reason, r.stateSince ?? '', r.status, r.outMinutes, r.dayPercent ?? '', r.scheduledMin, r.adherentMin].map(safeCsvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="adherence-${v.day}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

// ---------------------------------------------------------------- history: adherence over days

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const FILL_PER_REQUEST = 8;

/** Past days that have not been judged and kept yet are judged now, a few at a time, so a long range builds up over a few requests. */
async function fillHistory(tenantId: string, groupId: string, from: string, to: string): Promise<number> {
  const today = await withTenant(tenantId, async (tx) => todayIn((await loadGroup(tx, groupId)).timezone));
  const last = to < addDays(today, -1) ? to : addDays(today, -1);
  const days: string[] = [];
  for (let d = from; d <= last; d = addDays(d, 1)) days.push(d);
  if (!days.length) return 0;
  const have = new Set((await withTenant(tenantId, (tx) => tx.q<{ day: string }>('SELECT day::text AS day FROM adherence_days WHERE wfm_group_id = $1 AND day BETWEEN $2::date AND $3::date', [groupId, from, last]))).map((r) => r.day));
  const missing = days.filter((d) => !have.has(d));
  for (const day of missing.slice(0, FILL_PER_REQUEST)) {
    const r = await computeLite(tenantId, groupId, day);
    const rows = r.agents.filter((a) => a.scheduledMin > 0);
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < rows.length; i += 5000) {
        const c = rows.slice(i, i + 5000);
        await tx.exec(
          `INSERT INTO adherence_daily (tenant_id, wfm_group_id, day, employee_id, team, scheduled_min, adherent_min)
           SELECT :t, $1, $2::date, x.e, x.tm, x.s, x.a FROM unnest($3::uuid[], $4::text[], $5::int[], $6::int[]) AS x(e, tm, s, a)
           ON CONFLICT (wfm_group_id, day, employee_id) DO UPDATE SET team = EXCLUDED.team, scheduled_min = EXCLUDED.scheduled_min, adherent_min = EXCLUDED.adherent_min`,
          [groupId, day, c.map((a) => a.employeeId), c.map((a) => a.team), c.map((a) => a.scheduledMin), c.map((a) => a.adherentMin)]);
      }
      await tx.exec('INSERT INTO adherence_days (tenant_id, wfm_group_id, day) VALUES (:t, $1, $2::date) ON CONFLICT DO NOTHING', [groupId, day]);
    });
  }
  return Math.max(0, missing.length - FILL_PER_REQUEST);
}

const HistQ = z.object({
  groupId: uuid, from: z.string().regex(isoDay), to: z.string().regex(isoDay), by: z.enum(['agent', 'team']).default('agent'), team: many, q: z.string().max(80).optional(),
  scope: z.enum(['all', 'mine']).default('all'), sort: z.enum(['percent', 'name', 'scheduled']).default('percent'), dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});

intraday.get('/adherence/history', requires('intraday:read'), async (req, res) => {
  const p = me(req), q = parse(HistQ, req.query);
  if (q.to < q.from) throw bad('The end date is before the start date');
  if (Date.parse(q.to) - Date.parse(q.from) > 92 * 86_400_000) throw bad('Choose at most 93 days at a time');
  const remaining = await fillHistory(p.tenantId, q.groupId, q.from, q.to);
  const mine = q.scope === 'mine' ? await myTeams(p.tenantId, p.userId) : null;
  const teams = q.team?.length ? q.team.filter((t) => t !== NO_TEAM) : null, wantNone = !!q.team?.includes(NO_TEAM);
  // the same filter for every query below
  const where = `d.tenant_id = :t AND d.wfm_group_id = $1 AND d.day BETWEEN $2::date AND $3::date
    AND ($4::text[] IS NULL OR d.team = ANY($4::text[]) OR ($5::boolean AND d.team IS NULL))
    AND ($6::text[] IS NULL OR d.team = ANY($6::text[]))
    AND ($7::text IS NULL OR (e.first_name || ' ' || e.last_name || ' ' || e.employee_number) ILIKE '%' || $7 || '%')`;
  const params = [q.groupId, q.from, q.to, q.team?.length ? teams : null, wantNone, mine, q.q?.trim() || null];
  const dir = q.dir === 'desc' ? 'DESC' : q.dir === 'asc' ? 'ASC' : q.sort === 'percent' ? 'ASC' : 'ASC';
  const order = q.sort === 'name' ? 'name' : q.sort === 'scheduled' ? 'scheduled_min' : 'percent';
  const out = await withTenant(p.tenantId, async (tx) => {
    const rows = q.by === 'team'
      ? await tx.q<any>(
        `SELECT coalesce(d.team, '') AS name, NULL::text AS employee_number, NULL::text AS team, count(DISTINCT d.employee_id)::int AS people, sum(d.scheduled_min)::int AS scheduled_min, sum(d.adherent_min)::int AS adherent_min,
                round(100.0 * sum(d.adherent_min) / nullif(sum(d.scheduled_min), 0), 1)::float AS percent, count(*) OVER ()::int AS total
         FROM adherence_daily d JOIN employees e ON e.id = d.employee_id WHERE ${where} GROUP BY coalesce(d.team, '') ORDER BY ${order} ${dir} NULLS LAST, name LIMIT ${q.limit} OFFSET ${q.offset}`, params)
      : await tx.q<any>(
        `SELECT e.id AS employee_id, e.first_name || ' ' || e.last_name AS name, e.employee_number, (array_agg(d.team ORDER BY d.day DESC))[1] AS team, 1 AS people, sum(d.scheduled_min)::int AS scheduled_min,
                sum(d.adherent_min)::int AS adherent_min, round(100.0 * sum(d.adherent_min) / nullif(sum(d.scheduled_min), 0), 1)::float AS percent, count(*) OVER ()::int AS total
         FROM adherence_daily d JOIN employees e ON e.id = d.employee_id WHERE ${where} GROUP BY e.id ORDER BY ${order} ${dir} NULLS LAST, name LIMIT ${q.limit} OFFSET ${q.offset}`, params);
    const series = await tx.q<any>(
      `SELECT d.day::text AS day, round(100.0 * sum(d.adherent_min) / nullif(sum(d.scheduled_min), 0), 1)::float AS percent, count(DISTINCT d.employee_id)::int AS people
       FROM adherence_daily d JOIN employees e ON e.id = d.employee_id WHERE ${where} GROUP BY d.day ORDER BY d.day`, params);
    const all = await tx.one<any>(
      `SELECT round(100.0 * sum(d.adherent_min) / nullif(sum(d.scheduled_min), 0), 1)::float AS percent, count(DISTINCT d.employee_id)::int AS people, coalesce(sum(d.scheduled_min), 0)::int AS scheduled_min
       FROM adherence_daily d JOIN employees e ON e.id = d.employee_id WHERE ${where}`, params);
    return { rows, series, all };
  });
  const total = out.rows[0]?.total ?? 0;
  res.setHeader('X-Total-Count', String(total));
  res.json({ by: q.by, from: q.from, to: q.to, building: remaining, overall: out.all, series: out.series, rows: out.rows.map(({ total: _t, ...r }: any) => r) });
});

// ---------------------------------------------------------------- when a supervisor is told

const Settings = z.object({ alertAfterMin: z.number().int().min(1).max(240), enabled: z.boolean() });
export const DEFAULT_ALERT_MIN = 10;

intraday.get('/adherence/alert-settings', requires('intraday:read'), async (req, res) => {
  const r = await withTenant(me(req).tenantId, (tx) => tx.one<any>('SELECT alert_after_min, enabled FROM adherence_settings WHERE tenant_id = :t'));
  res.json({ alertAfterMin: r?.alertAfterMin ?? DEFAULT_ALERT_MIN, enabled: r?.enabled ?? true });
});

intraday.put('/adherence/alert-settings', requires('intraday:act'), async (req, res) => {
  const p = me(req), b = parse(Settings, req.body);
  await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<any>('SELECT alert_after_min, enabled FROM adherence_settings WHERE tenant_id = :t');
    await tx.exec(
      `INSERT INTO adherence_settings (tenant_id, alert_after_min, enabled, updated_by) VALUES (:t, $1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET alert_after_min = $1, enabled = $2, updated_by = $3, updated_at = now()`, [b.alertAfterMin, b.enabled, p.name]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'ADHERENCE_ALERTS', entityId: p.tenantId, entityName: 'Adherence alerts', before: before ?? { alertAfterMin: DEFAULT_ALERT_MIN, enabled: true }, after: b });
  });
  res.json(b);
});
