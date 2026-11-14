/**
 * Platform / Super Admin routes (/api/v1/platform/*).
 * Manages organisations, workspaces, and organisation administrator provisioning.
 * Never returns passwords in any response.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { raw } from '../../db.ts';
import { dropCache, redis } from '../../infra.ts';
import { HttpError, bad, conflict, notFound, parse } from '../../http.ts';
import { ensureRolePermissions } from '../../bootstrap.ts';
import { adminFromMfaToken, authenticatePlatform, signMfaToken, signPlatformToken } from './auth.ts';
import { getPlatformUrls, getSecuritySetting, sendPlatformEmail, settingsRouter } from './settings.ts';
import { findRecoveryCode, mfaFailed, mfaLocked, mfaPassed, newRecoveryCodes, newSecret, otpauthUri, verifyTotp } from './mfa.ts';
import { decrypt, encrypt } from '../../secrets.ts';
import { cleanWeekend } from '../payWeek.ts';
import { BUILT_INS } from '../compliance/rules.ts';
import { addMonths, ALL_MODULES, applyPlanToLicence, forget as forgetTenant, getPlan, plansRouter, resolveTerms, usageOf, whyNotFit, type Terms, type PlanRow } from './plans.ts';
import { hasCountry, publicHolidays } from '../holidays.ts';

export const platform = Router();

const uuid = z.string().uuid();
const PlatformLogin = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const Address = z.object({
  line1: z.string().max(200),
  line2: z.string().max(200),
  city: z.string().max(100),
  state: z.string().max(100),
  postalCode: z.string().max(30),
  country: z.string().max(80),
}).partial();
const optEmail = z.union([z.string().email(), z.literal('')]).optional();

// Onboarding profile (organization_settings columns added in migration 062)
const OrgProfile = {
  country: z.string().max(80).optional(),
  industry: z.string().max(80).optional(),
  companySize: z.string().max(40).optional(),
  registrationId: z.string().max(80).optional(),
  website: z.string().max(200).optional(),
  contactPhone: z.string().max(40).optional(),
  billingContactName: z.string().max(160).optional(),
  billingContactEmail: optEmail,
  securityContactName: z.string().max(160).optional(),
  securityContactEmail: optEmail,
  registeredAddress: Address.optional(),
  billingAddress: Address.optional(),
  billingSameAsRegistered: z.boolean().optional(),
  contractRef: z.string().max(80).optional(),
  accountOwner: z.string().max(160).optional(),
  internalNotes: z.string().max(2000).optional(),
  termsAcceptedAt: z.string().max(40).nullable().optional(),
  isTrial: z.boolean().optional(),
};
const PROFILE_COLUMNS: Record<string, string> = {
  country: 'country', industry: 'industry', companySize: 'company_size', registrationId: 'registration_id', website: 'website',
  contactPhone: 'contact_phone', billingContactName: 'billing_contact_name', billingContactEmail: 'billing_contact_email',
  securityContactName: 'security_contact_name', securityContactEmail: 'security_contact_email', registeredAddress: 'registered_address',
  billingAddress: 'billing_address', billingSameAsRegistered: 'billing_same_as_registered', contractRef: 'contract_ref',
  accountOwner: 'account_owner', internalNotes: 'internal_notes', termsAcceptedAt: 'terms_accepted_at', isTrial: 'is_trial',
};
const JSON_PROFILE = new Set(['registeredAddress', 'billingAddress']);

// Writes the profile fields that were sent (and only those) to organization_settings.
async function saveOrgProfile(tenantId: string, body: Record<string, any>): Promise<void> {
  const sets: string[] = [];
  const args: any[] = [tenantId];
  for (const [key, col] of Object.entries(PROFILE_COLUMNS)) {
    if (body[key] === undefined) continue;
    let v = body[key];
    if (JSON_PROFILE.has(key)) v = JSON.stringify(v ?? {});
    else if ((col === 'billing_contact_email' || col === 'security_contact_email') && v === '') v = null;
    else if (col === 'terms_accepted_at' && v) v = new Date(v);
    args.push(v);
    sets.push(`${col} = $${args.length}${JSON_PROFILE.has(key) ? '::jsonb' : ''}`);
  }
  if (!sets.length) return;
  await raw(`UPDATE wfm.organization_settings SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1`, args);
}

function profileOut(s: any) {
  const g = (camel: string, snake: string, fallback: any = '') => s?.[camel] ?? s?.[snake] ?? fallback;
  return {
    country: g('country', 'country'),
    industry: g('industry', 'industry'),
    companySize: g('companySize', 'company_size'),
    registrationId: g('registrationId', 'registration_id'),
    website: g('website', 'website'),
    contactPhone: g('contactPhone', 'contact_phone'),
    billingContactName: g('billingContactName', 'billing_contact_name'),
    billingContactEmail: g('billingContactEmail', 'billing_contact_email', null),
    securityContactName: g('securityContactName', 'security_contact_name'),
    securityContactEmail: g('securityContactEmail', 'security_contact_email', null),
    registeredAddress: g('registeredAddress', 'registered_address', {}),
    billingAddress: g('billingAddress', 'billing_address', {}),
    billingSameAsRegistered: g('billingSameAsRegistered', 'billing_same_as_registered', true),
    contractRef: g('contractRef', 'contract_ref'),
    accountOwner: g('accountOwner', 'account_owner'),
    internalNotes: g('internalNotes', 'internal_notes'),
    termsAcceptedAt: g('termsAcceptedAt', 'terms_accepted_at', null),
    isTrial: g('isTrial', 'is_trial', false),
    onboardedBy: g('onboardedBy', 'onboarded_by'),
  };
}

const NewOrgBody = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  legalName: z.string().max(200).optional(),
  timezone: z.string().min(1).max(80).default('UTC'),
  currency: z.string().min(3).max(3).default('USD'),
  locale: z.string().min(2).max(20).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: optEmail,
  ...OrgProfile,
  payWeekStart: z.number().int().min(0).max(6).optional(),                   // weekday a pay week begins on, Monday 0 ... Sunday 6 (Monday when omitted)
  weekendDays: z.array(z.number().int().min(0).max(6)).min(1).max(3).optional(),   // weekdays that count as the weekend (Saturday and Sunday when omitted)
  holidayCountry: z.string().length(2).optional(),
  compliancePack: z.string().max(60).optional(),                             // a ready-made labour-law pack to assign to the whole organisation                           // add this country's public holidays for this year and next
  mainSiteName: z.string().trim().max(80).optional(),                         // the first site; its time zone, country and address come from the organisation
  adminUser: z.string().min(1).max(60).optional(),
  adminName: z.string().min(1).max(160).optional(),
  // When no password is given, a one-time temporary password is generated and must be changed at first sign-in.
  adminPassword: z.string().min(8).optional(),
  adminEmail: z.string().email().optional(),
  planTier: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/).optional(),     // a plan code from the catalogue (Settings, Plans)
  maxEmployees: z.number().int().min(1).optional(),     // employee seats: the one number that is really per customer
  maxUsers: z.number().int().min(1).optional(),         // users, sites, workspaces and modules come from the plan unless overridden (with a reason)
  maxSites: z.number().int().min(1).optional(),
  maxWorkspaces: z.number().int().min(1).optional(),
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
  startDate: z.string().max(40).optional(),
  endDate: z.string().max(40).optional(),
  termMonths: z.number().int().min(1).max(120).optional(),
  customReason: z.string().max(300).optional(),
  modules: z.array(z.enum(ALL_MODULES)).optional(),
});

const OrgPatch = z.object({
  name: z.string().min(1).max(160).optional(),
  legalName: z.string().max(200).optional(),
  displayName: z.string().max(160).optional(),
  contactName: z.string().max(160).optional(),
  contactEmail: z.string().email().nullable().optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: z.string().min(3).max(3).optional(),
  locale: z.string().min(2).max(20).optional(),
  ...OrgProfile,
});

const NewWorkspaceBody = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, 'may only contain lowercase letters, numbers and dash').optional(),
  description: z.string().max(500).optional(),
  timezone: z.string().min(1).max(80).optional(),
  currency: z.string().min(3).max(3).optional(),
});

const NewOrgAdminBody = z.object({
  username: z.string().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'may only contain letters, numbers, dot, dash and underscore'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
});

const EmergencyResetBody = z.object({
  userId: z.string().uuid(),
  method: z.enum(['TEMPORARY_PASSWORD', 'RESET_LINK', 'BOTH']).default('BOTH'),
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';

function getClientIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

function generateSecureTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const nums = '23456789';
  const special = '!@#$%^&*';

  let pwd = '';
  pwd += upper[crypto.randomInt(upper.length)];
  pwd += lower[crypto.randomInt(lower.length)];
  pwd += nums[crypto.randomInt(nums.length)];
  pwd += special[crypto.randomInt(special.length)];

  const all = upper + lower + nums + special;
  for (let i = 0; i < 8; i++) {
    pwd += all[crypto.randomInt(all.length)];
  }
  return pwd.split('').sort(() => 0.5 - Math.random()).join('');
}

async function logPlatformAudit(params: {
  adminId?: string | null;
  adminEmail: string;
  action: string;
  targetTenantId?: string | null;
  targetTenantName?: string | null;
  targetTenantCode?: string | null;
  targetEntityType: string;
  targetEntityId?: string | null;
  targetEntityName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  details?: Record<string, any>;
  status?: 'SUCCESS' | 'FAILURE' | 'WARNING';
}) {
  try {
    await raw(
      `INSERT INTO wfm.platform_audit_log (
        admin_id, admin_email, action, target_tenant_id, target_tenant_name, target_tenant_code,
        target_entity_type, target_entity_id, target_entity_name, ip_address, user_agent, details, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        params.adminId || null,
        params.adminEmail,
        params.action,
        params.targetTenantId || null,
        params.targetTenantName || null,
        params.targetTenantCode || null,
        params.targetEntityType,
        params.targetEntityId || null,
        params.targetEntityName || null,
        params.ipAddress || null,
        params.userAgent || null,
        JSON.stringify(params.details || {}),
        params.status || 'SUCCESS',
      ]
    );
  } catch (err) {
    console.error('[platform_audit] Error recording log:', err);
  }
}

// ---------------------------------------------------------------- Super Admin Authentication

async function completeSignIn(req: any, res: any, admin: { id: string; email: string; status: string }, method: string) {
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || 'Unknown';
  await logPlatformAudit({ adminId: admin.id, adminEmail: admin.email, action: 'SIGN_IN', targetEntityType: 'PLATFORM_SESSION', ipAddress: ip, userAgent, details: { method }, status: 'SUCCESS' });
  const sec = await getSecuritySetting();
  const token = signPlatformToken({ id: admin.id, email: admin.email }, sec.sessionHours);
  const issued = jwt.decode(token) as jwt.JwtPayload;
  await raw(
    `INSERT INTO wfm.platform_sessions (admin_id, jti, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, to_timestamp($5))`,
    [admin.id, String(issued.jti), ip, userAgent.slice(0, 300), issued.exp]
  );
  await raw('UPDATE wfm.platform_admins SET last_login_at = now() WHERE id = $1', [admin.id]);
  res.json({ token, admin: { id: admin.id, email: admin.email, status: admin.status } });
}

platform.post('/auth/login', async (req, res) => {
  const b = parse(PlatformLogin, req.body);
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || 'Unknown';

  const rows = await raw<{ id: string; email: string; password_hash: string; status: string }>(
    `SELECT id, email, password_hash, status FROM wfm.platform_admins WHERE lower(email) = lower($1)`,
    [b.email]
  );
  if (!rows.length) {
    await logPlatformAudit({
      adminEmail: b.email,
      action: 'SIGN_IN_FAILED',
      targetEntityType: 'PLATFORM_SESSION',
      ipAddress: ip,
      userAgent,
      details: { reason: 'Admin account not found' },
      status: 'FAILURE',
    });
    throw bad('Invalid email or password');
  }
  const admin = rows[0];
  if (admin.status !== 'ACTIVE') {
    await logPlatformAudit({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'SIGN_IN_FAILED',
      targetEntityType: 'PLATFORM_SESSION',
      ipAddress: ip,
      userAgent,
      details: { reason: 'Admin account disabled' },
      status: 'FAILURE',
    });
    throw bad('This super admin account has been disabled');
  }
  const passwordHash = (admin as any).passwordHash || (admin as any).password_hash;
  if (!passwordHash) {
    throw bad('Invalid email or password');
  }
  const ok = await bcrypt.compare(b.password, passwordHash);
  if (!ok) {
    await logPlatformAudit({
      adminId: admin.id,
      adminEmail: admin.email,
      action: 'SIGN_IN_FAILED',
      targetEntityType: 'PLATFORM_SESSION',
      ipAddress: ip,
      userAgent,
      details: { reason: 'Incorrect password' },
      status: 'FAILURE',
    });
    throw bad('Invalid email or password');
  }

  const [m] = await raw<any>('SELECT totp_enabled FROM wfm.platform_admins WHERE id = $1', [admin.id]);
  if (m?.totpEnabled ?? m?.totp_enabled) {
    res.json({ mfaRequired: true, mfaToken: signMfaToken(admin.id) });
    return;
  }
  await completeSignIn(req, res, admin, 'password');
});

// Second step of sign-in for accounts with two-factor on: an authenticator code, or one of the one-time recovery codes.
platform.post('/auth/login/mfa', async (req, res) => {
  const b = parse(z.object({ mfaToken: z.string().min(10), code: z.string().trim().min(6).max(24) }), req.body);
  const adminId = adminFromMfaToken(b.mfaToken);
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || 'Unknown';
  const [a] = await raw<any>('SELECT id, email, status, totp_secret_enc, recovery_codes FROM wfm.platform_admins WHERE id = $1 AND totp_enabled', [adminId]);
  if (!a || a.status !== 'ACTIVE') throw bad('That code is not correct.');
  if (mfaLocked(adminId)) throw bad('Too many wrong codes. Wait 10 minutes and try again.');
  const hashes: string[] = a.recoveryCodes ?? a.recovery_codes ?? [];
  let method = '';
  if (verifyTotp(decrypt(a.totpSecretEnc ?? a.totp_secret_enc), b.code)) method = 'authenticator app';
  else {
    const idx = findRecoveryCode(hashes, b.code);
    if (idx >= 0) {
      method = 'recovery code';
      hashes.splice(idx, 1);
      await raw('UPDATE wfm.platform_admins SET recovery_codes = $2::jsonb WHERE id = $1', [adminId, JSON.stringify(hashes)]);
    }
  }
  if (!method) {
    mfaFailed(adminId);
    await logPlatformAudit({ adminId, adminEmail: a.email, action: 'SIGN_IN_FAILED', targetEntityType: 'PLATFORM_SESSION', ipAddress: ip, userAgent, details: { reason: 'Wrong two-factor code' }, status: 'FAILURE' });
    throw bad('That code is not correct.');
  }
  mfaPassed(adminId);
  await completeSignIn(req, res, a, method);
});

// All routes below require platform authentication
platform.use(authenticatePlatform);

// When two-factor sign-in is required, an account without it can only reach its own Account page until it is set up.
platform.use(async (req, _res, next) => {
  try {
    if (req.path.startsWith('/auth/')) return next();
    if ((await getSecuritySetting()).requireMfa) {
      const [a] = await raw<any>('SELECT totp_enabled FROM wfm.platform_admins WHERE id = $1', [req.platformAdmin!.id]);
      if (!(a?.totpEnabled ?? a?.totp_enabled)) throw new HttpError(403, 'MFA_SETUP_REQUIRED', 'Two-factor sign-in is required. Set it up on the Account page to continue.');
    }
    next();
  } catch (e) { next(e); }
});
platform.use('/settings', settingsRouter(logPlatformAudit, getClientIp));
platform.use('/', plansRouter(logPlatformAudit, getClientIp));       // plan catalogue and country templates

platform.post('/auth/logout', async (req, res) => {
  const ip = getClientIp(req);
  await raw('UPDATE wfm.platform_sessions SET revoked_at = now() WHERE jti = $1 AND revoked_at IS NULL', [req.platformAdmin!.jti]);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'SIGN_OUT',
    targetEntityType: 'PLATFORM_SESSION',
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    status: 'SUCCESS',
  });
  res.json({ ok: true });
});

platform.get('/auth/me', async (req, res) => {
  const [a] = await raw<any>(
    'SELECT id, email, status, display_name, last_login_at, password_changed_at, created_at, totp_enabled FROM wfm.platform_admins WHERE id = $1',
    [req.platformAdmin!.id]
  );
  res.json({
    admin: {
      ...req.platformAdmin,
      status: a?.status,
      displayName: a?.displayName ?? a?.display_name ?? '',
      lastLoginAt: a?.lastLoginAt ?? a?.last_login_at ?? null,
      passwordChangedAt: a?.passwordChangedAt ?? a?.password_changed_at ?? null,
      createdAt: a?.createdAt ?? a?.created_at ?? null,
      mfaEnabled: !!(a?.totpEnabled ?? a?.totp_enabled),
      mfaSetupRequired: (await getSecuritySetting()).requireMfa && !(a?.totpEnabled ?? a?.totp_enabled),
    },
  });
});

// ---------------------------------------------------------------- Super Admin account: profile, password, sessions

const ProfileBody = z.object({ displayName: z.string().trim().max(120) });
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'Use at least 12 characters').max(200)
    .regex(/[a-z]/, 'Include a lowercase letter').regex(/[A-Z]/, 'Include an uppercase letter').regex(/[0-9]/, 'Include a number'),
});

platform.patch('/auth/profile', async (req, res) => {
  const b = parse(ProfileBody, req.body);
  await raw('UPDATE wfm.platform_admins SET display_name = $2, updated_at = now() WHERE id = $1', [req.platformAdmin!.id, b.displayName]);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action: 'UPDATE_PROFILE', targetEntityType: 'PLATFORM_ADMIN',
    targetEntityId: req.platformAdmin!.id, ipAddress: getClientIp(req), userAgent: (req.headers['user-agent'] as string) || 'Unknown', status: 'SUCCESS',
  });
  res.json({ ok: true, displayName: b.displayName });
});

platform.post('/auth/change-password', async (req, res) => {
  const b = parse(ChangePasswordBody, req.body);
  const ip = getClientIp(req);
  const userAgent = (req.headers['user-agent'] as string) || 'Unknown';
  const [a] = await raw<any>('SELECT password_hash FROM wfm.platform_admins WHERE id = $1', [req.platformAdmin!.id]);
  const hash = a?.passwordHash || a?.password_hash;
  if (!hash || !(await bcrypt.compare(b.currentPassword, hash))) {
    await logPlatformAudit({
      adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action: 'PASSWORD_CHANGE_FAILED', targetEntityType: 'PLATFORM_ADMIN',
      ipAddress: ip, userAgent, details: { reason: 'Current password incorrect' }, status: 'FAILURE',
    });
    throw bad('The current password is not correct');
  }
  if (b.newPassword === b.currentPassword) throw bad('Choose a password that is different from the current one');
  await raw(
    'UPDATE wfm.platform_admins SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1',
    [req.platformAdmin!.id, await bcrypt.hash(b.newPassword, 12)]
  );
  // Every other device is signed out; this one stays signed in.
  const ended = await raw<{ id: string }>(
    'UPDATE wfm.platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND jti <> $2 AND revoked_at IS NULL RETURNING id',
    [req.platformAdmin!.id, req.platformAdmin!.jti]
  );
  await logPlatformAudit({
    adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action: 'PASSWORD_CHANGED', targetEntityType: 'PLATFORM_ADMIN',
    targetEntityId: req.platformAdmin!.id, ipAddress: ip, userAgent, details: { otherSessionsEnded: ended.length }, status: 'SUCCESS',
  });
  res.json({ ok: true, otherSessionsEnded: ended.length });
});

// ---- two-factor sign-in (authenticator app)
async function secondFactorOk(adminId: string, code: string, consume = false): Promise<boolean> {
  const [a] = await raw<any>('SELECT totp_secret_enc, recovery_codes FROM wfm.platform_admins WHERE id = $1 AND totp_enabled', [adminId]);
  if (!a || mfaLocked(adminId)) return false;
  if (verifyTotp(decrypt(a.totpSecretEnc ?? a.totp_secret_enc), code)) { mfaPassed(adminId); return true; }
  const hashes: string[] = a.recoveryCodes ?? a.recovery_codes ?? [];
  const idx = findRecoveryCode(hashes, code);
  if (idx >= 0) {
    if (consume) { hashes.splice(idx, 1); await raw('UPDATE wfm.platform_admins SET recovery_codes = $2::jsonb WHERE id = $1', [adminId, JSON.stringify(hashes)]); }
    mfaPassed(adminId);
    return true;
  }
  mfaFailed(adminId);
  return false;
}
const passwordOk = async (adminId: string, password: string) => {
  const [a] = await raw<any>('SELECT password_hash FROM wfm.platform_admins WHERE id = $1', [adminId]);
  const h = a?.passwordHash || a?.password_hash;
  return !!h && (await bcrypt.compare(password, h));
};
const mfaAudit = (req: any, action: string, status: 'SUCCESS' | 'FAILURE' = 'SUCCESS') =>
  logPlatformAudit({ adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action, targetEntityType: 'PLATFORM_ADMIN', targetEntityId: req.platformAdmin!.id, ipAddress: getClientIp(req), userAgent: (req.headers['user-agent'] as string) || 'Unknown', status });

platform.post('/auth/mfa/setup', async (req, res) => {
  const [a] = await raw<any>('SELECT totp_enabled FROM wfm.platform_admins WHERE id = $1', [req.platformAdmin!.id]);
  if (a?.totpEnabled ?? a?.totp_enabled) throw conflict('Two-factor sign-in is already on for this account.');
  const secret = newSecret();
  await raw('UPDATE wfm.platform_admins SET totp_secret_enc = $2 WHERE id = $1', [req.platformAdmin!.id, encrypt(secret)]);
  res.json({ secret, otpauthUri: otpauthUri(secret, req.platformAdmin!.email, 'Enterprise WFM') });
});

platform.post('/auth/mfa/enable', async (req, res) => {
  const b = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
  const [a] = await raw<any>('SELECT totp_secret_enc, totp_enabled FROM wfm.platform_admins WHERE id = $1', [req.platformAdmin!.id]);
  const enc = a?.totpSecretEnc ?? a?.totp_secret_enc;
  if (!enc || (a.totpEnabled ?? a.totp_enabled)) throw bad('Start the setup again to get a new key.');
  if (mfaLocked(req.platformAdmin!.id) || !verifyTotp(decrypt(enc), b.code)) { mfaFailed(req.platformAdmin!.id); throw bad('That code is not correct. Check the time on your phone and try the next code.'); }
  mfaPassed(req.platformAdmin!.id);
  const codes = newRecoveryCodes();
  await raw('UPDATE wfm.platform_admins SET totp_enabled = true, totp_enabled_at = now(), recovery_codes = $2::jsonb WHERE id = $1', [req.platformAdmin!.id, JSON.stringify(codes.hashes)]);
  await mfaAudit(req, 'MFA_ENABLED');
  res.json({ ok: true, recoveryCodes: codes.plain });
});

platform.post('/auth/mfa/disable', async (req, res) => {
  const b = parse(z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(24) }), req.body);
  if ((await getSecuritySetting()).requireMfa) throw bad('Two-factor sign-in is required for all Super Admins, so it cannot be turned off. Ask for the requirement to be lifted first.');
  if (!(await passwordOk(req.platformAdmin!.id, b.password)) || !(await secondFactorOk(req.platformAdmin!.id, b.code))) { await mfaAudit(req, 'MFA_DISABLE_FAILED', 'FAILURE'); throw bad('The password or the code is not correct.'); }
  await raw(`UPDATE wfm.platform_admins SET totp_enabled = false, totp_secret_enc = NULL, totp_enabled_at = NULL, recovery_codes = '[]'::jsonb WHERE id = $1`, [req.platformAdmin!.id]);
  await mfaAudit(req, 'MFA_DISABLED');
  res.json({ ok: true });
});

platform.post('/auth/mfa/recovery-codes', async (req, res) => {
  const b = parse(z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(24) }), req.body);
  if (!(await passwordOk(req.platformAdmin!.id, b.password)) || !(await secondFactorOk(req.platformAdmin!.id, b.code, true))) { await mfaAudit(req, 'MFA_RECOVERY_FAILED', 'FAILURE'); throw bad('The password or the code is not correct.'); }
  const codes = newRecoveryCodes();
  await raw('UPDATE wfm.platform_admins SET recovery_codes = $2::jsonb WHERE id = $1', [req.platformAdmin!.id, JSON.stringify(codes.hashes)]);
  await mfaAudit(req, 'MFA_RECOVERY_CODES_RENEWED');
  res.json({ ok: true, recoveryCodes: codes.plain });
});

platform.get('/auth/sessions', async (req, res) => {
  const rows = await raw<any>(
    `SELECT id, jti, ip_address, user_agent, created_at, last_seen_at, expires_at
     FROM wfm.platform_sessions
     WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_seen_at DESC LIMIT 50`,
    [req.platformAdmin!.id]
  );
  res.json(rows.map((s) => ({
    id: s.id,
    current: (s.jti ?? '') === req.platformAdmin!.jti,
    ipAddress: s.ipAddress ?? s.ip_address ?? null,
    userAgent: s.userAgent ?? s.user_agent ?? null,
    createdAt: s.createdAt ?? s.created_at,
    lastSeenAt: s.lastSeenAt ?? s.last_seen_at,
    expiresAt: s.expiresAt ?? s.expires_at,
  })));
});

platform.post('/auth/sessions/revoke-others', async (req, res) => {
  const ended = await raw<{ id: string }>(
    'UPDATE wfm.platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND jti <> $2 AND revoked_at IS NULL RETURNING id',
    [req.platformAdmin!.id, req.platformAdmin!.jti]
  );
  await logPlatformAudit({
    adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action: 'SESSIONS_REVOKED', targetEntityType: 'PLATFORM_SESSION',
    ipAddress: getClientIp(req), userAgent: (req.headers['user-agent'] as string) || 'Unknown', details: { count: ended.length }, status: 'SUCCESS',
  });
  res.json({ ok: true, ended: ended.length });
});

platform.delete('/auth/sessions/:id', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const ended = await raw<{ id: string }>(
    'UPDATE wfm.platform_sessions SET revoked_at = now() WHERE id = $1 AND admin_id = $2 AND revoked_at IS NULL RETURNING id',
    [id, req.platformAdmin!.id]
  );
  if (!ended.length) throw notFound('Session');
  await logPlatformAudit({
    adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action: 'SESSIONS_REVOKED', targetEntityType: 'PLATFORM_SESSION',
    targetEntityId: id, ipAddress: getClientIp(req), userAgent: (req.headers['user-agent'] as string) || 'Unknown', details: { count: 1 }, status: 'SUCCESS',
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Organizations

platform.get('/organizations', async (_req, res) => {
  const list = await raw<any>(
    `SELECT t.id, t.name, t.code, t.timezone, t.currency, t.created_at,
            coalesce(s.legal_name, t.name) AS legal_name,
            coalesce(s.display_name, t.name) AS display_name,
            s.contact_name, s.contact_email, s.locale,
            (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = t.id) AS workspace_count,
            (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = t.id) AS user_count
     FROM wfm.tenants t
     LEFT JOIN wfm.organization_settings s ON s.tenant_id = t.id
     ORDER BY t.name`
  );
  res.json(list);
});

// ---------------------------------------------------------------- Hierarchy Tree
platform.get('/tree', async (_req, res) => {
  const orgs = await raw<any>(
    `SELECT t.id, t.name, t.code, t.timezone, t.currency, t.created_at,
            coalesce(s.legal_name, t.name) AS legal_name,
            coalesce(s.display_name, t.name) AS display_name,
            s.contact_name, s.contact_email, s.locale
     FROM wfm.tenants t
     LEFT JOIN wfm.organization_settings s ON s.tenant_id = t.id
     ORDER BY t.name`
  );

  const workspaces = await raw<any>(
    `SELECT w.id, w.tenant_id, w.name, w.code, w.slug, w.description, w.timezone, w.currency, w.status, w.is_default, w.created_at,
            (SELECT count(*)::int FROM wfm.workspace_members m WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM wfm.workspaces w
     ORDER BY w.is_default DESC, w.name`
  );

  const admins = await raw<any>(
    `SELECT u.id, u.tenant_id, u.username, u.display_name, u.email, u.role, u.status, u.created_at
     FROM wfm.users u
     WHERE u.role = 'WFM_ADMIN'
     ORDER BY u.username`
  );

  const tree = orgs.map((org: any) => {
    const orgId = org.id;
    const orgWorkspaces = workspaces.filter((w: any) => (w.tenantId || w.tenant_id) === orgId);
    const orgAdmins = admins.filter((u: any) => (u.tenantId || u.tenant_id) === orgId);
    return {
      id: orgId,
      name: org.name,
      code: org.code,
      displayName: org.displayName || org.display_name || org.name,
      legalName: org.legalName || org.legal_name || org.name,
      contactName: org.contactName || org.contact_name || '',
      contactEmail: org.contactEmail || org.contact_email || null,
      timezone: org.timezone,
      currency: org.currency,
      locale: org.locale || 'en',
      createdAt: org.createdAt || org.created_at,
      workspaceCount: orgWorkspaces.length,
      adminCount: orgAdmins.length,
      workspaces: orgWorkspaces.map((w: any) => ({
        id: w.id,
        tenantId: orgId,
        name: w.name,
        code: w.code,
        slug: w.slug,
        description: w.description || '',
        timezone: w.timezone,
        currency: w.currency,
        status: w.status,
        isDefault: w.isDefault ?? w.is_default ?? false,
        memberCount: w.memberCount ?? w.member_count ?? 0,
        createdAt: w.createdAt || w.created_at,
      })),
      admins: orgAdmins.map((u: any) => ({
        id: u.id,
        tenantId: orgId,
        username: u.username,
        displayName: u.displayName || u.display_name || u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt || u.created_at,
      })),
    };
  });

  res.json({
    platform: {
      name: 'Enterprise WFM Platform',
      version: '1.0.0',
      totalOrgs: orgs.length,
      totalWorkspaces: workspaces.length,
      totalAdmins: admins.length,
    },
    tree,
  });
});

// ---------------------------------------------------------------- Cross-Tenant Analytics & Capacity Telemetry
platform.get('/analytics', async (_req, res) => {
  const orgs = await raw<any>(
    `SELECT 
      t.id, t.name, t.code, t.timezone, t.currency, t.created_at,
      coalesce(s.display_name, t.name) AS display_name,
      coalesce(s.legal_name, t.name) AS legal_name,
      (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = t.id) AS workspace_count,
      (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = t.id) AS user_count,
      (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = t.id AND u.status = 'ACTIVE') AS active_user_count,
      (SELECT count(*)::int FROM wfm.employees e WHERE e.tenant_id = t.id) AS employee_count,
      (SELECT count(*)::int FROM wfm.schedule_versions sv WHERE sv.tenant_id = t.id) AS schedule_count,
      (SELECT count(*)::int FROM wfm.schedule_versions sv WHERE sv.tenant_id = t.id AND sv.status = 'PUBLISHED') AS published_schedule_count,
      (SELECT count(*)::int FROM wfm.forecast_versions fv WHERE fv.tenant_id = t.id) AS forecast_count,
      (SELECT count(*)::int FROM wfm.interval_history ih WHERE ih.tenant_id = t.id) AS interval_count,
      (SELECT count(*)::int FROM wfm.shift_templates st WHERE st.tenant_id = t.id) AS shift_template_count,
      (SELECT count(*)::int FROM wfm.integration_connectors ic WHERE ic.tenant_id = t.id) AS connector_count,
      (SELECT count(*)::int FROM wfm.audit_log al WHERE al.tenant_id = t.id) AS audit_count,
      (SELECT max(al.at) FROM wfm.audit_log al WHERE al.tenant_id = t.id) AS last_audit_at,
      (SELECT max(u.last_login_at) FROM wfm.users u WHERE u.tenant_id = t.id) AS last_login_at
    FROM wfm.tenants t
    LEFT JOIN wfm.organization_settings s ON s.tenant_id = t.id
    ORDER BY t.name`
  );

  const [shiftSummary] = await raw<any>('SELECT count(*)::int AS total_shifts FROM wfm.schedule_shifts');
  const totalShifts = shiftSummary?.total_shifts ?? 0;

  const recentAudit = await raw<any>(
    `SELECT al.id, al.at, al.tenant_id, t.name AS tenant_name, t.code AS tenant_code,
            al.actor_name, al.actor_role, al.action, al.entity_type, al.entity_name, al.diff_summary, al.source
     FROM wfm.audit_log al
     JOIN wfm.tenants t ON t.id = al.tenant_id
     ORDER BY al.at DESC
     LIMIT 15`
  );

  const totalOrgs = orgs.length;
  const totalWorkspaces = orgs.reduce((acc: number, o: any) => acc + (o.workspaceCount ?? o.workspace_count ?? 0), 0);
  const totalUsers = orgs.reduce((acc: number, o: any) => acc + (o.userCount ?? o.user_count ?? 0), 0);
  const totalActiveUsers = orgs.reduce((acc: number, o: any) => acc + (o.activeUserCount ?? o.active_user_count ?? 0), 0);
  const totalEmployees = orgs.reduce((acc: number, o: any) => acc + (o.employeeCount ?? o.employee_count ?? 0), 0);
  const totalSchedules = orgs.reduce((acc: number, o: any) => acc + (o.scheduleCount ?? o.schedule_count ?? 0), 0);
  const totalPublishedSchedules = orgs.reduce((acc: number, o: any) => acc + (o.publishedScheduleCount ?? o.published_schedule_count ?? 0), 0);
  const totalForecasts = orgs.reduce((acc: number, o: any) => acc + (o.forecastCount ?? o.forecast_count ?? 0), 0);
  const totalIntervals = orgs.reduce((acc: number, o: any) => acc + (o.intervalCount ?? o.interval_count ?? 0), 0);
  const totalConnectors = orgs.reduce((acc: number, o: any) => acc + (o.connectorCount ?? o.connector_count ?? 0), 0);
  const totalAuditLogs = orgs.reduce((acc: number, o: any) => acc + (o.auditCount ?? o.audit_count ?? 0), 0);

  const tenantMetrics = orgs.map((o: any) => {
    const workspaceCount = o.workspaceCount ?? o.workspace_count ?? 0;
    const userCount = o.userCount ?? o.user_count ?? 0;
    const activeUserCount = o.activeUserCount ?? o.active_user_count ?? 0;
    const employeeCount = o.employeeCount ?? o.employee_count ?? 0;
    const scheduleCount = o.scheduleCount ?? o.schedule_count ?? 0;
    const publishedScheduleCount = o.publishedScheduleCount ?? o.published_schedule_count ?? 0;
    const forecastCount = o.forecastCount ?? o.forecast_count ?? 0;
    const intervalCount = o.intervalCount ?? o.interval_count ?? 0;
    const shiftTemplateCount = o.shiftTemplateCount ?? o.shift_template_count ?? 0;
    const connectorCount = o.connectorCount ?? o.connector_count ?? 0;
    const auditCount = o.auditCount ?? o.audit_count ?? 0;
    const lastActive = o.lastAuditAt || o.last_audit_at || o.lastLoginAt || o.last_login_at || o.createdAt || o.created_at;

    const activityScore = (userCount * 10) + (scheduleCount * 25) + (forecastCount * 15) + (intervalCount > 0 ? 50 : 0) + auditCount;
    let statusTier: 'HIGH_ACTIVITY' | 'MODERATE' | 'IDLE' = 'IDLE';
    if (activityScore > 100 || scheduleCount > 0 || intervalCount > 0) {
      statusTier = 'HIGH_ACTIVITY';
    } else if (activityScore > 10 || userCount > 1) {
      statusTier = 'MODERATE';
    }

    return {
      id: o.id,
      name: o.name,
      code: o.code,
      displayName: o.displayName || o.display_name || o.name,
      legalName: o.legalName || o.legal_name || o.name,
      timezone: o.timezone,
      currency: o.currency,
      createdAt: o.createdAt || o.created_at,
      workspaceCount,
      userCount,
      activeUserCount,
      employeeCount,
      scheduleCount,
      publishedScheduleCount,
      forecastCount,
      intervalCount,
      shiftTemplateCount,
      connectorCount,
      auditCount,
      lastActiveAt: lastActive,
      activityScore,
      statusTier,
    };
  });

  res.json({
    platform: {
      totalOrgs,
      totalWorkspaces,
      totalUsers,
      totalActiveUsers,
      totalEmployees,
      totalSchedules,
      totalPublishedSchedules,
      totalShifts,
      totalForecasts,
      totalIntervals,
      totalConnectors,
      totalAuditLogs,
    },
    tenants: tenantMetrics,
    storageDistribution: [
      { name: 'Interval History', records: totalIntervals, category: 'Telemetry & Timeseries' },
      { name: 'Schedule Shifts', records: totalShifts, category: 'Operational Rostering' },
      { name: 'Audit Ledger', records: totalAuditLogs, category: 'Security & Compliance' },
      { name: 'Workforce Roster', records: totalEmployees, category: 'Personnel Data' },
      { name: 'Forecast Versions', records: totalForecasts, category: 'Mathematical Models' },
    ],
    recentAudit: recentAudit.map((a: any) => ({
      id: a.id,
      at: a.at,
      tenantId: a.tenant_id,
      tenantName: a.tenant_name,
      tenantCode: a.tenant_code,
      actorName: a.actor_name,
      actorRole: a.actor_role,
      action: a.action,
      entityType: a.entity_type,
      entityName: a.entity_name,
      diffSummary: a.diff_summary,
      source: a.source,
    })),
  });
});

const INVITE_DAYS = 7;
/** A one-time link to set a password (valid for a week) and, when mail is set up, the email that carries it. The link is only ever shown here and in that email. */
async function createInvite(
  u: { tenantId: string; tenantName: string; tenantCode: string; userId: string; username: string; email: string | null; name: string },
  by?: { id: string; email: string }
): Promise<{ link: string; expiresAt: string; email: { sent: boolean; error?: string } | null }> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400000);
  await raw(`UPDATE wfm.emergency_password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.userId]);   // an older link stops working
  await raw(
    `INSERT INTO wfm.emergency_password_resets (tenant_id, user_id, token_hash, created_by_admin_id, created_by_admin_email, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [u.tenantId, u.userId, crypto.createHash('sha256').update(rawToken).digest('hex'), by?.id || null, by?.email || 'platform', expiresAt]
  );
  const urls = await getPlatformUrls();
  const link = `${urls.tenantApp}/reset-password?token=${rawToken}&org=${encodeURIComponent(u.tenantCode)}&invite=1`;
  let email: { sent: boolean; error?: string } | null = null;
  if (u.email) {
    const r = await sendPlatformEmail(
      u.email,
      `Your Enterprise WFM account for ${u.tenantName}`,
      `Hello ${u.name},\n\nAn Enterprise WFM account has been created for you as administrator of ${u.tenantName}.\n\nSet your password here (the link works once and expires in ${INVITE_DAYS} days):\n${link}\n\nYour sign-in name is: ${u.username}\nOrganisation code: ${u.tenantCode}\n\nIf you were not expecting this message, you can ignore it.`
    );
    email = { sent: r.ok, error: r.error };
  }
  return { link, expiresAt: expiresAt.toISOString(), email };
}

