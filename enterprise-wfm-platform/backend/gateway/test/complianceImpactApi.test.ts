/**
 * 'How many people would this touch' before a pack is chosen for a place: the whole organisation, a team, a WFM group, one person; and that a choice can be saved, replaced and removed.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test-force-exit --test test/complianceImpactApi.test.ts
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

describe('compliance pack impact', { skip: !PASSWORD }, () => {
  let admin = '', group: any, team: any;
  const people: any[] = [];
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Impact ${RUN}` })).json;
    team = (await call(admin, 'POST', '/workforce/teams', { name: `Impact team ${RUN}` })).json;
    for (let i = 1; i <= 3; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `IM${RUN}-${i}`, firstName: `Im${i}`, lastName: `Act${RUN}`, primaryGroupId: group.id, teamId: i <= 2 ? team.id : undefined });
      assert.equal(e.status, 201, e.text); people.push(e.json);
    }
  });
  const impact = async (q: string) => call(admin, 'GET', `/compliance/impact?${q}`);

  it('counts the people in a team, a WFM group, the organisation and one person', async () => {
    assert.equal((await impact(`scopeType=TEAM&scopeId=${team.id}`)).json.people, 2);
    assert.equal((await impact(`scopeType=GROUP&scopeId=${group.id}`)).json.people, 3);
    assert.equal((await impact(`scopeType=EMPLOYEE&scopeId=${people[0].id}`)).json.people, 1);
    assert.ok((await impact('scopeType=TENANT')).json.people >= 3, 'everyone, at least these three');
  });
  it('a region or a site with nobody in it counts zero, and a place that is not named is refused', async () => {
    assert.equal((await impact('scopeType=SITE&scopeId=00000000-0000-4000-8000-000000000000')).json.people, 0);
    assert.equal((await impact('scopeType=TEAM')).status, 400);
    assert.equal((await impact('scopeType=PLANET')).status, 400);
  });
  it('a person who has left is not counted', async () => {
    const before = (await impact(`scopeType=GROUP&scopeId=${group.id}`)).json.people;
    const r = await call(admin, 'PUT', `/workforce/employees/${people[2].id}`, { status: 'TERMINATED', reason: 'Left' });
    if (r.status === 200) assert.equal((await impact(`scopeType=GROUP&scopeId=${group.id}`)).json.people, before - 1);
  });
  it('a pack can be chosen for a team, replaced by another, and removed', async () => {
    const packs = (await call(admin, 'GET', '/compliance/packs')).json;
    const [a, b] = [packs.find((p: any) => p.code === 'EU_WTD'), packs.find((p: any) => p.code === 'IN_OSH_2020')];
    const put = (packId: string | null) => call(admin, 'PUT', '/compliance/assignments', { scopeType: 'TEAM', scopeId: team.id, packId });
    assert.equal((await put(a.id)).status, 200);
    const mine = async () => (await call(admin, 'GET', '/compliance/assignments')).json.filter((x: any) => x.scopeId === team.id);
    assert.deepEqual((await mine()).map((x: any) => x.packName), [a.name]);
    assert.equal((await put(b.id)).status, 200);
    assert.deepEqual((await mine()).map((x: any) => x.packName), [b.name], 'replaced, not added');
    assert.equal((await put(null)).status, 200);
    assert.deepEqual(await mine(), []);
  });
});
