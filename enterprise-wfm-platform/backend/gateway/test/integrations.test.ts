/**
 * Integration Station end to end: connector creation, entity matching, a historical backfill routed through the
 * same staged-import review a human's CSV upload goes through, live agent-state sync, and webhook signature
 * verification. Everything here calls our own real endpoints against the throwaway test database -- there is no
 * live Genesys/Amazon Connect/Salesforce account to test against, consistent with the plan's honesty note.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...extraHeaders, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const ctx: Record<string, any> = {};
let admin = '';

describe('Integration Station', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); admin = r.json.token; });

  it('lists the catalogue with real per-vendor fields, not a generic list', async () => {
    const r = await call(admin, 'GET', '/integrations/catalog');
    assert.equal(r.status, 200, r.text);
    const genesys = r.json.ACD.find((p: any) => p.id === 'GENESYS_CLOUD');
    assert.ok(genesys, 'Genesys Cloud preset present');
    assert.ok(genesys.fields.some((f: any) => f.key === 'clientId'));
    assert.ok(genesys.fields.some((f: any) => f.key === 'divisionId'));
    const adp = r.json.HRMS.find((p: any) => p.id === 'ADP');
    assert.ok(adp.fields.some((f: any) => f.kind === 'file'), 'ADP asks for a certificate file, not just a password');
  });

  it('prepares a group, a queue and an employee to match against', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Integ ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const q = await call(admin, 'POST', '/config/queues', { name: `Support Voice ${RUN}`, channel: 'VOICE', wfmGroupId: ctx.group.id, ahtDefault: 300 });
    assert.equal(q.status, 201, q.text); ctx.queue = q.json;
    await call(admin, 'POST', '/workforce/teams', { name: `Integ team ${RUN}` });
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: `employee_number,first_name,last_name,team\nIG${RUN},Ivy,Grant,Integ team ${RUN}`, dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    ctx.employee = (await call(admin, 'GET', '/workforce/employees')).json.find((e: any) => e.employeeNumber === `IG${RUN}`);
  });

  it('creates a generic ACD connector, returns the API key once, and redacts it from then on', async () => {
    const r = await call(admin, 'POST', '/integrations', { category: 'ACD', preset: 'GENERIC_ACD_API', name: `Test ACD ${RUN}`, wfmGroupId: ctx.group.id, config: { apiKey: 'vendor-key-xyz', baseUrl: 'https://acd.example.com', volumeEndpoint: '/api/history' } });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.apiKey, 'the connector API key is returned once on creation');
    ctx.connector = r.json; ctx.connectorKey = r.json.apiKey;
    const list = await call(admin, 'GET', `/integrations?groupId=${ctx.group.id}`);
    const found = list.json.find((c: any) => c.id === ctx.connector.id);
    assert.equal(found.config.apiKey, '••••••••', 'the secret is redacted once saved');
  });

  it('rejects a connector missing a required field for its preset', async () => {
    const r = await call(admin, 'POST', '/integrations', { category: 'ACD', preset: 'GENESYS_CLOUD', name: `Bad ${RUN}`, config: { clientId: 'x' } }); // missing clientSecret, region
    assert.equal(r.status, 400, r.text);
  });

  it('suggests a queue match by name and saves it', async () => {
    const s = await call(admin, 'POST', `/integrations/${ctx.connector.id}/entity-matches/suggest`, { entityType: 'queue', seen: [{ sourceId: '8892', sourceLabel: `Support Voice ${RUN} (vendor)` }] });
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json[0].targetId, ctx.queue.id);
    const save = await call(admin, 'PUT', `/integrations/${ctx.connector.id}/entity-matches`, { entityType: 'queue', matches: [{ sourceId: '8892', sourceLabel: `Support Voice ${RUN}`, targetId: ctx.queue.id }] });
    assert.equal(save.status, 200, save.text);
  });

  it('sets field maps for its own raw payload shape', async () => {
    const r = await call(admin, 'PUT', `/integrations/${ctx.connector.id}/field-maps`, [
      { targetField: 'day', sourcePath: 'date' }, { targetField: 'time', sourcePath: 'intervalStart' },
      { targetField: 'volume', sourcePath: 'stats.offered' }, { targetField: 'ahtSec', sourcePath: 'stats.ahtMs', transform: 'ms_to_s' },
    ]);
    assert.equal(r.status, 200, r.text);
  });

  it('runs a historical backfill through the same staged-import review a CSV upload goes through', async () => {
    const day = iso(new Date());
    const rows = [
      { queueId: '8892', date: day, intervalStart: '09:00', stats: { offered: 42, ahtMs: 305000 } },
      { queueId: '8892', date: day, intervalStart: '09:15', stats: { offered: 55, ahtMs: 298000 } },
    ];
    const bad = await call(null, 'POST', `/integrations/${ctx.connector.id}/backfill`, { rows, through: day }); // no key at all
    assert.equal(bad.status, 400, bad.text);
    const wrongKey = await call(null, 'POST', `/integrations/${ctx.connector.id}/backfill`, { rows, through: day }, { Authorization: 'Bearer not-the-real-key' });
    assert.equal(wrongKey.status, 404, wrongKey.text);

    const r = await call(null, 'POST', `/integrations/${ctx.connector.id}/backfill`, { rows, through: day }, { Authorization: `Bearer ${ctx.connectorKey}` });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.rowsMapped, 2);
    assert.equal(r.json.staged.status, 'READY');
    ctx.jobId = r.json.staged.id;
  });

  it('the backfilled job commits into real interval history like any staged import', async () => {
    const c = await call(admin, 'POST', `/data/imports/${ctx.jobId}/commit`);
    assert.equal(c.status, 200, c.text);
    assert.equal(c.json.createdRecords, 2, c.text);
  });

  it('creates an agent-state connector and syncs live agent state through it', async () => {
    const r = await call(admin, 'POST', '/integrations', { category: 'CRM', preset: 'SALESFORCE', name: `Test SF ${RUN}`, config: { clientId: 'c', clientSecret: 's', instanceUrl: 'https://x.my.salesforce.com', runAsUsername: 'integration@example.com' } });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.apiKey, 'API_PULL presets get a key too, for a manual test push or a future scheduled poll job');
    const connectorId = r.json.id, key = r.json.apiKey;
    await call(admin, 'PUT', `/integrations/${connectorId}/field-maps`, [{ targetField: 'employeeNumber', sourcePath: 'agentCode' }, { targetField: 'state', sourcePath: 'presenceStatus' }]);

    const live = await call(null, 'POST', `/integrations/${connectorId}/live`, { rows: [{ agentCode: `IG${RUN}`, presenceStatus: 'Available' }] }, { Authorization: `Bearer ${key}` });
    assert.equal(live.status, 200, live.text);
    assert.equal(live.json.kind, 'agent_state');
    assert.equal(live.json.accepted, 1, JSON.stringify(live.json));
  });

  it('creates a webhook connector and verifies its HMAC signature', async () => {
    const r = await call(admin, 'POST', '/integrations', { category: 'CRM', preset: 'SALESFORCE-WEBHOOK', name: `Test SF Webhook ${RUN}`, config: {} });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.webhookSecret, 'a webhook secret is returned once');
    const connectorId = r.json.id, secret = r.json.webhookSecret;
    await call(admin, 'PUT', `/integrations/${connectorId}/field-maps`, [{ targetField: 'employeeNumber', sourcePath: 'employeeNumber' }, { targetField: 'state', sourcePath: 'state' }]);

    const payload = { employeeNumber: `IG${RUN}`, state: 'Available' };
    const body = JSON.stringify(payload);
    const goodSig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

    const wrong = await fetch(`${BASE}/api/v1/integrations/${connectorId}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'deadbeef'.repeat(8) }, body });
    assert.equal(wrong.status, 400, await wrong.text());

    const ok = await fetch(`${BASE}/api/v1/integrations/${connectorId}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': goodSig }, body });
    const okText = await ok.text();
    assert.equal(ok.status, 200, okText);
    const j = JSON.parse(okText) as { accepted: number };
    assert.equal(j.accepted, 1, okText);
  });

  it('deletes a connector and its field/entity maps cascade away', async () => {
    const r = await call(admin, 'DELETE', `/integrations/${ctx.connector.id}`);
    assert.equal(r.status, 200, r.text);
    const maps = await call(admin, 'GET', `/integrations/${ctx.connector.id}/field-maps`);
    assert.deepEqual(maps.json, []);
  });
});