platform.post('/organizations', async (req, res) => {
  const b = parse(NewOrgBody, req.body);
  const code = b.code.toUpperCase();
  const existing = await raw<{ id: string }>('SELECT id FROM wfm.tenants WHERE upper(code) = $1', [code]);
  if (existing.length) {
    throw conflict(`An organisation with code "${code}" already exists.`);
  }

  // The plan and its terms are worked out first, so a bad choice is refused before anything is created.
  let licence: { plan: PlanRow; terms: Terms; start: Date; end: Date; isTrial: boolean; termMonths: number | null } | null = null;
  if (b.planTier) {
    const plan = await getPlan(b.planTier);
    if (!plan) throw bad('Choose a plan from the catalogue.');
    if (plan.status !== 'ACTIVE') throw bad(`${plan.name} is retired and cannot be given to a new customer.`);
    const terms = resolveTerms(plan, { maxEmployees: b.maxEmployees, maxUsers: b.maxUsers, maxSites: b.maxSites, maxWorkspaces: b.maxWorkspaces, gracePeriodDays: b.gracePeriodDays, modules: b.modules, reason: b.customReason });
    const start = b.startDate ? new Date(b.startDate) : new Date();
    const isTrial = !!b.isTrial;
    const end = isTrial ? new Date(start.getTime() + plan.trialDays * 86400000) : b.endDate ? new Date(b.endDate) : addMonths(start, b.termMonths ?? 12);
    if (!(end > start)) throw bad('The licence must end after it starts.');
    licence = { plan, terms, start, end, isTrial, termMonths: isTrial ? null : b.termMonths ?? null };
  }

  const [t] = await raw<any>(
    'INSERT INTO wfm.tenants (name, code, timezone, currency) VALUES ($1, $2, $3, $4) RETURNING *',
    [b.name, code, b.timezone, b.currency]
  );
  await ensureRolePermissions(t.id);

  // default workspace
  const [ws] = await raw<any>(
    `INSERT INTO wfm.workspaces (tenant_id, name, code, slug, timezone, currency, is_default, status)
     VALUES ($1, $2, 'DEFAULT', 'default', $3, $4, true, 'ACTIVE') RETURNING *`,
    [t.id, `${b.name} Default`, b.timezone, b.currency]
  );

  // organization settings
  await raw(
    `INSERT INTO wfm.organization_settings (tenant_id, legal_name, display_name, contact_name, contact_email, timezone, currency, locale, onboarded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [t.id, b.legalName || b.name, b.name, b.contactName || '', b.contactEmail || null, b.timezone, b.currency, b.locale || 'en', req.platformAdmin?.email || '']
  );
  await saveOrgProfile(t.id, b);

  // work calendar: the first workspace starts with the chosen pay week and weekend, so the customer's Scheduling Rules screen shows them from day one
  if (b.payWeekStart !== undefined || b.weekendDays) {
    await raw(
      `INSERT INTO wfm.scheduling_policy (tenant_id, workspace_id, defaults, updated_by) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET defaults = wfm.scheduling_policy.defaults || EXCLUDED.defaults, updated_at = now()`,
      [t.id, ws.id, JSON.stringify({ payWeekStart: b.payWeekStart ?? 0, weekendDays: cleanWeekend(b.weekendDays) }), req.platformAdmin?.email || 'platform']
    );
  }
  // labour-law pack for the country: added to the workspace and assigned to the whole organisation, so rotation and schedule checks have rules from the first day
  const pack = b.compliancePack ? BUILT_INS.find((x) => x.code === b.compliancePack) : undefined;
  if (pack) {
    const [row] = await raw<any>(
      `INSERT INTO wfm.compliance_packs (tenant_id, workspace_id, code, name, region, description, rules, built_in) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (tenant_id, workspace_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [t.id, ws.id, pack.code, pack.name, pack.region, pack.description, JSON.stringify(pack.rules)]);
    await raw(
      `INSERT INTO wfm.compliance_assignments (tenant_id, workspace_id, scope_type, scope_id, scope_key, pack_id) VALUES ($1, $2, 'TENANT', NULL, 'tenant', $3) ON CONFLICT DO NOTHING`,
      [t.id, ws.id, row.id]);
  }
  // the main site: where the organisation is, so the first group has a site to belong to and the Multi-Site page has something to show from day one
  const ra = (b as any).registeredAddress as { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string } | undefined;
  const mainSiteAddress = [ra?.line1, ra?.line2, ra?.city, ra?.state, ra?.postalCode].filter((x) => x && String(x).trim()).join(', ');
  const mainSiteName = b.mainSiteName?.trim() || 'Head office';
  await raw(
    `INSERT INTO wfm.sites (tenant_id, workspace_id, name, code, timezone, country, address) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.id, ws.id, mainSiteName, mainSiteName.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'SITE', b.timezone, b.country ?? '', mainSiteAddress]);
  let holidaysAdded = 0;
  if (b.holidayCountry && hasCountry(b.holidayCountry)) {
    const thisYear = new Date().getUTCFullYear();
    for (const h of [...publicHolidays(b.holidayCountry, thisYear), ...publicHolidays(b.holidayCountry, thisYear + 1)]) {
      await raw(
        `INSERT INTO wfm.special_events (tenant_id, workspace_id, name, kind, start_day, end_day, uplift_pct, lead_days, lag_days) VALUES ($1, $2, $3, 'holiday', $4::date, $5::date, 0, 0, 0)`,
        [t.id, ws.id, h.name, h.startDay, h.endDay]
      );
      holidaysAdded++;
    }
  }

  // the licence copies the plan's numbers (or the agreed exceptions), so editing the plan later never changes this customer by itself
  if (licence) {
    const keyPrefix = `LIC-${code.replace(/[^A-Za-z0-9]/g, '')}-${new Date().getFullYear()}-`;
    const licenseKey = `${keyPrefix}${Math.floor(1000 + Math.random() * 9000)}`;
    const L = licence.terms;
    const [lic] = await raw<any>(
      `INSERT INTO wfm.licenses (
        license_key, tenant_id, plan_tier, edition, status, start_date, end_date, renewal_date, grace_period_days,
        max_employees, max_users, max_supervisors, max_sites, max_workspaces, custom_terms, custom_reason, is_trial, term_months
      ) VALUES ($1, $2, $3, 'WFM_ENTERPRISE', 'ACTIVE', $4, $5, $5, $6, $7, $8, 25, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [licenseKey, t.id, licence.plan.code, licence.start, licence.end, L.gracePeriodDays, L.maxEmployees, L.maxUsers, L.maxSites, L.maxWorkspaces, L.customTerms, L.customReason, licence.isTrial, licence.termMonths]
    );
    for (const m of ALL_MODULES) {
      await raw(
        `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [lic.id, t.id, m, L.modules.includes(m)]
      );
    }
  }

  let initialAdmin: any = null;
  let invite: { link: string; expiresAt: string; email: { sent: boolean; error?: string } | null } | null = null;
  const adminUsername = b.adminUser || (b.adminEmail ? b.adminEmail.toLowerCase() : '');
  if (adminUsername && (b.adminPassword || b.adminEmail)) {
    // No password typed by the operator: the account starts locked and the administrator sets their own through a one-time link.
    const password = b.adminPassword || crypto.randomBytes(32).toString('base64url');
    const hash = await bcrypt.hash(password, 12);
    const [admin] = await raw<any>(
      `INSERT INTO wfm.users (tenant_id, username, display_name, email, role, password_hash, default_workspace_id, must_change_password)
       VALUES ($1, $2, $3, $4, 'WFM_ADMIN', $5, $6, false)
       RETURNING id, username, display_name, email, role, status`,
      [t.id, adminUsername, b.adminName || 'Administrator', b.adminEmail || null, hash, ws.id]
    );
    await raw(
      `INSERT INTO wfm.workspace_members (tenant_id, workspace_id, user_id, role, is_default)
       VALUES ($1, $2, $3, 'WFM_ADMIN', true)`,
      [t.id, ws.id, admin.id]
    );
    initialAdmin = {
      id: admin.id,
      username: admin.username,
      displayName: admin.display_name,
      email: admin.email,
      role: admin.role,
      status: admin.status,
    };
    if (!b.adminPassword) invite = await createInvite({ tenantId: t.id, tenantName: t.name, tenantCode: t.code, userId: admin.id, username: admin.username, email: b.adminEmail || null, name: b.adminName || 'Administrator' }, req.platformAdmin);
  }

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: 'PROVISION_ORGANISATION',
    targetTenantId: t.id,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'ORGANISATION',
    targetEntityId: t.id,
    targetEntityName: t.name,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: {
      name: t.name,
      code: t.code,
      legalName: b.legalName || b.name,
      timezone: b.timezone,
      currency: b.currency,
      defaultWorkspace: ws.name,
      payWeekStart: b.payWeekStart ?? null,
      weekendDays: b.weekendDays ?? null,
      compliancePack: pack?.code ?? null,
      mainSite: mainSiteName,
      holidaysAdded,
      initialAdminUser: initialAdmin?.username || null,
    },
    status: 'SUCCESS',
  });

  res.status(201).json({
    organization: {
      id: t.id,
      name: t.name,
      code: t.code,
      timezone: t.timezone,
      currency: t.currency,
      createdAt: t.created_at,
    },
    workspace: {
      id: ws.id,
      name: ws.name,
      code: ws.code,
      slug: ws.slug,
      isDefault: ws.is_default,
    },
    admin: initialAdmin,
    invite,
    holidaysAdded,
  });
});

platform.get('/organizations/:id', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  const [s] = await raw<any>('SELECT * FROM wfm.organization_settings WHERE tenant_id = $1', [orgId]);
  const workspaces = await raw<any>(
    `SELECT w.*, (SELECT count(*)::int FROM wfm.workspace_members m WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM wfm.workspaces w WHERE w.tenant_id = $1 ORDER BY w.is_default DESC, w.name`,
    [orgId]
  );
  const users = await raw<any>(
    `SELECT id, username, display_name, email, role, status, created_at, last_login_at
     FROM wfm.users WHERE tenant_id = $1 ORDER BY username`,
    [orgId]
  );

  res.json({
    organization: {
      id: t.id,
      name: s?.displayName || s?.display_name || t.name,
      code: t.code,
      legalName: s?.legalName || s?.legal_name || t.name,
      displayName: s?.displayName || s?.display_name || t.name,
      contactName: s?.contactName || s?.contact_name || '',
      contactEmail: s?.contactEmail || s?.contact_email || null,
      timezone: s?.timezone || t.timezone,
      currency: s?.currency || t.currency,
      locale: s?.locale || 'en',
      createdAt: t.createdAt || t.created_at,
      ...profileOut(s),
    },
    workspaces,
    users,
  });
});

platform.patch('/organizations/:id', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const b = parse(OrgPatch, req.body);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  if (b.name || b.timezone || b.currency) {
    await raw(
      'UPDATE wfm.tenants SET name = coalesce($2, name), timezone = coalesce($3, timezone), currency = coalesce($4, currency) WHERE id = $1',
      [orgId, b.name ?? null, b.timezone ?? null, b.currency ?? null]
    );
  }

  await raw(
    `INSERT INTO wfm.organization_settings (tenant_id, legal_name, display_name, contact_name, contact_email, timezone, currency, locale)
     SELECT $1, coalesce($2, t.name), coalesce($3, t.name), coalesce($4, ''), $5,
            coalesce($6, t.timezone), coalesce($7, t.currency), coalesce($8, 'en')
     FROM wfm.tenants t WHERE t.id = $1
     ON CONFLICT (tenant_id) DO UPDATE SET
       legal_name = coalesce($2, wfm.organization_settings.legal_name),
       display_name = coalesce($3, wfm.organization_settings.display_name),
       contact_name = coalesce($4, wfm.organization_settings.contact_name),
       contact_email = CASE WHEN $9::boolean THEN $5 ELSE wfm.organization_settings.contact_email END,
       timezone = coalesce($6, wfm.organization_settings.timezone),
       currency = coalesce($7, wfm.organization_settings.currency),
       locale = coalesce($8, wfm.organization_settings.locale),
       updated_at = now()`,
    [
      orgId,
      b.legalName ?? b.name ?? null,
      b.displayName ?? b.name ?? null,
      b.contactName ?? null,
      b.contactEmail ?? null,
      b.timezone ?? null,
      b.currency ?? null,
      b.locale ?? null,
      b.contactEmail !== undefined,
    ]
  );

  await saveOrgProfile(orgId, b);
  const [updatedT] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  const [updatedS] = await raw<any>('SELECT * FROM wfm.organization_settings WHERE tenant_id = $1', [orgId]);

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'UPDATE_ORGANISATION',
    targetTenantId: orgId,
    targetTenantName: updatedT.name,
    targetTenantCode: updatedT.code,
    targetEntityType: 'ORGANISATION',
    targetEntityId: orgId,
    targetEntityName: updatedT.name,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: b,
    status: 'SUCCESS',
  });

  res.json({
    id: updatedT.id,
    name: updatedS?.displayName || updatedS?.display_name || updatedT.name,
    code: updatedT.code,
    legalName: updatedS?.legalName || updatedS?.legal_name || updatedT.name,
    displayName: updatedS?.displayName || updatedS?.display_name || updatedT.name,
    contactName: updatedS?.contactName || updatedS?.contact_name || '',
    contactEmail: updatedS?.contactEmail || updatedS?.contact_email || null,
    timezone: updatedS?.timezone || updatedT.timezone,
    currency: updatedS?.currency || updatedT.currency,
    locale: updatedS?.locale || 'en',
    createdAt: updatedT.createdAt || updatedT.created_at,
    ...profileOut(updatedS),
  });
});

// ---------------------------------------------------------------- Workspaces of an Organization

platform.get('/organizations/:id/workspaces', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const rows = await raw<any>(
    `SELECT w.*, (SELECT count(*)::int FROM wfm.workspace_members m WHERE m.tenant_id = w.tenant_id AND m.workspace_id = w.id AND m.status = 'ACTIVE') AS member_count
     FROM wfm.workspaces w WHERE w.tenant_id = $1 ORDER BY w.is_default DESC, w.name`,
    [orgId]
  );
  res.json(rows);
});

platform.post('/organizations/:id/workspaces', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  const b = parse(NewWorkspaceBody, req.body);
  {
    const [lim] = await raw<any>(
      `SELECT l.max_workspaces, (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = l.tenant_id AND w.status = 'ACTIVE') AS used FROM wfm.licenses l WHERE l.tenant_id = $1 AND l.status NOT IN ('CANCELLED') ORDER BY l.created_at DESC LIMIT 1`, [orgId]);
    const max = lim?.maxWorkspaces ?? lim?.max_workspaces;
    if (lim && lim.used >= max) throw conflict(`This organisation's licence allows ${max} workspaces and it has ${lim.used}. Raise the workspace limit in Licensing first.`);
  }
  const code = b.code.toUpperCase();
  const existing = await raw<{ id: string }>('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND upper(code) = $2', [orgId, code]);
  if (existing.length) throw conflict(`A workspace with code "${code}" already exists in this organisation.`);

  const [ws] = await raw<any>(
    `INSERT INTO wfm.workspaces (tenant_id, name, code, slug, description, timezone, currency, is_default, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'ACTIVE') RETURNING *`,
    [orgId, b.name, code, b.slug || slugify(code), b.description ?? '', b.timezone || t.timezone, b.currency || t.currency]
  );

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'CREATE_WORKSPACE',
    targetTenantId: orgId,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'WORKSPACE',
    targetEntityId: ws.id,
    targetEntityName: ws.name,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: { code: ws.code, slug: ws.slug, timezone: ws.timezone },
    status: 'SUCCESS',
  });

  res.status(201).json({
    ...ws,
    memberCount: 0,
  });
});

// ---------------------------------------------------------------- Organization Administrator Provisioning

platform.post('/organizations/:id/admin', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [orgId]);
  if (!t) throw notFound('Organisation');

  const b = parse(NewOrgAdminBody, req.body);
  const existing = await raw<{ id: string }>('SELECT id FROM wfm.users WHERE tenant_id = $1 AND lower(username) = lower($2)', [orgId, b.username]);
  if (existing.length) throw conflict(`User "${b.username}" already exists in this organisation.`);

  const [defaultWs] = await raw<any>('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND is_default LIMIT 1', [orgId]);
  const hash = await bcrypt.hash(b.password, 12);
  const [u] = await raw<any>(
    `INSERT INTO wfm.users (tenant_id, username, display_name, email, role, password_hash, default_workspace_id)
     VALUES ($1, $2, $3, $4, 'WFM_ADMIN', $5, $6)
     RETURNING id, username, display_name, email, role, status, created_at`,
    [orgId, b.username, b.displayName || b.username, b.email || null, hash, defaultWs?.id || null]
  );

  if (defaultWs) {
    await raw(
      `INSERT INTO wfm.workspace_members (tenant_id, workspace_id, user_id, role, is_default)
       VALUES ($1, $2, $3, 'WFM_ADMIN', true) ON CONFLICT DO NOTHING`,
      [orgId, defaultWs.id, u.id]
    );
  }

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'PROVISION_ADMIN',
    targetTenantId: orgId,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'ORGANISATION_ADMIN',
    targetEntityId: u.id,
    targetEntityName: u.username,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: { username: u.username, email: u.email, role: u.role },
    status: 'SUCCESS',
  });

  res.status(201).json({
    user: {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      email: u.email,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
    },
  });
});

