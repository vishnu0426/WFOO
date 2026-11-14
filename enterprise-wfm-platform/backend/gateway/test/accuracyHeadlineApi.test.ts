/**
 * The one accuracy figure through the API: the same number on the Overview, the accuracy endpoint and the Models screen's check. Needs a running gateway and engine, and the test database
 * (the published forecast is dated back so its days count as already forecast):
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG TEST_DATABASE_URL=postgres://postgres:admin@localhost:5432/wfm_p3_test npx tsx --test --test-force-exit test/accuracyHeadlineApi.test.ts
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
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round((curve[Math.floor(s / 4)] * f * 0.5) / 4 + (n % 3)))},${270 + (s % 5) * 10}`);
  }
  return rows.join('\n');
}

let token = '';
const g: Record<string, string> = {};
/** A group with 56 days of history and a published short-term forecast that started `ago` days back, dated to have been made before its days. */
async function group(key: string, ago: number | null) {
  const grp = (await call(token, 'POST', '/config/groups', { name: `ACC${key} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 })).json;
  g[key] = grp.id;
  const q = (await call(token, 'POST', '/config/queues', { name: `ACC${key} Q ${RUN}`, channel: 'VOICE', wfmGroupId: grp.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.name, 56) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  if (ago === null) return;
  const v = (await call(token, 'POST', '/forecast/versions', { groupId: grp.id, kind: 'SHORT', weeks: 4, fromDay: iso(addDays(today, -ago)) })).json;
  assert.ok(v.id, 'a forecast');
  for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v.id}/${s}`, {});
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  try { await c.query(`UPDATE wfm.forecast_versions SET created_at = $2::timestamptz WHERE id = $1`, [v.id, addDays(today, -ago - 1).toISOString()]); } finally { await c.end(); }
}
before(async function () {
  token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
  await group('FULL', 27); await group('THIN', 6); await group('NONE', null);
});
const headline = async (k: string) => (await call(token, 'GET', `/forecast/accuracy-headline?groupId=${g[k]}`)).json;

describe('the headline accuracy figure', () => {
  it('is 100% minus the daily WAPE over 28 days, with its definition', async (t) => {
    if (!DB) return t.skip('needs TEST_DATABASE_URL');
    const h = await headline('FULL');
    assert.equal(h.name, 'Forecast accuracy'); assert.equal(h.windowDays, 28); assert.match(h.definition, /100% − WAPE/);
    assert.ok(h.days >= 14, `days ${h.days}`); assert.equal(h.state, 'OK'); assert.equal(h.note, '');
    assert.ok(Math.abs(h.accuracyPct + h.missPct - 100) < 0.11, `${h.accuracyPct} + ${h.missPct}`);
  });
  it('is the same number the Models screen\'s check is built on', async (t) => {
    if (!DB) return t.skip('needs TEST_DATABASE_URL');
    const h = await headline('FULL');
    const L = (await call(token, 'GET', `/forecast/learning?groupId=${g.FULL}`)).json;
    assert.equal(h.missPct, Math.round(L.evaluation.wape * 1000) / 10);
  });
  it('is the same number on the Overview, with a note about the window', async (t) => {
    if (!DB) return t.skip('needs TEST_DATABASE_URL');
    const h = await headline('FULL');
    const o = (await call(token, 'GET', `/overview/today?groupId=${g.FULL}`)).json;
    const k = o.kpis.find((x: any) => x.key === 'accuracy');
    assert.equal(k.value, h.accuracyPct); assert.match(k.sub, /Last 28 days: published forecasts missed by [\d.]+% a day/); assert.equal(k.trendBasis, 'vs the 28 days before');
  });
});

describe('when the data is thin', () => {
  it('under two completed weeks it is an early reading with the note', async (t) => {
    if (!DB) return t.skip('needs TEST_DATABASE_URL');
    const h = await headline('THIN');
    assert.equal(h.state, 'SPARSE'); assert.ok(h.days > 0 && h.days < 14, `days ${h.days}`); assert.match(h.note, /^Needs 2\+ completed weeks of data \(\d+ days? so far\)\.$/); assert.notEqual(h.accuracyPct, null);
    const o = (await call(token, 'GET', `/overview/today?groupId=${g.THIN}`)).json;
    assert.match(o.kpis.find((x: any) => x.key === 'accuracy').sub, /Needs 2\+ completed weeks/);
  });
  it('with no published forecast it says what is needed and has no number', async () => {
    const h = await headline('NONE');
    assert.equal(h.state, 'NONE'); assert.equal(h.accuracyPct, null); assert.equal(h.note, 'Needs a published forecast compared with actuals.');
    const o = (await call(token, 'GET', `/overview/today?groupId=${g.NONE}`)).json;
    assert.equal(o.kpis.find((x: any) => x.key === 'accuracy').value, null);
  });
});
