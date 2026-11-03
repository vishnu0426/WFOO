/**
 * Single sign-on with OpenID Connect: authorization code flow with PKCE. Works with any provider that publishes a discovery document
 * (Microsoft Entra ID, Okta, Google Workspace, Keycloak, Auth0...). The provider vouches for who the person is; the platform still decides what they can do
 * (their role), either from the user it already has or from the groups the provider sends.
 *
 * The id token is checked properly: signature against the provider's published keys, issuer, audience, expiry and the one-time nonce.
 */
import { safeFetch } from '../netGuard.ts';
import { createHash, createHmac, createPublicKey, randomBytes } from 'node:crypto';
import { hashPassword } from '../passwordHash.ts';
import jwt from 'jsonwebtoken';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { raw, resolveDefaultWorkspaceId, withTenant } from '../db.ts';
import { joinDefaultWorkspace } from './workspaceMembership.ts';
import { me, requires, signToken, ROLES } from '../auth.ts';
import { audit } from '../audit.ts';
import { config } from '../config.ts';
import { HttpError, bad, parse } from '../http.ts';
import { encrypt, open } from '../secrets.ts';
import { redis } from '../infra.ts';
import { cleanUrl, parseTo, returnBase, type ReturnTo } from './ssoReturn.ts';
import { adminLinkFor, buildIssuer, catalogue, cleanValues, detect, domainAllowed, looksLikeIds, normaliseScopes, preset, showClaims } from './ssoProviders.ts';

export const ssoPublic = Router();    // mounted at /auth/sso, before sign-in is required
export const ssoAdmin = Router();     // mounted at /sso, for administrators

const b64url = (b: Buffer) => b.toString('base64url');
const appUrl = () => (process.env.APP_URL || config.corsOrigin[0] || 'http://localhost:3000').replace(/\/$/, '');
const publicUrl = (req: Request) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = (req: Request) => `${publicUrl(req)}/api/v1/auth/sso/callback`;

interface Provider { tenantId: string; name: string; issuer: string; clientId: string; clientSecret: string; scopes: string; usernameClaim: string; groupClaim: string; groupRoles: Record<string, string>; defaultRole: string; jit: boolean; syncRole: boolean; passwordLogin: boolean; enabled: boolean; preset: string; presetValues: Record<string, string> }
const loadProvider = async (tenantId: string) => { const p = await withTenant(tenantId, (tx) => tx.one<Provider>('SELECT * FROM sso_providers WHERE tenant_id = :t')); return p ? { ...p, clientSecret: open(p.clientSecret) } : p; };      // stored encrypted, opened here to use
/** An organisation by its code; "_" means the only one, for a platform that hosts a single organisation. */
const tenantByCode = async (code: string) => {
  const all = await raw<{ id: string; code: string }>('SELECT id, code FROM tenants');
  return code === '_' ? (all.length === 1 ? all[0] : undefined) : all.find((t) => t.code.toLowerCase() === code.toLowerCase());
};

// ---------------------------------------------------------------- talking to the provider

const cache = new Map<string, { at: number; value: any }>();
async function cachedJson(url: string, ttlMs = 10 * 60_000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const r = await safeFetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new HttpError(502, 'SSO_PROVIDER', `The sign-in provider answered ${r.status} for ${url}`);
  const value = await r.json();
  cache.set(url, { at: Date.now(), value });
  return value;
}
const discover = async (issuer: string) => {
  const d = await cachedJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new HttpError(502, 'SSO_PROVIDER', 'That provider’s discovery document is missing endpoints.');
  return d as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
};

