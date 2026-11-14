/**
 * Which groups can be pooled on a day, through the API: only groups with a published short-term forecast covering it are ready, and pairs that already share people are named.
 * Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/poolingApi.test.ts
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
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
function csv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round((curve[Math.floor(s / 4)] * f * 0.5) / 4 + (n % 3)))},${270 + (s % 5) * 10}`);
  }
  return rows.join('\n');
}

let token = '', siteId = '';
const ids: Record<string, string> = {};
const tomorrow = iso(addDays(today, 1));
async function group(key: string, withForecast: boolean, site: string | null) {
  const g = (await call(token, 'POST', '/config/groups', { name: `POOL${key} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88, ...(site ? { siteId: site } : {}) })).json;
  ids[key] = g.id;
  const q = (await call(token, 'POST', '/config/queues', { name: `POOL${key} Q ${RUN}`, channel: key === 'B' ? 'CHAT' : 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  if (withForecast) {
    const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.name, 60) });
    await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
    const v = (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 2, fromDay: iso(today) })).json;
    for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v.id}/${s}`, {});
  }
}
before(async () => {
  token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
  const s = await call(token, 'POST', '/config/sites', { name: `Pool site ${RUN}`, timezone: 'UTC' });
  siteId = s.json.id;
  await group('A', true, siteId); await group('B', true, siteId); await group('C', false, null);
  const e = await call(token, 'POST', '/workforce/employees', { employeeNumber: `POOL${RUN}-1`, firstName: 'Pool', lastName: `Run${RUN}`, primaryGroupId: ids.A, eligibleGroupIds: [ids.A, ids.B], weeklyContractHours: 40, maxWeeklyHours: 40 });
  assert.equal(e.status, 201, e.text);
});
const candidates = async (day = tomorrow) => (await call(token, 'GET', `/forecast/pooling/candidates?day=${day}`)).json;
const mine = (r: any) => (r.groups as any[]).filter((g) => g.name.includes(RUN));

describe('which groups can be pooled on a day', () => {
  it('only those with a published short-term forecast covering it are ready, with the forecast named', async () => {
    const g = mine(await candidates());
    const by = Object.fromEntries(g.map((x: any) => [x.name.slice(4, 5), x]));
    assert.equal(by.A.ready, true); assert.equal(by.B.ready, true); assert.equal(by.C.ready, false); assert.ok(by.A.forecastName); assert.equal(by.C.forecastName, null);
  });
  it('carries the site, the channels and the people for the picker', async () => {
    const by = Object.fromEntries(mine(await candidates()).map((x: any) => [x.name.slice(4, 5), x]));
    assert.equal(by.A.siteId, siteId); assert.match(by.A.siteName, /^Pool site/); assert.deepEqual(by.A.channels, ['VOICE']); assert.deepEqual(by.B.channels, ['CHAT']); assert.equal(by.A.people, 1); assert.equal(by.C.siteId, null);
  });
  it('a day the forecast does not cover makes nothing ready', async () => {
    const far = iso(addDays(today, 200));
    assert.ok(mine(await candidates(far)).every((g: any) => !g.ready));
  });
  it('names the pair that already shares people', async () => {
    const r = await candidates();
    const pair = (r.sharedPairs as any[]).find((p) => [p.a, p.b].sort().join() === [ids.A, ids.B].sort().join());
    assert.ok(pair, JSON.stringify(r.sharedPairs.slice(0, 3))); assert.equal(pair.people, 1);
  });
  it('refuses a day that is not a date', async () => assert.equal((await call(token, 'GET', '/forecast/pooling/candidates?day=soon')).status, 400));
});

describe('the comparison itself', () => {
  it('still works for two ready groups, and says why for one that is not ready', async () => {
    const ok = await call(token, 'GET', `/forecast/pooling?groupIds=${ids.A},${ids.B}&day=${tomorrow}`);
    assert.equal(ok.status, 200); assert.ok(ok.json.separateHours > 0); assert.equal(ok.json.groups.length, 2);
    const no = await call(token, 'GET', `/forecast/pooling?groupIds=${ids.A},${ids.C}&day=${tomorrow}`);
    assert.equal(no.status, 400); assert.match(no.json.error.message, /no published short-term forecast/);
  });
});
