/**
 * The identity providers an administrator can pick for single sign-on. Choosing one changes which boxes are asked for, builds the provider address (issuer)
 * from them, fills in sensible defaults and lists the steps on the provider's side. "Any OpenID Connect provider" keeps the plain issuer box for anything not listed.
 * Adding a provider is one entry here. Pure, so it is tested without a database.
 *
 * Provider names are their owners' trademarks and are listed only so you can pick the service you already use.
 */
export interface SsoField { key: string; label: string; hint?: string; placeholder?: string; optional?: boolean }
export interface SsoPreset {
  id: string; label: string; button: string;
  fields: SsoField[];
  issuer: (v: Record<string, string>) => string;
  defaults: { scopes: string; usernameClaim: string; groupClaim: string };
  adminLink?: (v: Record<string, string>, issuer: string) => string | null;      // the provider's own admin screen, to jump straight there
  steps: string[];                       // "{redirect}" is replaced with this platform's redirect address
  limits: string[];                      // what this provider cannot do, said plainly
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const LOCAL = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;       // a Keycloak on the same machine, for trying it out
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A host typed the way people type it: with or without https:// and a trailing slash. */
export const cleanHost = (s: string) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
const host = (v: Record<string, string>, k: string, what: string) => { const h = cleanHost(v[k] ?? ''); if (!HOST.test(h)) throw new Error(`${what} should look like company.example.com.`); return h; };
const label = (v: Record<string, string>, k: string, what: string) => { const h = (v[k] ?? '').trim(); if (!LABEL.test(h)) throw new Error(`${what} may only contain letters, numbers and dashes.`); return h.toLowerCase(); };

const STD = { scopes: 'openid profile email', usernameClaim: 'email', groupClaim: 'groups' };

export const PRESETS: SsoPreset[] = [
  {
    id: 'entra', label: 'Microsoft Entra ID (Azure AD)', button: 'Sign in with Microsoft',
    fields: [{ key: 'tenant', label: 'Directory (tenant) ID', hint: 'Entra admin centre > Overview. A GUID, or your verified domain such as contoso.onmicrosoft.com', placeholder: '00000000-0000-0000-0000-000000000000' }],
    issuer: (v) => {
      const t = (v.tenant ?? '').trim().toLowerCase();
      if (['common', 'organizations', 'consumers'].includes(t)) throw new Error('Use your own directory ID. "common" and "organizations" make the token issuer differ for every company, so sign-ins would be refused.');
      if (!GUID.test(t) && !HOST.test(t)) throw new Error('The directory ID should be a GUID such as 00000000-0000-0000-0000-000000000000, or a domain such as contoso.onmicrosoft.com.');
      return `https://login.microsoftonline.com/${t}/v2.0`;
    },
    adminLink: () => 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    defaults: STD,
    steps: ['Entra admin centre > App registrations > New registration. Choose "Web" and paste the redirect address: {redirect}', 'Copy the Application (client) ID and the Directory (tenant) ID into the boxes here.', 'Certificates & secrets > New client secret. Copy its Value (not the ID) into Client secret.', 'Optional, for roles: Token configuration > Add groups claim. Then list the group object IDs under "Roles from groups".'],
    limits: ['Groups arrive as object IDs (GUIDs), not names, so write the IDs in "Roles from groups".', 'A person in more than about 200 groups gets no group list in the token, so their role falls back to the default role or their existing role.', 'If email is empty for some people, set "Who they are" to preferred_username.'],
  },
  {
    id: 'okta', label: 'Okta', button: 'Sign in with Okta',
    fields: [{ key: 'domain', label: 'Okta domain', hint: 'For example company.okta.com (no https://)', placeholder: 'company.okta.com' }],
    issuer: (v) => `https://${host(v, 'domain', 'The Okta domain')}`,
    adminLink: (v) => { try { return `https://${host(v, 'domain', '')}/admin`; } catch { return null; } },
    defaults: { scopes: 'openid profile email groups', usernameClaim: 'email', groupClaim: 'groups' },
    steps: ['Okta admin > Applications > Create App Integration > OIDC > Web Application. Sign-in redirect URI: {redirect}', 'Copy the Client ID and Client secret into the boxes here.', 'For roles: Sign On > OpenID Connect ID Token > add a "groups" claim with a filter (for example starts with WFM-).'],
    limits: ['Groups only arrive if you add the groups claim in Okta.'],
  },
  {
    id: 'google', label: 'Google Workspace', button: 'Sign in with Google',
    fields: [{ key: 'allowedDomain', label: 'Only allow this email domain', hint: 'Recommended, for example company.com. Anyone with another address is refused', placeholder: 'company.com', optional: true }],
    issuer: () => 'https://accounts.google.com',
    adminLink: () => 'https://console.cloud.google.com/apis/credentials',
    defaults: { scopes: 'openid profile email', usernameClaim: 'email', groupClaim: 'groups' },
    steps: ['Google Cloud console > APIs & Services > Credentials > Create credentials > OAuth client ID > Web application. Authorised redirect URI: {redirect}', 'Copy the Client ID and Client secret into the boxes here.', 'OAuth consent screen: choose "Internal" so only your organisation can sign in.'],
    limits: ['Google sends no group list, so roles cannot come from groups. Everyone gets the default role below unless they already exist here with a role.'],
  },
  {
    id: 'keycloak', label: 'Keycloak', button: 'Sign in with Keycloak',
    fields: [
      { key: 'server', label: 'Keycloak server', hint: 'For example sso.company.com, or sso.company.com/auth for older versions', placeholder: 'sso.company.com' },
      { key: 'realm', label: 'Realm', placeholder: 'company' },
    ],
    issuer: (v) => {
      const raw = (v.server ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
      const [h, ...rest] = raw.split('/');
      if (!HOST.test(h.replace(/:\d{1,5}$/, '')) && !LOCAL.test(h)) throw new Error('The Keycloak server should look like sso.company.com.');
      if (rest.some((p) => !/^[a-z0-9._~-]+$/i.test(p))) throw new Error('The Keycloak path contains a character that is not allowed.');
      const realm = (v.realm ?? '').trim();
      if (!/^[A-Za-z0-9._~-]+$/.test(realm)) throw new Error('The realm may only contain letters, numbers and . _ ~ -');
      const scheme = LOCAL.test(h) ? 'http' : 'https';
      return `${scheme}://${[h, ...rest].join('/')}/realms/${realm}`;
    },
    adminLink: (v, issuer) => { const m = /^(.*)\/realms\/([^/]+)$/.exec(issuer); return m ? `${m[1]}/admin/master/console/#/${m[2]}/clients` : null; },
    defaults: STD,
    steps: ['Keycloak admin > Clients > Create client. Client type "OpenID Connect", turn Client authentication on, valid redirect URI: {redirect}', 'Credentials tab: copy the Client secret into the box here. The Client ID is the one you typed.', 'For roles: Client scopes > Add mapper > Group Membership, token claim name "groups", add to ID token.'],
    limits: ['Group names arrive with a leading slash (/WFM-Managers) unless "Full group path" is switched off in the mapper.'],
  },
  {
    id: 'auth0', label: 'Auth0', button: 'Sign in with Auth0',
    fields: [{ key: 'domain', label: 'Auth0 domain', hint: 'For example company.eu.auth0.com, or your custom domain', placeholder: 'company.auth0.com' }],
    issuer: (v) => `https://${host(v, 'domain', 'The Auth0 domain')}/`,
    adminLink: () => 'https://manage.auth0.com/',
    defaults: STD,
    steps: ['Auth0 dashboard > Applications > Create Application > Regular Web Application. Allowed Callback URL: {redirect}', 'Settings: copy the Client ID and Client secret into the boxes here.'],
    limits: ['Auth0 sends no groups by default; add them to the ID token with an Action, using a claim name that contains a web address (for example https://company.com/groups), and type that name in "Where their groups are".'],
  },
  {
    id: 'onelogin', label: 'OneLogin', button: 'Sign in with OneLogin',
    fields: [{ key: 'subdomain', label: 'OneLogin subdomain', hint: 'The part before .onelogin.com', placeholder: 'company' }],
    issuer: (v) => `https://${label(v, 'subdomain', 'The OneLogin subdomain')}.onelogin.com/oidc/2`,
    adminLink: (v) => { try { return `https://${label(v, 'subdomain', '')}.onelogin.com/admin`; } catch { return null; } },
    defaults: STD,
    steps: ['OneLogin admin > Applications > Add App > "OpenId Connect (OIDC)". Redirector URI: {redirect}', 'SSO tab: copy the Client ID and Client Secret into the boxes here. Token endpoint authentication: POST.'],
    limits: ['Groups arrive only if you add them as a parameter in the app.'],
  },
  {
    id: 'pingone', label: 'PingOne (Ping Identity)', button: 'Sign in with Ping',
    fields: [{ key: 'environment', label: 'Environment ID', hint: 'PingOne > Environment > Settings. A GUID', placeholder: '00000000-0000-0000-0000-000000000000' }],
    issuer: (v) => { const e = (v.environment ?? '').trim().toLowerCase(); if (!GUID.test(e)) throw new Error('The environment ID should be a GUID such as 00000000-0000-0000-0000-000000000000.'); return `https://auth.pingone.com/${e}/as`; },
    adminLink: () => 'https://console.pingone.com/',
    defaults: STD,
    steps: ['PingOne > Applications > Add Application > Web App > OIDC. Redirect URI: {redirect}', 'Copy the Client ID and Client secret into the boxes here. Enable the application.'],
    limits: ['This is the .com region. For the EU, Canada or Asia-Pacific regions choose "Any OpenID Connect provider" and type the issuer shown in your PingOne.'],
  },
  {
    id: 'jumpcloud', label: 'JumpCloud', button: 'Sign in with JumpCloud',
    fields: [],
    issuer: () => 'https://oauth.id.jumpcloud.com/',
    adminLink: () => 'https://console.jumpcloud.com/',
    defaults: STD,
    steps: ['JumpCloud admin > SSO Applications > Add > Custom OIDC App. Redirect URI: {redirect}', 'Copy the Client ID and Client secret into the boxes here. Add the "email" and "profile" attributes.'],
    limits: ['Groups arrive only if you add the groups attribute to the app.'],
  },
  {
    id: 'generic', label: 'Any OpenID Connect provider', button: 'Single sign-on',
    fields: [{ key: 'issuer', label: 'Provider address (issuer)', hint: 'The address that has /.well-known/openid-configuration under it, for example https://login.company.com', placeholder: 'https://' }],
    issuer: (v) => {
      const s = (v.issuer ?? '').trim();
      let u: URL; try { u = new URL(s); } catch { throw new Error('The provider address should start with https://'); }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new Error('The provider address must start with https://');
      return s;
    },
    defaults: STD,
    steps: ['In your provider, register this platform as a web application (authorization code flow) with the redirect address: {redirect}', 'Copy the Client ID and Client secret into the boxes here.'],
    limits: [],
  },
];

export const preset = (id: string | undefined | null) => PRESETS.find((p) => p.id === id);

/** The scopes an administrator can tick, what each is for, and which providers offer which. `openid` is always asked for. */
const SCOPE_INFO: Record<string, string> = {
  openid: 'Required: signs the person in', profile: 'Their name and basic details', email: 'Their email address, used to match people here',
  groups: 'Their group memberships, when the provider sends them only on request', offline_access: 'A long-lived refresh token (not used here)', address: 'Postal address (not used here)', phone: 'Phone number (not used here)',
};
const SCOPES_FOR: Record<string, string[]> = {
  entra: ['profile', 'email'], okta: ['profile', 'email', 'groups'], google: ['profile', 'email'], keycloak: ['profile', 'email', 'groups'], auth0: ['profile', 'email'],
  onelogin: ['profile', 'email', 'groups'], pingone: ['profile', 'email', 'address', 'phone'], jumpcloud: ['profile', 'email'], generic: ['profile', 'email', 'groups', 'offline_access', 'address', 'phone'],
};
/** The details a provider usually sends for "who they are" and "their groups", offered before any sign-in has been tried. */
const CLAIMS_FOR: Record<string, { username: string[]; group: string[] }> = {
  entra: { username: ['email', 'preferred_username', 'upn'], group: ['groups', 'roles'] }, okta: { username: ['email', 'preferred_username'], group: ['groups'] },
  google: { username: ['email'], group: ['groups'] }, keycloak: { username: ['email', 'preferred_username'], group: ['groups', 'roles'] },
};
const CLAIMS_ANY = { username: ['email', 'preferred_username', 'upn', 'sub'], group: ['groups', 'roles'] };

/** What the screen needs: the catalogue without functions. */
export const catalogue = () => PRESETS.map(({ id, label, button, fields, defaults, steps, limits }) => ({
  id, label, button, fields, defaults, steps, limits,
  scopeOptions: ['openid', ...(SCOPES_FOR[id] ?? SCOPES_FOR.generic)].map((s) => ({ id: s, hint: SCOPE_INFO[s] ?? '', locked: s === 'openid' })),
  claimHints: CLAIMS_FOR[id] ?? CLAIMS_ANY,
}));

/**
 * Tidy a list of scopes typed or ticked: separated by spaces or commas, no duplicates, `openid` always first. A scope is a token of visible characters without
 * quotes or backslashes (RFC 6749); anything else would make the provider refuse every sign-in, so it is refused here with the offending word named.
 */
export function normaliseScopes(text: string): string {
  const out: string[] = ['openid'];
  for (const t of text.split(/[\s,]+/).filter(Boolean)) {
    if (!/^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/.test(t)) throw new Error(`"${t.slice(0, 40)}" is not a valid scope. A scope is a single word with no spaces, quotes or backslashes.`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 30) throw new Error('That is more than 30 scopes. Ask only for what you need.');
  return out.join(' ');
}

/** A link to the provider's own admin screen where the application is registered, when it can be worked out. */
export function adminLinkFor(id: string, values: Record<string, string>, issuer: string): string | null {
  try { return preset(id)?.adminLink?.(values, issuer) ?? null; } catch { return null; }
}

/** The issuer for a provider and the values typed for it. Throws a plain-language message when a value is wrong. */
export function buildIssuer(id: string, values: Record<string, string>): string {
  const p = preset(id);
  if (!p) throw new Error('That provider is not in the list.');
  for (const f of p.fields) if (!f.optional && !(values[f.key] ?? '').trim()) throw new Error(`${f.label} is required.`);
  return p.issuer(values);
}

/** Only the values this provider asks for, tidied, so nothing else is stored. */
export function cleanValues(id: string, values: Record<string, string>): Record<string, string> {
  const p = preset(id);
  const out: Record<string, string> = {};
  for (const f of p?.fields ?? []) { const v = (values[f.key] ?? '').trim(); if (v) out[f.key] = v.slice(0, 300); }
  if (p?.id === 'google' && out.allowedDomain) out.allowedDomain = cleanHost(out.allowedDomain);
  return out;
}

/** True when an email address is allowed by the organisation's domain limit (no limit means everyone). */
export const domainAllowed = (allowedDomain: string | undefined, email: string) => {
  if (!allowedDomain) return true;
  const at = email.lastIndexOf('@');
  return at > 0 && email.slice(at + 1).toLowerCase() === allowedDomain.toLowerCase();
};

/**
 * Recognise a provider from a pasted address: the issuer, the discovery address (.../.well-known/openid-configuration) or just a domain.
 * Returns the provider and the values to put in its boxes, or null when nothing sensible can be made of it. An unrecognised but valid address becomes "any provider".
 */
export function detect(text: string): { preset: string; values: Record<string, string>; issuer: string } | null {
  let t = text.trim().replace(/\/\.well-known\/openid-configuration\/?$/i, '');
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = `https://${t}`;
  let u: URL; try { u = new URL(t); } catch { return null; }
  const h = u.hostname.toLowerCase(), path = u.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean);
  const guess = (): { preset: string; values: Record<string, string> } => {
    if (h === 'login.microsoftonline.com' && seg[0]) return { preset: 'entra', values: { tenant: seg[0] } };
    if (h === 'sts.windows.net' && seg[0]) return { preset: 'entra', values: { tenant: seg[0] } };
    if (/\.(okta|oktapreview|okta-emea)\.com$/.test(h) && !seg.length) return { preset: 'okta', values: { domain: h } };
    if (h === 'accounts.google.com' && !seg.length) return { preset: 'google', values: {} };
    const kc = /^(.*)\/realms\/([^/]+)$/.exec(path);
    if (kc) return { preset: 'keycloak', values: { server: `${u.host}${kc[1]}`, realm: kc[2] } };
    if (/\.auth0\.com$/.test(h) && !seg.length) return { preset: 'auth0', values: { domain: h } };
    if (/\.onelogin\.com$/.test(h) && path === '/oidc/2') return { preset: 'onelogin', values: { subdomain: h.split('.')[0] } };
    if (h === 'auth.pingone.com' && seg[0] && seg[1] === 'as') return { preset: 'pingone', values: { environment: seg[0] } };
    if (h === 'oauth.id.jumpcloud.com') return { preset: 'jumpcloud', values: {} };
    return { preset: 'generic', values: { issuer: `${u.origin}${path}` } };
  };
  const g = guess();
  try { return { ...g, values: cleanValues(g.preset, g.values), issuer: buildIssuer(g.preset, g.values) }; } catch { /* fall back to the plain form below */ }
  try { const issuer = buildIssuer('generic', { issuer: `${u.origin}${path}` }); return { preset: 'generic', values: { issuer }, issuer }; } catch { return null; }
}

/** What an administrator is shown from a test sign-in: the facts the provider sent, minus technical ones, each shortened. */
const HIDDEN = new Set(['nonce', 'at_hash', 'c_hash', 'iat', 'exp', 'nbf', 'jti', 'aud', 'iss', 'azp', 'auth_time', 'acr', 'amr', 'ver', 'aio', 'uti', 'rh', 'tid']);
export function showClaims(claims: Record<string, unknown>): { name: string; value: string; list: boolean }[] {
  const one = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return Object.entries(claims).filter(([k]) => !HIDDEN.has(k)).map(([name, v]) => {
    const text = Array.isArray(v) ? `${v.slice(0, 25).map(one).join(', ')}${v.length > 25 ? ` … (${v.length} in all)` : ''}` : one(v);
    return { name, value: text.length > 300 ? `${text.slice(0, 300)}…` : text, list: Array.isArray(v) };
  });
}

export const looksLikeIds = (groups: string[]) => groups.length > 0 && groups.every((g) => GUID.test(g));