/** Check an id token. Throws with a plain reason when anything is wrong. */
export async function verifyIdToken(idToken: string, p: { issuer: string; clientId: string }, nonce: string, doc: { issuer: string; jwks_uri: string }) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string') throw new Error('The sign-in provider sent something that is not an id token.');
  const { kid, alg } = decoded.header;
  if (!['RS256', 'RS384', 'RS512', 'ES256', 'ES384'].includes(String(alg))) throw new Error(`The id token uses an algorithm that is not accepted (${alg}).`);
  let keys = (await cachedJson(doc.jwks_uri, 5 * 60_000)).keys as any[];
  let jwk = keys.find((k) => k.kid === kid) ?? (keys.length === 1 && !kid ? keys[0] : undefined);
  if (!jwk) { cache.delete(doc.jwks_uri); keys = (await cachedJson(doc.jwks_uri, 0)).keys; jwk = keys.find((k) => k.kid === kid); }   // keys rotate
  if (!jwk) throw new Error('The id token is signed with a key the provider does not publish.');
  const claims = jwt.verify(idToken, createPublicKey({ key: jwk, format: 'jwk' }), { algorithms: [alg as jwt.Algorithm], issuer: doc.issuer || p.issuer, audience: p.clientId, clockTolerance: 60 }) as jwt.JwtPayload;
  if (claims.nonce !== nonce) throw new Error('The sign-in did not start here (nonce mismatch). Try again.');
  return claims;
}

// ---------------------------------------------------------------- the flow

