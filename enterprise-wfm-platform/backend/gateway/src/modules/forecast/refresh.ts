/**
 * Scheduled forecast refresh: the runner and the scheduler.
 *
 * A run does, in order: check the data is fresh (else skip and say so); measure how the live forecast really did against what happened; build a new DRAFT from the latest history; compare it
 * with the live one; archive an earlier automatic draft nobody touched; and tell the people who approve forecasts. It never submits or publishes anything: a person does. Every run, including
 * a skipped or failed one, is kept with its report. ATTENDANCE-style safeguards: one run at a time per schedule (a unique index, so two gateway processes cannot both start), a run that
 * was cut off by a restart is marked failed after 30 minutes, and a schedule is tried once per occasion (not again every five minutes after a failure).
 * FORECAST_REFRESH=off turns the scheduler off; the Run now button still works.
 */
import { raw, withTenant } from '../../db.ts';
import { audit } from '../../audit.ts';
import { notify } from '../../notify.ts';
import { publish } from '../../infra.ts';
import type { Principal } from '../../auth.ts';
import { HttpError } from '../../http.ts';
import { createVersion, loadGroup, todayIn, versionRecords } from './service.ts';
import { accuracyTrendFor } from './routes.ts';
import { compareDays } from './compare.ts';
import { accuracyFrom, accuracyLine, compareLine, freshness, horizonFor, isDue, localNow, notification, type Report } from './refreshMath.ts';

export const SYSTEM_NAME = 'Auto-refresh';
const systemPrincipal = (tenantId: string): Principal => ({ userId: null as unknown as string, tenantId, workspaceId: '', role: 'WFM_ADMIN', name: SYSTEM_NAME, username: 'auto-refresh', jti: 'system' } as Principal);

/** Everyone who can approve forecasts, who is told how a run went. */
async function approvers(tx: any): Promise<string[]> {
  return (await tx.q(`SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role IN (SELECT role FROM role_permissions WHERE tenant_id = :t AND permission = 'forecast:approve')`)).map((r: any) => r.id as string);
}

/** Record that a run has started. Refuses when one is already running for this schedule. */
export async function startRun(tenantId: string, settingsId: string, trigger: 'SCHEDULE' | 'MANUAL', startedBy: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const s = await tx.one<any>('SELECT * FROM forecast_refresh_settings WHERE tenant_id = :t AND id = $1', [settingsId]);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Refresh schedule not found');
    await tx.exec(`UPDATE forecast_refresh_runs SET status = 'FAILED', reason = 'Interrupted: the gateway stopped while this was running.', finished_at = now() WHERE tenant_id = :t AND settings_id = $1 AND status = 'RUNNING' AND started_at < now() - interval '30 minutes'`, [settingsId]);
    try {
      const r = await tx.one<{ id: string }>(`INSERT INTO forecast_refresh_runs (tenant_id, settings_id, wfm_group_id, kind, trigger, status, started_by) VALUES (:t, $1, $2, $3, $4, 'RUNNING', $5) RETURNING id`, [settingsId, s.wfmGroupId, s.kind, trigger, startedBy]);
      return r!.id;
    } catch (e: any) {
      if (/forecast_refresh_runs_one_running/.test(String(e?.message))) throw new HttpError(409, 'ALREADY_RUNNING', 'A refresh for this forecast is already running. Wait for it to finish.');
      throw e;
    }
  });
}

