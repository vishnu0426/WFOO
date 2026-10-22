/**
 * AWS Signature Version 4, implemented directly against Node's crypto module rather than pulled in as a dependency,
 * for the Amazon Connect API-pull adapter. This is the one piece of the Integration Station with an objective
 * ground truth to self-check against (AWS's own published test vectors) even without a live AWS account -- see
 * `test/integrations.sigv4.test.ts`, which verifies this against the canonical "get-vanilla" example from AWS's
 * public sig-v4 test suite.
 */
import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();

export interface SigV4Input {
  method: string; host: string; path: string; queryParams?: Record<string, string>; headers?: Record<string, string>; body?: string;
  region: string; service: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string; at?: Date;
}

const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
const dateStamp = (d: Date) => amzDate(d).slice(0, 8);

/** Signs a request and returns the headers to send (Authorization, X-Amz-Date, and X-Amz-Security-Token if a session token was given). */
export function signRequest(input: SigV4Input): Record<string, string> {
  const at = input.at ?? new Date();
  const xAmzDate = amzDate(at), dStamp = dateStamp(at);
  const body = input.body ?? '';
  const payloadHash = sha256Hex(body);

  const query = input.queryParams ?? {};
  const canonicalQuery = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');

  const baseHeaders: Record<string, string> = { host: input.host, 'x-amz-date': xAmzDate, ...(input.sessionToken ? { 'x-amz-security-token': input.sessionToken } : {}), ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const sortedHeaderNames = Object.keys(baseHeaders).sort();
  const canonicalHeaders = sortedHeaderNames.map((k) => `${k}:${baseHeaders[k].trim()}\n`).join('');
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [input.method.toUpperCase(), input.path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { Authorization: authorization, 'X-Amz-Date': xAmzDate, ...(input.sessionToken ? { 'X-Amz-Security-Token': input.sessionToken } : {}) };
}
