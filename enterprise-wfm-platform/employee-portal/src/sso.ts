/**
 * Single sign-on for the employee portal, the parts that need no browser: what the sign-in screen should offer, where the button goes, and how to read the
 * result the gateway sends back (in the part of the address after #, which is never sent to any server). No imports, so it is tested directly.
 */
export interface SsoInfo { enabled: boolean; name: string | null; passwordLogin: boolean; portal: boolean; /** where the button goes: absolute, on the address the provider returns to */ start?: string }

/**
 * password: the usual form only. both: the company button and the password form. sso-only: the button, with passwords reachable only through the
 * administrator link. blocked: the organisation requires single sign-on but the portal's address is not set on the server, so the button cannot work.
 * Anything unknown (no answer from the server) falls back to the password form, never to a blocked screen.
 */
export type Mode = 'password' | 'both' | 'sso-only' | 'blocked';
export function loginMode(info: SsoInfo | null): Mode {
  if (!info || !info.enabled) return 'password';
  if (!info.portal) return info.passwordLogin ? 'password' : 'blocked';
  return info.passwordLogin ? 'both' : 'sso-only';
}

/** The address the button goes to. "_" means the only organisation. The gateway decides where to return: the portal, from its own settings, never from this link. */
export const startUrl = (tenantCode: string, info?: SsoInfo | null) => info?.start || `/api/v1/auth/sso/${encodeURIComponent(tenantCode.trim() || '_')}/start?to=portal`;
export const infoUrl = (tenantCode: string) => `/auth/sso/${encodeURIComponent(tenantCode.trim() || '_')}/info`;

/** What came back after signing in at the company's page: a token, or the reason it did not work. */
export function readSsoReturn(hash: string): { token?: string; error?: string } {
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  const token = h.get('sso_token') ?? undefined, error = h.get('sso_error') ?? undefined;
  return token ? { token } : error ? { error: error.slice(0, 300) } : {};
}

/** True while a returned token is being turned into a session, so the sign-in form is not flashed. */
export const returningFromSso = (hash: string) => /(^#|&)sso_token=/.test(hash);
