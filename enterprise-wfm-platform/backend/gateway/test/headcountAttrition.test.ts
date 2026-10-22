/**
 * The attrition estimate behind the headcount plan: a real trailing-12-month figure from the audit trail's own
 * status-change history, not a guess.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

const ctx: Record<string, any> = {};
let admin = '';

describe('headcount attrition estimate', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); admin = r.json.token; });

  it('prepares a group with four active people', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Attr ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    await call(admin, 'POST', '/workforce/teams', { name: `Attr team ${RUN}` });
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours'];
    for (let i = 1; i <= 4; i++) lines.push(`AT${RUN}-${i},Attr${i},Person${i},Attr team ${RUN},Attr ${RUN},FULL_TIME,40`);
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false })).json.committed, true);
    ctx.emps = (await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json;
    assert.equal(ctx.emps.length, 4);
  });

  it('starts at zero attrition with nobody terminated', async () => {
    const r = await call(admin, 'GET', `/workforce/attrition?groupId=${ctx.group.id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.currentHeadcount, 4);
    assert.equal(r.json.terminatedTrailing12mo, 0);
    assert.equal(r.json.estimatedAnnualPct, 0);
  });

  it('picks up a real termination from the audit trail and recomputes the rate', async () => {
    const upd = await call(admin, 'PUT', `/workforce/employees/${ctx.emps[0].id}`, { status: 'TERMINATED' });
    assert.equal(upd.status, 200, upd.text);
    const r = await call(admin, 'GET', `/workforce/attrition?groupId=${ctx.group.id}`);
    assert.equal(r.json.currentHeadcount, 3, 'one fewer active person');
    assert.equal(r.json.terminatedTrailing12mo, 1);
    assert.equal(r.json.estimatedAnnualPct, Math.round((1 / 3) * 1000) / 10);
  });

  it('does not count an unrelated field edit as a termination', async () => {
    await call(admin, 'PUT', `/workforce/employees/${ctx.emps[1].id}`, { phone: '555-0100' });
    const r = await call(admin, 'GET', `/workforce/attrition?groupId=${ctx.group.id}`);
    assert.equal(r.json.terminatedTrailing12mo, 1, 'still just the one real termination');
  });
});
