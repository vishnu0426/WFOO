/**
 * What-if scenarios through the API: the baseline on its own, handle time in seconds, and a staffing cost from the group's cost per hour. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/scenariosApi.test.ts
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
/** `days` of history with a daytime shape and a weekend dip, the newest `endAgo` days before today. */
function csv(queue: string, days: number, endAgo: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = endAgo + days - 1; n >= endAgo; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round((curve[Math.floor(s / 4)] * f * 0.5) / 4 + (n % 3)))},${270 + (s % 5) * 10}`);
  }
  return rows.join('\n');
}

let token = '', groupId = '', versionId = '';
before(async () => {
  token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
  groupId = (await call(token, 'POST', '/config/groups', { name: `SCN ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json.id;
  const q = (await call(token, 'POST', '/config/queues', { name: `SCN Q ${RUN}`, channel: 'VOICE', wfmGroupId: groupId, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.name, 60, 1) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  versionId = (await call(token, 'POST', '/forecast/versions', { groupId, kind: 'SHORT', weeks: 2 })).json.id;
  assert.ok(versionId, 'a forecast to compare');
});
const compare = async (scenarios: unknown[]) => (await call(token, 'POST', `/forecast/versions/${versionId}/scenarios/compare`, { scenarios })).json;

describe('scenarios against the baseline', () => {
  it('with no scenarios it still answers with the baseline, so the screen is never empty', async () => {
    const r = await compare([]);
    assert.equal(r.results.length, 1); assert.equal(r.results[0].name, 'Baseline'); assert.ok(r.results[0].fte > 0); assert.equal(r.costPerHour, null); assert.equal(r.results[0].cost, null);
  });
  it('more volume needs more agents, and the change against the baseline is worked out', async () => {
    const r = await compare([{ name: 'Volume +10%', params: { volumePct: 10 } }]);
    assert.ok(r.results[1].fte > r.results[0].fte);
    assert.ok(Math.abs(r.results[1].impactRequiredFteDelta - (r.results[1].fte - r.results[0].fte)) < 0.011);
  });
  it('+15 seconds of handle time is the same as the matching percentage of the average', async () => {
    const a = await compare([{ name: 'sec', params: { ahtAddSec: 15 } }]);
    const b = await compare([{ name: 'pct', params: { ahtPct: (15 / a.avgAhtSec) * 100 } }]);
    assert.ok(a.results[1].fte > a.results[0].fte);
    assert.ok(Math.abs(a.results[1].fte - b.results[1].fte) < 0.01, `${a.results[1].fte} vs ${b.results[1].fte}`);
    assert.deepEqual(a.results[1].params, { ahtAddSec: 15 }, 'the answer echoes what was asked');
  });
  it('refuses handle time outside 600 seconds either way, and more than five scenarios', async () => {
    assert.equal((await call(token, 'POST', `/forecast/versions/${versionId}/scenarios/compare`, { scenarios: [{ name: 'x', params: { ahtAddSec: 700 } }] })).status, 400);
    assert.equal((await call(token, 'POST', `/forecast/versions/${versionId}/scenarios/compare`, { scenarios: Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, params: {} })) })).status, 400);
  });
});

describe('the cost of a scenario', () => {
  it('is the agent hours times the group cost per hour, once that is set', async () => {
    const put = await call(token, 'PUT', `/config/groups/${groupId}`, { agentCostPerHour: 30 });
    assert.equal(put.status, 200); assert.equal(put.json.agentCostPerHour, 30);
    const r = await compare([{ name: 'Volume +10%', params: { volumePct: 10 } }]);
    assert.equal(r.costPerHour, 30); assert.equal(r.currency.length, 3);
    assert.ok(Math.abs(r.results[0].cost - r.results[0].agentHours * 30) < 0.02);
    assert.ok(r.results[1].impactCostDelta > 0); assert.ok(Math.abs(r.results[1].impactCostDelta - (r.results[1].cost - r.results[0].cost)) < 0.02);
  });
  it('other group changes keep it, and null clears it', async () => {
    await call(token, 'PUT', `/config/groups/${groupId}`, { description: 'x' });
    assert.equal((await call(token, 'GET', `/config/groups/${groupId}`)).json.agentCostPerHour, 30);
    assert.equal((await call(token, 'PUT', `/config/groups/${groupId}`, { agentCostPerHour: null })).json.agentCostPerHour, null);
    assert.equal((await compare([])).costPerHour, null);
  });
  it('refuses a negative cost', async () => assert.equal((await call(token, 'PUT', `/config/groups/${groupId}`, { agentCostPerHour: -1 })).status, 400));
});
