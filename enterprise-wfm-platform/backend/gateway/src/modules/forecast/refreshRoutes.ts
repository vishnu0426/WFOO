/**
 * Scheduled forecast refresh: the settings for a group's short-term or long-term forecast, running one now, and the history of runs with their reports.
 *   GET  /forecast/refresh                         every schedule that has been saved (for the chips on the Forecasts list)
 *   GET  /forecast/refresh?groupId=                both kinds for one group, with defaults, the live forecast, the last run and when the next is due
 *   PUT  /forecast/refresh/:groupId/:kind          save the schedule
 *   POST /forecast/refresh/:groupId/:kind/run      run it now (answers at once with the run's id; the run goes on in the background)
 *   GET  /forecast/refresh/:groupId/:kind/runs     the runs, newest first, each with its report
 *   POST /forecast/refresh/run-due                 start whatever is due now (what the scheduler does every few minutes)
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../../db.ts';
import { me, requires } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { bad, notFound, parse } from '../../http.ts';
import { loadGroup } from './service.ts';
import { describe, localNow, nextRun } from './refreshMath.ts';
import { executeRun, findDue, runDueRefreshes, startRun } from './refresh.ts';

export const forecastRefresh = Router();
const uuid = z.string().uuid();
const Kind = z.enum(['SHORT', 'LONG']);

const DEFAULTS = { enabled: false, frequency: 'WEEKLY' as const, dayOfWeek: 0, hour: 6, horizonWeeks: null as number | null, horizonDays: null as number | null, staleAfterDays: 3, archiveOldDrafts: true };

const runDto = (r: any) => ({ id: r.id, trigger: r.trigger, status: r.status, reason: r.reason, startedBy: r.startedBy, startedAt: r.startedAt, finishedAt: r.finishedAt, versionId: r.versionId, report: r.report ?? {} });

function settingsDto(row: any | null, kind: 'SHORT' | 'LONG', tz: string, live: any | null, lastRun: any | null) {
  const s = row ? { enabled: row.enabled, frequency: row.frequency, dayOfWeek: row.dayOfWeek, hour: row.hour, horizonWeeks: row.horizonWeeks, horizonDays: row.horizonDays, staleAfterDays: row.staleAfterDays, archiveOldDrafts: row.archiveOldDrafts } : DEFAULTS;
  const now = localNow(tz);
  const next = nextRun({ enabled: s.enabled, frequency: s.frequency, dayOfWeek: s.dayOfWeek, hour: s.hour, lastRunDay: row?.lastRunDay ?? null }, now);
  return {
    kind, saved: !!row, ...s, timezone: tz, description: describe(s), nextRun: next, lastRunAt: row?.lastRunAt ?? null,
    live: live ? { id: live.id, seq: live.seq, name: live.name, fromDay: live.fromDay, toDay: live.toDay } : null,
    lastRun: lastRun ? runDto(lastRun) : null,
  };
}

forecastRefresh.get('/', requires('forecast:read'), async (req, res) => {
  const p = me(req), groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  const out = await withTenant(p.tenantId, async (tx) => {
    if (!groupId) {
      const rows = await tx.q<any>(`SELECT wfm_group_id, kind, enabled, frequency, day_of_week, hour FROM forecast_refresh_settings WHERE tenant_id = :t`);
      return { schedules: rows.map((r) => ({ groupId: r.wfmGroupId, kind: r.kind, enabled: r.enabled, description: describe(r) })) };
    }
    const group = await loadGroup(tx, groupId);
    const items = [];
    for (const kind of ['SHORT', 'LONG'] as const) {
      const row = await tx.one<any>(`SELECT *, last_run_day::text AS last_run_day FROM forecast_refresh_settings WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2`, [groupId, kind]);
      const live = await tx.one<any>(`SELECT id, seq, name, from_day::text AS from_day, to_day::text AS to_day FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2 AND status = 'PUBLISHED' ORDER BY seq DESC LIMIT 1`, [groupId, kind]);
      const last = row ? await tx.one<any>(`SELECT * FROM forecast_refresh_runs WHERE tenant_id = :t AND settings_id = $1 ORDER BY started_at DESC LIMIT 1`, [row.id]) : null;
      items.push(settingsDto(row, kind, group.timezone ?? 'UTC', live, last));
    }
    return { groupId, groupName: group.name, items };
  });
  res.json(out);
});

const Body = z.object({
  enabled: z.boolean(), frequency: z.enum(['DAILY', 'WEEKLY']), dayOfWeek: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23),
  horizonWeeks: z.number().int().min(1).max(18).nullable().default(null), horizonDays: z.number().int().min(30).max(730).nullable().default(null),
  staleAfterDays: z.number().int().min(1).max(60), archiveOldDrafts: z.boolean(),
});

forecastRefresh.put('/:groupId/:kind', requires('forecast:create'), async (req, res) => {
  const p = me(req), groupId = parse(uuid, req.params.groupId), kind = parse(Kind, req.params.kind), b = parse(Body, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, groupId);
    const before = await tx.one<any>(`SELECT * FROM forecast_refresh_settings WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2`, [groupId, kind]);
    const row = await tx.one<any>(
      `INSERT INTO forecast_refresh_settings (tenant_id, wfm_group_id, kind, enabled, frequency, day_of_week, hour, horizon_weeks, horizon_days, stale_after_days, archive_old_drafts, updated_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, wfm_group_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, frequency = EXCLUDED.frequency, day_of_week = EXCLUDED.day_of_week, hour = EXCLUDED.hour,
         horizon_weeks = EXCLUDED.horizon_weeks, horizon_days = EXCLUDED.horizon_days, stale_after_days = EXCLUDED.stale_after_days, archive_old_drafts = EXCLUDED.archive_old_drafts, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *, last_run_day::text AS last_run_day`,
      [groupId, kind, b.enabled, b.frequency, b.dayOfWeek, b.hour, kind === 'SHORT' ? b.horizonWeeks : null, kind === 'LONG' ? b.horizonDays : null, b.staleAfterDays, b.archiveOldDrafts, p.name]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'FORECAST_REFRESH_SETTINGS', entityId: row.id, entityName: `${group.name} ${kind === 'SHORT' ? 'short' : 'long'}-term`,
      before: before ? { enabled: before.enabled, frequency: before.frequency, dayOfWeek: before.dayOfWeek, hour: before.hour } : null, after: { enabled: b.enabled, frequency: b.frequency, dayOfWeek: b.dayOfWeek, hour: b.hour, staleAfterDays: b.staleAfterDays },
      diffSummary: b.enabled ? `auto-refresh on, ${describe(b)}` : 'auto-refresh off' });
    const live = await tx.one<any>(`SELECT id, seq, name, from_day::text AS from_day, to_day::text AS to_day FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2 AND status = 'PUBLISHED' ORDER BY seq DESC LIMIT 1`, [groupId, kind]);
    const last = await tx.one<any>(`SELECT * FROM forecast_refresh_runs WHERE tenant_id = :t AND settings_id = $1 ORDER BY started_at DESC LIMIT 1`, [row.id]);
    return settingsDto(row, kind, group.timezone ?? 'UTC', live, last);
  });
  res.json(out);
});

forecastRefresh.post('/:groupId/:kind/run', requires('forecast:create'), async (req, res) => {
  const p = me(req), groupId = parse(uuid, req.params.groupId), kind = parse(Kind, req.params.kind);
  const settingsId = await withTenant(p.tenantId, async (tx) => {
    await loadGroup(tx, groupId);                                   // 404 for a group that is not there
    // running it by hand works before a schedule has been saved: the settings row is made (switched off) if there is none yet
    const r = await tx.one<{ id: string }>(`INSERT INTO forecast_refresh_settings (tenant_id, wfm_group_id, kind, updated_by) VALUES (:t, $1, $2, $3) ON CONFLICT (tenant_id, wfm_group_id, kind) DO UPDATE SET wfm_group_id = EXCLUDED.wfm_group_id RETURNING id`, [groupId, kind, p.name]);
    return r!.id;
  });
  const runId = await startRun(p.tenantId, settingsId, 'MANUAL', p.name);
  void executeRun(p.tenantId, runId);                                 // the engine takes seconds to a minute: the answer does not wait for it
  res.status(202).json({ runId });
});

forecastRefresh.get('/:groupId/:kind/runs', requires('forecast:read'), async (req, res) => {
  const p = me(req), groupId = parse(uuid, req.params.groupId), kind = parse(Kind, req.params.kind), limit = parse(z.coerce.number().int().min(1).max(50).default(10), req.query.limit);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(`SELECT r.* FROM forecast_refresh_runs r WHERE r.tenant_id = :t AND r.wfm_group_id = $1 AND r.kind = $2 ORDER BY r.started_at DESC LIMIT $3`, [groupId, kind, limit]));
  res.json(rows.map(runDto));
});

forecastRefresh.post('/run-due', requires('forecast:create'), async (req, res) => {
  const p = me(req);
  const due = (await findDue()).filter((d) => d.tenantId === p.tenantId);
  if (due.length) void runDueRefreshes();
  res.status(202).json({ due: due.length });
});

export const refreshDefaults = DEFAULTS;
void bad; void notFound;
