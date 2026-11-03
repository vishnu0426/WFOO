/**
 * Data-feed connectors, webhooks and the other things that make the server call an address an administrator typed in must not reach internal addresses.
 * Run against a gateway started WITHOUT OUTBOUND_ALLOW / OUTBOUND_ALLOW_PRIVATE (the default):
 *   DATABASE_URL=... BASE_URL=http://localhost:4003 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/outboundGuard.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const RUN = Date.now().toString(36);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

describe('connectors and webhooks cannot be pointed at internal addresses', { skip: !process.env.ADMIN_PASSWORD || !process.env.DATABASE_URL }, () => {
  let admin = '';
  const sql = async (text: string, params: unknown[] = []) => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };
  const db = (host: string) => ({ category: 'DATABASE', preset: 'DATABASE_POSTGRES_PULL', name: `DB ${host} ${RUN}`, config: { host, port: '5432', database: 'd', username: 'u', password: 'p', query: 'SELECT 1' } });
  const rest = (baseUrl: string) => ({ category: 'ACD', preset: 'GENERIC_ACD_API', name: `REST ${baseUrl.length} ${RUN}`, config: { apiKey: 'k', baseUrl, volumeEndpoint: '/stats' } });
  const sftp = (host: string) => ({ category: 'SFTP', preset: 'GENERIC_SFTP', name: `SFTP ${host} ${RUN}`, config: { direction: 'they_host', host, port: '22', username: 'u', password: 'p', remotePath: '/in/*.csv' } });

  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('refuses to save a database, REST or SFTP connector that points at this server, its network or a metadata service', async () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '169.254.169.254', '10.0.0.5', '192.168.1.10', '172.16.4.4', '0.0.0.0']) {
      const d = await call(admin, 'POST', '/integrations', db(host));
      assert.equal(d.status, 400, `database ${host}: ${d.text.slice(0, 200)}`);
      assert.match(d.json.error.message, /not allowed|private network|this server/i);
      const s = await call(admin, 'POST', '/integrations', sftp(host));
      assert.equal(s.status, 400, `sftp ${host}`);
    }
    for (const url of ['http://127.0.0.1:5432', 'http://localhost:6379/', 'https://169.254.169.254/latest/meta-data/', 'http://10.1.2.3', 'http://[::1]:4222']) {
      const r = await call(admin, 'POST', '/integrations', rest(url));
      assert.equal(r.status, 400, `rest ${url}: ${r.text.slice(0, 200)}`);
    }
  });

  it('refuses the same when an existing connector is changed to it', async () => {
    const made = await call(admin, 'POST', '/integrations', db('db.example.com'));
    assert.equal(made.status, 201, made.text);
    const changed = await call(admin, 'PUT', `/integrations/${made.json.id ?? made.json.connector?.id}`, { config: db('127.0.0.1').config });
    assert.equal(changed.status, 400, changed.text);
  });

  it('accepts an address that is not yet known to this network (it may resolve later), and a public one', async () => {
    assert.equal((await call(admin, 'POST', '/integrations', db('feed-db.not-yet-created.invalid'))).status, 201);
    assert.equal((await call(admin, 'POST', '/integrations', rest('https://api.example.com'))).status, 201);
  });

  it('stops a connector that was saved earlier from calling an internal address when it runs, and does not say what is there', async () => {
    // saved before this rule existed: put the address straight into the table
    const made = await call(admin, 'POST', '/integrations', db('older.example.com'));
    assert.equal(made.status, 201, made.text);
    const conn = made.json.id ?? made.json.connector?.id;
    assert.equal((await call(admin, 'PUT', `/integrations/${conn}`, { status: 'ACTIVE' })).status, 200);
    await sql(`UPDATE integration_connectors SET config = jsonb_set(config, '{host}', '"127.0.0.1"') WHERE id = $1`, [conn]);
    await sql(`UPDATE integration_connectors SET config = jsonb_set(config, '{port}', '"5432"') WHERE id = $1`, [conn]);
    const run = await call(admin, 'POST', `/integrations/${conn}/run`, {});
    const text = JSON.stringify(run.json);
    assert.ok(!/ECONNREFUSED|ETIMEDOUT|password authentication|SCRAM|role |database ".*" does not exist/i.test(text), `nothing about the platform's own database comes back: ${text.slice(0, 300)}`);
    assert.match(text, /not allowed|this server|private network/i);
  });

  it('refuses a webhook to an internal address, a metadata service or a name that points there', async () => {
    for (const url of ['http://127.0.0.1:4222/', 'http://169.254.169.254/latest/', 'http://10.0.0.1/hook', 'http://localhost:6379/', 'http://[::1]/x']) {
      const r = await call(admin, 'POST', '/developer/webhooks', { name: `Hook ${RUN}`, url, events: ['schedule.published'], active: true });
      assert.equal(r.status, 400, `${url}: ${r.text.slice(0, 160)}`);
    }
    const ok = await call(admin, 'POST', '/developer/webhooks', { name: `Hook ok ${RUN}`, url: 'https://hooks.example.com/in', events: ['schedule.published'], active: true });
    assert.equal(ok.status, 201, ok.text);
  });
});