const cookieOf = (req: Request, name: string) => (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const portalUrl = () => cleanUrl(process.env.PORTAL_URL);
const baseFor = (to: ReturnTo) => returnBase(to, { app: appUrl(), portal: portalUrl() });
const fail = (res: Response, message: string, to: ReturnTo = 'app') => res.redirect(`${baseFor(to)}/#sso_error=${encodeURIComponent(message)}`);

ssoPublic.get('/:tenant/info', async (req, res) => {
  const t = await tenantByCode(String(req.params.tenant));
  const p = t ? await loadProvider(t.id) : undefined;
  // the start address is absolute and on the public address, the same host the provider returns to: the sign-in cookie is set where it starts, so a portal on another host must start it there
  res.json({ enabled: !!p?.enabled, name: p?.name ?? null, passwordLogin: p ? p.passwordLogin : true, portal: !!portalUrl(), start: `${publicUrl(req)}/api/v1/auth/sso/${encodeURIComponent(String(req.params.tenant))}/start?to=portal` });
});

ssoPublic.get('/:tenant/start', async (req, res) => {
  const t = await tenantByCode(String(req.params.tenant));
  const p = t ? await loadProvider(t.id) : undefined;
  const to = parseTo(req.query.to);
  if (!t || !p?.enabled) return fail(res, 'Single sign-on is not set up for that organisation.', to);
  if (to === 'portal' && !portalUrl()) return fail(res, 'The employee portal address is not set on the server (PORTAL_URL), so sign-in from the portal cannot return there. Ask your administrator.');
  try {
    const doc = await discover(p.issuer);
    const state = b64url(randomBytes(16)), nonce = b64url(randomBytes(16)), verifier = b64url(randomBytes(32));
    const cookie = jwt.sign({ t: t.id, s: state, n: nonce, v: verifier, to }, config.jwtSecret, { expiresIn: '10m' });
    res.cookie('wfm_sso', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600_000, secure: publicUrl(req).startsWith('https') });
    const u = new URL(doc.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri(req), scope: p.scopes, state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
    res.redirect(u.toString());
  } catch (e: any) { fail(res, e.message, to); }
});

/** The one employee record with this email that no login is linked to yet, or null when there is none or more than one (never guess between people). */
async function employeeByEmail(tx: any, email: string): Promise<string | null> {
  if (!email) return null;
  const rows = await tx.q('SELECT e.id FROM employees e WHERE e.tenant_id = :t AND lower(e.email) = lower($1) AND NOT EXISTS (SELECT 1 FROM users x WHERE x.tenant_id = :t AND x.employee_id = e.id)', [email]);
  return rows.length === 1 ? rows[0].id : null;
}

/** Work out who in the platform this person is, creating them on first sign-in when that is allowed. */
async function resolveUser(p: Provider, claims: jwt.JwtPayload, req: Request) {
  const login = String(claims[p.usernameClaim] ?? '').trim();
  if (!login) throw new Error(`The provider did not send "${p.usernameClaim}", so we cannot tell who you are.`);
  const allowed = p.presetValues?.allowedDomain;
  if (allowed && !domainAllowed(allowed, String(claims.email ?? login))) throw new Error(`Only ${allowed} addresses can sign in here.`);
  const groups: string[] = ([] as string[]).concat((claims[p.groupClaim] as string[] | string | undefined) ?? []);
  const mapped = groups.map((g) => p.groupRoles[g]).find((r) => r && (ROLES as readonly string[]).includes(r)) as (typeof ROLES)[number] | undefined;
  const mail = String(claims.email ?? (login.includes('@') ? login : '')).trim();
  return withTenant(p.tenantId, async (tx) => {
    let u = await tx.one<any>('SELECT * FROM users WHERE tenant_id = :t AND (lower(username) = lower($1) OR lower(email) = lower($1))', [login]);
    if (!u) {
      if (!p.jit) throw new Error('You are not set up in this system yet. Ask an administrator to add you.');
      const role = (mapped ?? p.defaultRole) as (typeof ROLES)[number];
      u = await tx.one<any>(
        `INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, employee_id, must_change_password) VALUES (:t, $1, $2, $3, $4, $5, $6, false) RETURNING *`,
        [login, String(claims.name ?? login), claims.email ?? (login.includes('@') ? login : null), role, await hashPassword(randomBytes(24).toString('hex'), 10), await employeeByEmail(tx, mail)]);
      await joinDefaultWorkspace(tx, u.id, u.employeeId ?? null, role);
      await audit(tx, { userId: u.id, tenantId: p.tenantId, workspaceId: '', role, name: u.displayName, username: u.username, jti: '' }, req, { action: 'CREATE', entityType: 'USER', entityId: u.id, entityName: login, diffSummary: `Created on first single sign-on as ${role}` });
    } else if (p.syncRole && mapped && mapped !== u.role) {
      await tx.exec('UPDATE users SET role = $2 WHERE tenant_id = :t AND id = $1', [u.id, mapped]);
      u = { ...u, role: mapped };
    }
    if (u.status !== 'ACTIVE') throw new Error('Your account is switched off. Ask an administrator.');
    if (!u.employeeId) {          // the employee portal needs the login tied to an employee record: match on email when it is unambiguous
      const emp = await employeeByEmail(tx, mail);
      if (emp) { await tx.exec('UPDATE users SET employee_id = $2 WHERE tenant_id = :t AND id = $1 AND employee_id IS NULL', [u.id, emp]); u = { ...u, employeeId: emp }; }
    }
    await tx.exec('UPDATE users SET last_login_at = now() WHERE tenant_id = :t AND id = $1', [u.id]);
    await audit(tx, { userId: u.id, tenantId: p.tenantId, workspaceId: u.defaultWorkspaceId ?? '', role: u.role, name: u.displayName, username: u.username, jti: '' }, req, { action: 'LOGIN', entityType: 'USER', entityId: u.id, entityName: u.username, diffSummary: 'Signed in with single sign-on' });
    return u;
  });
}

ssoPublic.get('/callback', async (req, res) => {
  const to = (() => { try { return parseTo((jwt.verify(cookieOf(req, 'wfm_sso') ?? '', config.jwtSecret) as any).to); } catch { return 'app' as ReturnTo; } })();
  try {
    const probeCookie = (() => { try { const c: any = jwt.verify(cookieOf(req, 'wfm_sso') ?? '', config.jwtSecret); return c?.probe ? c : null; } catch { return null; } })();
    if (probeCookie) return await finishProbe(req, res, probeCookie);          // "Try sign-in" from the settings screen: nobody is signed in
    if (typeof req.query.error === 'string') return fail(res, `The sign-in provider said: ${req.query.error_description ?? req.query.error}`, to);
    const code = String(req.query.code ?? ''), state = String(req.query.state ?? '');
    let c: any;
    try { c = jwt.verify(cookieOf(req, 'wfm_sso') ?? '', config.jwtSecret); } catch { return fail(res, 'The sign-in took too long or did not start here. Try again.', to); }
    if (!code || c.s !== state) return fail(res, 'The sign-in could not be matched to your browser. Try again.', to);
    const p = await loadProvider(c.t);
    if (!p?.enabled) return fail(res, 'Single sign-on is switched off.', to);
    const doc = await discover(p.issuer);
    const tr = await safeFetch(doc.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req), client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}), code_verifier: c.v }),
    });
    const tok: any = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) return fail(res, `The provider would not give a sign-in (${tok.error_description ?? tok.error ?? tr.status}).`, to);
    const claims = await verifyIdToken(tok.id_token, p, c.n, doc);
    const u = await resolveUser(p, claims, req);
    res.clearCookie('wfm_sso');
    const token = signToken({ userId: u.id, tenantId: p.tenantId, workspaceId: u.defaultWorkspaceId ?? await resolveDefaultWorkspaceId(p.tenantId), role: u.role, name: u.displayName, username: u.username });
    res.redirect(`${baseFor(to === 'portal' && !portalUrl() ? 'app' : to)}/#sso_token=${token}`);
  } catch (e: any) { fail(res, e?.message ?? 'Sign-in failed.', to); }
});

