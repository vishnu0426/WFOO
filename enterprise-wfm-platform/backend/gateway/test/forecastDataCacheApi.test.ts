/**
 * The forecast dashboard's data, now worked out once per forecast revision and per queue and then served from the cache: the answers must still be the right ones. Needs a running gateway
 * and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/forecastDataCacheApi.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
function historyCsv(queue: string, days: number, scale: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 7 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * scale) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`);
    }
  }
  return rows.join('\n');
}

describe('forecast data cache', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', version: any, qBig: any, qSmall: any, day = '';
  const data = async (q = '') => (await call(admin, 'GET', `/forecast/versions/${version.id}/data?grain=60&from=${day}&to=${day}${q}`)).json;
  const total = (d: any) => d.buckets.reduce((a: number, b: any) => a + b.volume, 0);

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    const g = (await call(admin, 'POST', '/config/groups', { name: `FDC ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
    qBig = (await call(admin, 'POST', '/config/queues', { name: `Big ${RUN}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
    qSmall = (await call(admin, 'POST', '/config/queues', { name: `Small ${RUN}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
    for (const [q, scale] of [[qBig, 1], [qSmall, 0.2]] as const) {
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56, scale) });
      assert.equal(up.status, 201, up.text);
      assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    }
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 2, fromDay: iso(addDays(today, -1)) });
    assert.equal(f.status, 201, f.text); version = f.json; day = iso(today);
  });

  it('gives the same answer the second time, for the group and for a queue', async () => {
    for (const q of ['', `&queueId=${qBig.id}`, `&queueId=${qSmall.id}`]) {
      const a = await data(q), b = await data(q);
      assert.ok(a.buckets.length >= 20, 'a day of hourly buckets');
      assert.deepEqual(a.buckets, b.buckets, `repeat call for "${q || 'all queues'}"`);
    }
  });

  it('keeps each queue\'s numbers apart, and they add up to the group\'s', async () => {
    const all = await data(), big = await data(`&queueId=${qBig.id}`), small = await data(`&queueId=${qSmall.id}`);
    assert.ok(total(big) > total(small) * 2, `the big queue (${Math.round(total(big))}) is much bigger than the small one (${Math.round(total(small))})`);
    assert.ok(Math.abs(total(big) + total(small) - total(all)) <= 3, `the two queues (${Math.round(total(big) + total(small))}) add up to the group (${Math.round(total(all))})`);
    // asking for one after the other again must not hand back the other's cached answer
    assert.ok(total(await data(`&queueId=${qSmall.id}`)) < total(await data(`&queueId=${qBig.id}`)));
  });

  it('reflects a change to the forecast: a new revision is a new answer, for the group and for the queue that was changed', async () => {
    const beforeAll = total(await data()), beforeBig = total(await data(`&queueId=${qBig.id}`)), beforeSmall = total(await data(`&queueId=${qSmall.id}`));
    const adj = await call(admin, 'PATCH', `/forecast/versions/${version.id}/adjustments`, { mode: 'pct', value: 50, from: day, to: day, queueId: qBig.id, reason: 'cache test: +50% for a day' });
    assert.equal(adj.status, 200, adj.text);
    const afterBig = total(await data(`&queueId=${qBig.id}`)), afterAll = total(await data());
    assert.ok(afterBig > beforeBig * 1.4, `the adjusted queue grows (${Math.round(beforeBig)} to ${Math.round(afterBig)})`);
    assert.ok(afterAll > beforeAll * 1.3, `and so does the group (${Math.round(beforeAll)} to ${Math.round(afterAll)})`);
    assert.ok(Math.abs(total(await data(`&queueId=${qSmall.id}`)) - beforeSmall) <= 1, 'the other queue does not change');
  });
});
