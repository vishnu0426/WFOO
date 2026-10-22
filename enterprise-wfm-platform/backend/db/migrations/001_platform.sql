-- Platform: tenants, users, RBAC matrix, audit ledger.
-- Conventions: UUID keys, tenant_id on every tenant table (RLS is applied to all of them by the migrator),
-- timestamps in UTC (timestamptz), the tenant's IANA zone lives on tenants.timezone.

CREATE TABLE IF NOT EXISTS tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  code          text NOT NULL UNIQUE,
  timezone      text NOT NULL DEFAULT 'UTC',
  currency      text NOT NULL DEFAULT 'USD',
  four_eyes     boolean NOT NULL DEFAULT false,   -- when true, the person who submits a forecast cannot approve it
  active_features text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username      text NOT NULL,
  email         text,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('WFM_ADMIN','WFM_MANAGER','FORECAST_PLANNER','SCHEDULER','SUPERVISOR_RTA','ANALYST','AGENT')),
  employee_id   uuid,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (tenant_id, username)
);
CREATE INDEX IF NOT EXISTS users_tenant ON users (tenant_id, role);

CREATE TABLE IF NOT EXISTS role_permissions (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       text NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (tenant_id, role, permission)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,
  actor_name   text NOT NULL,
  actor_role   text NOT NULL,
  action       text NOT NULL,            -- CREATE UPDATE DELETE APPROVE REJECT PUBLISH IMPORT EXPORT GENERATE ROLLBACK ...
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  entity_name  text,
  reason       text,
  before       jsonb,
  after        jsonb,
  diff_summary text,
  source       text NOT NULL DEFAULT 'API',
  ip_address   text,
  request_id   text
);
CREATE INDEX IF NOT EXISTS audit_tenant_at ON audit_log (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log (tenant_id, entity_type, entity_id, at DESC);
