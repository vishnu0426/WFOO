/**
 * A new queue borrowing the daily pattern of a similar queue, end to end: before, its forecast follows its own few flat days; after, it follows the
 * other queue's peak, while its own volume level stays its own.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/borrowShapeApi.test.ts
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
const clock = (s: number) => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`;

/** `days` days ending yesterday over 08:00 to 16:00; volume(slot) calls in each interval. */
function history(queue: string, days: number, volume: (slot: number) => number) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht,abandoned'];
  for (let n = days; n >= 1; n--) for (let s = 32; s < 64; s++) rows.push(`${queue},${iso(addDays(today, -n))},${clock(s)},${volume(s)},300,0`);
  return rows.join('\n');
}

let admin = '';
const ctx: Record<string, any> = {};

describe('borrowing the daily pattern of a similar queue', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });
  after(async () => { if (ctx.group) await call(admin, 'DELETE', `/config/groups/${ctx.group.id}`); });

  it('sets up a mature queue that peaks 08:00 to 09:00 and a new queue with ten flat days', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Shape ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20 }); assert.equal(g.status, 201, g.text); ctx.group = g.json;
    for (const [key, name] of [['old', `Mature ${RUN}`], ['fresh', `Fresh ${RUN}`], ['chat', `Chat ${RUN}`]] as const) {
      const q = await call(admin, 'POST', '/config/queues', { name, channel: key === 'chat' ? 'CHAT' : 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300, openSlot: 32, closeSlot: 64 }); assert.equal(q.status, 201, q.text);
      ctx[key] = q.json;
    }
    for (const [q, days, vol] of [[ctx.old, 70, (s: number) => (s < 36 ? 50 : 5)], [ctx.fresh, 10, () => 10]] as const) {
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: history(q.name, days, vol) }); assert.equal(up.status, 201, up.text);
      assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    }
  });

  const firstHourShare = async () => {
    const v = await call(admin, 'POST', '/forecast/versions', { groupId: ctx.group.id, kind: 'SHORT', weeks: 2, model: 'ets' });
    assert.equal(v.status, 201, v.text);
    const d = await call(admin, 'GET', `/forecast/versions/${v.json.id}/data?grain=15&queueId=${ctx.fresh.id}`);
    assert.equal(d.status, 200, d.text);
    const rows: any[] = Array.isArray(d.json) ? d.json : d.json.buckets ?? d.json.rows ?? d.json.data;
    assert.ok(rows?.length, d.text.slice(0, 300));
    const sum = (f: (s: number) => boolean) => rows.filter((r) => f(r.slot)).reduce((n, r) => n + r.volume, 0);
    const total = sum(() => true);
    return { share: sum((s) => s >= 32 && s < 36) / total, total };
  };

  it('before borrowing, the new queue follows its own flat days', async () => {
    ctx.before = await firstHourShare();
    assert.ok(ctx.before.share < 0.2, `an even day puts about an eighth in the first hour, got ${ctx.before.share}`);
  });

  it('refuses a queue to borrow from itself, from another channel, or a chain', async () => {
    assert.equal((await call(admin, 'PUT', `/config/queues/${ctx.fresh.id}`, { shapeFromQueueId: ctx.fresh.id })).status, 400);
    const other = await call(admin, 'PUT', `/config/queues/${ctx.fresh.id}`, { shapeFromQueueId: ctx.chat.id });
    assert.equal(other.status, 400); assert.match(other.json.message ?? other.text, /same channel/);
    assert.equal((await call(admin, 'PUT', `/config/queues/${ctx.fresh.id}`, { shapeFromQueueId: crypto.randomUUID() })).status, 404);
  });

  it('after borrowing, the new queue peaks in the first hour like the mature one, and keeps its own volume', async () => {
    const put = await call(admin, 'PUT', `/config/queues/${ctx.fresh.id}`, { shapeFromQueueId: ctx.old.id });
    assert.equal(put.status, 200, put.text); assert.equal(put.json.shapeFromQueueId, ctx.old.id);
    const after = await firstHourShare();
    assert.ok(after.share > 0.45, `the mature queue puts 200 of 360 calls (56%) in the first hour, got ${after.share}`);
    assert.ok(Math.abs(after.total - ctx.before.total) / ctx.before.total < 0.15, `the level stays its own: ${ctx.before.total} before, ${after.total} after`);
    assert.equal((await call(admin, 'PUT', `/config/queues/${ctx.old.id}`, { shapeFromQueueId: ctx.fresh.id })).status, 400, 'the donor cannot itself borrow from a queue that borrows from it');
  });

  it('says in the history check that it is borrowing, and how far it is from enough of its own', async () => {
    const r = await call(admin, 'GET', `/forecast/history-quality?groupId=${ctx.group.id}`);
    const q = r.json.queues.find((x: any) => x.queueId === ctx.fresh.id);
    assert.equal(q.shapeFromQueueId, ctx.old.id);
    assert.ok(q.findings.some((f: any) => f.code === 'BORROWED_SHAPE' && f.count === 10 && f.message.includes(ctx.old.name)), JSON.stringify(q.findings));
  });

  it('stops borrowing when cleared', async () => {
    const put = await call(admin, 'PUT', `/config/queues/${ctx.fresh.id}`, { shapeFromQueueId: null });
    assert.equal(put.status, 200); assert.equal(put.json.shapeFromQueueId, null);
    assert.ok((await firstHourShare()).share < 0.2);
  });
});
