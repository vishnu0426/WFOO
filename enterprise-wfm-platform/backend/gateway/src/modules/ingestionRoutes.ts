/**
 * Staged data ingestion (Rule 7: a file never mutates live data directly).
 *
 *   1 upload + parse/validate   -> import_jobs + import_rows (staged, nothing live changes)
 *   2 diff                      -> every valid row is NEW, UPDATE or UNCHANGED against live interval_history
 *   3 quality audit             -> gaps, outliers, zero days, future dates: rows flagged, issues recorded
 *   4 atomic commit             -> one transaction; previous values are kept on each row
 *   5 rollback                  -> restores exactly what the commit changed (refused if a later import overwrote it)
 *
 * Live feed: POST /data/ingest and NATS wfm.<tenant>.ingest.interval write interval rows directly (small, idempotent upserts).
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, conflict, notFound, parse } from '../http.ts';
import { dropCache, publish } from '../infra.ts';
import { learnFromNewData } from './forecast/learning.ts';
import { TEMPLATE_CSV, normalise, parseCsv, type DateFormat, type QueueRef } from './csv.ts';

export const ingestion = Router();

const INTERVAL_TYPES = ['HISTORICAL_VOLUME', 'HISTORICAL_AHT', 'ACTUALS'] as const;
const MAX_BYTES = 10 * 1024 * 1024;

export const Upload = z.object({
  dataType: z.enum([...INTERVAL_TYPES, 'EMPLOYEES', 'TEAMS', 'SKILLS', 'AVAILABILITY', 'TIME_OFF', 'SCHEDULES']).default('HISTORICAL_VOLUME'),
  fileName: z.string().min(1).max(200),
  csv: z.string().min(1),
  queueId: z.string().optional(),                       // when the file has no queue column
  intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(15),
  dateFormat: z.enum(['iso', 'mdy', 'dmy']).default('iso'),
});

const jobDto = (j: any) => ({
  id: j.id, tenantId: j.tenantId, dataType: j.dataType, sourceType: j.sourceType, fileName: j.fileName, fileSizeKb: j.fileSizeKb, status: j.status,
  totalRecords: j.totalRecords, validRecords: j.validRecords, warningRecords: j.warningRecords, errorRecords: j.errorRecords,
  createdRecords: j.createdRecords, updatedRecords: j.updatedRecords, skippedRecords: j.skippedRecords,
  createdAt: j.createdAt, createdBy: j.createdBy, completedAt: j.completedAt, canRollback: j.canRollback, isRolledBack: j.isRolledBack, summary: j.summary,
});

const tenantTz = (tx: Tx) => tx.one<{ timezone: string }>('SELECT timezone FROM tenants WHERE id = :t').then((r) => r?.timezone ?? 'UTC');

// ---------------------------------------------------------------- 1-3: stage, diff, audit

/** The staging half of ingestion (stage -> diff -> quality audit), factored out so a connector's historical backfill
 * (Integration Station) can stage a pull exactly like a human's CSV upload, review included, instead of writing
 * interval_history directly. `p`/`req` carry through to the audit log same as the HTTP path. */
