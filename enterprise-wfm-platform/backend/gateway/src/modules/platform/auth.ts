/**
 * Platform / Super Admin Authentication.
 * Uses a separate secret and explicit audience "platform".
 * Tenant tokens cannot access platform routes, and platform tokens cannot access tenant routes.
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.ts';
import { HttpError } from '../../http.ts';
import { raw } from '../../db.ts';

// Dedicated platform secret: falls back to a derived secret so backend/.env does not need to be changed
const PLATFORM_JWT_SECRET = process.env.PLATFORM_JWT_SECRET || `${config.jwtSecret}:platform_super_admin_secret_v1`;

export interface PlatformPrincipal {
  id: string;
  adminId: string;
  email: string;
  aud: 'platform';
  jti: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformAdmin?: PlatformPrincipal;
    }
  }
}

export function signPlatformToken(admin: { id: string; email: string }, hours = 8): string {
  return jwt.sign(
    {
      email: admin.email,
    },
    PLATFORM_JWT_SECRET,
    {
      subject: admin.id,
      audience: 'platform',
      expiresIn: `${hours}h`,
      jwtid: randomUUID(),
    }
  );
}

/** A five-minute pass between the password step and the one-time code step of sign-in. It cannot be used for anything else. */
export function signMfaToken(adminId: string): string {
  return jwt.sign({ purpose: 'mfa' }, PLATFORM_JWT_SECRET, { subject: adminId, audience: 'platform-mfa', expiresIn: '5m' });
}
export function adminFromMfaToken(token: string): string {
  try {
    const d = jwt.verify(token, PLATFORM_JWT_SECRET, { audience: 'platform-mfa' }) as jwt.JwtPayload;
    if (d.purpose !== 'mfa' || !d.sub) throw new Error('bad');
    return String(d.sub);
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'The sign-in step expired. Start again.');
  }
}

export async function principalFromPlatformToken(token: string): Promise<PlatformPrincipal> {
  try {
    const d = jwt.verify(token, PLATFORM_JWT_SECRET, { audience: 'platform' }) as jwt.JwtPayload;
    if (d.aud !== 'platform' || !d.sub) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid platform token');
    }
    const rows = await raw<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM wfm.platform_admins WHERE id = $1 AND status = 'ACTIVE'`,
      [d.sub]
    );
    if (!rows.length) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Platform admin account not found or disabled');
    }
    // A session that was ended (sign-out, "sign out other devices", password change) is refused even though the token has not expired.
    const sess = await raw<{ revoked: boolean }>(
      `SELECT (revoked_at IS NOT NULL) AS revoked FROM wfm.platform_sessions WHERE jti = $1`,
      [d.jti]
    );
    if (sess.length) {
      if (sess[0].revoked) throw new HttpError(401, 'UNAUTHENTICATED', 'This session has ended');
      await raw(`UPDATE wfm.platform_sessions SET last_seen_at = now() WHERE jti = $1 AND last_seen_at < now() - interval '1 minute'`, [d.jti]);
    }
    return {
      id: String(d.sub),
      adminId: String(d.sub),
      email: String(d.email || rows[0].email),
      aud: 'platform',
      jti: String(d.jti),
    };
  } catch (err: any) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired platform session');
  }
}

export async function authenticatePlatform(req: Request, _res: Response, next: NextFunction) {
  try {
    const rawToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (typeof req.query.platformToken === 'string' ? req.query.platformToken : '');
    if (!rawToken) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Platform authentication required');
    }
    const p = await principalFromPlatformToken(rawToken);
    req.platformAdmin = p;
    next();
  } catch (e) {
    next(e instanceof HttpError ? e : new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired platform session'));
  }
}