platform.post('/organizations/:id/admin/:userId/invite', async (req, res) => {
  const orgId = parse(uuid, req.params.id);
  const userId = parse(uuid, req.params.userId);
  const [row] = await raw<any>(
    `SELECT u.id, u.username, u.display_name, u.email, t.name AS tenant_name, t.code AS tenant_code
     FROM wfm.users u JOIN wfm.tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.tenant_id = $2`,
    [userId, orgId]
  );
  if (!row) throw notFound('User');
  const invite = await createInvite({ tenantId: orgId, tenantName: row.tenantName ?? row.tenant_name, tenantCode: row.tenantCode ?? row.tenant_code, userId, username: row.username, email: row.email, name: row.displayName ?? row.display_name }, req.platformAdmin);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id, adminEmail: req.platformAdmin!.email, action: 'SEND_INVITE', targetTenantId: orgId, targetTenantName: row.tenantName ?? row.tenant_name,
    targetTenantCode: row.tenantCode ?? row.tenant_code, targetEntityType: 'ORGANISATION_ADMIN', targetEntityId: userId, targetEntityName: row.username,
    ipAddress: getClientIp(req), userAgent: (req.headers['user-agent'] as string) || 'Unknown', details: { emailSent: invite.email?.sent ?? false }, status: 'SUCCESS',
  });
  res.json(invite);
});

