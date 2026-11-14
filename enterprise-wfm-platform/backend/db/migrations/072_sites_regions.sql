-- Sites, completed as a level of the organisation:
--  regions   a level above sites (EMEA, APAC...), so reports and, later, access can be set for a whole region.
--  sites     get a region, an address, and a status: a site that closes is marked CLOSED and keeps its history instead of being deleted. A closed site no longer counts against the plan.
CREATE TABLE IF NOT EXISTS regions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS regions_name ON regions (tenant_id, lower(name));

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS region_id uuid REFERENCES regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS address   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  ADD COLUMN IF NOT EXISTS closed_on date;