export async function stageImport(p: Principal, req: import('express').Request | null, b: z.infer<typeof Upload>) {
  if (!(INTERVAL_TYPES as readonly string[]).includes(b.dataType)) throw new HttpError(501, 'NOT_IMPLEMENTED', `${b.dataType} imports arrive with the workforce module. Interval history (HISTORICAL_VOLUME, HISTORICAL_AHT, ACTUALS) is available now.`);
  const bytes = Buffer.byteLength(b.csv);
  if (bytes > MAX_BYTES) throw new HttpError(413, 'TOO_LARGE', 'File exceeds 10MB; split it into several files');
  const matrix = parseCsv(b.csv);
  if (matrix.length < 2) throw bad('The file has a header but no data rows');
  if (matrix.length > 1_000_001) throw bad('More than 1,000,000 rows; split the file');

  const job = await withTenant(p.tenantId, async (tx) => {
    await tx.exec("SET LOCAL statement_timeout = '240s'");   // a stuck query fails with an error instead of leaving the screen loading forever
    const queues = await tx.q<QueueRef>('SELECT id, name, code, aht_default FROM queues WHERE tenant_id = :t');
    const norm = normalise(matrix, { queue: b.queueId, intervalMin: b.intervalMinutes, dateFormat: b.dateFormat as DateFormat, queues });
    const j = await tx.one<any>(
      `INSERT INTO import_jobs (tenant_id, data_type, file_name, file_size_kb, status, total_records, options, created_by)
       VALUES (:t, $1, $2, $3, 'VALIDATING', $4, $5, $6) RETURNING id`,
      [b.dataType, b.fileName, Math.ceil(bytes / 1024), norm.rowsRead, JSON.stringify({ queueId: b.queueId, intervalMinutes: b.intervalMinutes, dateFormat: b.dateFormat }), p.name]);
    const id = j!.id as string;

    // stage rows: valid rows, then the (capped) error rows so the planner can see exactly what was rejected
    const errs = norm.errors.slice(0, 5000);
    for (let i = 0; i < norm.records.length; i += 5000) {
      const c = norm.records.slice(i, i + 5000);
      await tx.exec(
        `INSERT INTO import_rows (tenant_id, job_id, line, row_status, queue_id, day, slot, volume, aht_sec, abandoned)
         SELECT :t, $1, * FROM unnest($2::int[], $3::text[], $4::uuid[], $5::date[], $6::smallint[], $7::int[], $8::int[], $9::int[])`,
        [id, c.map((r) => r.line), c.map(() => 'VALID'), c.map((r) => r.queueId), c.map((r) => r.day), c.map((r) => r.slot), c.map((r) => r.volume), c.map((r) => r.ahtSec), c.map((r) => r.abandoned)]);
    }
    if (errs.length) {
      await tx.exec(
        `INSERT INTO import_rows (tenant_id, job_id, line, row_status, message) SELECT :t, $1, * FROM unnest($2::int[], $3::text[], $4::text[])`,
        [id, errs.map((e) => e.line), errs.map(() => 'ERROR'), errs.map((e) => e.message)]);
    }

    // diff against live data
    // (two plain statements instead of a self-join: the planner has no statistics for rows staged a moment ago,
    // and a self-join with a LEFT JOIN can then choose a plan that never finishes on a large file)
    await tx.exec(`UPDATE import_rows SET action = 'NEW' WHERE job_id = $1 AND row_status <> 'ERROR'`, [id]);
    await tx.exec(
      `UPDATE import_rows r SET action = CASE WHEN h.volume = r.volume AND h.aht_sec = r.aht_sec AND h.abandoned = r.abandoned THEN 'UNCHANGED' ELSE 'UPDATE' END
       FROM interval_history h WHERE r.job_id = $1 AND r.row_status <> 'ERROR' AND h.queue_id = r.queue_id AND h.day = r.day AND h.slot = r.slot`, [id]);

    const quality = await qualityAudit(tx, id, queues);
    const [d] = await tx.q<any>(
      `SELECT count(*) FILTER (WHERE action = 'NEW')::int AS new_rows, count(*) FILTER (WHERE action = 'UPDATE')::int AS updated_rows,
              count(*) FILTER (WHERE action = 'UNCHANGED')::int AS unchanged_rows, count(*) FILTER (WHERE row_status = 'VALID')::int AS valid,
              count(*) FILTER (WHERE row_status = 'WARNING')::int AS warnings, count(*) FILTER (WHERE row_status = 'ERROR')::int AS errors
       FROM import_rows WHERE job_id = $1`, [id]);
    const perQueue = await tx.q<any>(
      `SELECT q.name AS queue, min(r.day)::text AS first_day, max(r.day)::text AS last_day, count(DISTINCT r.day)::int AS days, count(*)::int AS intervals, sum(r.volume)::int AS contacts
       FROM import_rows r JOIN queues q ON q.id = r.queue_id WHERE r.job_id = $1 AND r.row_status <> 'ERROR' GROUP BY q.name ORDER BY q.name`, [id]);
    const summary = { columns: norm.columns, diff: { new: d.newRows, updated: d.updatedRows, unchanged: d.unchangedRows }, perQueue, quality };
    const status = d.valid + d.warnings === 0 ? 'FAILED' : 'READY';
    await tx.exec(
      `UPDATE import_jobs SET status = $2, valid_records = $3, warning_records = $4, error_records = $5, summary = $6 WHERE tenant_id = :t AND id = $1`,
      [id, status, d.valid, d.warnings, d.errors, JSON.stringify(summary)]);
    await audit(tx, p, req, { action: 'IMPORT', entityType: 'IMPORT_JOB', entityId: id, entityName: b.fileName, diffSummary: `staged ${d.valid + d.warnings} valid rows, ${d.errors} rejected`, reason: 'File staged for review' });
    return tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1', [id]);
  });
  return jobDto(job);
}

