/**
 * Where a person is sent after single sign-on: the admin web app or the employee portal. The sign-in link names the target ("app" or "portal"), never an
 * address, and the addresses come only from the server's settings (APP_URL, PORTAL_URL). A link cannot make the gateway send a signed-in person anywhere else,
 * so this cannot be turned into an open redirect. Pure, so it is tested without a server.
 */
export type ReturnTo = 'app' | 'portal';

/** Anything other than "portal" means the admin app. */
export const parseTo = (v: unknown): ReturnTo => (v === 'portal' ? 'portal' : 'app');

/** An http(s) address from a setting, without a trailing slash, or undefined when it is missing or not a usable address (no credentials, no other scheme). */
export function cleanUrl(v: string | undefined | null): string | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch { return undefined; }
}

/** The base address for a target. The portal falls back to the admin app only when it was never asked for; an unconfigured portal is reported by the caller. */
export const returnBase = (to: ReturnTo, urls: { app: string; portal?: string }) => (to === 'portal' && urls.portal ? urls.portal : urls.app);
