-- Follow the Sun: named selections of WFM groups ("Global support", "Americas") that anyone in the organisation can reopen with one click.
CREATE TABLE IF NOT EXISTS sun_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  group_ids   uuid[] NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sun_views_name ON sun_views (tenant_id, lower(name));
