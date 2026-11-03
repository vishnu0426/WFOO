/**
 * What a connector does with rows once it has them, shared by every way rows can arrive: pushed to /live by a relay, or pulled by
 * the server itself on a schedule or by "Run now". Also writes the run history the Data Feeds page shows.
 */
import { camelize, pool, withTenant, withWorkspace, type Tx } from '../../db.ts';
import { nextRunAfter } from './schedule.ts';
import { CONFIG_SECRET_KEYS, openFields } from '../../secrets.ts';
import { bad } from '../../http.ts';
import { ingestLive, LiveRows } from '../ingestionRoutes.ts';
import { ingestAgentEvents } from '../intradayRoutes.ts';
import { mapFields, type FieldMap } from './mapping.ts';
import { presetById, type Preset } from './presets.ts';
import { pullJson, type FetchFn } from './engine.ts';
import { safeFetch } from '../../netGuard.ts';
import { pullSftp, type SftpLike } from './sftpPull.ts';
import { findRows, pullSupport, checkDbValue, MAX_DB_ROWS } from './pullRules.ts';
import { readPostgres, type DbClientLike } from './dbPull.ts';
import { stageImport, Upload as StageUpload } from '../ingestionRoutes.ts';
import { parseMinute } from '../csv.ts';
import type { Principal } from '../../auth.ts';

export { findRows, pullSupport };

export async function loadFieldMaps(tx: Tx, connectorId: string): Promise<FieldMap[]> {
  const rows = await tx.q<any>('SELECT target_field, source_path, transform FROM integration_field_maps WHERE tenant_id = :t AND connector_id = $1', [connectorId]);
  return rows.map((r) => ({ targetField: r.targetField, sourcePath: r.sourcePath, transform: (r.transform || null) as FieldMap['transform'] }));
}


/** A queue by id, name, code or alias (the names the phone system or the database uses), case-insensitively. */
export function queueResolver<Q extends { id: string; name: string; code?: string; aliases?: string[] | null }>(queues: Q[]) {
  const by = new Map<string, Q>();
  for (const q of queues) for (const k of [q.id, q.name, q.code, ...(q.aliases ?? [])]) if (k) by.set(String(k).toLowerCase(), q);
  return (v: string) => by.get(String(v).trim().toLowerCase());
}

/** Values that lost their time zone on the way (a JavaScript Date from a timestamp column) are refused with a plain instruction. */
function refuseTimestamps(mapped: Record<string, unknown>[]) {
  for (const m of mapped.slice(0, 100)) for (const f of ['day', 'time'] as const) { const msg = checkDbValue(f, m[f]); if (msg) throw bad(msg); }
}

/** 30 and 60 minute rows become 2 and 4 fifteen-minute slots sharing the volume, as an uploaded file of that length does. */
export function spreadIntervals<R extends { time?: string; slot?: number; volume: number; abandoned?: number }>(rows: R[], intervalMin: number): R[] {
  const step = intervalMin === 60 ? 4 : intervalMin === 30 ? 2 : 1;
  if (step === 1) return rows;
  return rows.flatMap((r) => {
    const base = r.slot ?? Math.floor((parseMinute(r.time ?? '') ?? 0) / 15);
    return Array.from({ length: step }, (_, k) => base + k).filter((slot) => slot < 96)
      .map((slot) => ({ ...r, time: undefined, slot, volume: Math.round(r.volume / step), abandoned: r.abandoned === undefined ? undefined : Math.round(r.abandoned / step) }));
  });
}

