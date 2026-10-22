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
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  jwtSecret: need('JWT_SECRET'),
  jwtTtl: process.env.JWT_TTL || '12h',
  protoPath: path.resolve(here, '../../proto/wfm.proto'),
  migrationsDir: path.resolve(here, '../../db/migrations'),
  bootstrap: {
    tenantName: process.env.BOOTSTRAP_TENANT_NAME || 'My Organisation',
    tenantCode: process.env.BOOTSTRAP_TENANT_CODE || 'ORG',
    timezone: process.env.BOOTSTRAP_TIMEZONE || 'UTC',
    adminUser: process.env.BOOTSTRAP_ADMIN_USER || 'admin',
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  },
};

if (config.jwtSecret.length < 16) throw new Error('JWT_SECRET must be at least 16 characters');