/** Do the run that startRun recorded. Never throws: the outcome is in the run's row (and in the notification). */
export async function executeRun(tenantId: string, runId: string): Promise<void> {
  const ctx = await withTenant(tenantId, async (tx) => {
    const run = (await tx.one<any>('SELECT * FROM forecast_refresh_runs WHERE tenant_id = :t AND id = $1', [runId]))!;
    const s = (await tx.one<any>('SELECT *, last_run_day::text AS last_run_day FROM forecast_refresh_settings WHERE tenant_id = :t AND id = $1', [run.settingsId]))!;
    const group = await loadGroup(tx, s.wfmGroupId);
    const live = await tx.one<any>(`SELECT * FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2 AND status = 'PUBLISHED' ORDER BY seq DESC LIMIT 1`, [s.wfmGroupId, s.kind]);
    const newest = (await tx.one<{ day: string | null }>(`SELECT max(h.day)::text AS day FROM interval_history h JOIN queues q ON q.id = h.queue_id WHERE h.tenant_id = :t AND q.wfm_group_id = $1`, [s.wfmGroupId]))?.day ?? null;
    const prev = await tx.one<any>(`SELECT report FROM forecast_refresh_runs WHERE tenant_id = :t AND settings_id = $1 AND status = 'CREATED' AND id <> $2 ORDER BY started_at DESC LIMIT 1`, [s.id, runId]);
    return { run, s, group, live, newest, prev };
  });
  const { run, s, group, live, newest, prev } = ctx;
  const today = todayIn(group.timezone ?? 'UTC');
  const fresh = freshness(newest, today, s.staleAfterDays);
  const report: Report = { freshness: fresh, live: live ? { id: live.id, seq: live.seq, name: live.name } : null, accuracy: null, previousWape: null, draft: null, compare: null, archivedDrafts: 0, notified: 0 };

  const finish = async (status: 'CREATED' | 'SKIPPED' | 'FAILED', reason: string, versionId: string | null) => {
    report.text = { freshness: fresh.text, accuracy: accuracyLine(report.accuracy, report.previousWape), compare: compareLine(report.compare) };
    const note = notification({ group: group.name, kind: s.kind, status, reason, report });
    await withTenant(tenantId, async (tx) => {
      const users = await approvers(tx);
      await notify(tx, users, { kind: 'INFO', title: note.title, body: note.body, data: { screen: 'forecasts', groupId: s.wfmGroupId, versionId } });
      report.notified = users.length;
      await tx.exec(`UPDATE forecast_refresh_runs SET status = $2, reason = $3, version_id = $4, report = $5::jsonb, finished_at = now() WHERE tenant_id = :t AND id = $1`, [runId, status, reason, versionId, JSON.stringify(report)]);
      await tx.exec(`UPDATE forecast_refresh_settings SET last_run_at = now()${run.trigger === 'SCHEDULE' ? ', last_run_day = $2::date' : ''} WHERE tenant_id = :t AND id = $1`, run.trigger === 'SCHEDULE' ? [s.id, today] : [s.id]);
      await audit(tx, systemPrincipal(tenantId), null, { action: 'CREATE', entityType: 'FORECAST_REFRESH', entityId: runId, entityName: `${group.name} ${s.kind === 'SHORT' ? 'short' : 'long'}-term`, reason: status === 'CREATED' ? undefined : reason, after: { status, trigger: run.trigger, versionId } });
    });
    // the web app's bell listens to these live events (the inbox rows above are for the mobile and employee apps)
    publish(tenantId, ['forecast', 'refresh'], { runId, groupId: s.wfmGroupId, kind: s.kind, status, title: note.title, body: note.body });
  };

  try {
    if (!fresh.ok) { await finish('SKIPPED', fresh.text, null); return; }
    report.accuracy = s.kind === 'SHORT' ? accuracyFrom(await accuracyTrendFor(tenantId, s.wfmGroupId, 8)) : null;
    report.previousWape = prev?.report?.accuracy?.latestWeek?.wapeDaily ?? null;

    const v = await createVersion(systemPrincipal(tenantId), null, { groupId: s.wfmGroupId, kind: s.kind, ...horizonFor(s.kind, { horizonWeeks: s.horizonWeeks, horizonDays: s.horizonDays }, live) });
    await withTenant(tenantId, (tx) => tx.exec(`UPDATE forecast_versions SET name = name || ' · auto refresh' WHERE tenant_id = :t AND id = $1`, [v.id]));
    report.draft = { id: v.id, seq: v.seq, name: `${v.name} · auto refresh`, fromDay: v.fromDay, toDay: v.toDay, model: v.modelReq ?? null };

    if (live) {
      const [dl, dn] = await Promise.all([versionRecords(tenantId, live), versionRecords(tenantId, v)]);
      const c = compareDays(dl.daily, dn.daily);
      report.compare = {
        baseVersion: `v${live.seq}`, days: c.overlap?.days ?? 0, volumeBase: c.summary.volume.a, volumeNew: c.summary.volume.b, deltaPct: c.summary.volume.deltaPct, biggest: c.biggest,
        peakRequiredBase: c.summary.peakRequired.a, peakRequiredNew: c.summary.peakRequired.b,
      };
    }
    if (s.archiveOldDrafts) {
      // an earlier automatic draft that nobody has adjusted, submitted or approved is replaced by this one (a draft someone has worked on is never touched)
      report.archivedDrafts = (await withTenant(tenantId, (tx) => tx.q<any>(
        `UPDATE forecast_versions SET status = 'ARCHIVED' WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2 AND status = 'DRAFT' AND created_by = $3 AND rev = 0 AND id <> $4 RETURNING id`, [s.wfmGroupId, s.kind, SYSTEM_NAME, v.id]))).length;
    }
    await finish('CREATED', '', v.id);
  } catch (e: any) {
    console.error('[forecast-refresh]', e?.message);
    try { await finish('FAILED', String(e?.message ?? 'The refresh failed.').slice(0, 300), null); } catch (e2: any) { console.error('[forecast-refresh] could not record the failure:', e2?.message); }
  }
}