ingestion.post('/imports', requires('data:import'), async (req, res) => {
  const p = me(req), b = parse(Upload, req.body);
  res.status(201).json(await stageImport(p, req, b));
});

/** Flags suspicious rows (kept importable) and records one issue per finding. */
async function qualityAudit(tx: Tx, jobId: string, queues: QueueRef[]) {
  const name = (id: string) => queues.find((q) => q.id === id)?.name ?? id;
  const issues: { severity: 'ERROR' | 'WARNING' | 'INFO'; entityId: string; entityName: string; issue: string; impact: string; fix: string }[] = [];

  const cov = await tx.q<any>(
    `SELECT queue_id, count(DISTINCT day)::int AS days, count(*)::int AS n, min(day)::text AS first_day, max(day)::text AS last_day
     FROM import_rows WHERE job_id = $1 AND row_status <> 'ERROR' GROUP BY queue_id`, [jobId]);
  for (const c of cov) {
    const missing = c.days * 96 - c.n;
    if (missing > 0) issues.push({ severity: 'WARNING', entityId: c.queueId, entityName: name(c.queueId), issue: `${missing.toLocaleString()} of ${(c.days * 96).toLocaleString()} expected 15-minute intervals are missing (${c.firstDay} to ${c.lastDay})`,
      impact: 'Gaps are filled with the same-weekday baseline when forecasting, which slightly blurs the intraday pattern.', fix: 'Re-export the missing intervals from the ACD, or accept the gaps.' });
    if (c.days < 28) issues.push({ severity: 'INFO', entityId: c.queueId, entityName: name(c.queueId), issue: `Only ${c.days} days of history in this file`,
      impact: 'Models need at least 4-8 weeks to be scored reliably; a year or more lets them learn holidays and yearly patterns.', fix: 'Add earlier history if you have it.' });
  }

  // medians per queue and slot are computed first (at most queues x 96 rows) and passed back as literals: joining a grouped
  // subquery to a freshly staged table let the planner re-run the aggregate per row, which stalled large uploads for good
  const meds = await tx.q<{ queueId: string; slot: number; m: number }>(
    `SELECT queue_id, slot, percentile_cont(0.5) WITHIN GROUP (ORDER BY volume)::float8 AS m FROM import_rows WHERE job_id = $1 AND row_status <> 'ERROR' GROUP BY queue_id, slot`, [jobId]);
  const outliers = meds.length ? await tx.exec(
    `UPDATE import_rows r SET row_status = 'WARNING', message = 'Volume is more than 5x the usual for this interval'
     FROM unnest($2::uuid[], $3::int[], $4::float8[]) AS med(queue_id, slot, m)
     WHERE r.job_id = $1 AND r.queue_id = med.queue_id AND r.slot = med.slot AND r.row_status = 'VALID' AND r.volume > 20 AND r.volume > 5 * med.m`,
    [jobId, meds.map((x) => x.queueId), meds.map((x) => x.slot), meds.map((x) => x.m)]) : 0;
  if (outliers) issues.push({ severity: 'WARNING', entityId: jobId, entityName: 'Volume outliers', issue: `${outliers.toLocaleString()} intervals are more than 5x their usual volume`,
    impact: 'Outlier days are detected and replaced by the forecaster, but a wrong export could still skew AHT and intraday shape.', fix: 'Check the flagged rows; import anyway if they are real (a campaign or outage).' });

  const ahtBad = await tx.exec(`UPDATE import_rows SET row_status = 'WARNING', message = 'Handle time over 1 hour' WHERE job_id = $1 AND row_status = 'VALID' AND aht_sec > 3600`, [jobId]);
  if (ahtBad) issues.push({ severity: 'WARNING', entityId: jobId, entityName: 'Handle time', issue: `${ahtBad.toLocaleString()} intervals report an average handle time over one hour`,
    impact: 'Very long AHT inflates staffing requirements.', fix: 'Confirm the AHT unit is seconds and not minutes or milliseconds.' });

  const zero = await tx.q<any>(`SELECT queue_id, count(*)::int AS n FROM (SELECT queue_id, day FROM import_rows WHERE job_id = $1 AND row_status <> 'ERROR' GROUP BY queue_id, day HAVING sum(volume) = 0) z GROUP BY queue_id`, [jobId]);
  for (const z of zero) issues.push({ severity: 'WARNING', entityId: z.queueId, entityName: name(z.queueId), issue: `${z.n} whole days with zero contacts`,
    impact: 'A full day of zeros usually means the feed was down, not that nobody called. Zeros pull the forecast down.', fix: 'Remove those days from the file or mark them as an outage event.' });

  const future = await tx.exec(`UPDATE import_rows SET row_status = 'WARNING', message = 'Date is in the future' WHERE job_id = $1 AND row_status = 'VALID' AND day > current_date`, [jobId]);
  if (future) issues.push({ severity: 'WARNING', entityId: jobId, entityName: 'Future dates', issue: `${future.toLocaleString()} rows are dated in the future`, impact: 'Future rows are not history; they will be treated as actuals.', fix: 'Check the date format (day/month order) in the file.' });

  for (const i of issues) {
    await tx.exec(
      `INSERT INTO data_quality_issues (tenant_id, job_id, severity, category, entity_id, entity_name, issue, impact, remediation) VALUES (:t, $1, $2, 'FORECAST', $3, $4, $5, $6, $7)`,
      [jobId, i.severity, i.entityId, i.entityName, i.issue, i.impact, i.fix]);
  }
  const score = Math.max(0, 100 - issues.filter((i) => i.severity === 'ERROR').length * 25 - issues.filter((i) => i.severity === 'WARNING').length * 8);
  return { score, issues: issues.map((i) => ({ severity: i.severity, entity: i.entityName, issue: i.issue, impact: i.impact, fix: i.fix })) };
}

