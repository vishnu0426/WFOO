/**
 * Staffing results say whether the target was met, and chat efficiency is the group's own. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/staffingStatus.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe('staffing results through the gateway', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', group: any;
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Chat ${RUN}` })).json;
    assert.ok(group.id, JSON.stringify(group));
  });
  const trace = (over: object = {}) => call(admin, 'POST', '/forecast/trace-staffing', { groupId: group.id, channel: 'chat', volume: 180, ahtSec: 600, ...over });

  it('a new group has the default chat efficiency, shown on the group', async () => {
    assert.equal(group.chatEfficiency, 0.85);
  });

  it('refuses a chat efficiency outside 0.3 to 1', async () => {
    assert.equal((await call(admin, 'PUT', `/config/groups/${group.id}`, { chatEfficiency: 1.5 })).status, 400);
    assert.equal((await call(admin, 'PUT', `/config/groups/${group.id}`, { chatEfficiency: 0.1 })).status, 400);
  });

  it('the group own chat efficiency decides how many agents chat needs', async () => {
    const q = await call(admin, 'POST', '/config/queues', { name: `Chat q ${RUN}`, channel: 'CHAT', wfmGroupId: group.id, ahtDefault: 600, concurrency: 3 });
    assert.ok([200, 201].includes(q.status), q.text);
    const base = (await trace()).json;
    assert.equal(base.chatEfficiency, 0.85);
    assert.ok(base.targetMet, 'an ordinary load reaches its target');
    assert.equal(base.status, 'OK');
    assert.ok(base.offeredLoadErlangs > 0);
    const up = await call(admin, 'PUT', `/config/groups/${group.id}`, { chatEfficiency: 0.6, reason: 'measured chat productivity' });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.chatEfficiency, 0.6);
    const poor = (await trace()).json;
    assert.equal(poor.chatEfficiency, 0.6);
    assert.ok(poor.offeredLoadErlangs > base.offeredLoadErlangs, 'chats at once cost more when agents handle them less well');
    assert.ok(poor.agents >= base.agents);
    await call(admin, 'PUT', `/config/groups/${group.id}`, { chatEfficiency: 1, reason: 'test' });
    const full = (await trace()).json;
    assert.ok(full.offeredLoadErlangs < base.offeredLoadErlangs);
  });

  it('a request the engine refuses comes back as a clear error, not a number', async () => {
    const r = await trace({ occupancyCap: 0.31 });          // allowed by the gateway
    assert.equal(r.status, 200, r.text);
    const bad = await call(admin, 'POST', '/forecast/trace-staffing', { groupId: group.id, channel: 'voice', volume: 100, ahtSec: 300, occupancyCap: 1.3 });
    assert.equal(bad.status, 400);
  });
});