/** Raw vendor rows -> field map -> entity map -> routed by the preset's `writesTo` (interval history or agent state). */
export async function applyLiveRows(connector: any, preset: Preset, input: Record<string, unknown>[], opts: { intervalMin?: number } = {}): Promise<any> {
  const id: string = connector.id;
  return withWorkspace(connector.tenantId, connector.workspaceId, async (tx) => {
    const maps = await loadFieldMaps(tx, id);
    const mapped = input.map((r) => mapFields(r, maps));
    refuseTimestamps(mapped);

    if (preset.writesTo === 'agent_state') {
      // the vendor's own agent id (e.g. "1002@agnoshin.com") is never going to equal our employee_number by
      // coincidence -- same entity-match indirection queue matching already uses, just for employees here.
      const empMaps = await tx.q<any>('SELECT source_id, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [id, 'employee']);
      const employees = await tx.q<any>('SELECT id, employee_number FROM employees WHERE tenant_id = :t');
      const empNoById = new Map(employees.map((e) => [e.id, e.employeeNumber]));
      const empNoBySource = new Map(empMaps.filter((m) => m.targetId && empNoById.has(m.targetId)).map((m) => [m.sourceId, empNoById.get(m.targetId) as string]));
      const events = mapped.filter((m) => m.employeeNumber && m.state).map((m) => ({ employeeNumber: empNoBySource.get(String(m.employeeNumber)) ?? String(m.employeeNumber), state: String(m.state), reason: m.reason ? String(m.reason) : undefined, at: m.at ? String(m.at) : undefined }));
      if (!events.length) throw bad('No row mapped to employeeNumber + state');
      return { kind: 'agent_state', ...(await ingestAgentEvents(connector.tenantId, events)) };
    }
    if (preset.writesTo === 'interval_history') {
      const queues = await tx.q<any>('SELECT id, name, code, aliases FROM queues WHERE tenant_id = :t');
      const resolve = queueResolver(queues);
      const entityMaps = await tx.q<any>('SELECT source_id, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [id, 'queue']);
      const queueBySource = new Map(entityMaps.filter((m) => m.targetId).map((m) => [m.sourceId, m.targetId as string]));
      const unmatched: { index: number; message: string }[] = [];   // rows whose queue is not known here are reported, not silently dropped
      const rows = mapped.map((m, i) => {
        const sourceQueueId = String((input[i] as any).queueId ?? (input[i] as any).queue ?? '');
        const queueId = queueBySource.get(sourceQueueId) ?? resolve(sourceQueueId)?.id;
        if (!queueId) unmatched.push({ index: i, message: `No queue match for '${sourceQueueId}'` });
        return queueId ? { queueId, day: String(m.day ?? ''), time: m.time ? String(m.time) : undefined, slot: m.slot !== undefined ? Number(m.slot) : undefined, volume: Number(m.volume ?? 0), ahtSec: m.ahtSec !== undefined ? Number(m.ahtSec) : undefined, abandoned: m.abandoned !== undefined ? Number(m.abandoned) : undefined } : null;
      }).filter((r): r is NonNullable<typeof r> => !!r && !!r.day);
      if (!rows.length) throw bad('No row mapped to a known queue; name the queues exactly as they are here, add the names as aliases on the queue, or set up queue matching first');
      const saved = await ingestLive(connector.tenantId, LiveRows.parse({ rows: spreadIntervals(rows, opts.intervalMin ?? 15) }).rows, { record: false });
      return { kind: 'interval_history', ...saved, errors: [...unmatched, ...saved.errors] };
    }
    throw bad(`Live sync for '${preset.writesTo}' connectors is not wired yet; use the backfill/upsert path for HRMS.`);
  });
}


const csvCell = (v: unknown) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

/**
 * Raw vendor rows -> field map -> queue -> a staged import for review, exactly like a manual CSV upload. Used by the relay's /backfill
 * and by the database pull's "Load history". A queue is found through the connector's own matching first, then by name, code or alias.
 */
export async function stageBackfillRows(connector: any, input: Record<string, unknown>[], through: string, opts: { intervalMin?: number; label?: string } = {}) {
  const principal: Principal = { userId: connector.id, tenantId: connector.tenantId, workspaceId: connector.workspaceId, role: 'WFM_ADMIN', name: `Connector: ${connector.name}`, username: `connector:${connector.id}`, jti: '' };
  const prep = await withWorkspace(connector.tenantId, connector.workspaceId, async (tx) => {
    const maps = await loadFieldMaps(tx, connector.id);
    const entityMaps = await tx.q<any>('SELECT source_id, target_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2', [connector.id, 'queue']);
    const queueBySource = new Map(entityMaps.filter((m) => m.targetId).map((m) => [m.sourceId, m.targetId as string]));
    const queues = await tx.q<any>('SELECT id, name, code, aliases, aht_default AS "ahtDefault" FROM queues WHERE tenant_id = :t');
    return { maps, queueBySource, queues };
  });
  const byId = new Map<string, any>(prep.queues.map((q: any) => [q.id, q]));
  const resolve = queueResolver<any>(prep.queues);
  const errors: string[] = [];
  const csvRows = ['queue,date,interval,volume,aht,abandoned'];
  const mappedAll = input.map((r) => mapFields(r, prep.maps));
  refuseTimestamps(mappedAll);
  input.forEach((raw, i) => {
    const m = mappedAll[i];
    const sourceQueueId = String((raw as any).queueId ?? (raw as any).queue ?? '');
    const viaMatch = prep.queueBySource.get(sourceQueueId);
    const q = (viaMatch ? byId.get(viaMatch) : undefined) ?? resolve(sourceQueueId);
    if (!q) return errors.push(`Row ${i}: no queue match for '${sourceQueueId}'. Name the queues exactly as they are here, add the name as an alias on the queue, or set up queue matching`);
    const day = String(m.day ?? '').slice(0, 10), time = String(m.time ?? '00:00');
    if (!day) return errors.push(`Row ${i}: no day mapped`);
    csvRows.push([csvCell(q.name), day, time, Number(m.volume ?? 0), Number(m.ahtSec ?? q.ahtDefault ?? 300), Number(m.abandoned ?? 0)].join(','));
  });
  if (csvRows.length === 1) throw bad(errors[0] ?? 'No rows could be mapped');
  const staged = await stageImport(principal, null, StageUpload.parse({
    dataType: 'HISTORICAL_VOLUME', fileName: `${opts.label ?? `${connector.name}-backfill-${through}`}.csv`, csv: csvRows.join('\n'), intervalMinutes: opts.intervalMin ?? 15,
  }));
  await withWorkspace(connector.tenantId, connector.workspaceId, (tx) => tx.exec('UPDATE integration_connectors SET backfill_status = $2, backfill_through = $3, last_received_at = now(), last_error = NULL WHERE tenant_id = :t AND id = $1', [connector.id, 'IN_PROGRESS', through]));
  return { staged, rowsMapped: csvRows.length - 1, mappingErrors: errors.slice(0, 50), mappingErrorCount: errors.length };
}

// ---------------------------------------------------------------- run history

export type RunTrigger = 'SCHEDULE' | 'MANUAL' | 'PUSH';
export type RunKind = 'PULL' | 'FILE' | 'LIVE' | 'BACKFILL' | 'WEBHOOK';
export interface RunSummary { rowsIn: number; rowsOk: number; rowsRejected: number; message: string; failed?: boolean; partial?: boolean }

/** One row of history per delivery or poll, kept 30 days, and the connector's own "last data / last error" fields brought up to date. */
export async function recordRun(connector: { id: string; tenantId: string; workspaceId: string }, trigger: RunTrigger, kind: RunKind, startedAt: Date, r: RunSummary) {
  const status = r.failed ? 'FAILED' : r.partial || r.rowsRejected > 0 ? 'PARTIAL' : 'OK';
  await withWorkspace(connector.tenantId, connector.workspaceId, async (tx) => {
    await tx.exec(
      `INSERT INTO integration_runs (tenant_id, connector_id, started_at, finished_at, trigger, kind, status, rows_in, rows_ok, rows_rejected, message) VALUES (:t, $1, $2, now(), $3, $4, $5, $6, $7, $8, $9)`,
      [connector.id, startedAt, trigger, kind, status, r.rowsIn, r.rowsOk, r.rowsRejected, r.message.slice(0, 500)]);
    await tx.exec(`DELETE FROM integration_runs WHERE tenant_id = :t AND connector_id = $1 AND started_at < now() - interval '30 days'`, [connector.id]);
    await tx.exec(
      `UPDATE integration_connectors SET last_error = $2, last_received_at = CASE WHEN $3 THEN now() ELSE last_received_at END WHERE tenant_id = :t AND id = $1`,
      [connector.id, r.failed ? r.message.slice(0, 500) : null, !r.failed && r.rowsOk > 0]);
  });
  return status;
}

/** Counts from what applyLiveRows returned, for the history row. */
export const summariseLive = (rowsIn: number, out: any): RunSummary => {
  const rejected = Array.isArray(out?.errors) ? out.errors.length : 0;
  const ok = typeof out?.accepted === 'number' ? out.accepted : rowsIn - rejected;
  return { rowsIn, rowsOk: ok, rowsRejected: rejected, message: rejected ? `${ok} saved, ${rejected} turned away${out.errors[0]?.message ? `: ${out.errors[0].message}` : ''}` : `${ok} row${ok === 1 ? '' : 's'} saved` };
};

// ---------------------------------------------------------------- scheduled / manual pulls

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function pullRest(connector: any, preset: Preset, fetchImpl: FetchFn = (url, init) => safeFetch(url, { ...(init as any), signal: AbortSignal.timeout(30_000) }) as any): Promise<RunSummary> {
  const config = openFields(connector.config, CONFIG_SECRET_KEYS);
  const base = String(config.baseUrl ?? '').trim(), path = String(config.volumeEndpoint ?? '').trim();
  if (!base || !path) throw new Error('The connector needs a base URL and a historical volume endpoint.');
  const today = new Date(), yesterday = new Date(today.getTime() - 86_400_000);
  const url = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\{from\}/g, isoDay(yesterday)).replace(/\{to\}/g, isoDay(today));
  const json = await pullJson(connector.id, preset, connector.config, url, fetchImpl);
  const rows = findRows(json).slice(0, 5000);
  if (!rows.length) return { rowsIn: 0, rowsOk: 0, rowsRejected: 0, message: 'The source returned no rows' };
  return summariseLive(rows.length, await applyLiveRows(connector, preset, rows));
}


const addDays = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

/**
 * One read of the customer's database. A normal run re-reads the last two days (the newest interval is often still being finalised, and
 * writing the same interval again just replaces it) and saves them to live history. "Load history" instead reads the last N weeks a week at a time
 * and stages them for review, so nothing historical reaches the forecasts until a person has looked at it.
 */
export async function pullDatabase(connector: any, config: Record<string, any>, opts: { backfill?: boolean; db?: DbClientLike } = {}): Promise<RunSummary> {
  const preset = presetById(connector.preset)!;
  const intervalMin = Number(config.intervalMinutes) || 15;
  const today = isoDay(new Date());
  if (!opts.backfill) {
    const { rows } = await readPostgres(config, addDays(today, -2), today, MAX_DB_ROWS, opts.db);
    if (!rows.length) return { rowsIn: 0, rowsOk: 0, rowsRejected: 0, message: 'The query returned no rows for the last two days' };
    return summariseLive(rows.length, await applyLiveRows(connector, preset, rows, { intervalMin }));
  }
  const weeks = config.backfillWeeks ? Number(config.backfillWeeks) : 8;
  let buffer: Record<string, unknown>[] = [], read = 0, ok = 0, bad = 0, jobs = 0, firstError = '';
  const flush = async () => {
    if (!buffer.length) return;
    const out = await stageBackfillRows(connector, buffer, today, { intervalMin, label: `${connector.name}-history-${today}${jobs ? `-part${jobs + 1}` : ''}` });
    jobs++; ok += out.rowsMapped; bad += out.mappingErrorCount; firstError = firstError || out.mappingErrors[0] || '';
    buffer = [];
  };
  for (let start = addDays(today, -weeks * 7); start <= today; start = addDays(start, 7)) {
    const end = addDays(start, 6) < today ? addDays(start, 6) : today;
    const { rows } = await readPostgres(config, start, end, MAX_DB_ROWS, opts.db);
    read += rows.length; buffer.push(...rows);
    if (buffer.length >= 100_000) await flush();
  }
  await flush();
  if (!jobs) return { rowsIn: read, rowsOk: 0, rowsRejected: 0, message: `The query returned no rows for the last ${weeks} weeks`, partial: true };
  return { rowsIn: read, rowsOk: ok, rowsRejected: bad, partial: bad > 0, message: `Loaded ${ok.toLocaleString()} rows from the last ${weeks} week${weeks === 1 ? '' : 's'} into ${jobs} staged import${jobs === 1 ? '' : 's'} for review${bad ? `. ${bad.toLocaleString()} rows could not be matched to a queue: ${firstError}` : ''}` };
}

/** A look at what the query returns, read-only and saving nothing, so the admin can check it before scheduling it. */
export async function testDatabaseQuery(connector: any, config: Record<string, any>, db?: DbClientLike) {
  const today = isoDay(new Date());
  const { rows, columns } = await readPostgres(config, addDays(today, -2), today, 20, db);
  const problems: string[] = [];
  const mapped = await withWorkspace(connector.tenantId, connector.workspaceId, async (tx) => {
    const maps = await loadFieldMaps(tx, connector.id);
    const queues = await tx.q<any>('SELECT id, name, code, aliases FROM queues WHERE tenant_id = :t');
    const entity = await tx.q<any>('SELECT source_id FROM integration_entity_maps WHERE tenant_id = :t AND connector_id = $1 AND entity_type = $2 AND target_id IS NOT NULL', [connector.id, 'queue']);
    return { maps, resolve: queueResolver<any>(queues), matched: new Set(entity.map((e: any) => e.sourceId)) };
  });
  const sample = rows.slice(0, 5).map((r) => mapFields(r, mapped.maps));
  try { refuseTimestamps(sample); } catch (e: any) { problems.push(e.message); }
  for (const f of ['day', 'time', 'volume']) if (rows.length && sample.every((m) => m[f] === undefined || m[f] === null || m[f] === '')) problems.push(`Nothing is mapped to ${f}. Return a column named ${f}, or map your own column name on the field-mapping screen.`);
  const unknown = [...new Set(rows.map((r: any) => String(r.queueId ?? r.queue ?? '')).filter((n) => n && !mapped.matched.has(n) && !mapped.resolve(n)))];
  if (!rows.length) problems.push('The query returned no rows for the last two days. If that is expected, the connection works but there is nothing to see yet.');
  else if (!columns.some((c) => c === 'queue' || c === 'queueId')) problems.push('No column named queue. Return the queue name as a column called queue.');
  if (unknown.length) problems.push(`Queue name${unknown.length === 1 ? '' : 's'} not known here: ${unknown.slice(0, 5).map((n) => `'${n}'`).join(', ')}. Add as an alias on the queue, or set up queue matching.`);
  return { columns, rowCount: rows.length, sample: rows.slice(0, 5).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), problems };
}

