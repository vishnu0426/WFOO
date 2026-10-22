-- A group's shrinkage as named, auditable parts (breaks, training, meetings, absence, ...) instead of one flat
-- number. When a group has categories, their percentages sum to the effective shrinkage used for staffing;
-- wfm_groups.shrinkage stays as the fallback for a group with no categories defined yet.
CREATE TABLE IF NOT EXISTS shrinkage_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  name         text NOT NULL,
  pct          numeric NOT NULL CHECK (pct >= 0 AND pct <= 90),
  sort         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wfm_group_id, name)
);
CREATE INDEX IF NOT EXISTS shrinkage_categories_group ON shrinkage_categories (tenant_id, wfm_group_id);