// ---------------------------------------------------------------- review

ingestion.get('/imports', requires('data:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>('SELECT * FROM import_jobs WHERE tenant_id = :t ORDER BY created_at DESC LIMIT 100'))).map(jobDto));
});

ingestion.get('/imports/:id', requires('data:read'), async (req, res) => {
  const id = String(req.params.id);
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const j = await tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1', [id]);
    if (!j) throw notFound('Import job');
    const errors = await tx.q('SELECT line, message FROM import_rows WHERE job_id = $1 AND row_status = \'ERROR\' ORDER BY line LIMIT 100', [id]);
    const warnings = await tx.q(
      `SELECT r.line, r.message, q.name AS queue, r.day::text AS day, r.slot, r.volume FROM import_rows r LEFT JOIN queues q ON q.id = r.queue_id WHERE r.job_id = $1 AND r.row_status = 'WARNING' ORDER BY r.line LIMIT 100`, [id]);
    const sample = await tx.q(
      `SELECT r.line, q.name AS queue, r.day::text AS day, r.slot, r.volume, r.aht_sec, r.abandoned, r.action, r.row_status AS status, r.prev_volume
       FROM import_rows r JOIN queues q ON q.id = r.queue_id WHERE r.job_id = $1 AND r.row_status <> 'ERROR' ORDER BY (r.action = 'UPDATE') DESC, r.line LIMIT 40`, [id]);
    return { ...jobDto(j), errors, warnings, sample };
  });
  res.json(out);
});