// ---------------------------------------------------------------- Emergency Credential Reset

platform.post('/emergency-reset', async (req, res) => {
  const b = parse(EmergencyResetBody, req.body);
  const [user] = await raw<any>(
    `SELECT u.id, u.username, u.display_name, u.email, u.status, u.role, u.tenant_id,
            t.name AS tenant_name, t.code AS tenant_code
     FROM wfm.users u
     JOIN wfm.tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [b.userId]
  );
  if (!user) throw notFound('User');

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const tempPassword = generateSecureTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  if (b.method === 'TEMPORARY_PASSWORD' || b.method === 'BOTH') {
    await raw(
      `UPDATE wfm.users 
       SET password_hash = $1, status = 'ACTIVE', must_change_password = true 
       WHERE id = $2 AND tenant_id = $3`,
      [passwordHash, user.id, user.tenantId || user.tenant_id]
    );
  }

  await raw(
    `UPDATE wfm.emergency_password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [user.id]
  );

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  await raw(
    `INSERT INTO wfm.emergency_password_resets (
      tenant_id, user_id, token_hash, created_by_admin_id, created_by_admin_email, temp_password_hint, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      user.tenantId || user.tenant_id,
      user.id,
      tokenHash,
      req.platformAdmin!.id,
      req.platformAdmin!.email,
      tempPassword.slice(0, 3) + '••••' + tempPassword.slice(-2),
      expiresAt.toISOString(),
    ]
  );

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin!.id,
    adminEmail: req.platformAdmin!.email,
    action: 'EMERGENCY_CREDENTIAL_RESET',
    targetTenantId: user.tenantId || user.tenant_id,
    targetTenantName: user.tenantName || user.tenant_name,
    targetTenantCode: user.tenantCode || user.tenant_code,
    targetEntityType: 'ORGANISATION_ADMIN',
    targetEntityId: user.id,
    targetEntityName: user.username,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: {
      method: b.method,
      userEmail: user.email,
      mustChangePassword: true,
      expiresAt: expiresAt.toISOString(),
    },
    status: 'SUCCESS',
  });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.display_name || user.username,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId || user.tenant_id,
      tenantName: user.tenantName || user.tenant_name,
      tenantCode: user.tenantCode || user.tenant_code,
    },
    method: b.method,
    temporaryPassword: (b.method === 'TEMPORARY_PASSWORD' || b.method === 'BOTH') ? tempPassword : null,
    resetToken: rawToken,
    resetUrl: `/reset-password?token=${rawToken}&org=${user.tenantCode || user.tenant_code}`,
    expiresAt: expiresAt.toISOString(),
    mustChangePassword: true,
  });
});

platform.get('/emergency-resets', async (_req, res) => {
  const items = await raw<any>(
    `SELECT r.id, r.tenant_id, r.user_id, r.created_by_admin_email, r.temp_password_hint,
            r.expires_at, r.used_at, r.created_at,
            u.username, u.display_name, u.email, u.role,
            t.name AS tenant_name, t.code AS tenant_code,
            CASE 
              WHEN r.used_at IS NOT NULL THEN 'USED'
              WHEN r.expires_at < now() THEN 'EXPIRED'
              ELSE 'ACTIVE'
            END AS token_status
     FROM wfm.emergency_password_resets r
     JOIN wfm.users u ON u.id = r.user_id
     JOIN wfm.tenants t ON t.id = r.tenant_id
     ORDER BY r.created_at DESC
     LIMIT 50`
  );
  res.json(items);
});

// ---------------------------------------------------------------- Global Platform Audit Trail

platform.get('/audit', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const actionFilter = typeof req.query.action === 'string' ? req.query.action.trim() : '';
  const tenantFilter = typeof req.query.tenantId === 'string' ? req.query.tenantId.trim() : '';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

  const conditions: string[] = ['1=1'];
  const params: any[] = [];

  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    conditions.push(`(
      admin_email ILIKE ${p} OR
      target_tenant_name ILIKE ${p} OR
      target_tenant_code ILIKE ${p} OR
      target_entity_name ILIKE ${p} OR
      action ILIKE ${p} OR
      ip_address ILIKE ${p}
    )`);
  }

  if (actionFilter) {
    params.push(actionFilter);
    conditions.push(`action = $${params.length}`);
  }

  if (tenantFilter) {
    params.push(tenantFilter);
    conditions.push(`target_tenant_id = $${params.length}`);
  }

  const whereClause = conditions.join(' AND ');

  const [countResult] = await raw<any>(
    `SELECT count(*)::int AS total FROM wfm.platform_audit_log WHERE ${whereClause}`,
    params
  );
  const total = countResult?.total ?? 0;

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const items = await raw<any>(
    `SELECT id, at, admin_id, admin_email, action, target_tenant_id, target_tenant_name, target_tenant_code,
            target_entity_type, target_entity_id, target_entity_name, ip_address, user_agent, details, status
     FROM wfm.platform_audit_log
     WHERE ${whereClause}
     ORDER BY at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const [stats] = await raw<any>(
    `SELECT 
      count(*)::int AS total_events,
      count(*) FILTER (WHERE action IN ('SIGN_IN', 'SIGN_IN_FAILED', 'SIGN_OUT'))::int AS session_events,
      count(*) FILTER (WHERE action IN ('PROVISION_ORGANISATION', 'CREATE_WORKSPACE', 'UPDATE_ORGANISATION', 'PROVISION_ADMIN'))::int AS provisioning_events,
      count(*) FILTER (WHERE action = 'EMERGENCY_CREDENTIAL_RESET')::int AS credential_resets,
      count(*) FILTER (WHERE status = 'FAILURE')::int AS security_alerts
     FROM wfm.platform_audit_log`
  );

  res.json({
    total,
    limit,
    offset,
    items,
    stats: {
      totalEvents: stats?.totalEvents ?? stats?.total_events ?? total,
      sessionEvents: stats?.sessionEvents ?? stats?.session_events ?? 0,
      provisioningEvents: stats?.provisioningEvents ?? stats?.provisioning_events ?? 0,
      credentialResets: stats?.credentialResets ?? stats?.credential_resets ?? 0,
      securityAlerts: stats?.securityAlerts ?? stats?.security_alerts ?? 0,
    },
  });
});

// ---------------------------------------------------------------- Platform Licensing & Entitlements

platform.get('/licenses', async (_req, res) => {
  const rows = await raw<any>(
    `SELECT l.*, t.name AS tenant_name, t.code AS tenant_code,
            (SELECT count(*)::int FROM wfm.employees e WHERE e.tenant_id = l.tenant_id AND e.status != 'TERMINATED') AS active_employees,
            (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = l.tenant_id AND u.status = 'ACTIVE') AS active_users,
            (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = l.tenant_id AND w.status = 'ACTIVE') AS active_workspaces,
            (SELECT coalesce(array_agg(module_code), '{}') FROM wfm.license_modules lm WHERE lm.license_id = l.id AND lm.enabled = true) AS enabled_modules
     FROM wfm.licenses l
     JOIN wfm.tenants t ON t.id = l.tenant_id
     ORDER BY l.created_at DESC`
  );
  res.json(rows);
});

const IssueLicenseBody = z.object({
  tenantId: z.string().uuid(),
  planTier: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,29}$/).default('ENTERPRISE'),
  maxEmployees: z.number().int().min(1).optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxSites: z.number().int().min(1).optional(),
  maxWorkspaces: z.number().int().min(1).optional(),
  gracePeriodDays: z.number().int().min(0).optional(),
  endDate: z.string().optional(),
  termMonths: z.number().int().min(1).max(120).optional(),
  isTrial: z.boolean().optional(),
  customReason: z.string().max(300).optional(),
  modules: z.array(z.enum(ALL_MODULES)).optional(),
  adminUser: z.string().min(1).max(60).optional(),
  adminPassword: z.string().min(8).optional(),
  adminEmail: z.string().email().optional(),
});

