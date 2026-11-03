/**
 * Where the server may connect on behalf of an administrator.
 *
 * Several settings make this server open a connection to an address a person typed in: a data-feed connector (REST address, database host, SFTP host), a webhook,
 * the single sign-on provider, an SMS gateway. Left open, a configuration administrator could point any of them at the platform's own database, its cache, its
 * message bus or a cloud metadata service and learn what answers (open or closed ports, error text, even data). So every such connection goes through here:
 *
 *   - Never allowed, whatever is configured: cloud metadata addresses, "this host" (0.0.0.0, ::), multicast and broadcast.
 *   - Not allowed unless listed: loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10), and private networks (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7).
 *   - Public addresses are allowed.
 *
 * To reach something on a private network on purpose (a customer's database over a VPN), name it in OUTBOUND_ALLOW: a comma-separated list of IP addresses, CIDR
 * ranges (10.20.0.0/16) and host names. OUTBOUND_ALLOW_PRIVATE=true allows all of the private networks (not loopback or link-local) for a deployment that lives entirely inside
 * one. The name is looked up here and the connection is made to the address that was checked, so a name that answers differently a moment later cannot slip through.
 */
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export class OutboundBlocked extends Error {
  status = 400; code = 'ADDRESS_NOT_ALLOWED';
  constructor(message: string) { super(message); }
}

