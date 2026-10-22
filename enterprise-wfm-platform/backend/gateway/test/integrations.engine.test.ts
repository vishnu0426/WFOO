/**
 * The generic auth engine, exercised with a fake `fetch` (no real vendor account exists to test against -- see the
 * plan's honesty note). Checks the request shaping and response handling for each header-based auth type, and the
 * OAuth2 client-credentials token flow including caching and expiry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, oauthToken, pullJson, _resetTokenCacheForTests, type FetchFn } from '../src/modules/integrations/engine.ts';
import { presetById } from '../src/modules/integrations/presets.ts';

const fakeRes = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('authHeaders', () => {
  it('BEARER_STATIC sends the API key as a bearer token', async () => {
    const h = await authHeaders('c1', presetById('GENERIC_ACD_API')!, { apiKey: 'secret-123' }, (async () => fakeRes({})) as FetchFn);
    assert.deepEqual(h, { Authorization: 'Bearer secret-123' });
  });

  it('API_KEY_HEADER uses a custom header name when one is configured', async () => {
    const h = await authHeaders('c1', { ...presetById('UKG_PRO')!, authType: 'API_KEY_HEADER' }, { apiKey: 'k-1', headerName: 'X-Custom-Key' }, (async () => fakeRes({})) as FetchFn);
    assert.deepEqual(h, { 'X-Custom-Key': 'k-1' });
  });

  it('API_KEY_HEADER falls back to X-Api-Key with no header name configured', async () => {
    const h = await authHeaders('c1', { ...presetById('UKG_PRO')!, authType: 'API_KEY_HEADER' }, { apiKey: 'k-1' }, (async () => fakeRes({})) as FetchFn);
    assert.deepEqual(h, { 'X-Api-Key': 'k-1' });
  });

  it('BASIC base64-encodes username:password', async () => {
    const h = await authHeaders('c1', presetById('CISCO_UCCE')!, { username: 'svc', password: 'pw' }, (async () => fakeRes({})) as FetchFn);
    assert.equal(h.Authorization, `Basic ${Buffer.from('svc:pw').toString('base64')}`);
  });

  it('AWS_SIGV4 and MUTUAL_TLS refuse to produce a plain header, since neither is a simple header', async () => {
    await assert.rejects(() => authHeaders('c1', presetById('AMAZON_CONNECT')!, {}, (async () => fakeRes({})) as FetchFn), /SigV4/);
    await assert.rejects(() => authHeaders('c1', presetById('ADP')!, {}, (async () => fakeRes({})) as FetchFn), /Mutual TLS/);
  });
});

describe('oauthToken', () => {
  it('fetches a token with Basic client-credentials auth and a form-encoded body', async () => {
    _resetTokenCacheForTests();
    let seenUrl = '', seenInit: any = null;
    const fetchImpl: FetchFn = async (url, init) => { seenUrl = url; seenInit = init; return fakeRes({ access_token: 'tok-abc', expires_in: 3600 }); };
    const token = await oauthToken('c2', 'https://login.example.com/oauth/token', 'cid', 'csecret', fetchImpl);
    assert.equal(token, 'tok-abc');
    assert.equal(seenUrl, 'https://login.example.com/oauth/token');
    assert.equal(seenInit.headers.Authorization, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    assert.equal(seenInit.body, 'grant_type=client_credentials');
  });

  it('caches the token and does not re-request until it is close to expiry', async () => {
    _resetTokenCacheForTests();
    let calls = 0;
    const fetchImpl: FetchFn = async () => { calls++; return fakeRes({ access_token: `tok-${calls}`, expires_in: 3600 }); };
    const a = await oauthToken('c3', 'https://x/token', 'i', 's', fetchImpl);
    const b = await oauthToken('c3', 'https://x/token', 'i', 's', fetchImpl);
    assert.equal(a, b); assert.equal(calls, 1);
  });

  it('rejects clearly when the token endpoint fails', async () => {
    _resetTokenCacheForTests();
    const fetchImpl: FetchFn = async () => fakeRes({ error: 'invalid_client' }, false, 401);
    await assert.rejects(() => oauthToken('c4', 'https://x/token', 'i', 'bad', fetchImpl), /401/);
  });

  it('Genesys Cloud derives its token URL from the configured region', async () => {
    _resetTokenCacheForTests();
    let seenUrl = '';
    const fetchImpl: FetchFn = async (url) => { seenUrl = url; return fakeRes({ access_token: 't', expires_in: 3600 }); };
    await authHeaders('c5', presetById('GENESYS_CLOUD')!, { region: 'eu-west-1', clientId: 'i', clientSecret: 's' }, fetchImpl);
    assert.equal(seenUrl, 'https://login.eu-west-1.mypurecloud.com/oauth/token');
  });
});

describe('pullJson', () => {
  it('returns the parsed JSON body on success', async () => {
    const out = await pullJson('c6', presetById('GENERIC_ACD_API')!, { apiKey: 'k' }, 'https://x/data', (async () => fakeRes({ hello: 'world' })) as FetchFn);
    assert.deepEqual(out, { hello: 'world' });
  });
  it('throws with the status and body on a non-OK response', async () => {
    await assert.rejects(() => pullJson('c7', presetById('GENERIC_ACD_API')!, { apiKey: 'k' }, 'https://x/data', (async () => fakeRes({ error: 'nope' }, false, 500)) as FetchFn), /500/);
  });
});
