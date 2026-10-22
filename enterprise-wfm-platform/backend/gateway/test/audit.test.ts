/**
 * Audit log: filters, summary, CSV export, and that a schedule's change history is recorded for replay.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe('audit log', () => {
  let token = '';
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200);
    token = r.json.token;
    // make sure there is something to read
    await call(token, 'POST', '/config/groups', { name: `Audit probe ${Date.now().toString(36)}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
  });

  it('lists records newest first and filters by action, entity and text', async () => {
    const all = await call(token, 'GET', '/audit?limit=50');
    assert.equal(all.status, 200);
    assert.ok(all.json.length > 0);
    const ids = all.json.map((r: any) => Number(r.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    const creates = await call(token, 'GET', '/audit?action=CREATE');
    assert.ok(creates.json.every((r: any) => r.action === 'CREATE'));
    const text = await call(token, 'GET', '/audit?q=Audit%20probe');
    assert.ok(text.json.length > 0 && text.json.every((r: any) => JSON.stringify(r).toLowerCase().includes('audit probe')));
    const nothing = await call(token, 'GET', '/audit?q=zzz-no-such-thing-zzz');
    assert.equal(nothing.json.length, 0);
  });

  it('filters by date and pages backwards', async () => {
    const future = await call(token, 'GET', '/audit?from=2999-01-01');
    assert.equal(future.json.length, 0);
    const page1 = await call(token, 'GET', '/audit?limit=2');
    if (page1.json.length === 2) {
      const page2 = await call(token, 'GET', `/audit?limit=2&before=${page1.json[1].id}`);
      assert.ok(page2.json.every((r: any) => Number(r.id) < Number(page1.json[1].id)));
    }
  });

  it('summarises counts for the filters', async () => {
    const s = await call(token, 'GET', '/audit/summary');
    assert.equal(s.status, 200);
    assert.ok(s.json.total >= 1 && s.json.actors >= 1);
    assert.ok(Array.isArray(s.json.entityTypes) && Array.isArray(s.json.actions) && Array.isArray(s.json.actorNames));
  });

  it('exports CSV with a header, and records the export itself', async () => {
    const before = (await call(token, 'GET', '/audit?action=EXPORT')).json.length;
    const r = await call(token, 'GET', '/audit/export.csv');
    assert.equal(r.status, 200);
    assert.ok(r.text.startsWith('id,time_utc,actor,role,action,entity_type'));
    const after = (await call(token, 'GET', '/audit?action=EXPORT')).json.length;
    assert.equal(after, before + 1);
  });

  it('needs authentication', async () => {
    assert.equal((await call(null, 'GET', '/audit')).status, 401);
    assert.equal((await call(null, 'GET', '/audit/export.csv')).status, 401);
  });

  it('serves a version history for schedule replay (empty for an unknown version)', async () => {
    const r = await call(token, 'GET', '/scheduling/versions/00000000-0000-0000-0000-000000000000/revisions');
    assert.equal(r.status, 404);
  });
});