const list = (cidrs: [string, number, 'ipv4' | 'ipv6'][]) => { const b = new net.BlockList(); for (const [a, p, t] of cidrs) b.addSubnet(a, p, t); return b; };
const NEVER = list([
  ['169.254.169.254', 32, 'ipv4'], ['168.63.129.16', 32, 'ipv4'], ['100.100.100.200', 32, 'ipv4'], ['fd00:ec2::254', 128, 'ipv6'],   // cloud metadata services
  ['0.0.0.0', 8, 'ipv4'], ['::', 128, 'ipv6'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['ff00::', 8, 'ipv6'],               // this host, multicast, reserved, broadcast
]);
const LOCAL = list([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6'], ['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']]);
const PRIVATE = list([['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['fc00::', 7, 'ipv6'], ['198.18.0.0', 15, 'ipv4'], ['192.0.0.0', 24, 'ipv4']]);

/** An IPv4 address written as IPv6 (::ffff:10.0.0.1) is the IPv4 address. */
function plain(ip: string): { ip: string; v: 'ipv4' | 'ipv6' } {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return { ip: m[1], v: 'ipv4' };
  return { ip, v: net.isIPv6(ip) ? 'ipv6' : 'ipv4' };
}

interface Allow { hosts: Set<string>; nets: net.BlockList; privateToo: boolean }
let allowFor = '', allowParsed: Allow = { hosts: new Set(), nets: new net.BlockList(), privateToo: false };
function allow(): Allow {
  const raw = `${process.env.OUTBOUND_ALLOW ?? ''}|${process.env.OUTBOUND_ALLOW_PRIVATE ?? ''}`;
  if (raw === allowFor) return allowParsed;
  const a: Allow = { hosts: new Set(), nets: new net.BlockList(), privateToo: String(process.env.OUTBOUND_ALLOW_PRIVATE).toLowerCase() === 'true' };
  for (const part of String(process.env.OUTBOUND_ALLOW ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [addr, bits] = part.split('/');
    if (net.isIP(addr)) { const v = net.isIPv6(addr) ? 'ipv6' : 'ipv4'; if (bits !== undefined) a.nets.addSubnet(addr, Number(bits), v); else a.nets.addAddress(addr, v); }
    else a.hosts.add(part.toLowerCase());
  }
  allowFor = raw; allowParsed = a;
  return a;
}

/** Why an address may not be used, or null when it may. */
export function addressProblem(rawIp: string, host?: string): string | null {
  const { ip, v } = plain(rawIp);
  if (NEVER.check(ip, v)) return 'That address is not allowed.';
  const a = allow();
  if (host && a.hosts.has(host.toLowerCase())) return null;
  if (a.nets.check(ip, v)) return null;
  if (LOCAL.check(ip, v)) return 'That address points back at this server or its own network, which is not allowed.';
  if (PRIVATE.check(ip, v) && !a.privateToo) return 'That address is on a private network. Ask your administrator to allow it (OUTBOUND_ALLOW) if it is meant to be reached.';
  return null;
}

/** Looks the name up and returns an address that may be used. Refuses if any address it answers with may not be used (a name that points both inside and outside is not trusted). */
export async function resolveSafe(host: string): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, '').trim();
  if (!bare) throw new OutboundBlocked('No address was given.');
  const found = net.isIP(bare) ? [{ address: bare, family: net.isIPv6(bare) ? 6 : 4 }] : await dns.promises.lookup(bare, { all: true }).catch(() => []);
  if (!found.length) throw new Error(`The name ${bare} could not be found.`);
  for (const f of found) { const p = addressProblem(f.address, bare); if (p) throw new OutboundBlocked(p); }
  const pick = found.find((f) => f.family === 4) ?? found[0];
  return { address: pick.address, family: pick.family as 4 | 6 };
}

/** For a save screen: refuse an address that can never be used, but do not fail merely because a name does not resolve yet. */
export async function checkTarget(host: string): Promise<void> {
  try { await resolveSafe(host); } catch (e) { if (e instanceof OutboundBlocked) throw e; }
}

/** A `lookup` for http/https/net: the connection is made to the address that was checked. */
export const guardedLookup = (host: string, opts: any, cb: any) => {
  resolveSafe(host).then((r) => (opts?.all ? cb(null, [{ address: r.address, family: r.family }]) : cb(null, r.address, r.family)), (e) => cb(e));
};

const MAX_BODY = 25 * 1024 * 1024;
/**
 * fetch() for addresses an administrator typed in. Same shape as fetch (it returns a Response), but the connection goes to a checked address, a redirect is checked the
 * same way before it is followed (at most 3), only http and https are spoken, and an answer larger than 25 MB is cut off.
 */
export async function safeFetch(input: string | URL, init: { method?: string; headers?: Record<string, string> | Headers; body?: string | Buffer | URLSearchParams | null; signal?: AbortSignal; redirect?: 'follow' | 'manual' } = {}): Promise<Response> {
  let url = new URL(String(input));
  let method = (init.method ?? 'GET').toUpperCase(), body: string | Buffer | null = init.body instanceof URLSearchParams ? init.body.toString() : (init.body ?? null);
  const headers: Record<string, string> = {};
  if (init.headers) (init.headers instanceof Headers ? [...init.headers.entries()] : Object.entries(init.headers)).forEach(([k, v]) => { headers[k.toLowerCase()] = String(v); });
  if (init.body instanceof URLSearchParams && !headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded';
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundBlocked('Only http:// and https:// addresses can be used.');
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) await resolveSafe(url.hostname);       // the lookup hook below is not used for an address written as numbers, so check it here
    const res = await once(url, method, headers, body, init.signal);
    if (init.redirect !== 'manual' && [301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      if (hop >= 3) throw new Error('The address redirected too many times.');
      url = new URL(res.headers.get('location')!, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = null; }
      delete headers.authorization;                                    // never hand a key to a different address
      continue;
    }
    return res;
  }
}

function once(url: URL, method: string, headers: Record<string, string>, body: string | Buffer | null, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers: { ...headers, ...(body != null && !headers['content-length'] ? { 'content-length': String(Buffer.byteLength(body)) } : {}) }, lookup: guardedLookup as any, signal }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(new Error('The answer was larger than 25 MB.')); return; } chunks.push(c); });
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const status = res.statusCode ?? 0;
        let data = Buffer.concat(chunks);
        const enc = (h.get('content-encoding') ?? '').toLowerCase();
        try {
          if (enc === 'gzip') data = zlib.gunzipSync(data); else if (enc === 'deflate') data = zlib.inflateSync(data); else if (enc === 'br') data = zlib.brotliDecompressSync(data);
          if (enc) { h.delete('content-encoding'); h.delete('content-length'); }
        } catch (e) { return reject(e); }
        resolve(new Response([204, 205, 304].includes(status) || (status >= 100 && status < 200) ? null : data, { status, headers: h }));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