/** Runs one pull or file pick-up now, records it in the history, and never throws: a failure is a FAILED run the planner can see. */
export async function runConnector(connector: any, trigger: Exclude<RunTrigger, 'PUSH'>, deps: { sftp?: SftpLike; fetchImpl?: FetchFn; db?: DbClientLike; backfill?: boolean } = {}): Promise<{ status: string; message: string; rowsIn: number; rowsOk: number; rowsRejected: number }> {
  const started = new Date();
  const preset = presetById(connector.preset);
  const isDb = connector.preset === 'DATABASE_POSTGRES_PULL';
  const kind: RunKind = connector.method === 'FILE_SFTP' ? 'FILE' : isDb && deps.backfill ? 'BACKFILL' : 'PULL';
  let summary: RunSummary;
  try {
    const config = openFields(connector.config, CONFIG_SECRET_KEYS);
    const support = pullSupport(preset, config);
    if (!preset || !support.canPull) throw new Error(support.note || 'This connector does not pull data; the source sends it to us.');
    summary = kind === 'FILE' ? await pullSftp(connector, config, deps.sftp) : isDb ? await pullDatabase(connector, config, { backfill: deps.backfill, db: deps.db }) : await pullRest(connector, preset, deps.fetchImpl);
  } catch (e: any) { summary = { rowsIn: 0, rowsOk: 0, rowsRejected: 0, message: e?.message ?? String(e), failed: true }; }
  const status = await recordRun(connector, trigger, kind, started, summary).catch((e) => { console.error('[connectors] could not record run:', e.message); return summary.failed ? 'FAILED' : 'OK'; });
  return { status, message: summary.message, rowsIn: summary.rowsIn, rowsOk: summary.rowsOk, rowsRejected: summary.rowsRejected };
}

