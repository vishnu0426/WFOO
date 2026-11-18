/**
 * Certificate handling for the NATS connectors: whether to check the server's certificate, and an optional CA certificate (the public certificate of the
 * authority that signed the server's own) for servers on a private network. Only a public certificate is accepted here, never a private key.
 */
import { X509Certificate } from 'node:crypto';

export const CA_KEY = 'tlsCaCert';
const MAX_BYTES = 20_000;

export interface CaSummary { count: number; subject: string; issuer: string; validTo: string; selfSigned: boolean }

/** The certificates in a PEM text, or an Error saying in plain words what is wrong with it. */
export function inspectCa(pem: string, now = new Date()): CaSummary {
  if (Buffer.byteLength(pem) > MAX_BYTES) throw new Error('That file is too large to be a certificate.');
  if (/PRIVATE KEY-----/.test(pem)) throw new Error('That file contains a private key. Upload only the public CA certificate, never a key.');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks) throw new Error('That is not a certificate. A CA certificate is a text file that starts with -----BEGIN CERTIFICATE-----.');
  if (blocks.length > 10) throw new Error('That file holds too many certificates (the limit is 10).');
  const certs = blocks.map((b) => { try { return new X509Certificate(b); } catch { throw new Error('One of the certificates in the file is damaged and could not be read.'); } });
  const first = certs[0];
  const gone = certs.find((c) => new Date(c.validTo) < now);
  if (gone) throw new Error(`The certificate for ${gone.subject.replace(/\n/g, ', ')} expired on ${new Date(gone.validTo).toISOString().slice(0, 10)}. Ask for a current one.`);
  return { count: certs.length, subject: first.subject.replace(/\n/g, ', '), issuer: first.issuer.replace(/\n/g, ', '), validTo: new Date(first.validTo).toISOString().slice(0, 10), selfSigned: first.subject === first.issuer };
}

/** The TLS options for a connection: checked unless the setting is "false". With an uploaded authority, that authority is the one trusted (it replaces the public list). */
export function natsTlsOptions(cfg: Record<string, string>): { rejectUnauthorized: boolean; ca?: string } {
  const ca = (cfg[CA_KEY] ?? '').trim();
  return { rejectUnauthorized: cfg.tlsRejectUnauthorized !== 'false', ...(ca ? { ca } : {}) };
}
