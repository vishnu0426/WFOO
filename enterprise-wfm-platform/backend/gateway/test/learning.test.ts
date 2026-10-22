/**
 * Forecast self-learning: published forecasts are compared with what really arrived, weekday corrections are learned and applied
 * to new forecasts, and a drifted forecast gets a draft replacement. Needs DATABASE_URL to back-date a forecast (the real one
 * is created "today", so it cannot yet have been wrong about a past day).
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... DATABASE_URL=... npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB = process.env.DATABASE_URL;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const CURVE = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];

function csv(queue: string, from: number, to: number, scale: number) {
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = from; n >= to; n--) {
    const d = daysAgo(n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.45 : 1;
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.round(((CURVE[Math.floor(s / 4)] * f * 1.6) / 4) * scale)},400`);
  }
  return rows.join('\n');
}

describe('forecast self-learning', { skip: DB ? false : 'needs DATABASE_URL to back-date a forecast' }, () => {
  let token = '', groupId = '';
  const name = `Learn ${Date.now().toString(36)}`;

  before(async () => {
    const l = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(l.status, 200); token = l.json.token;
    const g = await call(token, 'POST', '/config/groups', { name, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    groupId = g.json.id;
    const q = await call(token, 'POST', '/config/queues', { name: `${name} voice`, channel: 'VOICE', wfmGroupId: groupId, ahtDefault: 400 });
    // 56 quiet weeks-worth of ordinary history, then a forecast that will later turn out too low
    const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: csv(q.json.name, 70, 15, 1) });
    assert.equal((await call(token, 'POST', `/data/imports/${up.json.id}/commit`)).json.status, 'COMPLETED');
    const f = await call(token, 'POST', '/forecast/versions', { groupId, kind: 'SHORT', weeks: 2, fromDay: iso(daysAgo(13)) });
    assert.equal(f.status, 201);
    // a deliberate manual override on the one day this forecast's 2-week range shares with "today" -- the day a
    // reforecast will also cover -- to check it survives the auto-relearn draft replacement below, not just a clone
    const adj = await call(token, 'PATCH', `/forecast/versions/${f.json.id}/adjustments`, { mode: 'total', value: 999, from: iso(daysAgo(0)), to: iso(daysAgo(0)), slotFrom: 40, slotTo: 40, reason: 'Manual override to verify it survives an auto-relearn reforecast' });
    assert.equal(adj.status, 200, JSON.stringify(adj));
    for (const s of ['submit', 'approve', 'publish']) assert.equal((await call(token, 'POST', `/forecast/versions/${f.json.id}/${s}`, {})).status, 200);
    const db = new pg.Client({ connectionString: DB }); await db.connect();
    await db.query('SET search_path = wfm, public');
    await db.query(`UPDATE forecast_versions SET created_at = $2::date - 1 WHERE id = $1`, [f.json.id, iso(daysAgo(14))]);
    await db.end();
    // what really happened afterwards: 30% more contacts than the forecast expected
    const act = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'a.csv', csv: csv(q.json.name, 13, 1, 1.3) });
    assert.equal((await call(token, 'POST', `/data/imports/${act.json.id}/commit`)).json.status, 'COMPLETED');
  });

  it('sees that the published forecast was too low', async () => {
    const r = await call(token, 'GET', `/forecast/learning?groupId=${groupId}`);
    assert.equal(r.status, 200);
    assert.ok(r.json.evaluation.days >= 5, `days ${r.json.evaluation.days}`);
    assert.ok(r.json.evaluation.bias < -0.1, `bias ${r.json.evaluation.bias}`);
    assert.equal(r.json.evaluation.drift, true);
  });

  it('learns by itself when new real volume arrives: corrections are stored and a draft is prepared', async () => {
    let st: any;
    for (let i = 0; i < 40; i++) {                       // the import triggers learning in the background
      st = await call(token, 'GET', `/forecast/learning?groupId=${groupId}`);
      if (st.json.runs.some((r: any) => r.action === 'DRAFT_CREATED')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const run = st.json.runs.find((r: any) => r.action === 'DRAFT_CREATED');
    assert.ok(run, JSON.stringify(st.json.runs));
    assert.equal(run.trigger, 'DATA');
    assert.ok(st.json.factors.length >= 5 && st.json.factors.every((f: any) => f.factor > 1.03 && f.factor <= 1.25), JSON.stringify(st.json.factors));
    const draft = await call(token, 'GET', `/forecast/versions/${run.versionId}`);
    assert.equal(draft.json.status, 'DRAFT');
    assert.match(JSON.stringify(draft.json.summary ?? draft.json), /earlier forecasts got wrong/);
    assert.match(run.note, /carrying forward 1 manual override/, `note should say the override carried over: ${run.note}`);

    const csv = await (await fetch(`${BASE}/api/v1/forecast/versions/${run.versionId}/export.csv`, { headers: { Authorization: `Bearer ${token}` } })).text();
    const row = csv.split('\n').find((l) => l.includes(`,${iso(daysAgo(0))},10:00,`));
    assert.ok(row, `no row for today 10:00 in the new draft's export:\n${csv.slice(0, 400)}`);
    const adjustedContacts = row!.split(',')[4];
    assert.equal(adjustedContacts, '999.00', 'the manual override on today (the one overlapping day) carried into the new draft');
  });

  it('does not stack another draft while one is waiting', async () => {
    const r = await call(token, 'POST', '/forecast/learning/run', { groupId });
    assert.notEqual(r.json.action, 'DRAFT_CREATED');
  });

  it('forecasts higher with learning on than with it off, and can forget', async () => {
    const total = async (id: string) => (await call(token, 'GET', `/forecast/versions/${id}/data?grain=day`)).json.buckets.reduce((s: number, b: any) => s + b.volume, 0);
    const on = await call(token, 'POST', '/forecast/versions', { groupId, kind: 'SHORT', weeks: 2 });
    assert.equal((await call(token, 'PUT', '/forecast/learning/settings', { groupId, enabled: false })).json.enabled, false);
    const off = await call(token, 'POST', '/forecast/versions', { groupId, kind: 'SHORT', weeks: 2 });
    assert.ok((await total(on.json.id)) > (await total(off.json.id)) * 1.03);
    assert.match((await call(token, 'POST', '/forecast/learning/run', { groupId })).json.note, /switched off/);
    await call(token, 'PUT', '/forecast/learning/settings', { groupId, enabled: true });
    assert.ok((await call(token, 'DELETE', `/forecast/learning/factors?groupId=${groupId}`)).json.cleared > 0);
    assert.equal((await call(token, 'GET', `/forecast/learning?groupId=${groupId}`)).json.factors.length, 0);
  });

  it('needs the right permission', async () => {
    assert.equal((await call(null, 'GET', `/forecast/learning?groupId=${groupId}`)).status, 401);
  });
});
