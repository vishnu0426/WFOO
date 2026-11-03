/**
 * Sizes that depend on the machine and on the rest of the deployment are worked out at start instead of being a number somebody has to guess:
 *   - database connections per process, from the database's own limit and how many gateway processes may run;
 *   - how many parts of one schedule build go to the engines at once, from how many engines there are.
 * Anything set in the environment wins. What was chosen, and why, is logged and shown at /metrics (wfm_gateway_sizing).
 */
import type { Pool } from 'pg';
import { sizing } from './metrics.ts';

/** Connections for one process: 80% of what the database allows once its reserved ones and 10 for other tools are taken off, shared by every process that may run
 *  (GATEWAY_MAX_REPLICAS web or all-in-one processes, plus one for jobs), kept between 4 and 50. */
export function poolSizeFor(maxConnections: number, reserved: number, usedByOthers: number, replicas: number): number {
  const room = Math.max(0, maxConnections - reserved - Math.max(10, usedByOthers)) * 0.8;
  return Math.max(4, Math.min(50, Math.floor(room / Math.max(1, replicas + 1))));
}

/** Parts of one build in flight: two solves fit in each engine at once, plus one waiting so an engine never sits idle between parts. Never fewer than 3. */
export function partParallelFor(engines: number): number { return Math.max(3, Math.max(1, engines) * 2 + 1); }

export async function autosizeDatabasePool(pool: Pool, explicit: boolean): Promise<void> {
  const cur = (pool as any).options?.max ?? 0;
  sizing.db_pool_max = cur;
  if (explicit) return;
  try {
    const r = await pool.query(`SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) AS used`);
    const { max, reserved, used } = r.rows[0];
    const replicas = Math.max(1, Number(process.env.GATEWAY_MAX_REPLICAS || 4));
    const n = poolSizeFor(max, reserved, used, replicas);
    (pool as any).options.max = n;
    sizing.db_pool_max = n; sizing.db_max_connections = max;
    console.log(`[autosize] database connections per process: ${n} (the database allows ${max}; up to ${replicas} gateway processes plus one for jobs; set DB_POOL_MAX to choose)`);
  } catch (e: any) { console.warn(`[autosize] could not read the database's connection limit (${e.message}); keeping ${cur}`); }
}
