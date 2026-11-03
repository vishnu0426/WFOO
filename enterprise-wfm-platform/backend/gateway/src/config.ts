import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. Copy backend/.env.example to backend/.env and fill it in.`);
  return v;
};

export const config = {
  databaseUrl: need('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  natsUrl: process.env.NATS_URL || process.env.NATS_SERVERS || 'nats://localhost:4222',
  natsUser: process.env.NATS_USER || undefined,
  natsPass: process.env.NATS_PASS || undefined,
  natsTlsRejectUnauthorized: process.env.NATS_TLS_REJECT_UNAUTHORIZED === undefined ? undefined : !['false', '0'].includes(process.env.NATS_TLS_REJECT_UNAUTHORIZED.toLowerCase()),
  engineAddr: process.env.ENGINE_ADDR || '127.0.0.1:50051',
  port: Number(process.env.PORT || 4000),
  /** Which work this process does: 'all' (default, one process does everything), 'web' (answers requests only; run as many as needed behind the load balancer) or
   *  'jobs' (the timers and workers only: schedule runs, webhooks, reports, connector pulls, the adherence watcher; run exactly one). */
  role: (['web', 'jobs'].includes(String(process.env.GATEWAY_ROLE).toLowerCase()) ? String(process.env.GATEWAY_ROLE).toLowerCase() : 'all') as 'all' | 'web' | 'jobs',
  /** Database connections held by this process. Keep (web processes + 1) x this under the database's max_connections, or put a pooler in front. */
  dbPoolMax: Math.max(2, Number(process.env.DB_POOL_MAX || 12)),
  /** True when DB_POOL_MAX was set: then it is used as given and not worked out from the database's limit. */
  dbPoolExplicit: !!process.env.DB_POOL_MAX,
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  jwtSecret: need('JWT_SECRET'),
  jwtTtl: process.env.JWT_TTL || '12h',
  /** People given a temporary password must replace it before using anything else. Set FORCE_PASSWORD_CHANGE=false only for automated tests and throwaway demos. */
  forcePasswordChange: process.env.FORCE_PASSWORD_CHANGE !== 'false',
  protoPath: path.resolve(here, '../../proto/wfm.proto'),
  migrationsDir: path.resolve(here, '../../db/migrations'),
  bootstrap: {
    tenantName: process.env.BOOTSTRAP_TENANT_NAME || 'My Organisation',
    tenantCode: process.env.BOOTSTRAP_TENANT_CODE || 'ORG',
    timezone: process.env.BOOTSTRAP_TIMEZONE || 'UTC',
    adminUser: process.env.BOOTSTRAP_ADMIN_USER || 'admin',
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  },
  platformAdmin: {
    email: process.env.PLATFORM_ADMIN_EMAIL || process.env.SUPERADMIN_EMAIL || '',
    password: process.env.PLATFORM_ADMIN_PASSWORD || process.env.SUPERADMIN_PASSWORD || '',
  },
};

if (config.jwtSecret.length < 16) throw new Error('JWT_SECRET must be at least 16 characters');

// A production gateway never talks to the message bus without checking its certificate: NATS_TLS_REJECT_UNAUTHORIZED=false is for a shared development server only.
if (process.env.NODE_ENV === 'production' && config.natsTlsRejectUnauthorized === false) {
  throw new Error('Refusing to start in production with NATS_TLS_REJECT_UNAUTHORIZED=false. Install the message server\'s certificate authority (NODE_EXTRA_CA_CERTS) and remove the setting.');
}
