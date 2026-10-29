-- Licensing Subsystem: first-class License object, modular entitlements, capacity governance, and capacity requests.
-- Separates Platform -> Tenant -> License -> Organizations -> Users -> Employees.

CREATE TABLE IF NOT EXISTS wfm.licenses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key           text NOT NULL UNIQUE,
  tenant_id             uuid NOT NULL REFERENCES wfm.tenants(id) ON DELETE CASCADE,
  org_id                uuid GENERATED ALWAYS AS (tenant_id) STORED,
  plan_tier             text NOT NULL DEFAULT 'ENTERPRISE', -- 'STARTER', 'PROFESSIONAL', 'ENTERPRISE', 'ENTERPRISE_PLUS', 'CUSTOM'
  edition               text NOT NULL DEFAULT 'WFM_ENTERPRISE',
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ISSUED', 'PROVISIONING', 'ACTIVE', 'GRACE_PERIOD', 'SUSPENDED', 'CANCELLED', 'EXPIRED')),
  
  -- Effective dates & Grace Periods
  start_date            timestamptz NOT NULL DEFAULT now(),
  end_date              timestamptz NOT NULL DEFAULT (now() + interval '1 year'),
  renewal_date          timestamptz,
  grace_period_days     int NOT NULL DEFAULT 14,
  
  -- Quantitative Capacities
  max_employees         int NOT NULL DEFAULT 500,
  max_users             int NOT NULL DEFAULT 100,
  max_supervisors       int NOT NULL DEFAULT 25,
  max_sites             int NOT NULL DEFAULT 10,
  max_workspaces        int NOT NULL DEFAULT 5,
  max_api_calls_pm      int NOT NULL DEFAULT 1000,
  max_storage_gb        int NOT NULL DEFAULT 100,
  
  -- Metadata
  contract_id           text,
  billing_account_ref   text,
  issued_by             text NOT NULL DEFAULT 'PLATFORM_ADMIN',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS licenses_tenant ON wfm.licenses (tenant_id, status);

CREATE TABLE IF NOT EXISTS wfm.license_modules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id    uuid NOT NULL REFERENCES wfm.licenses(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES wfm.tenants(id) ON DELETE CASCADE,
  org_id        uuid GENERATED ALWAYS AS (tenant_id) STORED,
  module_code   text NOT NULL, -- FORECASTING, SCHEDULING, INTRADAY, ADHERENCE, TIME_OFF, SHIFT_BIDDING, EMPLOYEE_SELF_SERVICE, REPORTING, ADVANCED_ANALYTICS, AI_COPILOT
  enabled       boolean NOT NULL DEFAULT true,
  tier          text NOT NULL DEFAULT 'STANDARD',
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (license_id, module_code)
);

CREATE INDEX IF NOT EXISTS license_modules_tenant ON wfm.license_modules (tenant_id, module_code);

CREATE TABLE IF NOT EXISTS wfm.license_capacity_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES wfm.tenants(id) ON DELETE CASCADE,
  org_id                uuid GENERATED ALWAYS AS (tenant_id) STORED,
  requested_by_user_id  uuid NOT NULL REFERENCES wfm.users(id) ON DELETE CASCADE,
  resource_type         text NOT NULL CHECK (resource_type IN ('EMPLOYEES', 'USERS', 'SITES', 'MODULES')),
  current_capacity      int NOT NULL,
  requested_capacity    int NOT NULL,
  additional_needed     int NOT NULL,
  justification         text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by_admin     uuid REFERENCES wfm.platform_admins(id) ON DELETE SET NULL,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS license_requests_tenant ON wfm.license_capacity_requests (tenant_id, status);

-- Backfill default Enterprise licenses for existing tenants
DO $$
DECLARE
  t record;
  lic_id uuid;
  key_prefix text;
BEGIN
  FOR t IN SELECT id, code, name FROM wfm.tenants LOOP
    IF NOT EXISTS (SELECT 1 FROM wfm.licenses WHERE tenant_id = t.id) THEN
      key_prefix := 'LIC-' || upper(regexp_replace(t.code, '[^A-Za-z0-9]', '', 'g')) || '-' || to_char(now(), 'YYYY') || '-';
      INSERT INTO wfm.licenses (
        license_key, tenant_id, plan_tier, edition, status,
        start_date, end_date, renewal_date, grace_period_days,
        max_employees, max_users, max_supervisors, max_sites, max_workspaces
      ) VALUES (
        key_prefix || lpad(floor(random()*9000 + 1000)::text, 4, '0'),
        t.id, 'ENTERPRISE', 'WFM_ENTERPRISE', 'ACTIVE',
        now(), now() + interval '1 year', now() + interval '1 year', 14,
        500, 100, 25, 10, 5
      ) RETURNING id INTO lic_id;

      INSERT INTO wfm.license_modules (license_id, tenant_id, module_code, enabled) VALUES
        (lic_id, t.id, 'FORECASTING', true),
        (lic_id, t.id, 'SCHEDULING', true),
        (lic_id, t.id, 'INTRADAY', true),
        (lic_id, t.id, 'ADHERENCE', true),
        (lic_id, t.id, 'TIME_OFF', true),
        (lic_id, t.id, 'SHIFT_BIDDING', true),
        (lic_id, t.id, 'EMPLOYEE_SELF_SERVICE', true),
        (lic_id, t.id, 'REPORTING', true),
        (lic_id, t.id, 'AI_COPILOT', true)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