// ---------------------------------------------------------------- settings

/** Which provider was chosen and its issuer, from either the chosen provider's boxes or (the older form) a plain issuer. Throws a plain-language 400. */
function resolveConfig(body: { issuer?: string; preset: string; presetValues: Record<string, string>; scopes: string }) {
  const chosen = body.issuer && !Object.keys(body.presetValues).length ? { id: 'generic', values: { issuer: body.issuer } } : { id: body.preset, values: body.presetValues };
  if (!preset(chosen.id)) throw bad('That provider is not in the list.');
  try { return { issuer: buildIssuer(chosen.id, chosen.values), preset: chosen.id, presetValues: cleanValues(chosen.id, chosen.values), scopes: normaliseScopes(body.scopes) }; } catch (e: any) { throw bad(e.message); }
}
/** Identifies the exact provider, application and secret a test sign-in was done with, without storing any of them. */
const fingerprint = (c: { issuer: string; clientId: string; clientSecret: string; scopes: string }) => createHmac('sha256', config.jwtSecret).update([c.issuer, c.clientId, c.clientSecret, c.scopes].join('\u0000')).digest('hex');
const loadTested = (tenantId: string) => withTenant(tenantId, (tx) => tx.one<{ fingerprint: string; login: string | null; testedBy: string | null; testedAt: string }>('SELECT * FROM sso_tests WHERE tenant_id = :t'));

