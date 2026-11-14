/**
 * Forecast versions through the API: comparing one with another and archiving one that is not live. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/forecastLineageApi.test.ts
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
function historyCsv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 3 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`);
    }
  }
  return rows.join('\n');
}

describe('forecast versions: compare and archive', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', analyst = '', group: any, other: any, v1: any, v2: any, v3: any, day = '';
  const step = (id: string, s: string, body: object = {}) => call(admin, 'POST', `/forecast/versions/${id}/${s}`, body);

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    const mk = async (name: string) => {
      const g = (await call(admin, 'POST', '/config/groups', { name: `${name} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
      const q = (await call(admin, 'POST', '/config/queues', { name: `${name} Q ${RUN}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
      assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
      return g;
    };
    group = await mk('LinA'); other = await mk('LinB');
    const today = new Date(); today.setUTCHours(0, 0, 0, 0); day = iso(today);
    const build = async (g: any) => (await call(admin, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 2, fromDay: iso(addDays(today, -1)) })).json;
    v1 = await build(group);
    for (const s of ['submit', 'approve', 'publish']) assert.equal((await step(v1.id, s)).status, 200, s);
    v2 = (await call(admin, 'POST', `/forecast/versions/${v1.id}/clone`)).json;          // a draft copy of the live one
    assert.equal(v2.parentVersionId, v1.id);
    v3 = await build(other);
    await call(admin, 'POST', '/users', { username: `lin${RUN}`, displayName: 'Viewer', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    analyst = (await call(null, 'POST', '/auth/login', { username: `lin${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
  });

  it('a copy that has not been changed compares equal to the version it came from', async () => {
    const r = await call(admin, 'GET', `/forecast/versions/${v2.id}/compare?with=${v1.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version.id, v2.id); assert.equal(r.json.base.id, v1.id);
    assert.ok(r.json.overlap.days >= 14, `shares ${r.json.overlap.days} days`);
    assert.equal(r.json.summary.volume.a, r.json.summary.volume.b); assert.equal(r.json.summary.volume.deltaPct, 0);
    assert.equal(r.json.biggest, null); assert.deepEqual(r.json.adjusted, { base: 0, version: 0 });
    assert.ok(r.json.rows.every((x: any) => x.delta === 0));
  });

  it('shows what an adjustment changed: the day, the size, the totals and the count of edits', async () => {
    const before = (await call(admin, 'GET', `/forecast/versions/${v2.id}/compare?with=${v1.id}`)).json;
    const adj = await call(admin, 'PATCH', `/forecast/versions/${v2.id}/adjustments`, { mode: 'pct', value: 20, from: day, to: day, reason: 'compare test: +20% for a day' });
    assert.equal(adj.status, 200, adj.text);
    const r = (await call(admin, 'GET', `/forecast/versions/${v2.id}/compare?with=${v1.id}`)).json;
    assert.equal(r.biggest.day, day); assert.ok(r.biggest.delta > 0); assert.ok(Math.abs(r.biggest.deltaPct - 20) < 1, `about +20% (${r.biggest.deltaPct})`);
    const d = r.rows.find((x: any) => x.day === day); assert.ok(d.b > d.a);
    assert.ok(r.summary.volume.b > before.summary.volume.b); assert.ok(r.summary.volume.deltaPct > 0);
    assert.ok(r.adjusted.version > 0 && r.adjusted.base === 0);
    // the other way round it is the opposite
    const back = (await call(admin, 'GET', `/forecast/versions/${v1.id}/compare?with=${v2.id}`)).json;
    assert.ok(back.biggest.delta < 0);
  });

  it('refuses to compare a version with itself, with another forecast, or with something that is not there', async () => {
    assert.equal((await call(admin, 'GET', `/forecast/versions/${v1.id}/compare?with=${v1.id}`)).status, 400);
    const x = await call(admin, 'GET', `/forecast/versions/${v1.id}/compare?with=${v3.id}`);
    assert.equal(x.status, 400); assert.match(x.text, /same forecast/);
    assert.equal((await call(admin, 'GET', `/forecast/versions/${v1.id}/compare?with=00000000-0000-4000-8000-000000000000`)).status, 404);
    assert.equal((await call(admin, 'GET', `/forecast/versions/${v1.id}/compare`)).status, 400);
    assert.equal((await call(analyst, 'GET', `/forecast/versions/${v2.id}/compare?with=${v1.id}`)).status, 200, 'anyone who can read forecasts can compare them');
  });

  it('archives a version that is not live, with a reason, and keeps it', async () => {
    assert.equal((await step(v2.id, 'archive')).status, 400, 'a reason is required');
    assert.equal((await step(v2.id, 'archive', { reason: 'no' })).status, 400, 'and it has to say something');
    assert.equal((await call(analyst, 'POST', `/forecast/versions/${v2.id}/archive`, { reason: 'tidying up' })).status, 403);
    const r = await step(v2.id, 'archive', { reason: 'replaced by a better one' });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'ARCHIVED');
    const list = (await call(admin, 'GET', `/forecast/versions?groupId=${group.id}`)).json as any[];
    assert.equal(list.find((x) => x.id === v2.id).status, 'ARCHIVED', 'it is still in the list');
    assert.equal(list.find((x) => x.id === v1.id).status, 'PUBLISHED', 'the live version is untouched');
    assert.equal((await call(admin, 'GET', `/forecast/versions/${v2.id}/compare?with=${v1.id}`)).status, 200, 'an archived version can still be compared');
    const audit = (await call(admin, 'GET', `/audit?entityType=FORECAST_VERSION&limit=20`)).json;
    const rows = Array.isArray(audit) ? audit : audit?.rows ?? [];
    if (rows.length) assert.ok(rows.some((a: any) => a.entityId === v2.id && /replaced by a better one/.test(a.reason ?? '')), 'the reason is in the audit log');
  });

  it('will not archive the live version, or one that is already archived', async () => {
    const live = await step(v1.id, 'archive', { reason: 'trying to hide the live one' });
    assert.equal(live.status, 409, live.text); assert.match(live.text, /cannot archive a published/i);
    assert.equal((await step(v2.id, 'archive', { reason: 'again' })).status, 409);
    assert.equal((await call(admin, 'GET', `/forecast/versions?groupId=${group.id}`)).json.find((x: any) => x.id === v1.id).status, 'PUBLISHED');
  });

  it('an archived version can be cloned back into a draft', async () => {
    const c = await call(admin, 'POST', `/forecast/versions/${v2.id}/clone`);
    assert.equal(c.status, 201, c.text); assert.equal(c.json.status, 'DRAFT'); assert.equal(c.json.parentVersionId, v2.id);
  });
});
