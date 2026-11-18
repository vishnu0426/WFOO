/**
 * Leave as a year-by-year record against a running gateway: the estimate before a year is closed, hand adjustments, the carry expiry, and closing a year.
 *   BASE_URL=http://localhost:4011 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test-force-exit --test test/leaveYearApi.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const YEAR = new Date().getFullYear();

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, message: json?.error?.message as string | undefined };
}
let admin = '';
const ctx: Record<string, any> = {};
const setPolicy = async (patch: Record<string, unknown>) => { const cur = (await call(admin, 'GET', '/self-service/policy')).json; const r = await call(admin, 'PUT', '/self-service/policy', { ...cur, ...patch }); assert.equal(r.status, 200, r.text); return r.json; };
const emp = async (n: string) => { const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `LY${RUN}-${n}`, firstName: `Ly${n}`, lastName: `Run${RUN}`, primaryGroupId: ctx.group.id }); assert.equal(r.status, 201, r.text); return r.json; };
const login = async (employeeId: string) => {
  const c = await call(admin, 'POST', '/self-service/logins', { employeeId, role: 'AGENT' }); assert.equal(c.status, 201, c.text);
  const t = await call(null, 'POST', '/auth/login', { username: c.json.username, password: c.json.password, tenant: TENANT }); assert.equal(t.status, 200, t.text);
  return t.json.token as string;
};
const vacation = async (tok: string) => (await call(tok, 'GET', '/me/time-off')).json.balances.find((b: any) => b.type === 'VACATION');
const adjust = (body: Record<string, unknown>) => call(admin, 'POST', '/self-service/leave/adjustments', { employeeId: ctx.e.id, type: 'VACATION', year: YEAR, ...body });

describe('leave carry-forward as a year-end record', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token;
    ctx.group = (await call(admin, 'POST', '/config/groups', { name: `Leave year ${RUN}` })).json;
    await setPolicy({ entitlements: { VACATION: 20 }, carryOverDays: { VACATION: 5 }, carryExpiry: {}, accrualMode: 'UPFRONT' });
    ctx.e = await emp('P1'); ctx.tok = await login(ctx.e.id);
    // 18 days of vacation taken in December last year: 2 unused by the old estimate
    const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: ctx.e.id, type: 'VACATION', startDate: `${YEAR - 1}-12-01`, endDate: `${YEAR - 1}-12-18`, approve: true });
    assert.equal(t.status, 201, t.text);
  });

  it('before last year is closed, the carried days are an estimate, and it says so', async () => {
    const b = await vacation(ctx.tok);
    assert.equal(b.carriedOverDays, 2, '20 entitled - 18 used last year');
    assert.equal(b.estimated, true); assert.equal(b.remainingDays, 22);
  });

  it('a hand adjustment is added to the balance, with who did it and why', async () => {
    assert.equal((await adjust({ kind: 'GRANT', days: 3, reason: 'Long service award' })).status, 201);
    const b = await vacation(ctx.tok);
    assert.equal(b.adjustedDays, 3); assert.equal(b.remainingDays, 25);
    const list = (await call(admin, 'GET', `/self-service/leave/balances?employeeId=${ctx.e.id}&year=${YEAR}`)).json;
    assert.equal(list.adjustments.length, 1); assert.equal(list.adjustments[0].reason, 'Long service award'); assert.equal(list.adjustments[0].days, 3);
  });

  it('refuses an adjustment with no reason, a negative grant, or a type with no allowance', async () => {
    assert.equal((await adjust({ kind: 'GRANT', days: 1, reason: 'x' })).status, 400, 'a reason is needed');
    assert.equal((await adjust({ kind: 'GRANT', days: -1, reason: 'Wrong sign' })).status, 400);
    assert.equal((await adjust({ kind: 'GRANT', days: 1, type: 'TRAINING', reason: 'No allowance here' })).status, 400);
  });

  it('a deduction and a payout take days off; a correction may go either way', async () => {
    assert.equal((await adjust({ kind: 'PAYOUT', days: 1, reason: 'Paid out in cash' })).status, 201);
    assert.equal((await adjust({ kind: 'CORRECTION', days: -1, reason: 'Entered twice' })).status, 201);
    assert.equal((await vacation(ctx.tok)).adjustedDays, 1, '3 - 1 - 1');
    assert.equal((await adjust({ kind: 'CORRECTION', days: 2, reason: 'Back again' })).status, 201);
    assert.equal((await vacation(ctx.tok)).adjustedDays, 3);
  });

  it('closing the year writes what each person carries, from what was actually used and adjusted', async () => {
    // last year: give 3 days by hand, then close
    assert.equal((await adjust({ kind: 'GRANT', days: 3, year: YEAR - 1, reason: 'Missed from last year' })).status, 201);
    const pre = (await call(admin, 'GET', `/self-service/leave/year-close?year=${YEAR - 1}`)).json;
    assert.equal(pre.canClose, true); assert.equal(pre.closed, null);
    const v = pre.preview.byType.find((x: any) => x.type === 'VACATION'); assert.ok(v.carriedOut >= 5, 'this person carries the full 5: 20 + 3 - 18 = 5');
    assert.equal((await call(admin, 'POST', '/self-service/leave/year-close', { year: YEAR - 1, reason: 'x' })).status, 400, 'a reason is needed');
    const done = await call(admin, 'POST', '/self-service/leave/year-close', { year: YEAR - 1, reason: 'Year end' });
    assert.equal(done.status, 200, done.text); assert.ok(done.json.people >= 1);
    const after = (await call(admin, 'GET', `/self-service/leave/year-close?year=${YEAR - 1}`)).json;
    assert.ok(after.closed && after.closed.people >= 1, 'it is recorded as closed');
    const b = await vacation(ctx.tok);
    assert.equal(b.carriedOverDays, 5, 'the new year starts from the record: 20 + 3 - 18 = 5, within the cap');
    assert.equal(b.estimated, false); assert.equal(b.remainingDays, 28, '20 + 5 carried + 3 adjusted');
  });

  it('a closed year cannot be adjusted or closed twice by accident, and this year cannot be closed yet', async () => {
    const late = await adjust({ kind: 'GRANT', days: 1, year: YEAR - 1, reason: 'Too late' });
    assert.equal(late.status, 409, late.text); assert.match(late.message!, /already closed/);
    assert.equal((await call(admin, 'POST', '/self-service/leave/year-close', { year: YEAR, reason: 'Too early' })).status, 409);
  });

  it('carried days not used by the expiry date lapse', async () => {
    await setPolicy({ carryExpiry: { VACATION: '12-31' } });
    const open = await vacation(ctx.tok);
    assert.equal(open.expiredDays, 0, 'the date has not passed yet'); assert.equal(open.carryExpiresOn, `${YEAR}-12-31`);
    await setPolicy({ carryExpiry: { VACATION: '01-01' } });
    const gone = await vacation(ctx.tok);
    assert.equal(gone.expiredDays, 5, 'none of the 5 carried days were used by 1 January'); assert.equal(gone.remainingDays, 23, '20 + 3 adjusted, the carried 5 lapsed');
    await setPolicy({ carryExpiry: {} });
    assert.equal((await vacation(ctx.tok)).expiredDays, 0, 'with no date set, they never lapse');
  });

  it('a request for leave uses the balance as of its start date', async () => {
    await setPolicy({ carryExpiry: { VACATION: '01-01' } });
    const check = await call(ctx.tok, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: `${YEAR}-12-20`, endDate: `${YEAR}-12-22` });
    assert.equal(check.status, 200, check.text);
    await setPolicy({ carryExpiry: {} });
  });

  it('the editor can set the expiry date, and refuses one that is not a month-day', async () => {
    const cur = (await call(admin, 'GET', '/self-service/policy')).json;
    assert.equal((await call(admin, 'PUT', '/self-service/policy', { ...cur, carryExpiry: { VACATION: '3-31' } })).status, 400);
    const ok = await call(admin, 'PUT', '/self-service/policy', { ...cur, carryExpiry: { VACATION: '03-31' } });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.carryExpiry.VACATION, '03-31');
    await setPolicy({ carryExpiry: {} });
  });
});
