-- Public API and webhooks.
--
--  api_keys            a long-lived credential for another system to READ from the platform. Only a hash of the secret is stored; the secret is shown once.
--                      scopes limit what it can read (a subset of the *:read permissions). It can be revoked, can expire, and is rate limited per minute.
--  webhook_endpoints   where the platform tells another system that something happened (a schedule published, time off requested...). Each delivery is signed
--                      with the endpoint's secret (HMAC-SHA256 over timestamp + body) so the receiver can check who sent it.
--  webhook_deliveries  one row per event per endpoint: the durable outbox. Failed deliveries are retried with a growing delay, then marked failed. Any gateway can send.
--
-- These tables use org_id instead of tenant_id on purpose. A key has to be looked up, and a delivery claimed, before any organisation is known, which
-- row-level security (keyed on tenant_id) would hide. Every API read and write filters on org_id.

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL UNIQUE,                  -- the part of the key that is not secret, used to find it
  secret_hash   text NOT NULL,                         -- sha256 of the secret part
  scopes        text[] NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  rate_limit    int NOT NULL DEFAULT 600 CHECK (rate_limit BETWEEN 1 AND 100000),    -- requests a minute
  expires_at    timestamptz,
  last_used_at  timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_org ON api_keys (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  url              text NOT NULL,
  secret           text NOT NULL,
  events           text[] NOT NULL,                    -- event names, or '*' for all
  active           boolean NOT NULL DEFAULT true,
  consecutive_failures int NOT NULL DEFAULT 0,
  disabled_reason  text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_org ON webhook_endpoints (org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status     int,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC);
