/**
 * Time-based one-time passwords (RFC 6238: 6 digits, 30 second steps, SHA-1) for Super Admin sign-in, compatible with the usual authenticator apps,
 * plus one-time recovery codes. No third-party library: HMAC from node:crypto is all it takes.
 */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function totpAt(secret: string, timeMs: number): string {
  const counter = Math.floor(timeMs / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** True when the code matches the current 30-second step or the one either side (clock drift). */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  let ok = false;
  for (const drift of [-1, 0, 1]) {
    const expected = totpAt(secret, now + drift * 30000);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) ok = true;   // no early exit: constant work
  }
  return ok;
}

export const otpauthUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------------------------------------------------------------- recovery codes

const hashCode = (c: string) => crypto.createHash('sha256').update(c.replace(/[\s-]/g, '').toLowerCase()).digest('hex');

/** Ten single-use codes. The plain codes are shown once; only their hashes are kept. */
export function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: 10 }, () => {
    const a = crypto.randomBytes(5).toString('hex');
    return `${a.slice(0, 5)}-${a.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashCode) };
}

/** Index of the matching unused recovery code, or -1. */
export function findRecoveryCode(hashes: string[], input: string): number {
  const h = hashCode(input);
  return hashes.findIndex((x) => x === h);
}

// ---------------------------------------------------------------- guessing limit

const failures = new Map<string, { n: number; until: number }>();
/** At most 5 wrong codes per account in 10 minutes. */
export function mfaLocked(adminId: string): boolean {
  const f = failures.get(adminId);
  return !!f && f.n >= 5 && f.until > Date.now();
}
export function mfaFailed(adminId: string): void {
  const f = failures.get(adminId);
  if (!f || f.until <= Date.now()) failures.set(adminId, { n: 1, until: Date.now() + 10 * 60_000 });
  else f.n += 1;
}
export const mfaPassed = (adminId: string): void => { failures.delete(adminId); };
