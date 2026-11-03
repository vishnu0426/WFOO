/**
 * Picks up new CSV files from a customer's SFTP folder and stages each one for review, exactly like a manual upload: nothing reaches live
 * history until a person commits it on the Staged Ingestion page. Each file's settings (interval length, date order, queue) come from
 * the same detector the upload screen uses; a file the detector cannot settle is left alone and reported, never guessed.
 */
import SftpClient from 'ssh2-sftp-client';
import { resolveSafe } from '../../netGuard.ts';
import { withTenant, withWorkspace } from '../../db.ts';
import type { Principal } from '../../auth.ts';
import { detectFormat, parseCsv, type QueueRef } from '../csv.ts';
import { stageImport, Upload } from '../ingestionRoutes.ts';
import { parseRemotePath } from './pullRules.ts';

/** The few things we use from an SFTP client, so tests can supply an in-memory folder instead of a network server. */
export interface SftpLike {
  connect(o: { host: string; port: number; username: string; password: string; readyTimeout: number }): Promise<unknown>;
  list(dir: string): Promise<{ type: string; name: string; size: number; modifyTime: number }[]>;
  get(path: string): Promise<string | Buffer | NodeJS.WritableStream>;
  end(): Promise<unknown>;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_RUN = 20;

export interface PullResult { rowsIn: number; rowsOk: number; rowsRejected: number; message: string; partial: boolean }

export async function pullSftp(connector: any, config: Record<string, any>, given?: SftpLike): Promise<PullResult> {
  const client: SftpLike = given ?? (new SftpClient() as unknown as SftpLike);
  if ((config.direction ?? 'they_host') === 'we_host') throw new Error('This connector is set to "we host the SFTP endpoint", which is not available yet. Choose "they host" and give the server details, or have your side push through the on-site relay.');
  const missing = ['host', 'username', 'password'].filter((k) => !String(config[k] ?? '').trim());
  if (missing.length) throw new Error(`The SFTP connector needs ${missing.map((k) => (k === 'host' ? 'a host' : k === 'username' ? 'a username' : 'a password')).join(', ')}. Add it in the connector settings.`);
  const { dir, match } = parseRemotePath(config.remotePath);

  const principal: Principal = { userId: connector.id, tenantId: connector.tenantId, workspaceId: connector.workspaceId, role: 'WFM_ADMIN', name: `Connector: ${connector.name}`, username: `connector:${connector.id}`, jti: '' };
  const queues = await withWorkspace(connector.tenantId, connector.workspaceId, (tx) => tx.q<QueueRef>('SELECT id, name, code, aht_default, aliases FROM queues WHERE tenant_id = :t'));

  try {
    const host = given ? String(config.host).trim() : (await resolveSafe(String(config.host).trim())).address;     // the address that was checked (netGuard.ts)
    await client.connect({ host, port: Number(config.port) || 22, username: String(config.username), password: String(config.password), readyTimeout: 15_000 });
  } catch (e: any) { throw new Error(`Could not sign in to ${config.host}: ${e.message}`); }

  let rowsIn = 0, rowsOk = 0, rowsRejected = 0, staged = 0;
  const trouble: string[] = [];
  try {
    const files = (await client.list(dir)).filter((f) => f.type === '-' && !f.name.startsWith('.') && match.test(f.name)).sort((a, b) => a.modifyTime - b.modifyTime);
    if (!files.length) return { rowsIn, rowsOk, rowsRejected, message: `No matching files in ${dir}`, partial: false };
    let handled = 0;
    for (const f of files) {
      const mtime = new Date(f.modifyTime);
      const seen = await withTenant(connector.tenantId, (tx) => tx.one('SELECT 1 FROM integration_files WHERE connector_id = $1 AND file_name = $2 AND file_size = $3 AND file_mtime = $4', [connector.id, f.name, f.size, mtime]));
      if (seen) continue;
      if (++handled > MAX_FILES_PER_RUN) break;
      const note = (status: 'STAGED' | 'NEEDS_ATTENTION', message: string | null, jobId: string | null = null) => withTenant(connector.tenantId, (tx) => tx.exec(
        `INSERT INTO integration_files (tenant_id, connector_id, file_name, file_size, file_mtime, status, import_job_id, message) VALUES (:t, $1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [connector.id, f.name, f.size, mtime, status, jobId, message]));
      if (f.size > MAX_FILE_BYTES) { const m = 'larger than 10 MB; split it into several files'; trouble.push(`${f.name}: ${m}`); await note('NEEDS_ATTENTION', m); continue; }

      const body = await client.get(`${dir.replace(/\/$/, '')}/${f.name}`);
      const csv = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
      let sample = csv.slice(0, 256 * 1024);
      if (csv.length > sample.length) sample = sample.slice(0, sample.lastIndexOf('\n') + 1) || sample;   // drop the cut-off last line
      const det = detectFormat(parseCsv(sample), f.name, queues);
      const blocker = det.problems.find((p) => /^No (date|volume|interval)|mix/.test(p)) ?? (det.intervalMinutes.value === null ? det.intervalMinutes.reason : det.dateFormat.value === null ? det.dateFormat.reason : det.queueId.value === null ? det.queueId.reason : '');
      if (blocker) { trouble.push(`${f.name}: ${blocker}`); await note('NEEDS_ATTENTION', blocker); continue; }
      try {
        const job = await stageImport(principal, null, Upload.parse({
          dataType: det.dataType.value ?? 'HISTORICAL_VOLUME', fileName: f.name, csv, queueId: det.queueId.value || undefined,
          intervalMinutes: det.intervalMinutes.value as 15 | 30 | 60, dateFormat: det.dateFormat.value as 'iso' | 'mdy' | 'dmy',
        }));
        staged++; rowsIn += job.totalRecords; rowsOk += job.validRecords; rowsRejected += job.errorRecords;
        await note('STAGED', null, job.id);
      } catch (e: any) { trouble.push(`${f.name}: ${e.message}`); await note('NEEDS_ATTENTION', e.message); }
    }
  } finally { await client.end().catch(() => {}); }

  const parts = [staged ? `Staged ${staged} file${staged === 1 ? '' : 's'} for review on the Staged Ingestion page` : 'No new files'];
  if (trouble.length) parts.push(`${trouble.length} need${trouble.length === 1 ? 's' : ''} attention: ${trouble.slice(0, 3).join('; ')}${trouble.length > 3 ? '…' : ''}`);
  return { rowsIn, rowsOk, rowsRejected, message: parts.join('. '), partial: trouble.length > 0 || rowsRejected > 0 };
}
