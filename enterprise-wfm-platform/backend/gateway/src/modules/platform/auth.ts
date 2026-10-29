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

export function signPlatformToken(admin: { id: string; email: string }): string {
  return jwt.sign(
    {
      email: admin.email,
    },
    PLATFORM_JWT_SECRET,
    {
      subject: admin.id,
      audience: 'platform',
      expiresIn: '8h',
      jwtid: randomUUID(),
    }
  );
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
