/**
 * The history check through the API: how old the newest data may be is a setting on the group, and each finding comes back with its kind and advice. Needs a running gateway:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/historyStaleApi.test.ts
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
/** 40 days of one quiet interval a day, the newest `endAgo` days before today. */
function csv(queue: string, days: number, endAgo: number) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = endAgo + days - 1; n >= endAgo; n--) for (let s = 32; s < 80; s++) rows.push(`${queue},${iso(addDays(today, -n))},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${20 + (n % 5)},280`);
  return rows.join('\n');
}

let token = '', groupId = '', queueName = '';
before(async () => {
  token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
  const g = (await call(token, 'POST', '/config/groups', { name: `HSA ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
  groupId = g.id;
  queueName = `HSA Q ${RUN}`;
  const q = (await call(token, 'POST', '/config/queues', { name: queueName, channel: 'VOICE', wfmGroupId: groupId, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.name, 60, 6) });      // newest data 6 days old
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
});
const quality = async () => (await call(token, 'GET', `/forecast/history-quality?groupId=${groupId}`)).json;

describe('how old the newest data may be', () => {
  it('starts at three days, so six-day-old data is a caution', async () => {
    const g = (await call(token, 'GET', `/config/groups/${groupId}`)).json;
    assert.equal(g.historyStaleDays, 3);
    const r = await quality();
    assert.equal(r.staleAfterDays, 3);
    const stale = r.queues[0].findings.find((f: any) => f.code === 'STALE');
    assert.ok(stale); assert.equal(stale.kind, 'CAUTION'); assert.equal(stale.fix.action, 'IMPORT'); assert.equal(r.queues[0].freshness.daysBehind, 6);
  });
  it('can be raised for a group that imports weekly, and the caution goes', async () => {
    const put = await call(token, 'PUT', `/config/groups/${groupId}`, { historyStaleDays: 8 });
    assert.equal(put.status, 200); assert.equal(put.json.historyStaleDays, 8);
    const r = await quality();
    assert.equal(r.staleAfterDays, 8); assert.ok(!r.queues[0].findings.some((f: any) => f.code === 'STALE')); assert.equal(r.queues[0].freshness.level, 'CURRENT');
  });
  it('is kept when other group settings change', async () => {
    await call(token, 'PUT', `/config/groups/${groupId}`, { description: 'changed' });
    assert.equal((await call(token, 'GET', `/config/groups/${groupId}`)).json.historyStaleDays, 8);
  });
  it('refuses a number outside 1 to 60', async () => {
    assert.equal((await call(token, 'PUT', `/config/groups/${groupId}`, { historyStaleDays: 0 })).status, 400);
    assert.equal((await call(token, 'PUT', `/config/groups/${groupId}`, { historyStaleDays: 61 })).status, 400);
  });
});

describe('every finding comes with advice', () => {
  it('a kind, a short title, what it means, and a fix or none', async () => {
    await call(token, 'PUT', `/config/groups/${groupId}`, { historyStaleDays: 3 });
    const r = await quality();
    for (const f of r.queues[0].findings) { assert.ok(['BLOCK', 'CAUTION', 'TIP'].includes(f.kind)); assert.ok(f.title); assert.equal(typeof f.effect, 'string'); assert.ok(f.fix === null || f.fix.action); }
    assert.equal(r.queues[0].length.days, 60);
  });
});