// ---------------------------------------------------------------- scheduler

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * Claims the connectors that are due, sets each one's next run in the same transaction (so two gateway processes never run one twice), then runs
 * them. The next run follows the connector's own schedule: every N minutes, or a set time of day, on its weekdays, on the organisation's clock.
 */
export async function runDueConnectors(limit = 5) {
  const c = await pool.connect();
  let due: any[] = [];
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(
      `SELECT c.*, t.timezone AS org_timezone FROM integration_connectors c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.status = 'ACTIVE' AND c.schedule_min IS NOT NULL AND c.method IN ('API_PULL', 'FILE_SFTP', 'DATABASE') AND (c.next_run_at IS NULL OR c.next_run_at <= now())
       ORDER BY c.next_run_at NULLS FIRST LIMIT $1 FOR UPDATE OF c SKIP LOCKED`, [limit]);
    due = rows.map((r) => camelize<any>(r));
    for (const r of due) {
      const next = nextRunAfter({ everyMin: r.scheduleMin, at: r.scheduleAt ?? null, days: r.scheduleDays ?? null }, new Date(), r.orgTimezone || 'UTC');
      await c.query('UPDATE integration_connectors SET next_run_at = $2 WHERE id = $1', [r.id, next]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  for (const r of due) await runConnector(r, 'SCHEDULE');
  return due.length;
}

export function startConnectorScheduler(everyMs = 30_000) {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    runDueConnectors().catch((e) => console.error('[connectors] scheduler:', e.message)).finally(() => { ticking = false; });
  }, everyMs);
}
export function stopConnectorScheduler() { if (timer) clearInterval(timer); timer = null; }