platform.post('/licenses', async (req, res) => {
  const b = parse(IssueLicenseBody, req.body);
  const [t] = await raw<any>('SELECT * FROM wfm.tenants WHERE id = $1', [b.tenantId]);
  if (!t) throw notFound('Organisation');

  const [existingLic] = await raw<any>('SELECT id, plan_tier FROM wfm.licenses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [t.id]);
  const plan = await getPlan(b.planTier);
  if (!plan) throw bad('Choose a plan from the catalogue.');
  if (plan.status !== 'ACTIVE' && (existingLic?.planTier ?? existingLic?.plan_tier) !== plan.code) throw bad(`${plan.name} is retired and cannot be given to a customer.`);
  const terms = resolveTerms(plan, { maxEmployees: b.maxEmployees, maxUsers: b.maxUsers, maxSites: b.maxSites, maxWorkspaces: b.maxWorkspaces, gracePeriodDays: b.gracePeriodDays, modules: b.modules, reason: b.customReason });
  const now = new Date();
  const isTrial = !!b.isTrial;
  const endDate = isTrial ? new Date(now.getTime() + plan.trialDays * 86400000) : b.endDate ? new Date(b.endDate) : addMonths(now, b.termMonths ?? 12);
  if (!(endDate > now)) throw bad('The licence must end in the future.');

  let lic: any;
  if (existingLic) {
    [lic] = await raw<any>(
      `UPDATE wfm.licenses SET
         plan_tier = $2, status = 'ACTIVE', max_employees = $3, max_users = $4, max_sites = $5, max_workspaces = $6, grace_period_days = $7,
         end_date = $8, custom_terms = $9, custom_reason = $10, is_trial = $11, term_months = $12, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [existingLic.id, plan.code, terms.maxEmployees, terms.maxUsers, terms.maxSites, terms.maxWorkspaces, terms.gracePeriodDays, endDate, terms.customTerms, terms.customReason, isTrial, isTrial ? null : b.termMonths ?? null]
    );
  } else {
    const keyPrefix = `LIC-${t.code.replace(/[^A-Za-z0-9]/g, '')}-${new Date().getFullYear()}-`;
    const licenseKey = `${keyPrefix}${Math.floor(1000 + Math.random() * 9000)}`;
    [lic] = await raw<any>(
      `INSERT INTO wfm.licenses (
        license_key, tenant_id, plan_tier, edition, status, start_date, end_date, renewal_date, grace_period_days,
        max_employees, max_users, max_supervisors, max_sites, max_workspaces, custom_terms, custom_reason, is_trial, term_months
      ) VALUES ($1, $2, $3, 'WFM_ENTERPRISE', 'ACTIVE', now(), $4, $4, $5, $6, $7, 25, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [licenseKey, t.id, plan.code, endDate, terms.gracePeriodDays, terms.maxEmployees, terms.maxUsers, terms.maxSites, terms.maxWorkspaces, terms.customTerms, terms.customReason, isTrial, isTrial ? null : b.termMonths ?? null]
    );
  }

  for (const m of ALL_MODULES) {
    await raw(
      `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = $4`,
      [lic.id, t.id, m, terms.modules.includes(m)]
    );
  }

  let adminSummary: any = null;
  if (b.adminUser && b.adminPassword) {
    const hash = await bcrypt.hash(b.adminPassword, 12);
    const [ws] = await raw<any>('SELECT id FROM wfm.workspaces WHERE tenant_id = $1 AND is_default LIMIT 1', [t.id]);
    const wsId = ws?.id;

    const [existingUser] = await raw<any>('SELECT id FROM wfm.users WHERE tenant_id = $1 AND username = $2', [t.id, b.adminUser]);
    if (existingUser) {
      await raw('UPDATE wfm.users SET password_hash = $2, status = \'ACTIVE\' WHERE id = $1', [existingUser.id, hash]);
    } else {
      const [u] = await raw<any>(
        `INSERT INTO wfm.users (tenant_id, username, display_name, email, role, password_hash, default_workspace_id)
         VALUES ($1, $2, 'Administrator', $3, 'WFM_ADMIN', $4, $5)
         RETURNING id`,
        [t.id, b.adminUser, b.adminEmail || null, hash, wsId || null]
      );
      if (wsId) {
        await raw(
          `INSERT INTO wfm.workspace_members (tenant_id, workspace_id, user_id, role, is_default)
           VALUES ($1, $2, $3, 'WFM_ADMIN', true)
           ON CONFLICT DO NOTHING`,
          [t.id, wsId, u.id]
        );
      }
    }
    adminSummary = {
      username: b.adminUser,
      password: b.adminPassword,
    };
  }

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: 'ISSUE_LICENSE',
    targetTenantId: t.id,
    targetTenantName: t.name,
    targetTenantCode: t.code,
    targetEntityType: 'LICENSE',
    targetEntityId: lic.id,
    targetEntityName: lic.licenseKey,
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    details: {
      planTier: b.planTier,
      maxEmployees: b.maxEmployees,
      maxUsers: b.maxUsers,
      licenseKey: lic.licenseKey,
    },
    status: 'SUCCESS',
  });

  res.status(201).json({
    organization: t,
    license: lic,
    adminUser: adminSummary?.username || null,
    adminPassword: adminSummary?.password || null,
  });
});