const dto = (p: Provider | undefined, req: Request, tested?: { fingerprint: string; login: string | null; testedAt: string } | null) => ({
  portalUrl: portalUrl() ?? null,
  tested: tested ? { at: tested.testedAt, login: tested.login, ok: !!p && tested.fingerprint === fingerprint({ issuer: p.issuer, clientId: p.clientId, clientSecret: open(p.clientSecret), scopes: p.scopes }) } : null,
  preset: p?.preset ?? 'generic', presetValues: p?.presetValues ?? {}, configured: !!p, name: p?.name ?? 'Single sign-on', issuer: p?.issuer ?? '', clientId: p?.clientId ?? '', hasSecret: !!p?.clientSecret, scopes: p?.scopes ?? 'openid profile email',
  usernameClaim: p?.usernameClaim ?? 'email', groupClaim: p?.groupClaim ?? 'groups', groupRoles: p?.groupRoles ?? {}, defaultRole: p?.defaultRole ?? 'AGENT', jit: p?.jit ?? false, syncRole: p?.syncRole ?? false,
  passwordLogin: p?.passwordLogin ?? true, enabled: p?.enabled ?? false, redirectUri: redirectUri(req),
});
const Body = z.object({
  preset: z.string().max(30).default('generic'), presetValues: z.record(z.string().max(50), z.string().max(300)).default({}),
  name: z.string().trim().min(1).max(60).default('Single sign-on'), issuer: z.string().max(500).optional(), clientId: z.string().trim().min(1).max(300), clientSecret: z.string().max(500).optional(),
  scopes: z.string().trim().min(3).max(200).default('openid profile email'), usernameClaim: z.string().trim().min(1).max(60).default('email'), groupClaim: z.string().trim().min(1).max(60).default('groups'),
  groupRoles: z.record(z.string().max(200), z.enum(ROLES)).default({}), defaultRole: z.enum(ROLES).default('AGENT'), jit: z.boolean().default(false), syncRole: z.boolean().default(false),
  passwordLogin: z.boolean().default(true), enabled: z.boolean().default(false),
});
ssoAdmin.get('/config', requires('users:read'), async (req, res) => { const t = me(req).tenantId; res.json(dto(await loadProvider(t), req, await loadTested(t))); });
ssoAdmin.put('/config', requires('users:write'), async (req, res) => {
  const p = me(req), body = parse(Body, req.body);
  const b = { ...body, ...resolveConfig(body) };
  if (b.defaultRole === 'WFM_ADMIN' || Object.values(b.groupRoles).includes('WFM_ADMIN')) {/* allowed, but it is an administrator's explicit choice and is audited below */}
  if (b.enabled) await discover(b.issuer).catch((e) => { throw bad(`Cannot reach that provider: ${e.message}`); });   // never switch on something that cannot work
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await tx.one<Provider>('SELECT * FROM sso_providers WHERE tenant_id = :t');
    // switching single sign-on on, or switching passwords off, is only allowed for a provider and application that a real sign-in has been tried with
    const now = fingerprint({ issuer: b.issuer, clientId: b.clientId, clientSecret: b.clientSecret || open(before?.clientSecret), scopes: b.scopes });
    const was = before ? fingerprint({ issuer: before.issuer, clientId: before.clientId, clientSecret: open(before.clientSecret), scopes: before.scopes }) : null;
    const needsTry = (b.enabled && !(before?.enabled && was === now)) || (!b.passwordLogin && !(before && !before.passwordLogin && was === now));
    if (needsTry && (await tx.one<{ fingerprint: string }>('SELECT fingerprint FROM sso_tests WHERE tenant_id = :t'))?.fingerprint !== now)
      throw bad('Try sign-in first: switching single sign-on on (or switching passwords off) needs one real sign-in through this provider, so a wrong setting cannot lock people out. Use "Try sign-in", then save again.');
    await tx.exec(
      `INSERT INTO sso_providers (tenant_id, name, issuer, client_id, client_secret, scopes, username_claim, group_claim, group_roles, default_role, jit, sync_role, password_login, enabled, preset, preset_values, updated_at)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       ON CONFLICT (tenant_id) DO UPDATE SET name = $1, issuer = $2, client_id = $3, client_secret = CASE WHEN $4 = '' THEN sso_providers.client_secret ELSE $4 END, scopes = $5, username_claim = $6, group_claim = $7,
         group_roles = $8, default_role = $9, jit = $10, sync_role = $11, password_login = $12, enabled = $13, preset = $14, preset_values = $15, updated_at = now()`,
      [b.name, b.issuer, b.clientId, encrypt(b.clientSecret ?? ''), b.scopes, b.usernameClaim, b.groupClaim, JSON.stringify(b.groupRoles), b.defaultRole, b.jit, b.syncRole, b.passwordLogin, b.enabled, b.preset, JSON.stringify(b.presetValues)]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SSO', entityId: 'sso', entityName: 'Single sign-on', before: before ? { enabled: before.enabled, issuer: before.issuer, jit: before.jit } : undefined, after: { enabled: b.enabled, issuer: b.issuer, jit: b.jit, defaultRole: b.defaultRole, groupRoles: b.groupRoles } });
    return tx.one<Provider>('SELECT * FROM sso_providers WHERE tenant_id = :t');
  });
  res.json(dto(out, req, await loadTested(p.tenantId)));
});
/** The providers to choose from, with the boxes each one asks for and its setup steps. */
ssoAdmin.get('/providers', requires('users:read'), (_req, res) => { res.json(catalogue()); });
/** Check the provider can be reached and says what we need, before anyone relies on it. Takes either a chosen provider and its values, or a plain issuer. */
ssoAdmin.post('/test', requires('users:write'), async (req, res) => {
  const b = parse(z.object({ issuer: z.string().max(500).optional(), preset: z.string().max(30).optional(), presetValues: z.record(z.string().max(50), z.string().max(300)).default({}) }), req.body);
  let issuer: string;
  try { issuer = b.preset ? buildIssuer(b.preset, b.presetValues) : buildIssuer('generic', { issuer: b.issuer ?? '' }); } catch (e: any) { return void res.json({ ok: false, error: e.message }); }
  try {
    cache.delete(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    const d = await discover(issuer); await cachedJson(d.jwks_uri, 0);
    const same = (d.issuer ?? '').replace(/\/$/, '') === issuer.replace(/\/$/, '');
    res.json({ ok: true, issuer: d.issuer, authorizationEndpoint: d.authorization_endpoint, issuerMatches: same, warning: same ? null : `The provider says its address is ${d.issuer}, not ${issuer}. Sign-ins will be refused until they match.` });
  } catch (e: any) { res.json({ ok: false, error: `Cannot reach that provider: ${e.message}` }); }
});

/** Show the provider address that will be used for the values typed so far, and a link to the provider's admin screen. */
ssoAdmin.post('/preview', requires('users:read'), (req, res) => {
  const b = parse(z.object({ preset: z.string().max(30), presetValues: z.record(z.string().max(50), z.string().max(300)).default({}) }), req.body);
  try { const issuer = buildIssuer(b.preset, b.presetValues); res.json({ ok: true, issuer, adminLink: adminLinkFor(b.preset, cleanValues(b.preset, b.presetValues), issuer) }); }
  catch (e: any) { res.json({ ok: false, error: e.message, adminLink: adminLinkFor(b.preset, cleanValues(b.preset, b.presetValues), '') }); }
});
/** Recognise the provider from a pasted address and give back what to put in its boxes. */
ssoAdmin.post('/detect', requires('users:read'), (req, res) => {
  const d = detect(parse(z.object({ text: z.string().max(500) }), req.body).text);
  res.json(d ? { ok: true, ...d, label: preset(d.preset)?.label } : { ok: false, error: 'That does not look like a web address. Paste the provider address, for example https://login.microsoftonline.com/<tenant>/v2.0' });
});

// ---------------------------------------------------------------- "Try sign-in": a real sign-in that signs nobody in, and shows what the provider sent

interface ProbeCfg { issuer: string; clientId: string; clientSecret: string; scopes: string; usernameClaim: string; groupClaim: string; groupRoles: Record<string, string>; defaultRole: string; jit: boolean; allowedDomain?: string }
interface ProbeResult {
  status: 'done' | 'error'; error?: string; claims?: { name: string; value: string; list: boolean }[]; login?: string; usernameClaim?: string; groupClaim?: string; groups?: string[];
  mappedRole?: string | null; existingUser?: { role: string; status: string } | null; outcome?: { ok: boolean; text: string }; employee?: { ok: boolean; text: string }; hints?: string[]; tried?: boolean;
}
interface Probe { tenantId: string; userName: string; cfg: ProbeCfg; used?: boolean; result?: ProbeResult }
const PROBE_TTL = 600;
const memProbes = new Map<string, { exp: number; v: string }>();
async function saveProbe(id: string, p: Probe) {
  const v = JSON.stringify(p);
  for (const [k, m] of memProbes) if (m.exp < Date.now()) memProbes.delete(k);
  if (memProbes.size < 500) memProbes.set(id, { exp: Date.now() + PROBE_TTL * 1000, v });
  try { await redis.set(`ssoprobe:${id}`, v, 'EX', PROBE_TTL); } catch { /* Redis is down: this process's own copy is used */ }
}
async function loadProbe(id: string): Promise<Probe | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  try { const v = await redis.get(`ssoprobe:${id}`); if (v) return JSON.parse(v); } catch { /* fall through to this process's copy */ }
  const m = memProbes.get(id);
  return m && m.exp > Date.now() ? JSON.parse(m.v) : null;
}
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The page the provider sends the test window back to. It shows no sign-in details; the settings screen reads the result itself. */
function probePage(res: Response, ok: boolean, message: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><title>Sign-in test</title><body style="font:15px system-ui;margin:3rem auto;max-width:28rem;text-align:center"><h2>${ok ? 'Sign-in test finished' : 'Sign-in test did not finish'}</h2><p>${esc(message)}</p><p style="color:#666">You can close this window and go back to the settings.</p><script>try{window.opener&&window.opener.postMessage({type:'wfm-sso-test'},location.origin)}catch(e){}setTimeout(function(){window.close()},${ok ? 1500 : 6000})</script>`);
}

ssoAdmin.post('/try', requires('users:write'), async (req, res) => {
  const p = me(req);
  const b = parse(Body.pick({ preset: true, presetValues: true, issuer: true, clientId: true, clientSecret: true, scopes: true, usernameClaim: true, groupClaim: true, groupRoles: true, defaultRole: true, jit: true }), req.body);
  const c = resolveConfig(b);
  const saved = await loadProvider(p.tenantId);
  await discover(c.issuer).catch((e) => { throw bad(`Cannot reach that provider: ${e.message}`); });
  const id = randomBytes(16).toString('hex');
  const cfg: ProbeCfg = { issuer: c.issuer, clientId: b.clientId, clientSecret: encrypt(b.clientSecret || saved?.clientSecret || ''), scopes: c.scopes, usernameClaim: b.usernameClaim, groupClaim: b.groupClaim, groupRoles: b.groupRoles, defaultRole: b.defaultRole, jit: b.jit, allowedDomain: c.presetValues.allowedDomain };
  await saveProbe(id, { tenantId: p.tenantId, userName: p.name, cfg });
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'SSO', entityId: 'sso', entityName: 'Single sign-on', diffSummary: `Started a test sign-in with ${c.preset}` }));
  res.json({ id, url: `${publicUrl(req)}/api/v1/auth/sso/try/${id}/go` });
});
ssoAdmin.get('/try/:id', requires('users:write'), async (req, res) => {
  const pr = await loadProbe(String(req.params.id));
  if (!pr || pr.tenantId !== me(req).tenantId) return void res.json({ status: 'expired' });
  res.json(pr.result ?? { status: 'waiting' });
});

ssoPublic.get('/try/:id/go', async (req, res) => {
  const id = String(req.params.id), pr = await loadProbe(id);
  if (!pr || pr.used || pr.result) return probePage(res, false, 'This test link has expired or was already used. Go back to the settings and press "Try sign-in" again.');
  try {
    const doc = await discover(pr.cfg.issuer);
    const state = b64url(randomBytes(16)), nonce = b64url(randomBytes(16)), verifier = b64url(randomBytes(32));
    pr.used = true; await saveProbe(id, pr);
    res.cookie('wfm_sso', jwt.sign({ t: pr.tenantId, s: state, n: nonce, v: verifier, probe: id }, config.jwtSecret, { expiresIn: '10m' }), { httpOnly: true, sameSite: 'lax', maxAge: 600_000, secure: publicUrl(req).startsWith('https') });
    const u = new URL(doc.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: 'code', client_id: pr.cfg.clientId, redirect_uri: redirectUri(req), scope: pr.cfg.scopes, state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }).toString();
    res.redirect(u.toString());
  } catch (e: any) { probePage(res, false, e.message); }
});

async function finishProbe(req: Request, res: Response, c: { probe: string; s: string; n: string; v: string }) {
  const pr = await loadProbe(c.probe);
  const end = async (r: ProbeResult, message: string) => { if (pr) { pr.result = r; await saveProbe(c.probe, pr); } res.clearCookie('wfm_sso'); probePage(res, r.status === 'done', message); };
  if (!pr) return probePage(res, false, 'This test has expired. Go back to the settings and press "Try sign-in" again.');
  try {
    if (typeof req.query.error === 'string') return await end({ status: 'error', error: `The sign-in provider said: ${req.query.error_description ?? req.query.error}` }, 'The provider refused the sign-in.');
    const code = String(req.query.code ?? '');
    if (!code || c.s !== String(req.query.state ?? '')) return await end({ status: 'error', error: 'The sign-in could not be matched to this test. Try again.' }, 'The sign-in could not be matched.');
    const cfg = pr.cfg, secret = open(cfg.clientSecret);
    const doc = await discover(cfg.issuer);
    const tr = await safeFetch(doc.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(req), client_id: cfg.clientId, ...(secret ? { client_secret: secret } : {}), code_verifier: c.v }),
    });
    const tok: any = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.id_token) return await end({ status: 'error', error: `The provider would not give a sign-in (${tok.error_description ?? tok.error ?? tr.status}). Check the Client ID and Client secret.` }, 'The provider would not give a sign-in.');
    const claims = await verifyIdToken(tok.id_token, cfg, c.n, doc);
    const login = String(claims[cfg.usernameClaim] ?? '').trim();
    const rawGroups = claims[cfg.groupClaim];
    const groups = ([] as unknown[]).concat(rawGroups ?? []).filter((g): g is string => typeof g === 'string');
    const mapped = groups.map((g) => cfg.groupRoles[g]).find((r) => r && (ROLES as readonly string[]).includes(r)) ?? null;
    const existing = login ? await withTenant(pr.tenantId, (tx) => tx.one<{ role: string; status: string; employeeId: string | null }>('SELECT role, status, employee_id FROM users WHERE tenant_id = :t AND (lower(username) = lower($1) OR lower(email) = lower($1))', [login])) : null;
    const mail = String(claims.email ?? (login.includes('@') ? login : '')).trim();
    const employee = !login ? undefined : await withTenant(pr.tenantId, async (tx) => {
      if (existing?.employeeId) { const e = await tx.one<any>('SELECT first_name, last_name, employee_number FROM employees WHERE tenant_id = :t AND id = $1', [existing.employeeId]); return { ok: true, text: `Linked to employee ${e?.firstName ?? ''} ${e?.lastName ?? ''} (#${e?.employeeNumber ?? '?'}), so the employee portal shows their schedule.` }; }
      const n = mail ? (await tx.q<any>('SELECT first_name, last_name, employee_number FROM employees WHERE tenant_id = :t AND lower(email) = lower($1)', [mail])) : [];
      if (n.length === 1) return { ok: true, text: `Will be linked to employee ${n[0].firstName} ${n[0].lastName} (#${n[0].employeeNumber}) by email at first sign-in, so the employee portal shows their schedule.` };
      if (n.length > 1) return { ok: false, text: `More than one employee record has the email ${mail}, so no link is made. Make the emails unique, or link the login by hand, or the employee portal will have nothing to show.` };
      return { ok: false, text: `No employee record has the email ${mail || '(none sent)'}, so the employee portal would have nothing to show. Fix the email on the employee record, or link the login by hand. The admin app is not affected.` };
    });
    const hints: string[] = [];
    let outcome: { ok: boolean; text: string };
    if (!login) outcome = { ok: false, text: `The provider did not send "${cfg.usernameClaim}", so nobody could be matched. Pick another claim under "Who they are" (the list above shows what it did send).` };
    else if (cfg.allowedDomain && !domainAllowed(cfg.allowedDomain, String(claims.email ?? login))) outcome = { ok: false, text: `You signed in as ${login}, but only ${cfg.allowedDomain} addresses are allowed.` };
    else if (existing && existing.status !== 'ACTIVE') outcome = { ok: false, text: `${login} exists here but the account is switched off.` };
    else if (existing) outcome = { ok: true, text: `${login} would sign in as ${existing.role}${mapped && mapped !== existing.role ? ` (their group maps to ${mapped}, applied only if "Keep roles in step" is on)` : ''}.` };
    else if (cfg.jit) outcome = { ok: true, text: `${login} is new here and would be created as ${mapped ?? cfg.defaultRole}.` };
    else outcome = { ok: false, text: `${login} is not set up here yet, and "Create people when they first sign in" is off, so they would be refused. Add them under Users Directory or switch that on.` };
    if (login && rawGroups === undefined) hints.push(`The provider sent no "${cfg.groupClaim}" claim, so roles cannot come from groups. Add a groups claim at the provider, or change "Where their groups are".`);
    if (looksLikeIds(groups)) hints.push('These groups are IDs, not names. Use the IDs in "Roles from groups" (the Add buttons do this for you).');
    if (groups.length && !mapped) hints.push('None of these groups is mapped to a role yet.');
    // a real sign-in through this exact provider, application and secret has now worked: switching on is allowed for it
    if (login) {
      const fp = fingerprint({ issuer: cfg.issuer, clientId: cfg.clientId, clientSecret: secret, scopes: cfg.scopes });
      await withTenant(pr.tenantId, (tx) => tx.exec('INSERT INTO sso_tests (tenant_id, fingerprint, login, tested_by, tested_at) VALUES (:t, $1, $2, $3, now()) ON CONFLICT (tenant_id) DO UPDATE SET fingerprint = $1, login = $2, tested_by = $3, tested_at = now()', [fp, login, pr.userName]));
    }
    await end({ status: 'done', claims: showClaims(claims), login, usernameClaim: cfg.usernameClaim, groupClaim: cfg.groupClaim, groups, mappedRole: mapped, existingUser: existing ?? null, outcome, employee, hints, tried: !!login }, `Signed in as ${login || 'someone'}. No one was signed in here.`);
  } catch (e: any) { await end({ status: 'error', error: e?.message ?? 'The test failed.' }, 'The test failed.'); }
}
