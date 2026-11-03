/**
 * Signing in without knowing an "organisation code": the words shown when it is missing or wrong, the link an administrator hands to a new employee
 * (the code is in the link, so nobody types it), and the settings that switch finding an organisation by email on or off. No database here.
 */

export const ORG_UNKNOWN_MSG = "We couldn't find that organisation. Check the code on your welcome message, or ask your manager.";
export const ORG_REQUIRED_MSG = 'Which organisation do you work for? Enter the organisation code from your welcome message, or use "Find my organisation" with your work email.';
export const DISCOVERY_OFF_MSG = 'Finding your organisation by email is switched off on this server. Ask your manager for the organisation code.';

/** A code as it may appear in an address: letters, digits, dash and underscore. */
export const validOrgCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(v.trim());

/** Finding an organisation by someone's email tells a stranger who has an account, so it can be switched off: LOGIN_DISCOVERY=false. On by default. */
export const discoveryOn = (env: Record<string, string | undefined> = process.env) => !/^(false|0|off|no)$/i.test((env.LOGIN_DISCOVERY ?? '').trim());

/**
 * Where an employee signs in, with the organisation already chosen. PORTAL_URL_TEMPLATE wins when set, for an address per organisation
 * (https://{org}.example.com); otherwise PORTAL_URL with ?org= on the end. Null when neither is configured.
 */
export function signInLink(code: string, env: Record<string, string | undefined> = process.env): string | null {
  const tpl = (env.PORTAL_URL_TEMPLATE ?? '').trim();
  if (tpl && tpl.includes('{org}')) return tpl.replace('{org}', encodeURIComponent(code.toLowerCase()));
  const base = (env.PORTAL_URL ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/?org=${encodeURIComponent(code)}` : null;
}

/** What to send a new employee, in one block they can paste into a message. */
export function welcomeMessage(p: { organisation: string; code: string; link: string | null; username: string; password: string }): string {
  return [
    `Welcome to ${p.organisation}'s WFM portal.`,
    p.link ? `Sign in here: ${p.link}` : `Organisation code: ${p.code}`,
    ...(p.link ? [`Organisation code, if you are asked for it: ${p.code}`] : []),
    `Username: ${p.username}`,
    `Temporary password: ${p.password}`,
    'You will be asked to choose your own password the first time you sign in.',
  ].join('\n');
}
