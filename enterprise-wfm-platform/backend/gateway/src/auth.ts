/**
 * Authentication (JWT), role-based access control and the tenant context of a request.
 * The role -> permission matrix is stored per tenant (seeded from DEFAULT_PERMISSIONS) and cached in Redis.
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { HttpError } from './http.ts';
import { cached, key, redis } from './infra.ts';
import { withTenant } from './db.ts';

export const ROLES = ['WFM_ADMIN', 'WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST', 'AGENT'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal { userId: string; tenantId: string; role: Role; name: string; username: string; jti: string; /** signed in with a temporary password: only changing it is allowed until they do */ mustChangePassword?: boolean }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { principal?: Principal; requestId?: string }
  }
}

const ALL = [
  'config:read', 'config:write', 'data:read', 'data:import', 'data:rollback',
  'forecast:read', 'forecast:create', 'forecast:adjust', 'forecast:submit', 'forecast:approve', 'forecast:publish', 'forecast:delete',
  'workforce:read', 'workforce:write', 'schedule:read', 'schedule:generate', 'schedule:edit', 'schedule:approve', 'schedule:publish',
  'intraday:read', 'intraday:act', 'audit:read', 'users:read', 'users:write', 'self:use',
] as const;
export type Permission = (typeof ALL)[number];
export const ALL_PERMISSIONS: readonly string[] = ALL;

const readOnly = ALL.filter((p) => p.endsWith(':read'));

/** Approval and publishing are separate from creating and editing, so they can be given to different people. */
export const DEFAULT_PERMISSIONS: Record<Role, readonly string[]> = {
  WFM_ADMIN: ALL,
  WFM_MANAGER: ALL.filter((p) => p !== 'users:write'),
  FORECAST_PLANNER: ['config:read', 'data:read', 'data:import', 'forecast:read', 'forecast:create', 'forecast:adjust', 'forecast:submit', 'workforce:read', 'schedule:read', 'intraday:read', 'self:use'],
  SCHEDULER: ['config:read', 'data:read', 'forecast:read', 'workforce:read', 'workforce:write', 'schedule:read', 'schedule:generate', 'schedule:edit', 'schedule:publish', 'intraday:read', 'self:use'],
  SUPERVISOR_RTA: ['config:read', 'data:read', 'forecast:read', 'workforce:read', 'schedule:read', 'intraday:read', 'intraday:act', 'self:use'],
  ANALYST: [...new Set([...readOnly, 'audit:read', 'self:use'])],
  AGENT: ['self:use'],
};

export const signToken = (p: Omit<Principal, 'jti'>): string =>
  jwt.sign({ tid: p.tenantId, role: p.role, name: p.name, username: p.username, ...(p.mustChangePassword ? { mcp: true } : {}) }, config.jwtSecret, { subject: p.userId, expiresIn: config.jwtTtl as jwt.SignOptions['expiresIn'], jwtid: randomUUID() });

/** The only requests a temporary-password session may make: see who it is, sign out, and choose a new password. */
const ALLOWED_WHILE_TEMPORARY = /^\/api\/v1\/auth\/(me|logout|change-password)(\/|\?|$)/;

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (typeof req.query.token === 'string' ? req.query.token : '');
    if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    const p = await principalFromToken(raw);
    req.principal = p;
    // a temporary password only opens the way to choosing a new one
    if (p.mustChangePassword && !ALLOWED_WHILE_TEMPORARY.test(req.originalUrl)) throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password before you continue.');
    next();
  } catch (e) { next(e instanceof HttpError ? e : new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired session')); }
}

export async function principalFromToken(token: string): Promise<Principal> {
  const d = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (await redis.get(`wfm:denied:${d.jti}`).catch(() => null)) throw new HttpError(401, 'UNAUTHENTICATED', 'Session ended');
  return { userId: String(d.sub), tenantId: d.tid, role: d.role, name: d.name, username: d.username, jti: String(d.jti), mustChangePassword: d.mcp === true };
}

export async function revokeToken(p: Principal): Promise<void> {
  await redis.set(`wfm:denied:${p.jti}`, '1', 'EX', 12 * 3600).catch(() => {});
}

export async function permissionsFor(tenantId: string, role: Role): Promise<Set<string>> {
  const list = await cached<string[]>(key(tenantId, 'perms', role), 600, () =>
    withTenant(tenantId, async (tx) => (await tx.q<{ permission: string }>('SELECT permission FROM role_permissions WHERE tenant_id = :t AND role = $1', [role])).map((r) => r.permission)));
  return new Set(list);
}

/** Route guard: the signed-in role must hold every listed permission. */
export const requires = (...perms: Permission[]) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const p = req.principal;
    if (!p) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    const have = await permissionsFor(p.tenantId, p.role);
    const missing = perms.filter((x) => !have.has(x));
    if (missing.length) throw new HttpError(403, 'FORBIDDEN', `Your role (${p.role}) is not allowed to do this (needs ${missing.join(', ')}).`, { missing });
    next();
  } catch (e) { next(e); }
};

/** Route guard: at least one of the listed permissions is enough. */
export const requiresAny = (...perms: Permission[]) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const p = req.principal;
    if (!p) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    const have = await permissionsFor(p.tenantId, p.role);
    if (!perms.some((x) => have.has(x))) throw new HttpError(403, "FORBIDDEN", `Your role (${p.role}) is not allowed to do this (needs one of ${perms.join(", ")}).`, { anyOf: perms });
    next();
  } catch (e) { next(e); }
};

export const me = (req: Request): Principal => {
  if (!req.principal) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return req.principal;
};