platform.get('/licenses/:id', async (req, res) => {
  const id = req.params.id;
  const [lic] = await raw<any>(
    `SELECT l.*, t.name AS tenant_name, t.code AS tenant_code
     FROM wfm.licenses l
     JOIN wfm.tenants t ON t.id = l.tenant_id
     WHERE l.id = $1`,
    [id]
  );
  if (!lic) throw notFound('License');
  const modules = await raw<any>('SELECT * FROM wfm.license_modules WHERE license_id = $1 ORDER BY module_code', [id]);
  const [{ count: activeEmployees }] = await raw<any>("SELECT count(*)::int AS count FROM wfm.employees WHERE tenant_id = $1 AND status != 'TERMINATED'", [lic.tenantId]);
  const [{ count: activeUsers }] = await raw<any>("SELECT count(*)::int AS count FROM wfm.users WHERE tenant_id = $1 AND status = 'ACTIVE'", [lic.tenantId]);
  res.json({ ...lic, modules, usage: { activeEmployees, activeUsers } });
});

const LicensePatch = z.object({
  planTier: z.string().optional(),
  status: z.enum(['DRAFT', 'ISSUED', 'PROVISIONING', 'ACTIVE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELLED', 'EXPIRED']).optional(),
  endDate: z.string().optional(),
  maxEmployees: z.number().int().min(1).optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxSites: z.number().int().min(1).optional(),
  maxWorkspaces: z.number().int().min(1).optional(),
  gracePeriodDays: z.number().int().min(0).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
  customReason: z.string().max(300).optional(),
});

