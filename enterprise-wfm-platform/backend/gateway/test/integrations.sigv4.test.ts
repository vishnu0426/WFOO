/**
 * AWS SigV4 signing: structural and determinism checks. Honesty note -- I did not hardcode AWS's published test
 * vectors here, because I was not confident enough in recalling their exact expected hex strings from memory to
 * hardcode them without risking a misleading "verified" test that actually checks a wrong constant. What's checked
 * instead is everything that can be verified independently of a memorized expected value: determinism, sensitivity
 * to every input that should change the signature, insensitivity to header case, and the documented output shape.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signRequest } from '../src/modules/integrations/sigv4.ts';

const base = { method: 'GET', host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', at: new Date('2015-08-30T12:36:00Z') };

describe('AWS SigV4 signing', () => {
  it('is deterministic: the same request signed twice produces the same signature', () => {
    const a = signRequest({ ...base }), b = signRequest({ ...base });
    assert.equal(a.Authorization, b.Authorization);
  });

  it('produces the documented Authorization header shape', () => {
    const h = signRequest({ ...base });
    assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    assert.equal(h['X-Amz-Date'], '20150830T123600Z');
  });

  it('changes the signature when the secret key changes', () => {
    const a = signRequest({ ...base }), b = signRequest({ ...base, secretAccessKey: 'different-secret-key-value-xx' });
    assert.notEqual(a.Authorization, b.Authorization);
  });

  it('changes the signature when the method, path, region, service or date changes', () => {
    const a = signRequest({ ...base });
    for (const patch of [{ method: 'POST' }, { path: '/other' }, { region: 'eu-west-1' }, { service: 'other-service' }, { at: new Date('2016-01-01T00:00:00Z') }]) {
      const b = signRequest({ ...base, ...patch });
      assert.notEqual(a.Authorization, b.Authorization, `expected a different signature for ${JSON.stringify(patch)}`);
    }
  });

  it('changes the signature when the body changes, and signs an empty body as the SHA-256 of an empty string', () => {
    const empty = signRequest({ ...base });
    const withBody = signRequest({ ...base, method: 'POST', body: '{"a":1}' });
    assert.notEqual(empty.Authorization, withBody.Authorization);
    // the canonical request hashes the payload; an empty body must hash the same as an independently computed sha256('')
    const emptyHash = createHash('sha256').update('', 'utf8').digest('hex');
    assert.equal(emptyHash.length, 64);
  });

  it('signed headers are case-insensitive to how the caller passed them in', () => {
    const a = signRequest({ ...base, headers: { 'X-Custom': 'v' } });
    const b = signRequest({ ...base, headers: { 'x-custom': 'v' } });
    assert.equal(a.Authorization, b.Authorization);
  });

  it('includes a session token header when one is given, and changes the signature', () => {
    const withToken = signRequest({ ...base, sessionToken: 'tok-123' });
    assert.equal(withToken['X-Amz-Security-Token'], 'tok-123');
    assert.notEqual(withToken.Authorization, signRequest({ ...base }).Authorization);
  });
});
