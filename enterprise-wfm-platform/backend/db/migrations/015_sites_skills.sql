-- Multi-site and multi-skill.
-- A site is where people work (its own time zone and country). A WFM group belongs to at most one site.
-- A group can require skills: when it does, its pool is everyone who has every required skill at the required level, whatever group
-- they belong to, so cross-trained people serve several groups and can be scheduled by any of them.

CREATE TABLE IF NOT EXISTS sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  code       text NOT NULL,
  timezone   text NOT NULL DEFAULT 'UTC',
  country    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name), UNIQUE (tenant_id, code)
);

ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS group_skills (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id    uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  skill_id        uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  min_proficiency int NOT NULL DEFAULT 1 CHECK (min_proficiency BETWEEN 1 AND 5),
  PRIMARY KEY (wfm_group_id, skill_id)
);
