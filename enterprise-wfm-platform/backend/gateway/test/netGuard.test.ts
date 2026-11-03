/**
 * Which addresses the server may connect to for an administrator (netGuard.ts), and that every feature that does so goes through it.
 * Unit tests use no network except a loopback listener started here.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { addressProblem, checkTarget, OutboundBlocked, resolveSafe, safeFetch } from '../src/netGuard.ts';

const env = (v: Record<string, string | undefined>) => { for (const [k, x] of Object.entries(v)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; } };
afterEach(() => env({ OUTBOUND_ALLOW: undefined, OUTBOUND_ALLOW_PRIVATE: undefined }));

describe('which addresses are allowed', () => {
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(addressProblem(ip), null, ip);
  });
  it('never allows metadata services, "this host" or multicast, even when everything private is allowed', () => {
    env({ OUTBOUND_ALLOW_PRIVATE: 'true', OUTBOUND_ALLOW: '169.254.0.0/16,0.0.0.0/8' });
    for (const ip of ['169.254.169.254', '168.63.129.16', '100.100.100.200', 'fd00:ec2::254', '0.0.0.0', '::', '224.0.0.1', 'ff02::1']) assert.ok(addressProblem(ip), ip);
  });
  it('refuses loopback, link-local and private networks by default, in every way of writing them', () => {
    for (const ip of ['127.0.0.1', '127.5.5.5', '::1', '169.254.1.1', 'fe80::1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) assert.ok(addressProblem(ip), ip);
    assert.equal(addressProblem('172.32.0.1'), null, 'just outside 172.16.0.0/12');
    assert.equal(addressProblem('::ffff:8.8.8.8'), null, 'a public IPv4 address written as IPv6');
  });
  it('allows a private network that is named, and only that one', () => {
    env({ OUTBOUND_ALLOW: '10.20.0.0/16, 192.168.5.5, db.corp.example' });
    assert.equal(addressProblem('10.20.3.4'), null);
    assert.equal(addressProblem('192.168.5.5'), null);
    assert.ok(addressProblem('10.21.0.1'), 'a different part of 10.0.0.0/8');
    assert.ok(addressProblem('192.168.5.6'));
    assert.equal(addressProblem('10.99.99.99', 'db.corp.example'), null, 'a named host is allowed whatever it answers');
    assert.ok(addressProblem('10.99.99.99', 'other.example'));
  });
  it('OUTBOUND_ALLOW_PRIVATE opens private networks but not loopback or link-local', () => {
    env({ OUTBOUND_ALLOW_PRIVATE: 'true' });
    assert.equal(addressProblem('10.1.1.1'), null); assert.equal(addressProblem('192.168.0.9'), null); assert.equal(addressProblem('fd00::1'), null);
    assert.ok(addressProblem('127.0.0.1')); assert.ok(addressProblem('169.254.1.1')); assert.ok(addressProblem('::1'));
  });
});

describe('looking a name up', () => {
  it('refuses a name that answers with an internal address', async () => {
    await assert.rejects(resolveSafe('localhost'), (e: any) => e instanceof OutboundBlocked);
    await assert.rejects(resolveSafe('127.0.0.1'), OutboundBlocked);
    await assert.rejects(resolveSafe('[::1]'), OutboundBlocked);
  });
  it('lets a save screen refuse such an address, but not complain about a name that does not exist yet', async () => {
    await assert.rejects(checkTarget('10.0.0.1'), OutboundBlocked);
    await checkTarget('this-name-does-not-exist.invalid');
  });
});

describe('connecting', () => {
  let server: http.Server;
  const listen = async () => { server = http.createServer((req, res) => { res.setHeader('x-seen', req.headers.authorization ?? 'none'); if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); } else res.end(JSON.stringify({ ok: true })); }); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return (server.address() as AddressInfo).port; };
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('refuses to fetch from this machine unless it is named, and fetches when it is', async () => {
    const port = await listen();
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), OutboundBlocked);
    env({ OUTBOUND_ALLOW: '127.0.0.0/8' });
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { headers: { authorization: 'Bearer k' } });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true }); assert.equal(r.headers.get('x-seen'), 'Bearer k');
  });
  it('checks every address a redirect leads to, and does not pass the key on', async () => {
    const port = await listen();
    env({ OUTBOUND_ALLOW: '127.0.0.1/32' });
    const manual = await safeFetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual' });
    assert.equal(manual.status, 302, 'a caller may ask to see the redirect itself');
    env({ OUTBOUND_ALLOW: undefined });
    await assert.rejects(safeFetch('http://localhost:1/'), OutboundBlocked);
  });
  it('speaks only http and https', async () => {
    await assert.rejects(safeFetch('file:///etc/passwd'), OutboundBlocked);
    await assert.rejects(safeFetch('gopher://example.com/'), OutboundBlocked);
  });
});
