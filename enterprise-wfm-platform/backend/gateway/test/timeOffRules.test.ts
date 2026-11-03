/**
 * Time off: blackout dates, daily limits for a date range, monthly accrual and carry-over.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { balanceOf, blackoutHits, capHits, type OffRule } from '../src/modules/timeOffRules.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const rule = (o: Partial<OffRule>): OffRule => ({ id: 'r', groupId: null, kind: 'BLACKOUT', startDay: '2027-12-20', endDay: '2027-12-31', maxOff: null, types: null, strict: false, reason: 'Year-end close', ...o });

describe('rules (arithmetic)', () => {
  it('a blackout covers any leave type that touches its dates, except sick leave', () => {
    assert.equal(blackoutHits([rule({})], 'g1', 'VACATION', '2027-12-28', '2028-01-03').length, 1);
    assert.equal(blackoutHits([rule({})], 'g1', 'VACATION', '2027-12-01', '2027-12-19').length, 0, 'ends the day before');
    assert.equal(blackoutHits([rule({})], 'g1', 'SICK', '2027-12-28', '2027-12-29').length, 0, 'sick leave is never blocked');
    assert.equal(blackoutHits([rule({ types: ['VACATION'] })], 'g1', 'PERSONAL', '2027-12-28', '2027-12-29').length, 0, 'only the listed types');
  });
  it('a blackout for one group does not touch another; one with no group touches everyone', () => {
    assert.equal(blackoutHits([rule({ groupId: 'g2' })], 'g1', 'VACATION', '2027-12-28', '2027-12-29').length, 0);
    assert.equal(blackoutHits([rule({ groupId: 'g1' })], 'g1', 'VACATION', '2027-12-28', '2027-12-29').length, 1);
    assert.equal(blackoutHits([rule({ groupId: null })], 'g9', 'VACATION', '2027-12-28', '2027-12-29').length, 1);
  });
  it('a daily limit names the first day that would go over it', () => {
    const cap = rule({ kind: 'CAP', maxOff: 2, reason: 'Peak season' });
    const off = new Map([['2027-12-21', 1], ['2027-12-22', 2], ['2027-12-23', 2]]);
    const hit = capHits([cap], 'g1', 'VACATION', '2027-12-21', '2027-12-23', off);
    assert.equal(hit.length, 1);
    assert.match(hit[0].text, /2027-12-22/);
    assert.match(hit[0].text, /Peak season/);
    assert.equal(capHits([cap], 'g1', 'VACATION', '2027-12-21', '2027-12-21', off).length, 0, 'one more is still within two');
  });
  it('monthly accrual builds up one twelfth a month; carry-over is capped', () => {
    const base = { type: 'VACATION', entitled: 24, usedThisYear: 0, lastYearEntitled: 24, lastYearUsed: 24, carryOverCap: 0 };
    assert.equal(balanceOf({ ...base, mode: 'UPFRONT', asOfMonth: 1 }).remainingDays, 24);
    assert.equal(balanceOf({ ...base, mode: 'MONTHLY', asOfMonth: 1 }).remainingDays, 2);
    assert.equal(balanceOf({ ...base, mode: 'MONTHLY', asOfMonth: 6 }).remainingDays, 12);
    assert.equal(balanceOf({ ...base, mode: 'MONTHLY', asOfMonth: 12 }).remainingDays, 24);
    const carried = balanceOf({ ...base, mode: 'MONTHLY', asOfMonth: 3, lastYearUsed: 14, carryOverCap: 5 });
    assert.equal(carried.carriedOverDays, 5, '10 were unused but only 5 may be carried');
    assert.equal(carried.remainingDays, 11);
    assert.equal(balanceOf({ ...base, mode: 'UPFRONT', asOfMonth: 1, usedThisYear: 30 }).remainingDays, 0, 'never negative');
  });
});

describe('rules (through the API)', () => {
  let admin = '', group: any, agent = '', employeeId = '';
  const tag = `T${RUN}`;
  const setPolicy = async (patch: Record<string, unknown>) => { const cur = (await call(admin, 'GET', '/self-service/policy')).json; const r = await call(admin, 'PUT', '/self-service/policy', { ...cur, ...patch }); assert.equal(r.status, 200, r.text); return r.json; };

  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `Off ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    assert.equal(g.status, 201, g.text); group = g.json;
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Off team ${tag}` })).status, 201);
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= 6; i++) lines.push(`OF${tag}-${i},Pat${i},Leave${i},Off team ${tag},Off ${tag},FULL_TIME,40,5`);
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false })).json.committed, true);
    const emps = (await call(admin, 'GET', `/workforce/employees?groupId=${group.id}`)).json;
    employeeId = emps[0].id;
    const c = await call(admin, 'POST', '/self-service/logins', { employeeId });
    assert.equal(c.status, 201, c.text);
    const l = await call(null, 'POST', '/auth/login', { username: c.json.username, password: c.json.password, tenant: TENANT });
    assert.equal(l.status, 200, l.text); agent = l.json.token;
    await setPolicy({ timeOffAutoApprove: true, timeOffMinNoticeDays: 0, timeOffMaxOffPercent: 100, entitlements: { VACATION: 24, SICK: 12 }, accrualMode: 'UPFRONT', carryOverDays: {} });
  });

  const day = (n: number) => iso(addDays(new Date(), n));

  it('a blackout sends the request to a manager with the reason, and a strict one refuses it', async () => {
    const start = day(60), end = day(63);
    const soft = await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'BLACKOUT', groupId: group.id, startDate: start, endDate: end, reason: 'Stocktake', types: [] });
    assert.equal(soft.status, 201, soft.text);
    const check = await call(agent, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: start, endDate: start });
    assert.equal(check.json.willBeApprovedAutomatically, false);
    assert.match(check.json.reasonsForReview.join(' '), /Stocktake/);
    const made = await call(agent, 'POST', '/me/time-off', { type: 'VACATION', startDate: start, endDate: start });
    assert.equal(made.json.request.status, 'REQUESTED', 'a manager decides');
    // sick leave is never held up by a blackout
    assert.equal((await call(agent, 'POST', '/me/time-off/check', { type: 'SICK', startDate: start, endDate: start })).json.reasonsForReview.some((x: string) => /Stocktake/.test(x)), false);
    // a manager booking leave in the blackout is told, not stopped
    const m = await call(admin, 'POST', '/workforce/time-off', { employeeId, type: 'VACATION', startDate: day(61), endDate: day(61), reason: 'agreed' });
    assert.equal(m.status, 201, m.text);
    assert.match(m.json.warnings.join(' '), /Stocktake/);
    const strict = await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'BLACKOUT', groupId: group.id, startDate: day(90), endDate: day(92), reason: 'Audit week', strict: true });
    assert.equal(strict.status, 201, strict.text);
    const refused = await call(agent, 'POST', '/me/time-off', { type: 'VACATION', startDate: day(91), endDate: day(91) });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /Audit week/);
    const other = await call(admin, 'POST', '/config/groups', { name: `Other ${tag}` });
    const forOther = await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'BLACKOUT', groupId: other.json.id, startDate: day(120), endDate: day(125), reason: 'Not mine' });
    assert.equal(forOther.status, 201);
    const elsewhere = await call(agent, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: day(121), endDate: day(121) });
    assert.equal(elsewhere.json.willBeApprovedAutomatically, true, `another group’s blackout does not touch this person: ${JSON.stringify(elsewhere.json.reasonsForReview)}`);
  });

  it('a daily limit counts the people already off and says which day is full', async () => {
    const d = day(150);
    assert.equal((await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'CAP', groupId: group.id, startDate: d, endDate: d, maxOff: 1, reason: 'Launch day' })).status, 201);
    const emps = (await call(admin, 'GET', `/workforce/employees?groupId=${group.id}`)).json;
    const other = emps.find((e: any) => e.id !== employeeId);
    assert.equal((await call(admin, 'POST', '/workforce/time-off', { employeeId: other.id, type: 'VACATION', startDate: d, endDate: d, approve: true })).status, 201);
    const check = await call(agent, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: d, endDate: d });
    assert.equal(check.json.willBeApprovedAutomatically, false);
    assert.match(check.json.reasonsForReview.join(' '), new RegExp(`${d}.*Launch day|Launch day.*${d}`));
    assert.equal((await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'CAP', groupId: group.id, startDate: d, endDate: d })).status, 400, 'a limit needs a number');
  });

  it('rules can be listed and removed', async () => {
    const list = await call(admin, 'GET', '/self-service/time-off-rules');
    assert.ok(list.json.length >= 4);
    const mine = list.json.find((r: any) => r.reason === 'Not mine');
    assert.equal((await call(admin, 'DELETE', `/self-service/time-off-rules/${mine.id}`)).status, 200);
    assert.ok(!(await call(admin, 'GET', '/self-service/time-off-rules')).json.some((r: any) => r.id === mine.id));
    assert.equal((await call(agent, 'GET', '/self-service/time-off-rules')).status, 403, 'staff cannot read or change the rules');
  });

  it('monthly accrual limits what can be booked early in the year; carry-over adds last year’s unused days', async () => {
    const pol = await setPolicy({ accrualMode: 'MONTHLY', entitlements: { VACATION: 12, SICK: 12 }, carryOverDays: {} });
    assert.equal(pol.accrualMode, 'MONTHLY');
    const nextJan = `${new Date().getFullYear() + 1}-01-10`;
    const jan = await call(agent, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: nextJan, endDate: addIsoDays(nextJan, 2) });
    assert.match(jan.json.reasonsForReview.join(' '), /available by then/, 'one twelfth of 12 days is 1 day by January');
    const dec = `${new Date().getFullYear() + 1}-12-01`;
    const late = await call(agent, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: dec, endDate: addIsoDays(dec, 2) });
    assert.ok(!/available by then|left and this asks/.test(late.json.reasonsForReview.join(' ')), 'by December the whole year is available');
    const bal = (await call(agent, 'GET', '/me/time-off')).json.balances.find((b: any) => b.type === 'VACATION');
    assert.equal(bal.entitledDays, 12);
    assert.ok(bal.accruedDays > 0 && bal.accruedDays <= 12);
    await setPolicy({ accrualMode: 'UPFRONT' });
  });
});

const addIsoDays = (s: string, n: number) => iso(addDays(new Date(`${s}T00:00:00`), n));
