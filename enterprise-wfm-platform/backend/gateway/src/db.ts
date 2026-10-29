/**
 * PostgreSQL access with tenant isolation.
 *
 * Every tenant table carries tenant_id and has row-level security (RLS) applied by the migrator. Each request runs in a
 * transaction that switches to the non-bypass role `wfm_app` and sets `app.tenant_id`, so a query that forgets its own
 * tenant filter still cannot see another tenant's rows. Queries also filter explicitly (`tenant_id = :t`) as defence in depth,
 * and that keeps behaviour correct on a database where the role could not be created (a warning is logged in that case).
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.ts';

pg.types.setTypeParser(1082, (v) => v);                 // DATE stays 'YYYY-MM-DD' (no time-zone shifting)
pg.types.setTypeParser(1700, (v) => parseFloat(v));     // NUMERIC -> number
pg.types.setTypeParser(20, (v) => parseInt(v, 10));     // BIGINT (counts) -> number

export const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c search_path=wfm,public', max: 12 });
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

export type Row = Record<string, any>;

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** Column names only (snake_case -> camelCase). JSONB values are returned untouched. */
export const camelize = <T = Row>(row: Row): T => {
  const out: Row = {};
  for (const k of Object.keys(row)) out[camel(k)] = row[k];
  return out as T;
};

let rlsRole = false;
export const isRlsEnforced = () => rlsRole;

/** `:t` and `:w` as whole tokens, so casts such as ::text or ::timestamp are never mistaken for them. */
const TENANT_PLACEHOLDER = /(?<!:):t\b/;
const TENANT_PLACEHOLDER_ALL = /(?<!:):t\b/g;
const WORKSPACE_PLACEHOLDER = /(?<!:):w\b/;
const WORKSPACE_PLACEHOLDER_ALL = /(?<!:):w\b/g;

export interface Scope { tenantId: string; orgId: string; workspaceId: string }
export const scopeStore = new AsyncLocalStorage<Scope>();
export const currentScope = (): Scope | undefined => scopeStore.getStore();
/** Run async work under a tenant/workspace scope without opening a transaction. */
export const withScope = <T>(tenantId: string, workspaceId: string, fn: () => T): T =>
  scopeStore.run({ tenantId, orgId: tenantId, workspaceId }, fn);

export class Tx {
  constructor(readonly client: pg.PoolClient, readonly tenantId: string, readonly workspaceId: string) {}

  private bind(text: string, params: unknown[]): { sql: string; params: unknown[] } {
    let sql = text;
    const p = [...params];
    if (TENANT_PLACEHOLDER.test(sql)) { p.push(this.tenantId); sql = sql.replace(TENANT_PLACEHOLDER_ALL, `$${p.length}`); }
    if (WORKSPACE_PLACEHOLDER.test(sql)) { p.push(this.workspaceId); sql = sql.replace(WORKSPACE_PLACEHOLDER_ALL, `$${p.length}`); }
    return { sql, params: p };
  }

  /** `:t` is the tenant/organisation id and `:w` the active workspace id. */
  async q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
    const b = this.bind(text, params);
    const res = await this.client.query(b.sql, b.params);
    return res.rows.map((r) => camelize<T>(r));
  }
  async one<T = Row>(text: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.q<T>(text, params))[0];
  }
  async exec(text: string, params: unknown[] = []): Promise<number> {
    const b = this.bind(text, params);
    return (await this.client.query(b.sql, b.params)).rowCount ?? 0;
  }
}

async function defaultWorkspaceId(client: pg.PoolClient, tenantId: string): Promise<string> {
  const r = await client.query('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND is_default LIMIT 1', [tenantId]);
  return r.rows[0]?.id ?? '';
}

