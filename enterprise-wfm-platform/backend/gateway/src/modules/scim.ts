/**
 * SCIM 2.0 user provisioning (RFC 7643/7644), the part identity providers use to create, update and switch off accounts automatically:
 * Users (list with filter, read, create, replace, patch, delete) plus the discovery documents. Authenticated with a SCIM token (an API key that holds only the
 * `scim:provision` scope, made by an administrator). Deleting a user switches the account off rather than erasing it, so the audit trail stays whole.
 *
 * The platform role comes from the `roles` attribute when the provider sends one, else from the single sign-on default role, else AGENT.
 * A person is linked to their employee record through the enterprise extension's employeeNumber.
 */
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../passwordHash.ts';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { withTenant } from '../db.ts';
import { ROLES, dropUserState, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError } from '../http.ts';
import { principalFromApiKey } from './developer.ts';

export const scim = Router();   // mounted at /scim/v2, outside the normal sign-in
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';

scim.use(express.json({ type: () => true, limit: '1mb' }));
scim.use((_req, res, next) => { res.type('application/scim+json'); next(); });

const problem = (res: Response, status: number, detail: string, scimType?: string) => res.status(status).json({ schemas: [ERR], status: String(status), detail, ...(scimType ? { scimType } : {}) });
const wrap = (fn: (req: Request, res: Response, p: Principal) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!raw.startsWith('wfm_')) return problem(res, 401, 'A SCIM token is required.');
    const p = await principalFromApiKey(raw);
    if (!p.scopes?.includes('scim:provision')) return problem(res, 403, 'That key is not a SCIM token.');
    await fn(req, res, p);
  } catch (e) {
    if (e instanceof HttpError) return problem(res, e.status, e.message);
    next(e);
  }
};

const toScim = (u: any, base: string, employeeNumber: string | null) => ({
  schemas: [USER, ...(employeeNumber ? [ENT] : [])], id: u.id, userName: u.username, displayName: u.displayName, name: { formatted: u.displayName },
  emails: u.email ? [{ value: u.email, primary: true }] : [], active: u.status === 'ACTIVE', roles: [{ value: u.role, primary: true }],
  ...(employeeNumber ? { [ENT]: { employeeNumber } } : {}),
  meta: { resourceType: 'User', created: u.createdAt, location: `${base}/Users/${u.id}` },
});
const base = (req: Request) => `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/scim/v2`;
const withEmp = async (tx: any, u: any) => toScim(u, '', u.employeeId ? (await tx.one('SELECT employee_number FROM employees WHERE tenant_id = :t AND id = $1', [u.employeeId]))?.employeeNumber ?? null : null);
const present = (o: any, req: Request) => ({ ...o, meta: { ...o.meta, location: `${base(req)}/Users/${o.id}` } });

