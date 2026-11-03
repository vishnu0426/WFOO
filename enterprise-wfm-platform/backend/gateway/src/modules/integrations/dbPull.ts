/**
 * Reads interval rows straight from a customer's PostgreSQL database. The admin writes one SELECT; we run it inside a read-only
 * transaction with a time limit and a row cap, so even a login with write rights cannot change anything through this path.
 * Other database engines are not read from here: they go through the relay, which runs inside the customer's network.
 */
import pg from 'pg';
import net from 'node:net';
import { resolveSafe } from '../../netGuard.ts';
import { MAX_DB_ROWS, prepareQuery } from './pullRules.ts';

/** The few things we use from a database client, so tests can supply a fake instead of a server. */
export interface DbClientLike {
  connect(): Promise<unknown>;
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; fields?: { name: string }[] }>;
  end(): Promise<unknown>;
}

export async function readPostgres(
  config: Record<string, any>, from: string, to: string, limit = MAX_DB_ROWS, client?: DbClientLike,
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  const { text, params } = prepareQuery(config.query, from, to, limit);
  const host = String(config.host ?? '').trim(), port = Number(config.port) || 5432;
  if (!host || !config.database || !config.username) throw new Error('The connector needs a host, a database name and a username.');
  // the connection goes to an address that was checked (never this server's own network unless an administrator listed it: see netGuard.ts), not to whatever the name answers later
  const target = client ? null : await resolveSafe(host);
  const db: DbClientLike = client ?? new pg.Client({
    host: target!.address, port, database: String(config.database), user: String(config.username), password: String(config.password ?? ''),
    ssl: config.ssl === 'require' ? { rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host } : false,
    connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000, application_name: 'wfm-connector',
  });
  try { await db.connect(); } catch (e: any) { throw new Error(`Could not connect to ${host}:${port}: ${e.message}`); }
  try {
    await db.query('BEGIN READ ONLY');
    let res;
    try { res = await db.query(text, params); }
    catch (e: any) { throw new Error(`The database rejected the query: ${e.message}`); }
    finally { await db.query('ROLLBACK').catch(() => {}); }
    if (res.rows.length > limit) throw new Error(`More than ${limit.toLocaleString()} rows came back. Narrow the query, or load fewer weeks of history.`);
    return { rows: res.rows, columns: (res.fields ?? []).map((f) => f.name) };
  } finally { await db.end().catch(() => {}); }
}
