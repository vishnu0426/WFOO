/**
 * The Staffing page's numbers through the API: the shrinkage staffing really uses (and where it comes from), and the people there are to set the need against. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/capacityApi.test.ts
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
function csv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round((curve[Math.floor(s / 4)] * f * 0.5) / 4 + (n % 3)))},${270 + (s % 5) * 10}`);
  }
  return rows.join('\n');
}

let token = '', groupId = '', versionId = '';
before(async () => {
  token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
  groupId = (await call(token, 'POST', '/config/groups', { name: `CAP ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 })).json.id;
  const q = (await call(token, 'POST', '/config/queues', { name: `CAP Q ${RUN}`, channel: 'VOICE', wfmGroupId: groupId, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.name, 60) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  versionId = (await call(token, 'POST', '/forecast/versions', { groupId, kind: 'LONG', days: 90 })).json.id;
  assert.ok(versionId, 'a long-term forecast');
});
const capacity = async () => (await call(token, 'GET', `/forecast/versions/${versionId}/capacity?grain=month`)).json;
const group = async () => (await call(token, 'GET', `/config/groups/${groupId}`)).json;

describe('which shrinkage is used', () => {
  it('is the flat setting while the group has no categories', async () => {
    const g = await group(), c = await capacity();
    assert.equal(g.shrinkageSource, 'FLAT'); assert.equal(g.shrinkageEffectivePercent, 20);
    assert.equal(c.shrinkageSource.source, 'FLAT'); assert.equal(c.shrinkageSource.effectivePct, 20); assert.equal(c.shrinkage, 0.2);
  });
  it('is the total of the categories once there are some, on the group and on the capacity plan alike', async () => {
    for (const [name, pct] of [['Breaks', 5], ['Training', 3], ['Absence', 2]] as const) await call(token, 'POST', `/config/groups/${groupId}/shrinkage-categories`, { name, pct });
    const g = await group(), c = await capacity();
    assert.equal(g.shrinkagePercent, 20, 'the flat setting is still stored');
    assert.equal(g.shrinkageSource, 'CATEGORIES'); assert.equal(g.shrinkageEffectivePercent, 10); assert.deepEqual(g.shrinkageCategories.map((x: any) => x.name), ['Breaks', 'Training', 'Absence']);
    assert.equal(c.shrinkageSource.source, 'CATEGORIES'); assert.equal(c.shrinkageSource.effectivePct, 10); assert.equal(c.shrinkageSource.flatPct, 20); assert.equal(c.shrinkage, 0.1);
    assert.equal(g.shrinkageEffectivePercent, c.shrinkageSource.effectivePct, 'every screen can show the same number');
  });
  it('the list of groups carries it too', async () => {
    const all = (await call(token, 'GET', '/config/groups')).json as any[];
    assert.equal(all.find((x) => x.id === groupId).shrinkageEffectivePercent, 10);
  });
});

describe('the people there are', () => {
  it('is nobody until people are assigned', async () => assert.deepEqual((await capacity()).headcount, { people: 0, fte: 0 }));
  it('counts active people in the group, and their contract hours as full-time equivalents', async () => {
    for (const [n, hours] of [['a', 40], ['b', 40], ['c', 20]] as const) {
      const r = await call(token, 'POST', '/workforce/employees', { employeeNumber: `CAP${RUN}-${n}`, firstName: `Cap${n}`, lastName: `Run${RUN}`, primaryGroupId: groupId, weeklyContractHours: hours, maxWeeklyHours: hours });
      assert.equal(r.status, 201, r.text);
    }
    const c = await capacity();
    assert.equal(c.headcount.people, 3); assert.equal(c.headcount.fte, 2.5, `100 contract hours at ${c.fteHoursWeek} h a week`);
  });
  it('has a need to set it against: periods with workload and agent hours', async () => {
    const c = await capacity();
    assert.ok(c.periods.length >= 1); assert.ok(c.periods.every((p: any) => p.workloadHours > 0 && p.agentHours > p.workloadHours));
  });
});