function bodyUser(b: any) {
  const email = b.emails?.find((e: any) => e.primary)?.value ?? b.emails?.[0]?.value ?? null;
  const role = b.roles?.map((r: any) => (typeof r === 'string' ? r : r.value)).find((r: string) => (ROLES as readonly string[]).includes(r)) ?? null;
  return { userName: b.userName as string | undefined, displayName: (b.displayName ?? b.name?.formatted ?? [b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ')) || undefined, email, role, active: typeof b.active === 'boolean' ? b.active : undefined, employeeNumber: b[ENT]?.employeeNumber as string | undefined };
}
async function employeeId(tx: any, number?: string) {
  if (!number) return null;
  return (await tx.one('SELECT id FROM employees WHERE tenant_id = :t AND employee_number = $1', [number]))?.id ?? null;
}

scim.get('/ServiceProviderConfig', (_req, res) => {
  res.json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A SCIM token made under Administration > API & Single Sign-On' }] });
});
scim.get('/ResourceTypes', (_req, res) => { res.json({ schemas: [LIST], totalResults: 1, Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER, schemaExtensions: [{ schema: ENT, required: false }] }] }); });
scim.get('/Schemas', (_req, res) => { res.json({ schemas: [LIST], totalResults: 0, Resources: [] }); });

scim.get('/Users', wrap(async (req, res, p) => {
  const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100))), start = Math.max(1, Number(req.query.startIndex ?? 1));
  let where = '', params: unknown[] = [];
  const f = String(req.query.filter ?? '').trim();
  if (f) {
    const m = /^(userName|emails\.value|externalId)\s+eq\s+"([^"]*)"$/i.exec(f);
    if (!m) return problem(res, 400, 'Only filters like userName eq "x" are supported.', 'invalidFilter');
    where = m[1].toLowerCase() === 'username' ? 'AND lower(username) = lower($1)' : 'AND lower(email) = lower($1)'; params = [m[2]];
  }
  const out = await withTenant(p.tenantId, async (tx) => {
    const total = (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE tenant_id = :t ${where}`, params))!.n;
    const rows = await tx.q<any>(`SELECT * FROM users WHERE tenant_id = :t ${where} ORDER BY username OFFSET ${start - 1} LIMIT ${count}`, params);
    return { total, items: await Promise.all(rows.map((u) => withEmp(tx, u))) };
  });
  res.json({ schemas: [LIST], totalResults: out.total, startIndex: start, itemsPerPage: out.items.length, Resources: out.items.map((u) => present(u, req)) });
}));

scim.get('/Users/:id', wrap(async (req, res, p) => {
  const u = await withTenant(p.tenantId, async (tx) => { const r = /^[0-9a-f-]{36}$/i.test(String(req.params.id)) ? await tx.one<any>('SELECT * FROM users WHERE tenant_id = :t AND id = $1', [String(req.params.id)]) : undefined; return r ? withEmp(tx, r) : null; });
  if (!u) return problem(res, 404, 'No such user.');
  res.json(present(u, req));
}));

scim.post('/Users', wrap(async (req, res, p) => {
  const b = bodyUser(req.body ?? {});
  if (!b.userName) return problem(res, 400, 'userName is required.', 'invalidValue');
  const out = await withTenant(p.tenantId, async (tx) => {
    if (await tx.one('SELECT 1 FROM users WHERE tenant_id = :t AND lower(username) = lower($1)', [b.userName])) return 'EXISTS';
    const defaultRole = (await tx.one<{ defaultRole: string }>('SELECT default_role FROM sso_providers WHERE tenant_id = :t'))?.defaultRole ?? 'AGENT';
    const u = await tx.one<any>(
      `INSERT INTO users (tenant_id, username, display_name, email, role, status, password_hash, employee_id, must_change_password) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, false) RETURNING *`,
      [b.userName, b.displayName ?? b.userName, b.email, b.role ?? defaultRole, b.active === false ? 'DISABLED' : 'ACTIVE', await hashPassword(randomBytes(24).toString('hex'), 10), await employeeId(tx, b.employeeNumber)]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'USER', entityId: u.id, entityName: b.userName, diffSummary: 'Provisioned by SCIM' });
    return withEmp(tx, u);
  });
  if (out === 'EXISTS') return problem(res, 409, 'A user with that userName already exists.', 'uniqueness');
  res.status(201).location(`${base(req)}/Users/${(out as any).id}`).json(present(out, req));
}));

/** Apply a full replacement (PUT) or a list of changes (PATCH) to a user. */
async function change(req: Request, res: Response, p: Principal, patch: boolean) {
  const out = await withTenant(p.tenantId, async (tx) => {
    const cur = /^[0-9a-f-]{36}$/i.test(String(req.params.id)) ? await tx.one<any>('SELECT * FROM users WHERE tenant_id = :t AND id = $1', [String(req.params.id)]) : undefined;
    if (!cur) return null;
    let b = bodyUser(req.body ?? {});
    if (patch) {
      const o: any = {};
      for (const op of req.body?.Operations ?? []) {
        const kind = String(op.op ?? '').toLowerCase();
        if (kind === 'remove') continue;
        const path = String(op.path ?? '');
        if (!path && op.value && typeof op.value === 'object') Object.assign(o, op.value);
        else if (path) o[path === 'name.formatted' ? 'displayName' : path.startsWith(ENT) ? ENT : path] = path.startsWith(ENT) ? { employeeNumber: op.value?.employeeNumber ?? op.value } : op.value;
      }
      b = bodyUser(o);
    }
    const emp = b.employeeNumber !== undefined ? await employeeId(tx, b.employeeNumber) : null;
    const u = await tx.one<any>(
      `UPDATE users SET username = coalesce($2, username), display_name = coalesce($3, display_name), email = CASE WHEN $4::boolean THEN $5 ELSE email END, role = coalesce($6, role),
              status = CASE WHEN $7::boolean IS NULL THEN status WHEN $7::boolean THEN 'ACTIVE' ELSE 'DISABLED' END, employee_id = CASE WHEN $8::boolean THEN $9::uuid ELSE employee_id END WHERE tenant_id = :t AND id = $1 RETURNING *`,
      [cur.id, patch ? null : b.userName ?? null, b.displayName ?? null, b.email !== null || !patch, b.email, b.role, b.active ?? null, b.employeeNumber !== undefined, emp]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: cur.id, entityName: cur.username, before: { role: cur.role, status: cur.status }, after: { role: u.role, status: u.status }, diffSummary: `${patch ? 'Patched' : 'Replaced'} by SCIM` });
    return withEmp(tx, u);
  });
  if (!out) return problem(res, 404, 'No such user.');
  await dropUserState(p.tenantId, String(out.id));
  res.json(present(out, req));
}
scim.put('/Users/:id', wrap((req, res, p) => change(req, res, p, false)));
scim.patch('/Users/:id', wrap((req, res, p) => change(req, res, p, true)));

scim.delete('/Users/:id', wrap(async (req, res, p) => {
  const ok = await withTenant(p.tenantId, async (tx) => {
    const cur = /^[0-9a-f-]{36}$/i.test(String(req.params.id)) ? await tx.one<any>(`UPDATE users SET status = 'DISABLED' WHERE tenant_id = :t AND id = $1 RETURNING username`, [String(req.params.id)]) : undefined;
    if (cur) await audit(tx, p, req, { action: 'UPDATE', entityType: 'USER', entityId: String(req.params.id), entityName: cur.username, diffSummary: 'Switched off by SCIM' });
    return !!cur;
  });
  if (!ok) return problem(res, 404, 'No such user.');
  await dropUserState(p.tenantId, String(req.params.id));
  res.status(204).end();
}));
