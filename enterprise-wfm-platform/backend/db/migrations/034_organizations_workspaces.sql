-- Organisations and workspaces.
-- A tenant is an organisation (org_id is kept as an explicit, generated alias of tenant_id so every row carries both names),
-- and every organisation can contain one or more workspaces. The default workspace preserves the behaviour of existing data.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS org_id uuid GENERATED ALWAYS AS (id) STORED;

CREATE TABLE IF NOT EXISTS workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  org_id        uuid GENERATED ALWAYS AS (tenant_id) STORED,
  name          text NOT NULL,
  code          text NOT NULL,
  slug          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  timezone      text NOT NULL DEFAULT 'UTC',
  currency      text NOT NULL DEFAULT 'USD',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  is_default    boolean NOT NULL DEFAULT false,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, slug),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_default ON workspaces (tenant_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS workspaces_tenant ON workspaces (tenant_id, status);

CREATE TABLE IF NOT EXISTS organization_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  org_id         uuid GENERATED ALWAYS AS (tenant_id) STORED,
  legal_name     text NOT NULL DEFAULT '',
  display_name   text NOT NULL DEFAULT '',
  contact_name   text NOT NULL DEFAULT '',
  contact_email  text,
  timezone       text NOT NULL DEFAULT 'UTC',
  currency       text NOT NULL DEFAULT 'USD',
  locale         text NOT NULL DEFAULT 'en',
  settings       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  org_id        uuid GENERATED ALWAYS AS (tenant_id) STORED,
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  role          text NOT NULL CHECK (role IN ('WFM_ADMIN','WFM_MANAGER','FORECAST_PLANNER','SCHEDULER','SUPERVISOR_RTA','ANALYST','AGENT')),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  UNIQUE (tenant_id, workspace_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_default ON workspace_members (tenant_id, user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members (tenant_id, user_id);
DO $$ BEGIN
  ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_workspace_fk
    FOREIGN KEY (org_id, workspace_id) REFERENCES workspaces (org_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Every tenant table now carries org_id. It is generated from tenant_id, so it can never disagree with the RLS tenant boundary.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'wfm' AND c.column_name = 'tenant_id'
      AND c.table_name NOT IN ('workspaces', 'workspace_members', 'organization_settings')
  LOOP
    EXECUTE format('ALTER TABLE wfm.%I ADD COLUMN IF NOT EXISTS org_id uuid GENERATED ALWAYS AS (tenant_id) STORED', t.table_name);
  END LOOP;
END $$;

-- One default workspace per existing organisation, named after the organisation.
INSERT INTO workspaces (tenant_id, name, code, slug, description, timezone, currency, is_default)
SELECT t.id, t.name, t.code,
       coalesce(nullif(lower(regexp_replace(t.code, '[^a-zA-Z0-9]+', '-', 'g')), ''), 'default'),
       'Default workspace for ' || t.name, t.timezone, t.currency, true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.tenant_id = t.id AND w.is_default)
ON CONFLICT DO NOTHING;

INSERT INTO organization_settings (tenant_id, legal_name, display_name, timezone, currency)
SELECT t.id, t.name, t.name, t.timezone, t.currency
FROM tenants t
ON CONFLICT (tenant_id) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS default_workspace_id uuid;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_default_workspace_fk
    FOREIGN KEY (default_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE users u
SET default_workspace_id = w.id
FROM workspaces w
WHERE w.tenant_id = u.tenant_id AND w.is_default AND u.default_workspace_id IS NULL;

-- Existing users become members of their organisation's default workspace with the role they already had.
INSERT INTO workspace_members (tenant_id, workspace_id, user_id, employee_id, role, is_default)
SELECT u.tenant_id, w.id, u.id, u.employee_id, u.role, true
FROM users u
JOIN workspaces w ON w.tenant_id = u.tenant_id AND w.is_default
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_members m WHERE m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.workspace_id = w.id
)
ON CONFLICT DO NOTHING;

-- New administration permissions. The default matrix is re-seeded for existing tenants so admins can use the new screens.
INSERT INTO role_permissions (tenant_id, role, permission)
SELECT t.id, r.role, p.permission
FROM tenants t
CROSS JOIN (VALUES ('WFM_ADMIN'), ('WFM_MANAGER')) AS r(role)
CROSS JOIN (VALUES ('organization:read'), ('organization:write'), ('workspace:read'), ('workspace:create'), ('workspace:write'), ('workspace:members')) AS p(permission)
ON CONFLICT DO NOTHING;
