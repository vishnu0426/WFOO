/**
 * Pushed hard, the gateway keeps answering, shows the strain at /metrics, and nothing fails with a server error.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/overload.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const get = (path: string, token?: string) => fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('overload and metrics', { skip: !PASSWORD }, () => {
  let admin = '';
  before(async () => {
    const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: PASSWORD, tenant: TENANT }) });
    admin = ((await r.json()) as any).token;
  });

  it('serves metrics in the Prometheus text format, with the numbers an autoscaler needs', async () => {
    const r = await get('/metrics');
    assert.equal(r.status, 200);
    const text = await r.text();
    for (const name of ['wfm_gateway_event_loop_delay_seconds', 'wfm_gateway_http_in_flight', 'wfm_gateway_http_requests_total', 'wfm_gateway_db_pool_connections', 'wfm_gateway_engine_busy_total',
      'wfm_gateway_engine_busy_wait_seconds_total', 'wfm_schedule_jobs{state="queued"}', 'wfm_schedule_jobs_oldest_queued_seconds', 'wfm_gateway_sizing{name="db_pool_max"}', 'wfm_gateway_memory_bytes']) {
      assert.ok(text.includes(name), `${name} is reported`);
    }
    for (const line of text.trim().split('\n')) assert.ok(line.startsWith('#') || /^[a-z_]+(\{[^}]*\})? -?[0-9.e+-]+$/.test(line), `valid line: ${line}`);
  });

  it('keeps every request answered while hundreds are made at once, and says so in the metrics', async () => {
    const paths = ['/api/v1/config/groups', '/api/v1/config/queues', '/api/v1/workforce/teams', '/api/v1/data/coverage', '/api/v1/config/groups/summary'];
    const before = await (await get('/metrics')).text();
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => get(paths[i % paths.length], admin).then(async (r) => { await r.arrayBuffer(); return r.status; })));
    const sec = (Date.now() - t0) / 1000;
    const bad = results.filter((s) => s >= 500);
    assert.equal(bad.length, 0, `${bad.length} of 300 failed with a server error`);
    assert.ok(sec < 60, `300 requests took ${sec.toFixed(1)} s`);
    const after = await (await get('/metrics')).text();
    const total = (t: string) => Number((/wfm_gateway_http_requests_total\{class="2xx"\} (\d+)/.exec(t) ?? [])[1] ?? 0);
    assert.ok(total(after) - total(before) >= 300, 'the requests were counted');
    const pool = /wfm_gateway_db_pool_connections\{state="max"\} (\d+)/.exec(after);
    assert.ok(pool && Number(pool[1]) >= 4, 'the connection limit is reported');
    const idle = await get('/health'); assert.equal(idle.status, 200, 'and it is still healthy afterwards');
  });

  it('answers a cheap call quickly even while others are in flight', async () => {
    const heavy = Array.from({ length: 60 }, () => get('/api/v1/data/coverage', admin).then((r) => r.arrayBuffer()));
    const t0 = Date.now(); const r = await get('/health'); const ms = Date.now() - t0;
    await Promise.all(heavy);
    assert.equal(r.status, 200); assert.ok(ms < 3000, `health took ${ms} ms under load`);
  });
});