// ---------------------------------------------------------------- the scheduler

let busy = false;
/** The schedules that are due at this moment, across every tenant. */
export async function findDue(at = new Date()): Promise<{ tenantId: string; id: string }[]> {
  const out: { tenantId: string; id: string }[] = [];
  for (const t of await raw<{ id: string }>('SELECT id FROM tenants')) {
    const rows = await withTenant(t.id, (tx) => tx.q<any>(`SELECT s.id, s.enabled, s.frequency, s.day_of_week, s.hour, s.last_run_day::text AS last_run_day, g.timezone FROM forecast_refresh_settings s JOIN wfm_groups g ON g.id = s.wfm_group_id WHERE s.tenant_id = :t AND s.enabled`));
    for (const r of rows) if (isDue({ enabled: r.enabled, frequency: r.frequency, dayOfWeek: r.dayOfWeek, hour: r.hour, lastRunDay: r.lastRunDay }, localNow(r.timezone ?? 'UTC', at))) out.push({ tenantId: t.id, id: r.id });
  }
  return out;
}

/** Start every schedule that is due. Returns how many it ran. One at a time: a refresh runs the engine, which is the heavy part. */
export async function runDueRefreshes(at = new Date()): Promise<number> {
  if (busy) return 0;
  busy = true;
  let n = 0;
  try {
    for (const d of await findDue(at)) {
      try { const id = await startRun(d.tenantId, d.id, 'SCHEDULE', SYSTEM_NAME); await executeRun(d.tenantId, id); n++; }
      catch (e: any) { if (e?.code !== 'ALREADY_RUNNING') console.error('[forecast-refresh] scheduler:', e?.message); }
    }
  } finally { busy = false; }
  return n;
}

let timer: NodeJS.Timeout | null = null;
export function startForecastRefresh() {
  if (timer || process.env.FORECAST_REFRESH === 'off') return;
  const every = Math.max(60, Number(process.env.FORECAST_REFRESH_TICK_SECONDS) || 300) * 1000;
  timer = setInterval(() => { runDueRefreshes().catch((e) => console.error('[forecast-refresh]', e?.message)); }, every);
  timer.unref();
}
