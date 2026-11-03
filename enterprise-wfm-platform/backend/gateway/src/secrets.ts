/**
 * Encryption of secrets at rest: mail and SMS credentials, webhook signing secrets, the single sign-on client secret and connector credentials.
 *
 * AES-256-GCM, a fresh random 12-byte nonce for every value, and the key's short fingerprint stored beside the value so the right key is found after a rotation.
 * A stored value looks like `enc:v1:<key fingerprint>:<nonce+tag+ciphertext, base64url>`. A value without that prefix is plain text saved by an older version: it is
 * still read, and is encrypted the next time it is saved and by the start-up pass (`encryptExisting`).
 *
 * The key comes from SECRETS_KEY (32 random bytes as 64 hex characters or base64; `openssl rand -hex 32`). If it is not set, a key is derived from JWT_SECRET so nothing
 * breaks, but then changing JWT_SECRET makes saved secrets unreadable, and the status endpoint says so. To rotate: put the old key in SECRETS_KEY_PREVIOUS (comma
 * separated), set the new one in SECRETS_KEY, restart, and everything is re-encrypted under the new key at start-up.
 *
 * A secret that cannot be decrypted (wrong key) is treated as not set and logged once: the service carries on and the screen asks for it again.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from './config.ts';

const PREFIX = 'enc:v1:';
const AAD = Buffer.from('wfm-secret-v1');

const toKey = (s: string): Buffer => {
  const t = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(t, 'base64');
  if (b.length === 32 && b.toString('base64').replace(/=+$/, '') === t.replace(/=+$/, '')) return b;
  return Buffer.from(hkdfSync('sha256', Buffer.from(t), Buffer.from('wfm-secrets-salt'), Buffer.from('wfm-secrets-key'), 32));          // a passphrase: stretch it to a key
};
const fingerprint = (k: Buffer) => createHash('sha256').update(k).update('fp').digest('hex').slice(0, 8);

export const derivedKey = () => Buffer.from(hkdfSync('sha256', Buffer.from(config.jwtSecret), Buffer.from('wfm-secrets-salt'), Buffer.from('wfm-secrets-from-jwt'), 32));
const configured = (process.env.SECRETS_KEY ?? '').trim();
const primary = configured ? toKey(configured) : derivedKey();
const all: Buffer[] = [primary, ...(process.env.SECRETS_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(toKey), ...(configured ? [derivedKey()] : [])];
const byFp = new Map(all.map((k) => [fingerprint(k), k]));
export const keyStatus = () => ({ source: configured ? 'SECRETS_KEY' : 'DERIVED_FROM_JWT_SECRET', fingerprint: fingerprint(primary), previousKeys: all.length - 1 - (configured ? 1 : 0) });
if (!configured) console.warn('[secrets] SECRETS_KEY is not set: secrets are encrypted with a key derived from JWT_SECRET. Set SECRETS_KEY (openssl rand -hex 32) so the two can be changed independently.');

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);
/** Encrypted under the key in use now (not an old one, not plain text). */
export const isCurrent = (v: unknown) => isEncrypted(v) && v.slice(PREFIX.length).startsWith(`${fingerprint(primary)}:`);

export function encrypt(plain: string): string {
  if (plain === '' || isEncrypted(plain)) return plain;
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', primary, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${fingerprint(primary)}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export class SecretUnreadable extends Error { constructor() { super('A saved secret cannot be read with the current key. Enter it again.'); } }
/** The plain text of a stored value. Plain text from an older version passes through. Throws SecretUnreadable if the key is wrong. */
export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const rest = stored.slice(PREFIX.length), i = rest.indexOf(':');
  const blob = Buffer.from(rest.slice(i + 1), 'base64url');
  const tryKeys = byFp.has(rest.slice(0, i)) ? [byFp.get(rest.slice(0, i))!] : all;
  for (const k of tryKeys) {
    try {
      const d = createDecipheriv('aes-256-gcm', k, blob.subarray(0, 12));
      d.setAAD(AAD); d.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
    } catch { /* wrong key or damaged: try the next */ }
  }
  throw new SecretUnreadable();
}
let warned = 0;
/** Like `decrypt`, but a value that cannot be read comes back empty (and is logged now and then) instead of throwing. */
export function open(stored: string | null | undefined): string {
  if (!stored) return '';
  try { return decrypt(stored); } catch { if (Date.now() - warned > 60_000) { warned = Date.now(); console.error('[secrets] a saved secret could not be decrypted with the current key; it is treated as not set'); } return ''; }
}

// ---- object helpers (a JSON object of values where only some keys are secret)
export const lockFields = <T extends Record<string, any>>(o: T, keys: Iterable<string>): T => { const out: Record<string, any> = { ...o }; for (const k of keys) if (typeof out[k] === 'string' && out[k]) out[k] = encrypt(out[k]); return out as T; };
export const openFields = <T extends Record<string, any>>(o: T, keys: Iterable<string>): T => { const out: Record<string, any> = { ...o }; for (const k of keys) if (typeof out[k] === 'string' && out[k]) out[k] = open(out[k]); return out as T; };
/** Connector configuration keys that hold credentials. */
export const CONFIG_SECRET_KEYS = ['clientSecret', 'apiKey', 'password', 'isuPassword', 'secretAccessKey', 'privateKeyPem', 'refreshToken', 'userApiKey', 'customerApiKey', 'natsPass'];
