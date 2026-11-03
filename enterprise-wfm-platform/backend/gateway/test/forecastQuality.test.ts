/**
 * Forecast data quality end to end: the history check finds gaps and stale data, and a queue that counts only answered calls gets its
 * abandoned callers added back into demand.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/forecastQuality.test.ts
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** 70 days ending yesterday, 08:00 to 16:00 (32 intervals) at 10 calls and 2 abandoned each, with `skip` days left out. */
function history(queue: string, skip: number[] = []) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht,abandoned'];
  for (let n = 70; n >= 1; n--) {
    if (skip.includes(n)) continue;
    const day = iso(addDays(today, -n));
    for (let s = 32; s < 64; s++) rows.push(`${queue},${day},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},10,300,2`);
  }
  return rows.join('\n');
}

let admin = '';
const ctx: Record<string, any> = {};
const NAME_A = `Gaps ${RUN}`, NAME_B = `Answered ${RUN}`;

describe('forecast data quality', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });
  after(async () => { for (const g of [ctx.gA, ctx.gB]) if (g) await call(admin, 'DELETE', `/config/groups/${g.id}`); });

  it('builds two groups, one queue each, with history', async () => {
    for (const [key, name, skip] of [['A', NAME_A, [30, 29]], ['B', NAME_B, []]] as const) {
      const g = await call(admin, 'POST', '/config/groups', { name, serviceLevelGoal: 80, serviceLevelThresholdSec: 20 }); assert.equal(g.status, 201, g.text);
      const q = await call(admin, 'POST', '/config/queues', { name: `Q ${name}`, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300, openSlot: 32, closeSlot: 64 }); assert.equal(q.status, 201, q.text);
      assert.equal(q.json.volumeBasis, 'OFFERED', 'every call that arrived is the default'); assert.equal(q.json.abandonRepeatPct, 0);
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: history(q.json.name, [...skip]) }); assert.equal(up.status, 201, up.text);
      assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
      ctx[`g${key}`] = g.json; ctx[`q${key}`] = q.json;
    }
  });

  it('finds the two days missing from the middle, and says the rest is fine', async () => {
    const r = await call(admin, 'GET', `/forecast/history-quality?groupId=${ctx.gA.id}`);
    assert.equal(r.status, 200, r.text);
    const q = r.json.queues[0];
    assert.equal(q.queueId, ctx.qA.id); assert.equal(q.days, 68);
    const f = q.findings.find((x: any) => x.code === 'MISSING_DAYS');
    assert.ok(f, JSON.stringify(q.findings)); assert.equal(f.count, 2); assert.equal(q.repairedDays, 2);
    assert.ok(!q.findings.some((x: any) => x.code === 'STALE' || x.code === 'SHORT' || x.code === 'PARTIAL_DAYS'), 'a queue open 08:00 to 16:00 with 32 intervals a day is complete');
    const clean = (await call(admin, 'GET', `/forecast/history-quality?groupId=${ctx.gB.id}`)).json.queues[0];
    assert.ok(!clean.findings.some((x: any) => x.code === 'MISSING_DAYS'));
    assert.equal(clean.abandonRatePct, 20, 'with every call counted, 2 of 10 abandoned');
  });

  it('changes what the history means, and refuses a value it does not know', async () => {
    assert.equal((await call(admin, 'PUT', `/config/queues/${ctx.qB.id}`, { volumeBasis: 'SOMETIMES' })).status, 400);
    assert.equal((await call(admin, 'PUT', `/config/queues/${ctx.qB.id}`, { abandonRepeatPct: 150 })).status, 400);
    const put = await call(admin, 'PUT', `/config/queues/${ctx.qB.id}`, { volumeBasis: 'ANSWERED', abandonRepeatPct: 0 });
    assert.equal(put.status, 200, put.text); assert.equal(put.json.volumeBasis, 'ANSWERED');
    const check = (await call(admin, 'GET', `/forecast/history-quality?groupId=${ctx.gB.id}`)).json.queues[0];
    assert.equal(check.volumeBasis, 'ANSWERED');
    assert.ok(!check.findings.some((x: any) => x.code === 'ABANDON_BASIS'), 'no longer suggests the setting that is already on');
  });

  it('has no accuracy trend until a published forecast has met actuals, and says so', async () => {
    const r = await call(admin, 'GET', `/forecast/accuracy-trend?groupId=${ctx.gB.id}&weeks=8`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total.status, 'NO_DATA'); assert.deepEqual(r.json.queues, []); assert.deepEqual(r.json.total.weeks, []);
    assert.equal(r.json.limits.good, 0.08); assert.equal(r.json.weekStart, 0);
    assert.equal((await call(admin, 'GET', `/forecast/accuracy-trend?groupId=${ctx.gB.id}&weeks=2`)).status, 400, 'fewer than 4 weeks is not a trend');
  });

  it('adds the abandoned callers back into the demand the forecast plans for', async () => {
    const day = async () => { const r = await call(admin, 'GET', `/forecast/preview?groupId=${ctx.gB.id}`); assert.equal(r.status, 200, r.text); assert.equal(r.json.ready, true, r.text); return r.json.day.volume as number; };
    await call(admin, 'PUT', `/config/queues/${ctx.qB.id}`, { volumeBasis: 'OFFERED' });
    const offered = await day();
    assert.equal(offered, 320, 'a typical day is 32 intervals of 10 calls');
    await call(admin, 'PUT', `/config/queues/${ctx.qB.id}`, { volumeBasis: 'ANSWERED', abandonRepeatPct: 0 });
    assert.equal(await day(), 384, '32 intervals of 10 answered plus 2 abandoned');
    await call(admin, 'PUT', `/config/queues/${ctx.qB.id}`, { abandonRepeatPct: 50 });
    assert.equal(await day(), 352, 'half of the abandoned callers ring again, so are already counted');
  });
});
