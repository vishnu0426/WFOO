/**
 * The generic delivery engine: one HTTP-pull client parameterized by a preset's auth type, instead of a hand-written
 * adapter per vendor. This is what makes a preset configuration rather than code. AWS SigV4 (Amazon Connect) needs
 * per-request signing rather than a static header set, so it has its own function using `sigv4.ts`.
 *
 * Honesty note carried from the plan: none of this has been run against a live vendor account (we have none). The
 * OAuth2 client-credentials flow and header-based auths follow each vendor's documented shape and are unit-tested
 * with a fake `fetch`, not a real one.
 */
import type { Preset } from './presets.ts';

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

interface TokenCache { token: string; expiresAt: number }
const tokenCache = new Map<string, TokenCache>();
/** Test-only: clears the in-memory OAuth token cache between test cases. */
export const _resetTokenCacheForTests = () => tokenCache.clear();

const genesysTokenUrl = (region: string) => `https://login.${region}.mypurecloud.com/oauth/token`;

export async function oauthToken(connectorId: string, tokenUrl: string, clientId: string, clientSecret: string, fetchImpl: FetchFn): Promise<string> {
  const cached = tokenCache.get(connectorId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetchImpl(tokenUrl, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  if (!j.access_token) throw new Error('Token response had no access_token');
  tokenCache.set(connectorId, { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

/** Header-based auths only (everything except AWS_SIGV4, which signs per-request, and MUTUAL_TLS, which needs a TLS client certificate, not a header -- see the note in presets.ts for ADP). */
export async function authHeaders(connectorId: string, preset: Preset, config: Record<string, any>, fetchImpl: FetchFn): Promise<Record<string, string>> {
  switch (preset.authType) {
    case 'NONE': return {};
    case 'BEARER_STATIC': return { Authorization: `Bearer ${config.apiKey}` };
    case 'API_KEY_HEADER': return { [config.headerName || 'X-Api-Key']: config.apiKey };
    case 'BASIC': return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}` };
    case 'OAUTH2_CLIENT_CREDENTIALS': {
      const tokenUrl: string = config.tokenUrl || (preset.id === 'GENESYS_CLOUD' ? genesysTokenUrl(config.region) : '');
      if (!tokenUrl) throw new Error('No OAuth token URL is known for this connector; set one in its configuration.');
      return { Authorization: `Bearer ${await oauthToken(connectorId, tokenUrl, config.clientId, config.clientSecret, fetchImpl)}` };
    }
    case 'AWS_SIGV4': throw new Error('AWS SigV4 signs per-request; call pullAmazonConnectMetrics, not authHeaders, for this preset.');
    case 'MUTUAL_TLS': throw new Error('Mutual TLS needs a client certificate on the HTTP agent, not a header; see presets.ts note for ADP.');
    default: return {};
  }
}

/** Fetches one JSON page from a preset's configured endpoint using its auth, for API_PULL presets with header-based auth. */
export async function pullJson(connectorId: string, preset: Preset, config: Record<string, any>, url: string, fetchImpl: FetchFn): Promise<any> {
  const headers = await authHeaders(connectorId, preset, config, fetchImpl);
  const res = await fetchImpl(url, { method: 'GET', headers });
  if (!res.ok) throw new Error(`${preset.label} request failed: ${res.status} ${await res.text()}`);
  return res.json();
}