async function runScoped<T>(tenantId: string, workspaceId: string | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const active = scopeStore.getStore();
  const explicit = workspaceId ?? (active?.tenantId === tenantId ? active.workspaceId : undefined);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    // Resolve the default workspace before switching to the non-bypass role: the lookup only needs app.tenant_id.
    const ws = explicit || await defaultWorkspaceId(client, tenantId);
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
    if (rlsRole) await client.query('SET LOCAL ROLE wfm_app');
    const scope = { tenantId, orgId: tenantId, workspaceId: ws };
    const out = await scopeStore.run(scope, () => fn(new Tx(client, tenantId, ws)));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Run `fn` inside one transaction scoped to a tenant, using the active workspace when called inside a request. */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runScoped(tenantId, undefined, fn);
}

/** Run `fn` inside one transaction scoped to an explicit tenant + workspace. */
export async function withWorkspace<T>(tenantId: string, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runScoped(tenantId, workspaceId, fn);
}

/** Resolve a tenant's default workspace (used for old tokens and system jobs). */
export async function resolveDefaultWorkspaceId(tenantId: string): Promise<string> {
  return runScoped(tenantId, undefined, async (tx) => tx.workspaceId);
}

/** Tenant-less query (tenants table, migrations, health). Never use for tenant data. */
export async function raw<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows.map((r) => camelize<T>(r));
}

// ---------------------------------------------------------------- migrations + RLS

export async function migrate(): Promise<void> {
  await pool.query('CREATE SCHEMA IF NOT EXISTS wfm');
  await pool.query('CREATE TABLE IF NOT EXISTS wfm.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM wfm.schema_migrations')).rows.map((r) => r.name));
  const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(config.migrationsDir, f), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL search_path = wfm, public');
      await c.query(sql);
      await c.query('INSERT INTO wfm.schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log(`[db] applied migration ${f}`);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  await applyRowLevelSecurity();
}

async function applyRowLevelSecurity(): Promise<void> {
  // 1) the non-bypass role the app switches to per request
  try {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wfm_app') THEN CREATE ROLE wfm_app NOLOGIN; END IF; END $$`);
    await pool.query('GRANT wfm_app TO CURRENT_USER');
  } catch (e) {
    console.warn(`[db] WARNING could not create/grant role wfm_app (${(e as Error).message}). Row-level security will NOT be enforced by the database; the app still filters every query by tenant.`);
  }
  const ok = (await pool.query(`SELECT pg_has_role(current_user, 'wfm_app', 'MEMBER') AS ok`).catch(() => ({ rows: [{ ok: false }] }))).rows[0].ok as boolean;
  if (!ok) { rlsRole = false; return; }
  // 2) privileges + RLS on every table that has a tenant_id column
  await pool.query('GRANT USAGE ON SCHEMA wfm TO wfm_app');
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA wfm TO wfm_app');
  await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA wfm TO wfm_app');
  const tables = (await pool.query(
    `SELECT c.table_name,
            bool_or(c.column_name = 'workspace_id') AS workspace_scoped
     FROM information_schema.columns c
     WHERE c.table_schema = 'wfm' AND c.column_name IN ('tenant_id', 'workspace_id')
     GROUP BY c.table_name
     HAVING bool_or(c.column_name = 'tenant_id')
     ORDER BY c.table_name`)).rows as { table_name: string; workspace_scoped: boolean }[];
  // Membership is intentionally tenant-wide so a user can discover and switch between all their workspaces.
  const TENANT_ONLY = new Set(['users', 'role_permissions', 'workspaces', 'workspace_members', 'organization_settings', 'licenses', 'license_modules', 'license_capacity_requests']);
  for (const t of tables) {
    const tenant = `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    const workspace = t.workspace_scoped && !TENANT_ONLY.has(t.table_name)
      ? ` AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid`
      : '';
    await pool.query(`ALTER TABLE wfm."${t.table_name}" ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE wfm."${t.table_name}" FORCE ROW LEVEL SECURITY`);
    await pool.query(`DROP POLICY IF EXISTS tenant_isolation ON wfm."${t.table_name}"`);
    await pool.query(`CREATE POLICY tenant_isolation ON wfm."${t.table_name}" USING (${tenant}${workspace}) WITH CHECK (${tenant}${workspace})`);
  }
  rlsRole = true;
  console.log(`[db] row-level security enforced on ${tables.length} tables (role wfm_app)`);
}
