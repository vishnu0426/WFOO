/**
 * Configuration policy: activity definitions and the company-wide scheduling policy, plus the CSV column aliases.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, parseCsv, parseSeconds } from '../src/modules/csv.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: r.status, json };
}

describe('CSV import: call-centre export columns', () => {
  it('reads durations as h:mm:ss, m:ss or seconds', () => {
    assert.equal(parseSeconds('00:02:14'), 134);
    assert.equal(parseSeconds('2:14'), 134);
    assert.equal(parseSeconds('301'), 301);
    assert.ok(Number.isNaN(parseSeconds('abc')));
  });
  it('maps Incoming Calls, Talk Duration (AVG) and Abandoned Calls, and says plainly when there is no date', () => {
    const m = parseCsv('Index,Incoming Calls,Abandoned Calls,Talk Duration (AVG)\n1,217,13,00:02:14\n');
    const r = normalise(m, { queue: 'Q', queues: [{ id: 'q1', name: 'Q', code: 'Q', ahtDefault: 300 }] });
    assert.equal(r.columns.find((c) => c.field === 'volume')?.source, 'Incoming Calls');
    assert.equal(r.columns.find((c) => c.field === 'aht')?.source, 'Talk Duration (AVG)');
    assert.equal(r.columns.find((c) => c.field === 'abandoned')?.source, 'Abandoned Calls');
    assert.match(r.errors[0].message, /No date column/);
    assert.equal(r.rowsOk, 0);
  });
  it('imports a dated export with h:mm:ss handle time', () => {
    const m = parseCsv('Date,Time,Incoming Calls,Talk Duration (AVG)\n2026-01-05,09:00,42,00:05:00\n');
    const r = normalise(m, { queue: 'Q', queues: [{ id: 'q1', name: 'Q', code: 'Q', ahtDefault: 300 }] });
    assert.equal(r.errors.length, 0);
    assert.equal(r.records[0].volume, 42);
    assert.equal(r.records[0].ahtSec, 300);
  });
});

describe('activities and scheduling policy API', () => {
  let admin = '';
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, 'login failed: set ADMIN_PASSWORD and TENANT');
    admin = r.json.token;
  });

  it('starts empty: no seeded activities, default weights, no limits', async () => {
    const pol = await call(admin, 'GET', '/config/scheduling-policy');
    assert.equal(pol.status, 200);
    assert.equal(pol.json.minRestHours, null);
    assert.equal(pol.json.weights.understaffing, 90);
  });

  it('creates, edits, rejects duplicates and deletes an activity', async () => {
    const body = { name: `Coaching ${RUN}`, category: 'COACHING', countsAsWork: false, paid: true, shrinkage: true, color: '#F8DDDD' };
    const c = await call(admin, 'POST', '/config/activities', body);
    assert.equal(c.status, 201);
    assert.equal(c.json.status, 'ACTIVE');
    assert.equal((await call(admin, 'POST', '/config/activities', body)).status, 409);
    const u = await call(admin, 'PUT', `/config/activities/${c.json.id}`, { ...body, paid: false });
    assert.equal(u.status, 200);
    assert.equal(u.json.paid, false);
    assert.equal(u.json.version, 2);
    assert.equal((await call(admin, 'POST', '/config/activities', { ...body, name: 'x', color: 'red' })).status, 400);
    assert.equal((await call(admin, 'DELETE', `/config/activities/${c.json.id}`)).status, 204);
    assert.equal((await call(admin, 'DELETE', `/config/activities/${c.json.id}`)).status, 404);
  });

  it('saves the scheduling policy and rejects impossible combinations', async () => {
    const weights = { understaffing: 80, overstaffing: 20, contractHours: 40, preferences: 10, fairness: 60 };
    const ok = await call(admin, 'PUT', '/config/scheduling-policy', { minRestHours: 12, maxWeeklyHours: 45, maxConsecutiveDays: 5, maxDaysPerWeek: 5, adherenceGraceSeconds: 300, timelineColors: { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' }, weights });
    assert.equal(ok.status, 200);
    const back = await call(admin, 'GET', '/config/scheduling-policy');
    assert.equal(back.json.minRestHours, 12);
    assert.equal(back.json.weights.fairness, 60);
    assert.equal((await call(admin, 'PUT', '/config/scheduling-policy', { minRestHours: 12, maxWeeklyHours: 90, maxConsecutiveDays: 5, maxDaysPerWeek: 2, adherenceGraceSeconds: 300, timelineColors: { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' }, weights })).status, 400);
    assert.equal((await call(admin, 'PUT', '/config/scheduling-policy', { minRestHours: 12, maxWeeklyHours: 45, maxConsecutiveDays: 5, maxDaysPerWeek: 5, adherenceGraceSeconds: 300, timelineColors: { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' }, weights: { ...weights, fairness: 101 } })).status, 400);
    // clear the limits again so this run leaves nothing behind that changes other suites
    await call(admin, 'PUT', '/config/scheduling-policy', { minRestHours: null, maxWeeklyHours: null, maxConsecutiveDays: null, maxDaysPerWeek: null, adherenceGraceSeconds: 300, timelineColors: { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' }, weights: { understaffing: 90, overstaffing: 30, contractHours: 50, preferences: 20, fairness: 30 } });
  });

  it('an unauthenticated caller cannot change the policy', async () => {
    const r = await call(null, 'PUT', '/config/scheduling-policy', { minRestHours: 1, maxWeeklyHours: null, maxConsecutiveDays: null, maxDaysPerWeek: null, adherenceGraceSeconds: 300, timelineColors: { shift: '#7B6CA6', manual: '#6B7F99', violation: '#C9605F' }, weights: { understaffing: 1, overstaffing: 1, contractHours: 1, preferences: 1, fairness: 1 } });
    assert.equal(r.status, 401);
  });
});
