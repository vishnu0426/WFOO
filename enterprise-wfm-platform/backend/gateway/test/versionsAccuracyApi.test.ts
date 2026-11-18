/**
 * Accuracy of each forecast version (the picker on Generate Schedule): the same definition as the headline figure, per version, over the days of that forecast that have passed.
 * A forecast with nothing to compare yet has no entry. Needs a running gateway and the test database (to date a forecast back so its days count as already forecast):
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG TEST_DATABASE_URL=... npx tsx --test --test-force-exit test/versionsAccuracyApi.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB = process.env.TEST_DATABASE_URL || '';
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
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round((curve[Math.floor(s / 4)] * f * 0.5) / 4 + (n % 3)))},300`);
  }
  return rows.join('\n');
}

let token = '';
const g: Record<string, string> = {}, v: Record<string, string> = {};
/** A group with 56 days of history and a published short-term forecast that starts `startsIn` days from today (negative: started that long ago), dated as made the day before it started. */
async function group(key: string, startsIn: number | null) {
  const grp = (await call(token, 'POST', '/config/groups', { name: `VA${key} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 })).json;
  g[key] = grp.id;
  const q = (await call(token, 'POST', '/config/queues', { name: `VA${key} Q ${RUN}`, channel: 'VOICE', wfmGroupId: grp.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.name, 56) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  if (startsIn === null) return;
  const f = (await call(token, 'POST', '/forecast/versions', { groupId: grp.id, kind: 'SHORT', weeks: 4, fromDay: iso(addDays(today, startsIn)) })).json;
  assert.ok(f.id, 'a forecast');
  v[key] = f.id;
  for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${f.id}/${s}`, {});
  if (startsIn < 0) {
    const c = new pg.Client({ connectionString: DB }); await c.connect();
    try { await c.query(`UPDATE wfm.forecast_versions SET created_at = $2::timestamptz WHERE id = $1`, [f.id, addDays(today, startsIn - 1).toISOString()]); } finally { await c.end(); }
  }
}
before(async () => {
  if (!PASSWORD || !DB) return;
  token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
  await group('FULL', -27); await group('THIN', -6); await group('NONE', null); await group('FUTURE', 3);
});
const acc = async (k: string) => (await call(token, 'GET', `/forecast/versions-accuracy?groupId=${g[k]}`)).json as any[];

describe('accuracy of each forecast version', { skip: !PASSWORD || !DB }, () => {
  it('is 100% minus the miss over the days that have passed, and matches the headline when one forecast is live', async () => {
    const [a] = await acc('FULL');
    assert.equal(a.versionId, v.FULL);
    assert.ok(a.days >= 14, `days ${a.days}`); assert.equal(a.state, 'OK');
    const h = (await call(token, 'GET', `/forecast/accuracy-headline?groupId=${g.FULL}`)).json;
    assert.ok(Math.abs(a.accuracyPct - h.accuracyPct) < 0.11, `${a.accuracyPct} against the headline ${h.accuracyPct}`);
  });
  it('is an early reading when under two weeks have passed', async () => {
    const [a] = await acc('THIN');
    assert.equal(a.state, 'SPARSE'); assert.ok(a.days >= 1 && a.days <= 6, `days ${a.days}`);
  });
  it('has no entry for a forecast that has not started, or a group with none', async () => {
    assert.deepEqual(await acc('FUTURE'), []);
    assert.deepEqual(await acc('NONE'), []);
  });
  it('needs a group, and is refused without sign-in', async () => {
    assert.equal((await call(token, 'GET', '/forecast/versions-accuracy')).status, 400);
    assert.equal((await call(null, 'GET', `/forecast/versions-accuracy?groupId=${g.FULL}`)).status, 401);
  });
});
