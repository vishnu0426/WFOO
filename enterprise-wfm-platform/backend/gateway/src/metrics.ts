/**
 * What an operator or an autoscaler needs to see, in the Prometheus text format at GET /metrics:
 *   - how late the process answers (event-loop delay): the first sign that one process has too much plain computing to do;
 *   - requests in flight and their speed by outcome;
 *   - database connections in use and waiting for a free one;
 *   - each engine's calls in flight, busy answers and time spent waiting for a free engine;
 *   - schedule builds queued and running, and how long the oldest has waited (the number to scale engines and job processes on).
 * No names, tenants or other data about people: counts and sizes only.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import v8 from 'node:v8';
import os from 'node:os';
import type { Pool } from 'pg';
import { hashQueueLength, hashStats, hashThreads } from './passwordHash.ts';

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

const http = { inFlight: 0, byClass: new Map<string, number>(), seconds: 0, count: 0, slow: 0 };
const BUCKETS = [0.05, 0.25, 1, 5];
const buckets = new Array<number>(BUCKETS.length + 1).fill(0);
export function requestStarted() { http.inFlight++; }
export function requestFinished(status: number, ms: number) {
  http.inFlight = Math.max(0, http.inFlight - 1);
  const k = `${Math.floor(status / 100)}xx`;
  http.byClass.set(k, (http.byClass.get(k) ?? 0) + 1);
  http.seconds += ms / 1000; http.count++;
  if (ms > 5000) http.slow++;
  const s = ms / 1000; let i = 0; while (i < BUCKETS.length && s > BUCKETS[i]) i++; buckets[i]++;
}

/** Engine-side counters kept by infra.ts. */
export const engineStats = { busy: 0, busyWaitSec: 0, calls: 0, callSec: 0, errors: 0, waitedGaveUp: 0 };

/** Gateway sizes chosen at start (autosize.ts) so they can be seen next to the load. */
export const sizing: Record<string, number> = {};

let jobsCache: { at: number; queued: number; running: number; oldest: number } | null = null;
async function jobCounts(pool: Pool) {
  if (jobsCache && Date.now() - jobsCache.at < 5000) return jobsCache;
  try {
    const r = await pool.query(`SELECT count(*) FILTER (WHERE status = 'QUEUED')::int AS queued, count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
      coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'QUEUED')), 0)::float AS oldest FROM schedule_jobs WHERE status IN ('QUEUED', 'RUNNING')`);
    jobsCache = { at: Date.now(), ...r.rows[0] };
  } catch { jobsCache = { at: Date.now(), queued: -1, running: -1, oldest: -1 }; }   // the table is not there yet, or the database is down: say so with -1, never fail the scrape
  return jobsCache!;
}

export async function metricsText(o: { pool: Pool; role: string; engines: () => { inFlight: number[]; down: boolean[] } }): Promise<string> {
  const lines: string[] = [];
  const add = (name: string, kind: 'gauge' | 'counter', help: string, samples: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${kind}`);
    for (const [labels, v] of samples) lines.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`);
  };
  const ns = (x: number) => Math.round(x / 1e6) / 1000;        // nanoseconds -> seconds
  add('wfm_gateway_event_loop_delay_seconds', 'gauge', 'How late the process runs what is waiting (since the last scrape)', [['{quantile="0.5"}', ns(loop.percentile(50))], ['{quantile="0.99"}', ns(loop.percentile(99))], ['{quantile="1"}', ns(loop.max)]]);
  loop.reset();
  add('wfm_gateway_http_in_flight', 'gauge', 'Requests being served', [['', http.inFlight]]);
  add('wfm_gateway_http_requests_total', 'counter', 'Requests finished, by outcome', [...http.byClass].map(([k, v]) => [`{class="${k}"}`, v] as [string, number]));
  add('wfm_gateway_http_request_seconds_sum', 'counter', 'Total time spent serving requests', [['', Math.round(http.seconds * 1000) / 1000]]);
  add('wfm_gateway_http_request_seconds_count', 'counter', 'Requests timed', [['', http.count]]);
  let cum = 0;
  add('wfm_gateway_http_request_seconds_bucket', 'counter', 'Requests finished within each time', [...BUCKETS.map((b, i) => [`{le="${b}"}`, (cum += buckets[i])] as [string, number]), ['{le="+Inf"}', http.count]]);
  const pool: any = o.pool;
  add('wfm_gateway_db_pool_connections', 'gauge', 'Database connections by state', [['{state="total"}', pool.totalCount], ['{state="idle"}', pool.idleCount], ['{state="waiting"}', pool.waitingCount], ['{state="max"}', pool.options?.max ?? 0]]);
  const m = process.memoryUsage(), hs = v8.getHeapStatistics();
  add('wfm_gateway_memory_bytes', 'gauge', 'Process memory', [['{kind="rss"}', m.rss], ['{kind="heap_used"}', m.heapUsed], ['{kind="heap_limit"}', hs.heap_size_limit], ['{kind="machine_free"}', os.freemem()]]);
  const e = o.engines();
  add('wfm_gateway_engine_in_flight', 'gauge', 'Calls each engine is working on for this process', e.inFlight.map((v, i) => [`{engine="${i}"}`, v] as [string, number]));
  add('wfm_gateway_engine_down', 'gauge', 'Engines this process has just failed to reach', e.down.map((v, i) => [`{engine="${i}"}`, v ? 1 : 0] as [string, number]));
  add('wfm_gateway_engine_busy_total', 'counter', 'Times an engine said it was full', [['', engineStats.busy]]);
  add('wfm_gateway_engine_busy_wait_seconds_total', 'counter', 'Time requests waited for an engine to have room, instead of failing', [['', Math.round(engineStats.busyWaitSec * 1000) / 1000]]);
  add('wfm_gateway_engine_waited_gave_up_total', 'counter', 'Requests that waited for room and then gave up', [['', engineStats.waitedGaveUp]]);
  add('wfm_gateway_engine_calls_total', 'counter', 'Calls made to engines', [['', engineStats.calls]]);
  add('wfm_gateway_engine_call_seconds_total', 'counter', 'Time spent in engine calls', [['', Math.round(engineStats.callSec * 1000) / 1000]]);
  add('wfm_gateway_engine_errors_total', 'counter', 'Engine calls that failed', [['', engineStats.errors]]);
  add('wfm_gateway_password_hash_queue', 'gauge', 'Sign-ins and password changes waiting for a hashing thread', [['', hashQueueLength()]]);
  add('wfm_gateway_password_hash_threads', 'gauge', 'Threads that check passwords', [['', hashThreads()]]);
  add('wfm_gateway_password_hash_total', 'counter', 'Password checks and hashes, by outcome', [['{result="done"}', hashStats.done], ['{result="rejected_busy"}', hashStats.rejected], ['{result="on_main_thread"}', hashStats.inline]]);
  const j = await jobCounts(o.pool);
  add('wfm_schedule_jobs', 'gauge', 'Schedule builds by state (-1: not known)', [['{state="queued"}', j.queued], ['{state="running"}', j.running]]);
  add('wfm_schedule_jobs_oldest_queued_seconds', 'gauge', 'How long the oldest queued build has waited', [['', j.oldest]]);
  add('wfm_gateway_sizing', 'gauge', 'Sizes chosen at start', Object.entries(sizing).map(([k, v]) => [`{name="${k}"}`, v] as [string, number]));
  add('wfm_gateway_info', 'gauge', 'Which kind of process this is', [[`{role="${o.role}"}`, 1]]);
  return lines.join('\n') + '\n';
}