ingestion.delete('/imports/:id', requires('data:import'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const j = await tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1', [id]);
    if (!j) throw notFound('Import job');
    if (['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'ROLLED_BACK', 'IMPORTING'].includes(j.status)) throw conflict('A committed import cannot be discarded; roll it back instead.');
    await tx.exec('DELETE FROM import_jobs WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'IMPORT_JOB', entityId: id, entityName: j.fileName, reason: 'Staged import discarded' });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 4: atomic commit

ingestion.post('/imports/:id/commit', requires('data:import'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec("SET LOCAL statement_timeout = '240s'");
    const j = await tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1 FOR UPDATE', [id]);
    if (!j) throw notFound('Import job');
    if (j.status !== 'READY') throw conflict(`Only a job that passed validation can be committed (this one is ${j.status}).`);
    await tx.exec(`UPDATE import_jobs SET status = 'IMPORTING' WHERE tenant_id = :t AND id = $1`, [id]);

    // remember what is about to be replaced, so rollback is exact
    await tx.exec(`UPDATE import_rows SET was_new = true WHERE job_id = $1 AND row_status <> 'ERROR' AND action = 'NEW'`, [id]);
    await tx.exec(
      `UPDATE import_rows r SET was_new = false, prev_volume = h.volume, prev_aht_sec = h.aht_sec, prev_abandoned = h.abandoned
       FROM interval_history h WHERE r.job_id = $1 AND r.row_status <> 'ERROR' AND r.action = 'UPDATE' AND h.queue_id = r.queue_id AND h.day = r.day AND h.slot = r.slot`, [id]);
    const tz = await tenantTz(tx);
    await tx.exec(
      `INSERT INTO interval_history (tenant_id, queue_id, day, slot, starts_at, volume, aht_sec, abandoned, source, import_job_id)
       SELECT :t, r.queue_id, r.day, r.slot, ((r.day::timestamp + make_interval(mins => r.slot * 15)) AT TIME ZONE $2), r.volume, r.aht_sec, r.abandoned, 'IMPORT', $1
       FROM import_rows r WHERE r.job_id = $1 AND r.row_status <> 'ERROR' AND r.action IN ('NEW','UPDATE')
       ON CONFLICT (queue_id, day, slot) DO UPDATE SET volume = EXCLUDED.volume, aht_sec = EXCLUDED.aht_sec, abandoned = EXCLUDED.abandoned,
              starts_at = EXCLUDED.starts_at, source = 'IMPORT', import_job_id = EXCLUDED.import_job_id`, [id, tz]);
    const [c] = await tx.q<any>(
      `SELECT count(*) FILTER (WHERE action = 'NEW')::int AS created, count(*) FILTER (WHERE action = 'UPDATE')::int AS updated,
              count(*) FILTER (WHERE action = 'UNCHANGED' OR row_status = 'ERROR')::int AS skipped FROM import_rows WHERE job_id = $1`, [id]);
    const status = j.warningRecords > 0 || j.errorRecords > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
    await tx.exec(
      `UPDATE import_jobs SET status = $2, created_records = $3, updated_records = $4, skipped_records = $5, completed_at = now(), can_rollback = true WHERE tenant_id = :t AND id = $1`,
      [id, status, c.created, c.updated, c.skipped]);
    await audit(tx, p, req, { action: 'IMPORT', entityType: 'IMPORT_JOB', entityId: id, entityName: j.fileName, reason: 'Committed to live history', after: { created: c.created, updated: c.updated, skipped: c.skipped, status } });
    return tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1', [id]);
  });
  await dropCache(p.tenantId, 'holdout:*');
  publish(p.tenantId, ['data', 'imported'], { jobId: id, by: p.name });
  learnFromNewData(p.tenantId);
  res.json(jobDto(out));
});

// ---------------------------------------------------------------- 5: rollback

ingestion.post('/imports/:id/rollback', requires('data:rollback'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const reason = parse(z.object({ reason: z.string().min(3, 'is required') }), req.body).reason;
  const out = await withTenant(p.tenantId, async (tx) => {
    const j = await tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1 FOR UPDATE', [id]);
    if (!j) throw notFound('Import job');
    if (!j.canRollback || j.isRolledBack) throw conflict('This import cannot be rolled back.');
    const [{ n }] = await tx.q<{ n: number }>(
      `SELECT count(*)::int AS n FROM import_rows r JOIN interval_history h ON h.queue_id = r.queue_id AND h.day = r.day AND h.slot = r.slot
       WHERE r.job_id = $1 AND r.action IN ('NEW','UPDATE') AND h.import_job_id IS DISTINCT FROM r.job_id`, [id]);
    if (n > 0) throw conflict(`${n.toLocaleString()} of these intervals were changed again by a later import or live feed. Roll those back first.`);
    const removed = await tx.exec(
      `DELETE FROM interval_history h USING import_rows r WHERE r.job_id = $1 AND r.was_new AND h.queue_id = r.queue_id AND h.day = r.day AND h.slot = r.slot`, [id]);
    const restored = await tx.exec(
      `UPDATE interval_history h SET volume = r.prev_volume, aht_sec = r.prev_aht_sec, abandoned = r.prev_abandoned, source = 'RESTORED', import_job_id = NULL
       FROM import_rows r WHERE r.job_id = $1 AND r.action = 'UPDATE' AND NOT coalesce(r.was_new, false) AND h.queue_id = r.queue_id AND h.day = r.day AND h.slot = r.slot`, [id]);
    await tx.exec(`UPDATE import_jobs SET status = 'ROLLED_BACK', is_rolled_back = true, can_rollback = false WHERE tenant_id = :t AND id = $1`, [id]);
    await audit(tx, p, req, { action: 'ROLLBACK', entityType: 'IMPORT_JOB', entityId: id, entityName: j.fileName, reason, diffSummary: `${removed} intervals removed, ${restored} restored` });
    return tx.one<any>('SELECT * FROM import_jobs WHERE tenant_id = :t AND id = $1', [id]);
  });
  await dropCache(p.tenantId, 'holdout:*');
  res.json(jobDto(out));
});

// ---------------------------------------------------------------- coverage, quality, template

ingestion.get('/coverage', requires('data:read'), async (req, res) => {
  res.json(await withTenant(me(req).tenantId, (tx) => tx.q(
    `SELECT q.id AS queue_id, q.name, q.channel, min(h.day)::text AS first_day, max(h.day)::text AS last_day, count(DISTINCT h.day)::int AS days, count(h.*)::int AS intervals,
            greatest(0, count(DISTINCT h.day) * 96 - count(h.*))::int AS missing_intervals,
            coalesce(sum(h.volume) FILTER (WHERE h.day = current_date), 0)::int AS volume_today
     FROM queues q LEFT JOIN interval_history h ON h.queue_id = q.id WHERE q.tenant_id = :t GROUP BY q.id ORDER BY q.name`)));
});

ingestion.get('/quality', requires('data:read'), async (req, res) => {
  const out = await withTenant(me(req).tenantId, async (tx) => {
    const live: any[] = [];
    const cov = await tx.q<any>(
      `SELECT q.id, q.name, max(h.day)::text AS last_day, (current_date - max(h.day))::int AS stale_days, count(DISTINCT h.day)::int AS days,
              greatest(0, count(DISTINCT h.day) * 96 - count(h.*))::int AS missing
       FROM queues q LEFT JOIN interval_history h ON h.queue_id = q.id WHERE q.tenant_id = :t GROUP BY q.id, q.name`);
    for (const c of cov) {
      if (c.days === 0) live.push({ id: `nohist-${c.id}`, severity: 'WARNING', category: 'FORECAST', entityId: c.id, entityName: c.name, issue: 'No interval history', impactDescription: 'A forecast cannot be created for this queue.', suggestedRemediation: 'Import history or connect the live feed.', createdAt: new Date().toISOString() });
      else {
        if (c.staleDays > 2) live.push({ id: `stale-${c.id}`, severity: 'WARNING', category: 'FORECAST', entityId: c.id, entityName: c.name, issue: `Newest data is ${c.staleDays} days old (${c.lastDay})`, impactDescription: 'Forecasts start from the last complete day, so they are extrapolating further than they should.', suggestedRemediation: 'Check the ACD feed or import the latest days.', createdAt: new Date().toISOString() });
        if (c.missing > 0) live.push({ id: `gaps-${c.id}`, severity: 'INFO', category: 'FORECAST', entityId: c.id, entityName: c.name, issue: `${c.missing.toLocaleString()} intervals missing inside the history`, impactDescription: 'Gaps are filled with the same-weekday baseline.', suggestedRemediation: 'Re-export the missing intervals.', createdAt: new Date().toISOString() });
      }
    }
    const stored = await tx.q<any>(`SELECT id, severity, category, entity_id, entity_name, issue, impact AS impact_description, remediation AS suggested_remediation, created_at FROM data_quality_issues WHERE tenant_id = :t ORDER BY created_at DESC LIMIT 100`);
    return [...live, ...stored];
  });
  res.json(out);
});

ingestion.get('/import-template', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="interval-history-template.csv"');
  res.send(TEMPLATE_CSV);
});

// ---------------------------------------------------------------- live feed

const LiveRow = z.object({
  queue: z.string().optional(), queueId: z.string().optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.number().int().min(0).max(95).optional(), time: z.string().optional(),
  volume: z.number().int().min(0), ahtSec: z.number().positive().optional(), abandoned: z.number().int().min(0).optional(),
});
export const LiveRows = z.object({ rows: z.array(LiveRow).min(1).max(5000) });

export async function ingestLive(tenantId: string, input: z.infer<typeof LiveRows>['rows']): Promise<{ accepted: number; errors: { index: number; message: string }[] }> {
  return withTenant(tenantId, async (tx) => {
    const queues = await tx.q<QueueRef>('SELECT id, name, code, aht_default FROM queues WHERE tenant_id = :t');
    const errors: { index: number; message: string }[] = [];
    const rows: { queueId: string; day: string; slot: number; volume: number; aht: number; ab: number }[] = [];
    input.forEach((r, index) => {
      const ref = r.queueId ? queues.find((q) => q.id === r.queueId) : queues.find((q) => q.name.toLowerCase() === (r.queue ?? '').toLowerCase() || q.code.toLowerCase() === (r.queue ?? '').toLowerCase());
      if (!ref) return errors.push({ index, message: `Unknown queue '${r.queue ?? r.queueId}'` });
      let slot = r.slot;
      if (slot === undefined && r.time) { const m = /^(\d{1,2}):(\d{2})/.exec(r.time); if (m) slot = Math.floor((+m[1] * 60 + +m[2]) / 15); }
      if (slot === undefined || slot < 0 || slot > 95) return errors.push({ index, message: 'Give a slot (0-95) or a time like 09:15' });
      rows.push({ queueId: ref.id, day: r.day, slot, volume: r.volume, aht: Math.round(r.ahtSec ?? ref.ahtDefault), ab: r.abandoned ?? 0 });
    });
    if (rows.length) {
      const tz = await tenantTz(tx);
      await tx.exec(
        `INSERT INTO interval_history (tenant_id, queue_id, day, slot, starts_at, volume, aht_sec, abandoned, source)
         SELECT :t, x.q, x.d, x.s, ((x.d::timestamp + make_interval(mins => x.s * 15)) AT TIME ZONE $1), x.v, x.a, x.b, 'LIVE'
         FROM unnest($2::uuid[], $3::date[], $4::int[], $5::int[], $6::int[], $7::int[]) AS x(q, d, s, v, a, b)
         ON CONFLICT (queue_id, day, slot) DO UPDATE SET volume = EXCLUDED.volume, aht_sec = EXCLUDED.aht_sec, abandoned = EXCLUDED.abandoned, source = 'LIVE'`,
        [tz, rows.map((r) => r.queueId), rows.map((r) => r.day), rows.map((r) => r.slot), rows.map((r) => r.volume), rows.map((r) => r.aht), rows.map((r) => r.ab)]);
    }
    return { accepted: rows.length, errors };
  });
}

ingestion.post('/ingest', requires('data:import'), async (req, res) => {
  const p = me(req), b = parse(LiveRows, req.body);
  const r = await ingestLive(p.tenantId, b.rows);
  if (r.accepted) { await dropCache(p.tenantId, 'holdout:*'); publish(p.tenantId, ['data', 'actuals'], { accepted: r.accepted }); learnFromNewData(p.tenantId); }
  res.json(r);
});
