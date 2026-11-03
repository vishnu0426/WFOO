/**
 * The daily rollup of interval history (migration 057): it must equal what the interval rows say however they got there, and the coverage screens must read it.
 *   DATABASE_URL=... BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/intervalRollup.test.ts
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

describe('interval history daily rollup', { skip: !process.env.ADMIN_PASSWORD || !process.env.DATABASE_URL }, () => {
  let admin = ''; let tenantId = ''; let groupId = '';
  const q: Record<string, string> = {};
  const sql = async (text: string, params: unknown[] = []) => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  /** rows that differ between the rollup and a fresh aggregate of the intervals, either way round */
  const mismatches = async () => (await sql(
    `SELECT count(*)::int AS n FROM (
       (SELECT queue_id, day, count(*)::int AS i, sum(volume)::bigint AS v, sum(coalesce(abandoned, 0))::bigint AS a FROM interval_history WHERE tenant_id = $1 GROUP BY queue_id, day
        EXCEPT SELECT queue_id, day, intervals, volume, abandoned FROM interval_daily WHERE tenant_id = $1)
       UNION ALL
       (SELECT queue_id, day, intervals, volume, abandoned FROM interval_daily WHERE tenant_id = $1
        EXCEPT SELECT queue_id, day, count(*)::int, sum(volume)::bigint, sum(coalesce(abandoned, 0))::bigint FROM interval_history WHERE tenant_id = $1 GROUP BY queue_id, day)) x`, [tenantId]))[0].n;
  const coverage = async (name: string) => (await call(admin, 'GET', '/data/coverage')).json.find((c: any) => c.name === name);

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT })).json.token;
    tenantId = (await sql('SELECT id FROM tenants LIMIT 1'))[0].id;
    const g = await call(admin, 'POST', '/config/groups', { name: `Roll ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
    groupId = g.json.id;
    for (const n of ['A', 'B', 'C']) { const r = await call(admin, 'POST', '/config/queues', { name: `Roll ${n} ${RUN}`, channel: 'VOICE', ahtDefault: 300, wfmGroupId: groupId }); assert.equal(r.status, 201, r.text); q[n] = r.json.id; }
  });

  it('is exact after rows are added, changed, moved and removed in bulk', async () => {
    await sql(`INSERT INTO interval_history (tenant_id, queue_id, day, slot, starts_at, volume, aht_sec, abandoned) SELECT $1, $2, ($3::date - d), s, now(), 10 + s, 300, s % 5 FROM generate_series(1, 5) d, generate_series(0, 95) s`, [tenantId, q.A, day(0)]);
    assert.equal(await mismatches(), 0, 'after an insert');
    await sql(`INSERT INTO interval_history (tenant_id, queue_id, day, slot, starts_at, volume, aht_sec) SELECT $1, $2, ($3::date - 1), s, now(), 99, 300 FROM generate_series(0, 99 - 4) s WHERE s < 96
               ON CONFLICT (queue_id, day, slot) DO UPDATE SET volume = EXCLUDED.volume`, [tenantId, q.A, day(0)]);
    assert.equal(await mismatches(), 0, 'after an upsert that changed rows');
    await sql('UPDATE interval_history SET volume = volume + 5, abandoned = abandoned + 2 WHERE queue_id = $1 AND slot < 10', [q.A]);
    assert.equal(await mismatches(), 0, 'after an update');
    await sql(`UPDATE interval_history SET day = day - 40 WHERE queue_id = $1 AND day = $2::date - 2`, [q.A, day(0)]);   // a whole day moved elsewhere
    assert.equal(await mismatches(), 0, 'after rows moved to another day');
    await sql('DELETE FROM interval_history WHERE queue_id = $1 AND slot >= 90', [q.A]);
    assert.equal(await mismatches(), 0, 'after a delete');
    await sql('DELETE FROM interval_history WHERE queue_id = $1 AND day = $2::date - 3', [q.A, day(0)]);
    assert.equal(await mismatches(), 0, 'after a whole day was deleted');
    assert.equal((await sql('SELECT count(*)::int AS n FROM interval_daily WHERE queue_id = $1 AND day = $2::date - 3', [q.A, day(0)]))[0].n, 0, 'an empty day leaves no row behind');
  });

  it('follows the live feed and a file import, and its rollback', async () => {
    const name = `Roll B ${RUN}`;
    const live = await call(admin, 'POST', '/data/ingest', { rows: [{ queue: name, day: day(1), slot: 4, volume: 7 }, { queue: name, day: day(1), slot: 5, volume: 8 }, { queue: name, day: day(2), slot: 4, volume: 9 }] });
    assert.equal(live.json.accepted, 3, live.text); assert.equal(await mismatches(), 0, 'after live rows');
    await call(admin, 'POST', '/data/ingest', { rows: [{ queue: name, day: day(1), slot: 4, volume: 70 }] });
    assert.equal(await mismatches(), 0, 'after the live feed replaced an interval');
    const rows = ['queue,date,interval,volume,aht']; for (let i = 0; i < 8; i++) rows.push(`${name},${day(10)},${String(Math.floor(i / 4) + 9).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')},${5 + i},300`);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: `roll-${RUN}.csv`, csv: rows.join('\n') });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`, {})).status, 200);
    assert.equal(await mismatches(), 0, 'after an import was committed');
    const rb = await call(admin, 'POST', `/data/imports/${up.json.id}/rollback`, { reason: 'checking the rollup' });
    assert.equal(rb.status, 200, rb.text); assert.equal(await mismatches(), 0, 'after the import was rolled back');
  });

  it('is what the coverage and quality screens report', async () => {
    const name = `Roll A ${RUN}`;
    const direct = (await sql(`SELECT min(day)::text AS first_day, max(day)::text AS last_day, count(DISTINCT day)::int AS days, count(*)::int AS intervals FROM interval_history WHERE queue_id = $1`, [q.A]))[0];
    const c = await coverage(name);
    assert.equal(c.firstDay, direct.first_day); assert.equal(c.lastDay, direct.last_day); assert.equal(c.days, direct.days); assert.equal(c.intervals, direct.intervals);
    assert.equal(c.missingIntervals, Math.max(0, direct.days * 96 - direct.intervals));
    assert.ok(c.missingIntervals > 0, 'this queue has gaps (the rows were trimmed above)');
    const issues = (await call(admin, 'GET', '/data/quality')).json;
    assert.ok(issues.some((i: any) => i.id === `gaps-${q.A}`), 'the gap shows up as an issue');
    assert.ok(issues.some((i: any) => i.id === `nohist-${q.C}`), 'a queue with no history is told so');
  });

  it('stays quick however much history there is', async () => {
    // about 290,000 intervals for one queue (three years of days): the coverage answer must not depend on reading them
    await sql(`INSERT INTO interval_history (tenant_id, queue_id, day, slot, starts_at, volume, aht_sec) SELECT $1, $2, ($3::date - d), s, now(), 5, 300 FROM generate_series(100, 1100) d, generate_series(0, 95) s ON CONFLICT DO NOTHING`, [tenantId, q.C, day(0)]);
    assert.equal(await mismatches(), 0, 'after a large insert');
    const times: number[] = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); const r = await call(admin, 'GET', '/data/coverage'); assert.equal(r.status, 200); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    const c = await coverage(`Roll C ${RUN}`);
    assert.equal(c.days, 1001); assert.equal(c.missingIntervals, 0);
    // with the rollup this does not grow with the number of intervals; reading them all took well over a second here
    assert.ok(times[2] < 400, `coverage took ${Math.round(times[2])} ms (median of 5)`);
  });

  it('goes with the queue when a queue is deleted', async () => {
    assert.equal((await call(admin, 'DELETE', `/config/queues/${q.C}`)).status, 409, 'a queue with history asks for confirmation');
    assert.equal((await call(admin, 'DELETE', `/config/queues/${q.C}?force=true`)).status, 200);
    assert.equal((await sql('SELECT count(*)::int AS n FROM interval_daily WHERE queue_id = $1', [q.C]))[0].n, 0);
    assert.equal(await mismatches(), 0);
  });
});
