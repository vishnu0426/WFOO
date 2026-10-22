/**
 * Back-office / deferred-work forecasting: a BACKOFFICE queue with a turnaround target longer than same-day should
 * smooth a volume spike's required capacity across the operating days within that window (real math, engine-level
 * exact numbers verified in backend/engine/test_engine.py::test_backoffice_turnaround_smoothing). This is the
 * end-to-end wiring check: does the queue's turnaroundHours setting actually reach the engine and change the
 * published/staffed numbers, not a re-derivation of the smoothing formula itself.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
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

// flat, near-constant daily volume (weekday only, small deterministic noise) so any spike in the forecast comes
// from the special event, not natural day-to-day variation.
function historyCsv(queue: string, days: number) {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n);
    if ((d.getDay() + 6) % 7 >= 5) continue; // weekdays only: back office does not run weekends here
    const vol = 400 + Math.round(rnd() * 10 - 5);
    rows.push(`${queue},${iso(d)},09:00,${vol},600`);
  }
  return rows.join('\n');
}

async function buildBackofficeGroup(admin: string, tag: string, turnaroundHours: number | undefined) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const toMonday = (7 - ((start.getDay() + 6) % 7)) % 7;
  const from = iso(addDays(start, toMonday || 7));

  const g = await call(admin, 'POST', '/config/groups', { name: `BO ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 0, targetOccupancy: 100 });
  assert.equal(g.status, 201, g.text);
  const queueName = `BO Queue ${tag}`;
  const q = await call(admin, 'POST', '/config/queues', {
    name: queueName, channel: 'BACKOFFICE', wfmGroupId: g.json.id, ahtDefault: 600, openSlot: 0, closeSlot: 32, // 8 operating hours (0-8:00) at 15-min slots
    ...(turnaroundHours !== undefined ? { turnaroundHours } : {}),
  });
  assert.equal(q.status, 201, q.text);
  if (turnaroundHours !== undefined) assert.equal(q.json.turnaroundHours, turnaroundHours);

  const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queueName, 70) });
  assert.equal(up.status, 201, up.text);
  assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);

  // a one-day, 4x volume spike squarely inside the forecast's first week, on the third weekday so both a
  // before-spike and several after-spike days are visible in one 7-day forecast
  const spikeDay = iso(addDays(new Date(from + 'T00:00:00'), 2));
  const ev = await call(admin, 'POST', '/forecast/events', { groupId: g.json.id, queueId: q.json.id, name: `Spike ${tag}`, kind: 'campaign', startDay: spikeDay, upliftPct: 300 });
  assert.equal(ev.status, 201, ev.text);

  const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 1, fromDay: from });
  assert.equal(f.status, 201, f.text);

  const data = await call(admin, 'GET', `/forecast/versions/${f.json.id}/data?grain=day&queueId=${q.json.id}`);
  assert.equal(data.status, 200, data.text);
  const byDay = new Map<string, number>(data.json.buckets.map((b: any) => [b.day, b.peakRequired ?? 0]));
  return { from, spikeDay, byDay, dayAfter: iso(addDays(new Date(spikeDay + 'T00:00:00'), 1)), dayBefore: iso(addDays(new Date(spikeDay + 'T00:00:00'), -1)) };
}

describe('back-office turnaround smoothing (end to end)', () => {
  let admin = '';
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('a longer-than-24h turnaround setting flattens a volume spike across the days around it, versus the same queue staffed same-day', async () => {
    const flat = await buildBackofficeGroup(admin, `flat${RUN}`, 24);
    const smooth = await buildBackofficeGroup(admin, `smooth${RUN}`, 32); // a 4 operating-day window at 8h/day

    const flatSpike = flat.byDay.get(flat.spikeDay) ?? 0, smoothSpike = smooth.byDay.get(smooth.spikeDay) ?? 0;
    assert.ok(flatSpike > 0, 'the unsmoothed queue should show a real peak on the spike day');
    assert.ok(smoothSpike < flatSpike, `the smoothed queue's spike-day requirement (${smoothSpike}) should be lower than the unsmoothed one (${flatSpike})`);

    const flatAfter = flat.byDay.get(flat.dayAfter) ?? 0, smoothAfter = smooth.byDay.get(smooth.dayAfter) ?? 0;
    assert.ok(smoothAfter > flatAfter, `the day after the spike should be elevated for the smoothed queue (${smoothAfter}) versus the unsmoothed one (${flatAfter}), which absorbs none of the backlog`);

    const flatBefore = flat.byDay.get(flat.dayBefore) ?? 0, smoothBefore = smooth.byDay.get(smooth.dayBefore) ?? 0;
    assert.equal(smoothBefore, flatBefore, 'the day before the spike is unaffected either way: the backlog has not arrived yet');
  });

  it('turnaroundHours of 0 or unset behaves like same-day (the default, pre-existing behaviour)', async () => {
    const unset = await buildBackofficeGroup(admin, `unset${RUN}`, undefined);
    const explicit24 = await buildBackofficeGroup(admin, `exp24${RUN}`, 24);
    assert.equal(unset.byDay.get(unset.spikeDay), explicit24.byDay.get(explicit24.spikeDay));
  });
});
