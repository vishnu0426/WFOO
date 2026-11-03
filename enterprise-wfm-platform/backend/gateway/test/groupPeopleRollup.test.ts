/**
 * The per-group people counts (migration 061) must equal a fresh count however people got in, changed or left, and the WFM Groups list must read them.
 *   DATABASE_URL=... BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/groupPeopleRollup.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const RUN = Date.now().toString(36);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

describe('per-group people counts', { skip: !process.env.ADMIN_PASSWORD || !process.env.DATABASE_URL }, () => {
  let admin = '', tenantId = '';
  const groups: string[] = [];
  const sql = async (text: string, params: unknown[] = []) => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };
  const counts = async (g: string) => (await sql('SELECT people, primary_people FROM group_people WHERE group_id = $1', [g]))[0] ?? { people: 0, primary_people: 0 };
  const exact = async (label: string) => {
    for (const g of groups) {
      const fresh = (await sql(`SELECT (SELECT count(*)::int FROM employees WHERE tenant_id = $2 AND status <> 'TERMINATED' AND eligible_group_ids @> ARRAY[$1::uuid]) AS people,
                                       (SELECT count(*)::int FROM employees WHERE tenant_id = $2 AND status <> 'TERMINATED' AND primary_group_id = $1) AS prim`, [g, tenantId]))[0];
      const kept = await counts(g);
      assert.deepEqual({ people: kept.people, primary: kept.primary_people }, { people: fresh.people, primary: fresh.prim }, `${label}: group ${g}`);
    }
  };

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT })).json.token;
    tenantId = (await sql('SELECT id FROM tenants LIMIT 1'))[0].id;
    for (const n of ['A', 'B', 'C']) {
      const g = await call(admin, 'POST', '/config/groups', { name: `GP ${n} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
      assert.equal(g.status, 201, g.text); groups.push(g.json.id);
    }
  });

  it('is exact after people arrive by file, change group, are terminated, come back and are deleted', async () => {
    const nl = String.fromCharCode(10);
    const lines = ['employee_number,first_name,last_name,employment_type,weekly_hours,days_per_week,wfm_group'];
    for (let i = 1; i <= 12; i++) lines.push(`GP${RUN}-${i},Gp${i},Roll${i},FULL_TIME,40,5,GP A ${RUN}`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join(nl), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    await exact('after the import');
    assert.equal((await counts(groups[0])).primary_people, 12);

    await sql(`UPDATE employees SET primary_group_id = $2, eligible_group_ids = ARRAY[$2::uuid] WHERE tenant_id = $1 AND employee_number LIKE $3 AND (right(employee_number, 1))::int % 2 = 0`, [tenantId, groups[1], `GP${RUN}-%`]);
    await exact('after some moved to another group');
    await sql(`UPDATE employees SET eligible_group_ids = eligible_group_ids || $2::uuid WHERE tenant_id = $1 AND employee_number LIKE $3`, [tenantId, groups[2], `GP${RUN}-%`]);
    await exact('after everyone was also made eligible for a third group');
    await sql(`UPDATE employees SET phone = '123' WHERE tenant_id = $1 AND employee_number LIKE $2`, [tenantId, `GP${RUN}-%`]);
    await exact('after an unrelated edit');
    await sql(`UPDATE employees SET status = 'TERMINATED' WHERE tenant_id = $1 AND employee_number LIKE $2 AND (right(employee_number, 1))::int <= 3`, [tenantId, `GP${RUN}-%`]);
    await exact('after some left');
    await sql(`UPDATE employees SET status = 'ACTIVE' WHERE tenant_id = $1 AND employee_number = $2`, [tenantId, `GP${RUN}-1`]);
    await exact('after one came back');
    await sql(`DELETE FROM employees WHERE tenant_id = $1 AND employee_number LIKE $2 AND (right(employee_number, 1))::int >= 8`, [tenantId, `GP${RUN}-%`]);
    await exact('after some were deleted');
  });

  it('is what the WFM Groups list reports, and the list stays quick with a lot of people', async () => {
    const s = (await call(admin, 'GET', '/config/groups/summary')).json;
    for (const g of groups) { const k = await counts(g); assert.equal(s[g].people, k.people); assert.equal(s[g].primaryPeople, k.primary_people); }
    const t: number[] = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); assert.equal((await call(admin, 'GET', '/config/groups/summary')).status, 200); t.push(performance.now() - t0); }
    t.sort((a, b) => a - b);
    assert.ok(t[2] < 120, `the list took ${Math.round(t[2])} ms (median of 5)`);
  });
});
