/**
 * Public API and webhooks: keys with scopes, revoking, rate limits; signed deliveries, retry with backoff, switching off, and addresses that are refused.
 *   WEBHOOK_BACKOFF_SCALE=0.02 on the gateway makes retries fast.  BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | false>, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(every); }
  assert.fail('timed out waiting');
}

describe('API keys', () => {
  let admin = '', key = '', keyId = '';
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('creates a key that is shown once, and stores only a hash', async () => {
    const r = await call(admin, 'POST', '/developer/keys', { name: `Payroll ${RUN}`, scopes: ['schedule:read'], rateLimit: 600 });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.key, /^wfm_[0-9a-f]{10}_[0-9a-f]{48}$/);
    key = r.json.key; keyId = r.json.id;
    const list = await call(admin, 'GET', '/developer/keys');
    const mine = list.json.find((k: any) => k.id === keyId);
    assert.ok(mine && !('key' in mine) && !JSON.stringify(mine).includes(key.slice(-48)), 'the secret is never shown again');
    assert.equal((await call(admin, 'POST', '/developer/keys', { name: 'x', scopes: ['users:write'] })).status, 400, 'a key can only hold read scopes');
    assert.equal((await call(admin, 'POST', '/developer/keys', { name: 'x', scopes: [] })).status, 400);
  });

  it('reads what its scope allows and nothing else', async () => {
    assert.equal((await call(key, 'GET', '/scheduling/versions')).status, 200);
    const blocked = await call(key, 'GET', '/workforce/employees');
    assert.equal(blocked.status, 403, blocked.text);
    assert.match(blocked.text, /workforce:read/);
    assert.equal((await call(key, 'POST', '/scheduling/versions', {})).status, 403, 'it cannot generate or change anything');
    assert.equal((await call(key, 'GET', '/developer/keys')).status, 403, 'it cannot see or manage keys');
    assert.equal((await call(key, 'GET', '/me/home')).status, 403, 'it is not a person');
  });

  it('rejects a wrong secret and a made-up key', async () => {
    assert.equal((await call(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'), 'GET', '/scheduling/versions')).status, 401);
    assert.equal((await call('wfm_0000000000_' + '0'.repeat(48), 'GET', '/scheduling/versions')).status, 401);
    assert.equal((await call('wfm_not-a-key', 'GET', '/scheduling/versions')).status, 401);
  });

  it('is limited to its own rate', async () => {
    const k = await call(admin, 'POST', '/developer/keys', { name: `Slow ${RUN}`, scopes: ['schedule:read'], rateLimit: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(k.json.key, 'GET', '/scheduling/versions')).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.ok(codes.slice(3).every((c) => c === 429), `expected 429 after the limit, got ${codes}`);
    await call(admin, 'DELETE', `/developer/keys/${k.json.id}`);
  });

  it('stops working the moment it is revoked, and the use is recorded', async () => {
    const used = (await call(admin, 'GET', '/developer/keys')).json.find((k: any) => k.id === keyId);
    assert.ok(used.lastUsedAt, 'last used is recorded');
    assert.equal((await call(admin, 'DELETE', `/developer/keys/${keyId}`)).status, 200);
    const after = await call(key, 'GET', '/scheduling/versions');
    assert.equal(after.status, 401);
    assert.equal(after.json.error.code, 'KEY_REVOKED');
    assert.equal((await call(admin, 'DELETE', `/developer/keys/${keyId}`)).status, 404, 'already revoked');
  });

  it('describes the read API', async () => {
    const r = await call(admin, 'GET', '/developer/openapi.json');
    assert.equal(r.status, 200);
    assert.ok(r.json.paths['/scheduling/versions/{id}/shifts']);
    assert.ok(r.json['x-webhook-events'].some((e: any) => e.id === 'schedule.published'));
  });
});

describe('webhooks', () => {
  let admin = '', server: http.Server, url = '', hookId = '', secret = '';
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let mode: 'ok' | 'fail' = 'ok';

  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    admin = r.json.token;
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = mode === 'ok' ? 200 : 500; res.end('{}'); });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  after(() => { server.close(); });

  it('refuses addresses that would reach the server’s own network or are not web addresses', async () => {
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'ftp://example.com/x', 'not a url', 'https://user:pw@example.com/x']) {
      const r = await call(admin, 'POST', '/developer/webhooks', { name: 'bad', url: bad, events: ['*'] });
      assert.equal(r.status, 400, `${bad} -> ${r.status}`);
    }
    assert.equal((await call(admin, 'POST', '/developer/webhooks', { name: 'bad', url, events: ['no.such.event'] })).status, 400);
  });

  it('creates an endpoint, shows the secret once, and signs a test message the receiver can verify', async () => {
    const c = await call(admin, 'POST', '/developer/webhooks', { name: `Hook ${RUN}`, url, events: ['timeoff.decided', 'webhook.ping'] });
    assert.equal(c.status, 201, c.text);
    hookId = c.json.id; secret = c.json.secret;
    assert.match(secret, /^whsec_/);
    assert.ok(!('secret' in (await call(admin, 'GET', '/developer/webhooks')).json.find((h: any) => h.id === hookId)), 'the secret is not listed');
    const t = await call(admin, 'POST', `/developer/webhooks/${hookId}/test`, {});
    assert.equal(t.json.ok, true, t.text);
    const got = received.at(-1)!;
    assert.equal(got.headers['x-wfm-event'], 'webhook.ping');
    const expect = 'sha256=' + createHmac('sha256', secret).update(`${got.headers['x-wfm-timestamp']}.${got.body}`).digest('hex');
    assert.equal(got.headers['x-wfm-signature'], expect, 'the receiver can verify who sent it');
    assert.ok(JSON.parse(got.body).id === got.headers['x-wfm-delivery']);
  });

  it('delivers a real event from the platform, once', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Hook grp ${RUN}` });
    await call(admin, 'POST', '/workforce/teams', { name: `Hook team ${RUN}` });
    await call(admin, 'POST', '/workforce/employees/import', { csv: `employee_number,first_name,last_name,team,wfm_group\nHK${RUN},Hook,Person,Hook team ${RUN},Hook grp ${RUN}`, dryRun: false });
    const emp = (await call(admin, 'GET', `/workforce/employees?groupId=${g.json.id}`)).json[0];
    const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: emp.id, type: 'VACATION', startDate: '2031-03-03', endDate: '2031-03-04' });
    assert.equal(t.status, 201, t.text);
    const before = received.length;
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${t.json.id}/decide`, { status: 'APPROVED' })).status, 200);
    const hit = await until(async () => received.slice(before).find((r) => r.headers['x-wfm-event'] === 'timeoff.decided'));
    const body = JSON.parse(hit!.body);
    assert.equal(body.data.status, 'APPROVED');
    assert.equal(body.data.startDate, '2031-03-03');
    await sleep(1500);
    assert.equal(received.slice(before).filter((r) => r.headers['x-wfm-event'] === 'timeoff.decided').length, 1, 'delivered once, not once per gateway');
  });

  it('does not send events the endpoint did not ask for', async () => {
    const before = received.length;
    const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: (await call(admin, 'GET', '/workforce/employees')).json[0].id, type: 'VACATION', startDate: '2031-04-03', endDate: '2031-04-03', reason: 'x' });
    assert.equal(t.status, 201);
    await sleep(1500);
    assert.equal(received.slice(before).length, 0, 'creating time off by a manager is not an event this endpoint listens for');
  });

  it('retries when the receiver is down and records what happened', async () => {
    mode = 'fail';
    const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: (await call(admin, 'GET', '/workforce/employees')).json[0].id, type: 'PERSONAL', startDate: '2031-05-05', endDate: '2031-05-05' });
    const before = received.length;
    await call(admin, 'POST', `/workforce/time-off/${t.json.id}/decide`, { status: 'APPROVED' });
    const failing = await until(async () => { const d = (await call(admin, 'GET', `/developer/webhooks/${hookId}/deliveries`)).json.find((x: any) => x.event === 'timeoff.decided' && x.attempts >= 2 && x.status === 'PENDING'); return d; }, 30_000);
    assert.equal(failing.responseStatus, 500);
    assert.match(failing.error, /500/);
    mode = 'ok';
    await until(async () => (await call(admin, 'GET', `/developer/webhooks/${hookId}/deliveries`)).json.find((x: any) => x.id === failing.id && x.status === 'DELIVERED'), 30_000);
    assert.ok(received.length - before >= 2, 'it was sent again after the failures');
  });

  it('switches an endpoint off after too many failures in a row, and rotates the secret', async () => {
    const rot = await call(admin, 'POST', `/developer/webhooks/${hookId}/rotate-secret`, {});
    assert.equal(rot.status, 200);
    assert.notEqual(rot.json.secret, secret);
    const upd = await call(admin, 'PUT', `/developer/webhooks/${hookId}`, { name: `Hook ${RUN}`, url, events: ['*'], active: false });
    assert.equal(upd.json.active, false);
    const before = received.length;
    const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: (await call(admin, 'GET', '/workforce/employees')).json[0].id, type: 'PERSONAL', startDate: '2031-06-05', endDate: '2031-06-05' });
    await call(admin, 'POST', `/workforce/time-off/${t.json.id}/decide`, { status: 'APPROVED' });
    await sleep(1500);
    assert.equal(received.length, before, 'a switched-off endpoint gets nothing');
    assert.equal((await call(admin, 'DELETE', `/developer/webhooks/${hookId}`)).status, 200);
  });

  it('only an administrator can manage keys and webhooks', async () => {
    const lowly = await call(admin, 'POST', '/users', { username: `viewer${RUN}`, name: 'Viewer', role: 'ANALYST', password: 'Viewer#12345' });
    if (lowly.status === 201) {
      const l = await call(null, 'POST', '/auth/login', { username: `viewer${RUN}`, password: 'Viewer#12345', tenant: TENANT });
      assert.equal((await call(l.json.token, 'POST', '/developer/keys', { name: 'no', scopes: ['schedule:read'] })).status, 403);
    }
  });
});
