-- Labour-law compliance packs: named sets of rules (max hours, rest, breaks, night work, notice...) that can be assigned to the
-- whole organisation, a WFM group or a team. Nothing is hard-coded: a pack is data an administrator can copy and edit.

CREATE TABLE IF NOT EXISTS compliance_packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  region      text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  rules       jsonb NOT NULL DEFAULT '[]',          -- [{ id, type, severity: BLOCK|WARN, params: {...} }]
  built_in    boolean NOT NULL DEFAULT false,       -- shipped with the product: copy it to change it
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Which pack applies where. The most specific wins: team, then WFM group, then the whole organisation.
CREATE TABLE IF NOT EXISTS compliance_assignments (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('TENANT', 'GROUP', 'TEAM')),
  scope_id   uuid,                                  -- null for TENANT
  scope_key  text NOT NULL,                         -- 'tenant' or the scope_id, so the key is never null
  pack_id    uuid NOT NULL REFERENCES compliance_packs(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_key)
);

-- Some rules (for example night work) depend on the person having agreed to it.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS night_shift_consent boolean NOT NULL DEFAULT false;
