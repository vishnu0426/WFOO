/**
 * Secrets at rest. The first block needs nothing running. The second looks inside the database to prove that what is stored is ciphertext, and needs DATABASE_URL
 * pointing at the gateway's database as well as the usual BASE_URL / ADMIN_PASSWORD / TENANT.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { decrypt, encrypt, isCurrent, isEncrypted, open } from '../src/secrets.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB = process.env.DATABASE_URL || '';
const RUN = Date.now().toString(36);

describe('the encryption', () => {
  it('round-trips, and never stores the text it was given', () => {
    const e = encrypt('hunter2-super-secret');
    assert.ok(isEncrypted(e) && !e.includes('hunter2'));
    assert.equal(decrypt(e), 'hunter2-super-secret');
    assert.ok(isCurrent(e));
    assert.equal(decrypt(encrypt('é日本語 + emoji 🔐')), 'é日本語 + emoji 🔐');
  });
  it('uses a fresh nonce every time, so the same secret looks different each time it is saved', () => {
    assert.notEqual(encrypt('same'), encrypt('same'));
    assert.equal(decrypt(encrypt('same')), decrypt(encrypt('same')));
  });
  it('detects tampering instead of returning garbage', () => {
    const e = encrypt('payroll-password');
    const flipped = e.slice(0, -3) + (e.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.throws(() => decrypt(flipped), /cannot be read/);
    assert.equal(open(flipped), '', 'open() turns an unreadable value into "not set" rather than throwing');
    assert.equal(open('enc:v1:deadbeef:AAAA'), '');
  });
  it('lets plain text from an older version through, leaves empty alone and never encrypts twice', () => {
    assert.equal(decrypt('legacy-plain'), 'legacy-plain');
    assert.equal(open('legacy-plain'), 'legacy-plain');
    assert.equal(encrypt(''), '');
    assert.equal(open(null), '');
    const e = encrypt('x');
    assert.equal(encrypt(e), e);
    assert.equal(isCurrent('legacy-plain'), false);
  });
  it('a rotation works: the new key reads what the old one wrote only if the old key is kept as previous, and everything is current under the new one', () => {
    const run = (env: Record<string, string>, code: string) => execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { env: { ...process.env, DATABASE_URL: 'postgres://x', JWT_SECRET: 'a-test-jwt-secret-that-is-long', ...env }, cwd: process.cwd(), encoding: 'utf8' }).trim().split('\n').at(-1)!;
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    const stored = run({ SECRETS_KEY: A }, "import('./src/secrets.ts').then(m => console.log(m.encrypt('rotate-me')))");
    assert.ok(stored.startsWith('enc:v1:'));
    const withPrev = run({ SECRETS_KEY: B, SECRETS_KEY_PREVIOUS: A }, `import('./src/secrets.ts').then(m => console.log(m.open(${JSON.stringify(stored)}) + '|' + m.isCurrent(${JSON.stringify(stored)})))`);
    assert.equal(withPrev, 'rotate-me|false', 'readable, but not yet under the new key');
    const without = run({ SECRETS_KEY: B }, `import('./src/secrets.ts').then(m => console.log(JSON.stringify(m.open(${JSON.stringify(stored)}))))`);
    assert.equal(without, '""', 'without the old key it is unreadable, and says so by being empty');
    const derived = run({ SECRETS_KEY: '' }, "import('./src/secrets.ts').then(m => console.log(m.encrypt('from-jwt')))");
    const upgraded = run({ SECRETS_KEY: B }, `import('./src/secrets.ts').then(m => console.log(m.open(${JSON.stringify(derived)})))`);
    assert.equal(upgraded, 'from-jwt', 'switching on SECRETS_KEY later still reads what was encrypted with the derived key');
    const pass = run({ SECRETS_KEY: 'a long passphrase that is not hex' }, "import('./src/secrets.ts').then(m => console.log(m.open(m.encrypt('pp'))))");
    assert.equal(pass, 'pp', 'a passphrase works as a key too');
  });
});

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe('what is in the database', { skip: !DB || !PASSWORD ? 'needs DATABASE_URL and ADMIN_PASSWORD' : false }, () => {
  let admin = '', pool: pg.Pool, orgId = '';
  const sql = async (q: string, p: unknown[] = []) => (await pool.query(q, p)).rows;
  before(async () => {
    pool = new pg.Pool({ connectionString: DB, options: '-c search_path=wfm,public' });
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    orgId = (await sql('SELECT id FROM tenants WHERE lower(code) = lower($1)', [TENANT]))[0].id;
  });
  after(() => pool.end());

  it('stores the mail password and SMS gateway headers as ciphertext, and shows them to nobody', async () => {
    const r = await call(admin, 'PUT', '/channels/settings', {
      email: { enabled: false, provider: 'SMTP', from: 'a@b.c', values: { host: 'mail.example.com', port: '587', security: 'AUTO', user: 'u', pass: 'Plain-Mail-Password-123' } },
      sms: { enabled: false, provider: 'HTTP', values: { url: 'https://sms.example.com/s', headers: 'Authorization: Bearer PLAIN-SMS-TOKEN-456' } }, defaults: {},
    });
    assert.equal(r.status, 200, r.text);
    const row = (await sql('SELECT email, sms FROM channel_settings WHERE org_id = $1', [orgId]))[0];
    const dump = JSON.stringify(row);
    assert.ok(!dump.includes('Plain-Mail-Password-123') && !dump.includes('PLAIN-SMS-TOKEN-456'), 'no secret appears in the stored row');
    assert.ok(row.email.values.pass.startsWith('enc:v1:') && row.sms.values.headers.startsWith('enc:v1:'));
    assert.equal(row.email.values.host, 'mail.example.com', 'only the secrets are encrypted; the rest stays readable');
    assert.ok(!r.text.includes('Plain-Mail-Password') && r.json.email.saved.pass === true);
  });

  it('keeps a secret that was left empty on the next save, still encrypted, and still readable by the sender', async () => {
    const before = (await sql('SELECT email FROM channel_settings WHERE org_id = $1', [orgId]))[0].email.values.pass;
    const r = await call(admin, 'PUT', '/channels/settings', { email: { enabled: false, provider: 'SMTP', from: 'a@b.c', values: { host: 'mail.example.com', port: '587', security: 'AUTO', user: 'u', pass: '' } }, sms: { enabled: false, provider: 'HTTP', values: {} }, defaults: {} });
    assert.equal(r.status, 200, r.text);
    const after = (await sql('SELECT email FROM channel_settings WHERE org_id = $1', [orgId]))[0].email.values.pass;
    assert.ok(after.startsWith('enc:v1:'));
    assert.equal(decrypt(after), 'Plain-Mail-Password-123', 'the saved password survived the empty box');
    assert.notEqual(after, before, 'and it was written afresh with a new nonce');
  });

  it('stores webhook signing secrets as ciphertext yet still signs with the right one', async () => {
    const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.end('{}'); }); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const c = await call(admin, 'POST', '/developer/webhooks', { name: `Enc ${RUN}`, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/h`, events: ['webhook.ping'] });
      assert.equal(c.status, 201, c.text);
      const shown = c.json.secret as string;
      assert.match(shown, /^whsec_/, 'the person is shown the real secret once');
      const stored = (await sql('SELECT secret FROM webhook_endpoints WHERE id = $1', [c.json.id]))[0].secret as string;
      assert.ok(stored.startsWith('enc:v1:') && !stored.includes(shown.slice(6)));
      assert.equal((await call(admin, 'POST', `/developer/webhooks/${c.json.id}/test`, {})).json.ok, true);
      const m = got.at(-1)!;
      assert.equal(m.headers['x-wfm-signature'], `sha256=${createHmac('sha256', shown).update(`${m.headers['x-wfm-timestamp']}.${m.body}`).digest('hex')}`, 'signed with the secret that was shown');
      // an older plain-text secret still signs, and is encrypted by the re-encryption pass
      await sql("UPDATE webhook_endpoints SET secret = 'whsec_legacy_plain' WHERE id = $1", [c.json.id]);
      const st = await call(admin, 'GET', '/security/secrets');
      assert.equal(st.status, 200);
      assert.ok(st.json.plain >= 1 && st.json.allProtected === false, 'the status says something is still plain');
      await call(admin, 'POST', `/developer/webhooks/${c.json.id}/test`, {});
      const m2 = got.at(-1)!;
      assert.equal(m2.headers['x-wfm-signature'], `sha256=${createHmac('sha256', 'whsec_legacy_plain').update(`${m2.headers['x-wfm-timestamp']}.${m2.body}`).digest('hex')}`, 'a plain-text secret keeps working');
      const re = await call(admin, 'POST', '/security/secrets/reencrypt', {});
      assert.equal(re.status, 200, re.text);
      assert.ok(re.json.rewritten.webhooks >= 1);
      assert.ok(((await sql('SELECT secret FROM webhook_endpoints WHERE id = $1', [c.json.id]))[0].secret as string).startsWith('enc:v1:'));
      await call(admin, 'POST', `/developer/webhooks/${c.json.id}/test`, {});
      const m3 = got.at(-1)!;
      assert.equal(m3.headers['x-wfm-signature'], `sha256=${createHmac('sha256', 'whsec_legacy_plain').update(`${m3.headers['x-wfm-timestamp']}.${m3.body}`).digest('hex')}`, 'the same secret, now encrypted, still signs the same way');
      const rot = await call(admin, 'POST', `/developer/webhooks/${c.json.id}/rotate-secret`, {});
      assert.ok(rot.json.secret.startsWith('whsec_') && ((await sql('SELECT secret FROM webhook_endpoints WHERE id = $1', [c.json.id]))[0].secret as string).startsWith('enc:v1:'));
      await call(admin, 'DELETE', `/developer/webhooks/${c.json.id}`);
    } finally { srv.close(); }
  });

  it('stores the single sign-on client secret as ciphertext', async () => {
    const issuer = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ issuer: 'http://x', authorization_endpoint: 'http://x/a', token_endpoint: 'http://x/t', jwks_uri: 'http://x/k' })); });
    await new Promise<void>((ok) => issuer.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
      const r = await call(admin, 'PUT', '/sso/config', { name: 'x', issuer: url, clientId: 'cid', clientSecret: 'SSO-PLAIN-SECRET-789', enabled: false });
      assert.equal(r.status, 200, r.text);
      const row = (await sql('SELECT client_secret FROM sso_providers WHERE tenant_id = $1', [orgId]))[0];
      assert.ok(row.client_secret.startsWith('enc:v1:') && !row.client_secret.includes('SSO-PLAIN'));
      assert.equal(r.json.hasSecret, true);
      assert.equal((await call(admin, 'PUT', '/sso/config', { name: 'x', issuer: url, clientId: 'cid', enabled: false })).json.hasSecret, true, 'left empty, the saved secret is kept');
    } finally { issuer.close(); }
  });

  it('stores connector credentials as ciphertext and still redacts them on screen', async () => {
    const cat = await call(admin, 'GET', '/integrations/catalog');
    const presets: any[] = Object.entries(cat.json as Record<string, any[]>).flatMap(([category, list]) => list.map((p) => ({ ...p, category })));       // the catalogue is grouped by category
    const pick = presets.find((p) => p.method === 'API_PULL' && (p.configFields ?? p.fields ?? []).some((f: any) => ['clientSecret', 'apiKey', 'password'].includes(f.key)));
    assert.ok(pick, 'the catalogue has an API connector with a credential');
    const fields: any[] = pick.configFields ?? pick.fields;
    const config = Object.fromEntries(fields.filter((f) => f.required).map((f) => [f.key, /url/i.test(f.key) ? 'https://example.com' : 'plain-' + f.key]));
    const c = await call(admin, 'POST', '/integrations', { category: pick.category, preset: pick.id, name: `Enc connector ${RUN}`, config });
    assert.equal(c.status, 201, c.text);
    const stored = (await sql('SELECT config, webhook_secret FROM integration_connectors WHERE id = $1', [c.json.id]))[0];
    const secretKey = Object.keys(config).find((k) => ['clientSecret', 'apiKey', 'password'].includes(k));
    assert.ok(secretKey, 'a credential was set');
    assert.ok(stored.config[secretKey!].startsWith('enc:v1:'), 'the credential is encrypted');
    assert.equal(c.json.config[secretKey!], '••••••••', 'and never shown');
    await call(admin, 'DELETE', `/integrations/${c.json.id}`);
  });

  it('the status page can be read by an administrator and not by a plain user', async () => {
    const st = await call(admin, 'GET', '/security/secrets');
    assert.equal(st.status, 200);
    assert.ok(['SECRETS_KEY', 'DERIVED_FROM_JWT_SECRET'].includes(st.json.key.source));
    assert.ok(!JSON.stringify(st.json).includes('enc:v1:'), 'it counts secrets, it never returns one');
    assert.equal(st.json.unreadable, 0);
    const u = await call(admin, 'POST', '/users', { username: `sec${RUN}`, displayName: 'Plain User', role: 'AGENT', password: 'Plain#Pass12345' });
    if (u.status === 201) {
      const tok = (await call(null, 'POST', '/auth/login', { username: `sec${RUN}`, password: 'Plain#Pass12345', tenant: TENANT })).json.token;
      assert.equal((await call(tok, 'GET', '/security/secrets')).status, 403);
    }
  });
});
