import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectCa, natsTlsOptions } from '../src/modules/integrations/natsTls.ts';

// A throwaway self-signed certificate (CN=Test Root CA, valid until 2126) made with openssl for these tests. It has no key with it and is trusted nowhere.
const PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIULllwvX6zaL7a+5NhzBgp2Ldd1oswDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMVGVzdCBSb290IENBMCAXDTI2MTExODE0NDYzOVoYDzIx
MjYxMDI1MTQ0NjM5WjAXMRUwEwYDVQQDDAxUZXN0IFJvb3QgQ0EwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC5pBmw4jRiLwjTDFL1YgMvu2kkL26wgOy9
bIr7wfYGZUTCDMPP16XF4mrG3bZ4kOAG+dQ38cDSWUX8VQ/RwtH7C3DaV4ZmZQfI
L7F68DPCaCM/ncC/I0d7aCIGywe13avZ0T5NSPbawq/lJ0QIfsTXee3QtLn1JBrz
MXUmXT1JTwvJLyIzq0ZAV7IiMqSjSsGqgVweo6IPl2R6nk3j+8xbfb4a7LZ3UueC
tlZASnVveUUg7TfjeN23JSj9L6szDu/APiFeB6epMy/7HPCw5i6/I940SMHg/Ihb
C0L4tbe5opPPr7TZ57+UxHKu2XG/2doF8z1Slfq4u8MTXCEEF6XhAgMBAAGjUzBR
MB0GA1UdDgQWBBTSEHn9LtypGqXTTh4hO/N0JnxFSDAfBgNVHSMEGDAWgBTSEHn9
LtypGqXTTh4hO/N0JnxFSDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQARkEatdmwRhBFNfiIwgUekQHUnauMJB/+w88g8Gz37SwMhMvRku+2O/CUt
hBtboCLL44awEeIh7Qj+d7vQrlTGMjcPhnrG6ONcC0n5LxzqXQ8xPnsQWgM9v6xN
PyvXUBy54LuIMKm09woE99cg9kLeuMm8oX+MNs6ultVh144amwVM7DwLFIswcHnq
Egl+PjZOZ7VsT1taHrbcuokTabK2KP50eTq4oykFMkVhghojudnTuuu5EtTnNuAj
yTpVJZVC9+RQZDHKAbzN2f3NZV0GdhTpfNC0xo1KAKiwCAEynYUiuMepaI/QDGQR
3U5AyClYxv5p4hSXrWjHr9HdG94r
-----END CERTIFICATE-----`;

describe('NATS certificate settings', () => {
  it('refuses text that is not a certificate', () => {
    assert.throws(() => inspectCa('hello'), /not a certificate/);
  });
  it('refuses a private key', () => {
    assert.throws(() => inspectCa('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), /private key/);
  });
  it('refuses a damaged certificate and an oversized file', () => {
    assert.throws(() => inspectCa('-----BEGIN CERTIFICATE-----\nnot-base64!!\n-----END CERTIFICATE-----'), /damaged/);
    assert.throws(() => inspectCa('x'.repeat(30_000)), /too large/);
  });
  it('checks the certificate unless told not to, and passes the authority on', () => {
    assert.deepEqual(natsTlsOptions({}), { rejectUnauthorized: true });
    assert.deepEqual(natsTlsOptions({ tlsRejectUnauthorized: 'false' }), { rejectUnauthorized: false });
    assert.deepEqual(natsTlsOptions({ tlsCaCert: ' PEMTEXT ' }), { rejectUnauthorized: true, ca: 'PEMTEXT' });
  });
  it('reads a real CA certificate and says who it is and until when', () => {
    const s = inspectCa(PEM);
    assert.equal(s.count, 1);
    assert.match(s.subject, /Test Root CA/);
    assert.equal(s.selfSigned, true);
    assert.equal(s.validTo.slice(0, 2), '21');
  });
  it('refuses a certificate that has expired', () => {
    assert.throws(() => inspectCa(PEM, new Date('2200-01-01')), /expired on 2126/);
  });
});