platform.patch('/licenses/:id', async (req, res) => {
  const id = req.params.id;
  const b = parse(LicensePatch, req.body);
  const [existing] = await raw<any>('SELECT * FROM wfm.licenses WHERE id = $1', [id]);
  if (!existing) throw notFound('License');

  // seats must fit the plan, and limits or modules that differ from it are recorded as custom terms with a reason
  const planCode = b.planTier ?? existing.planTier ?? existing.plan_tier;
  const plan = await getPlan(planCode);
  if (b.planTier && !plan) throw bad('Choose a plan from the catalogue.');
  let flags = { customTerms: !!(existing.customTerms ?? existing.custom_terms), customReason: String(existing.customReason ?? existing.custom_reason ?? '') };
  if (plan) {
    const have = (await raw<any>('SELECT module_code FROM wfm.license_modules WHERE license_id = $1 AND enabled', [id])).map((m) => m.moduleCode ?? m.module_code) as string[];
    const finalModules = new Set(have);
    for (const [m, on] of Object.entries(b.modules ?? {})) (on ? finalModules.add(m) : finalModules.delete(m));
    const t = resolveTerms(plan, {
      maxEmployees: b.maxEmployees ?? existing.maxEmployees ?? existing.max_employees, maxUsers: b.maxUsers ?? existing.maxUsers ?? existing.max_users,
      maxSites: b.maxSites ?? existing.maxSites ?? existing.max_sites, maxWorkspaces: b.maxWorkspaces ?? existing.maxWorkspaces ?? existing.max_workspaces,
      modules: [...finalModules], reason: b.customReason ?? flags.customReason,
    });
    flags = { customTerms: t.customTerms, customReason: t.customReason };
  }

  const [updated] = await raw<any>(
    `UPDATE wfm.licenses SET
       custom_terms = $10, custom_reason = $11,
       plan_tier = coalesce($2, plan_tier),
       status = coalesce($3, status),
       end_date = coalesce($4, end_date),
       max_employees = coalesce($5, max_employees),
       max_users = coalesce($6, max_users),
       max_sites = coalesce($7, max_sites),
       max_workspaces = coalesce($8, max_workspaces),
       grace_period_days = coalesce($9, grace_period_days),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, b.planTier ?? null, b.status ?? null, b.endDate ? new Date(b.endDate) : null, b.maxEmployees ?? null, b.maxUsers ?? null, b.maxSites ?? null, b.maxWorkspaces ?? null, b.gracePeriodDays ?? null, flags.customTerms, flags.customReason]
  );

  const tenantId = existing.tenantId || existing.tenant_id;
  if (b.modules) {
    for (const [mod, enabled] of Object.entries(b.modules)) {
      await raw(
        `INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = $4`,
        [id, tenantId, mod, enabled]
      );
    }
  }

  // Invalidate cached role permissions in Redis so tenant users immediately see updated permissions
  await dropCache(tenantId, 'perms:*').catch(() => {});
  const redisKeys = await redis.keys(`wfm:${tenantId}:*`).catch(() => []);
  if (redisKeys.length) await redis.del(...redisKeys).catch(() => {});

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: 'UPDATE_LICENSE',
    targetTenantId: tenantId,
    targetEntityType: 'LICENSE',
    targetEntityId: id,
    details: { before: existing, patch: b },
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    status: 'SUCCESS',
  });

  const [fullUpdated] = await raw<any>(
    `SELECT l.*, t.name AS tenant_name, t.code AS tenant_code,
            (SELECT count(*)::int FROM wfm.employees e WHERE e.tenant_id = l.tenant_id AND e.status != 'TERMINATED') AS active_employees,
            (SELECT count(*)::int FROM wfm.users u WHERE u.tenant_id = l.tenant_id AND u.status = 'ACTIVE') AS active_users,
            (SELECT count(*)::int FROM wfm.workspaces w WHERE w.tenant_id = l.tenant_id AND w.status = 'ACTIVE') AS active_workspaces,
            (SELECT coalesce(array_agg(module_code), '{}') FROM wfm.license_modules lm WHERE lm.license_id = l.id AND lm.enabled = true) AS enabled_modules
     FROM wfm.licenses l
     JOIN wfm.tenants t ON t.id = l.tenant_id
     WHERE l.id = $1`,
    [id]
  );

  res.json(fullUpdated || updated);
});

platform.get('/capacity-requests', async (_req, res) => {
  const rows = await raw<any>(
    `SELECT r.*, t.name AS tenant_name, t.code AS tenant_code, u.username AS requester_name, u.email AS requester_email
     FROM wfm.license_capacity_requests r
     JOIN wfm.tenants t ON t.id = r.tenant_id
     JOIN wfm.users u ON u.id = r.requested_by_user_id
     ORDER BY r.created_at DESC`
  );
  res.json(rows);
});

const DecideCapacityRequest = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  notes: z.string().max(500).optional(),
  grant: z.number().int().min(1).max(1_000_000).optional(),     // approve a different amount than was asked for
});

platform.post('/capacity-requests/:id/decide', async (req, res) => {
  const id = req.params.id;
  const b = parse(DecideCapacityRequest, req.body);
  const [r] = await raw<any>('SELECT * FROM wfm.license_capacity_requests WHERE id = $1', [id]);
  if (!r) throw notFound('Capacity request');
  if (r.status !== 'PENDING') throw bad(`Request already decided (${r.status})`);

  if (b.action === 'APPROVE' && r.resourceType === 'PLAN') {
    // a plan change: the customer's licence takes the plan's limits and modules (seats and dates stay)
    const plan = await getPlan(r.requestedPlan ?? r.requested_plan);
    if (!plan || plan.status !== 'ACTIVE' || plan.isCustom) throw bad('That plan is no longer available. Reject the request, or change the plan on the licence yourself.');
    const [l] = await raw<any>('SELECT id, max_employees FROM wfm.licenses WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [r.tenantId]);
    if (!l) throw notFound('Licence');
    const problems = whyNotFit(plan, await usageOf(r.tenantId, l.maxEmployees ?? l.max_employees));
    if (problems.length) throw bad(`The customer no longer fits this plan. ${problems.join(' ')}`);
    await applyPlanToLicence(l.id, r.tenantId, plan);
  }

  let granted = r.additionalNeeded as number;
  if (b.action === 'APPROVE' && r.resourceType !== 'PLAN') {
    const [lic] = await raw<any>(`SELECT id FROM wfm.licenses WHERE tenant_id = $1 AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 1`, [r.tenantId]);
    if (!lic) throw notFound('Licence');
    const column: Record<string, string> = { EMPLOYEES: 'max_employees', USERS: 'max_users', SITES: 'max_sites', WORKSPACES: 'max_workspaces' };
    const label: Record<string, string> = { EMPLOYEES: 'employee seats', USERS: 'user accounts', SITES: 'sites', WORKSPACES: 'workspaces' };
    let what = '';
    if (r.resourceType === 'MODULES') {
      const mods: string[] = r.requestedModules ?? r.requested_modules ?? [];
      if (!mods.length) throw bad('This request names no modules.');
      for (const m of mods) {
        await raw(`INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled) VALUES ($1, $2, $3, true) ON CONFLICT (license_id, module_code) DO UPDATE SET enabled = true`, [lic.id, r.tenantId, m]);
      }
      granted = mods.length;
      what = `Added ${mods.join(', ')}`;
    } else if (column[r.resourceType]) {
      granted = b.grant ?? r.additionalNeeded;
      await raw(`UPDATE wfm.licenses SET ${column[r.resourceType]} = ${column[r.resourceType]} + $2 WHERE id = $1`, [lic.id, granted]);
      what = `Added ${granted} ${label[r.resourceType]}`;
    } else {
      throw bad(`Requests of the kind ${r.resourceType} cannot be approved here.`);
    }
    // anything beyond the plan is an exception: recorded as custom terms, so applying the plan to customers later does not take it away
    await raw(`UPDATE wfm.licenses SET custom_terms = true, custom_reason = CASE WHEN custom_reason = '' THEN $2 ELSE custom_reason || '; ' || $2 END, updated_at = now() WHERE id = $1`, [lic.id, `${what} (approved request)`]);
    await forgetTenant(r.tenantId);
  }

  const [updated] = await raw<any>(
    `UPDATE wfm.license_capacity_requests SET
       status = $2,
       reviewed_by_admin = $3,
       reviewed_at = now(),
       decision_note = $4
     WHERE id = $1
     RETURNING *`,
    [id, b.action === 'APPROVE' ? 'APPROVED' : 'REJECTED', req.platformAdmin?.id || null, (b.notes ?? '').trim()]
  );

  const ip = getClientIp(req);
  await logPlatformAudit({
    adminId: req.platformAdmin?.id,
    adminEmail: req.platformAdmin?.email || 'superadmin@wfm.local',
    action: b.action === 'APPROVE' ? 'APPROVE_CAPACITY_REQUEST' : 'REJECT_CAPACITY_REQUEST',
    targetTenantId: r.tenantId,
    targetEntityType: 'CAPACITY_REQUEST',
    targetEntityId: id,
    details: { request: r, decision: b.action, notes: b.notes, granted: b.action === 'APPROVE' ? granted : null },
    ipAddress: ip,
    userAgent: (req.headers['user-agent'] as string) || 'Unknown',
    status: 'SUCCESS',
  });

  res.json(updated);
});
