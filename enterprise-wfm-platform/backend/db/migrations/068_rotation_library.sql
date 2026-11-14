-- Rotation patterns, completed:
--  rotation_templates          a library of the organisation's own pattern shapes (a shape is letters, not shift templates: "A" and "B" are pointed at real templates when applied),
--                              shared by every WFM group of the workspace.
--  rotation_patterns           remember which library entry or ready-made preset a pattern was made from (so the library can show where it is used), and the date the
--                              current definition took effect.
--  rotation_pattern_revisions  every earlier definition of a pattern with the dates it was in force. A change made "from a date" keeps what happened before that date as it was.
-- A country's labour-law pack is suggested by its country template and assigned to a new organisation when it is created.

CREATE TABLE IF NOT EXISTS rotation_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  category    text NOT NULL DEFAULT 'CUSTOM',
  summary     text NOT NULL DEFAULT '',
  kind        text NOT NULL CHECK (kind IN ('DAY_CYCLE', 'WEEKLY')),
  shape       jsonb NOT NULL DEFAULT '[]',     -- DAY_CYCLE: one entry per cycle day, a letter or null for a day off
  steps       jsonb,                           -- WEEKLY: [{ name, weeks, letter }]
  letters     jsonb NOT NULL DEFAULT '[]',     -- [{ letter, label }]
  crews       jsonb NOT NULL DEFAULT '[]',     -- DAY_CYCLE: [{ name, offsetDays }]; WEEKLY: [{ name, offsetWeeks }]
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rotation_templates_name ON rotation_templates (tenant_id, lower(name));

ALTER TABLE rotation_patterns
  ADD COLUMN IF NOT EXISTS template_ref   text,
  ADD COLUMN IF NOT EXISTS effective_from date;

CREATE TABLE IF NOT EXISTS rotation_pattern_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pattern_id        uuid NOT NULL REFERENCES rotation_patterns(id) ON DELETE CASCADE,
  version           int NOT NULL,
  effective_from    date,                       -- null: from the start
  effective_to      date NOT NULL,              -- the last day this definition applied
  name              text NOT NULL,
  kind              text NOT NULL,
  cycle_days        smallint NOT NULL,
  sequence          jsonb NOT NULL,
  steps             jsonb,
  crews             jsonb NOT NULL,
  anchor_date       date NOT NULL,
  observes_holidays boolean NOT NULL DEFAULT true,
  changed_by        text,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  note              text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS rotation_pattern_revisions_pattern ON rotation_pattern_revisions (pattern_id, effective_to DESC);

ALTER TABLE wfm.country_templates ADD COLUMN IF NOT EXISTS compliance_pack text;     -- code of a built-in labour-law pack
UPDATE wfm.country_templates SET compliance_pack = 'IN_OSH_2020' WHERE code = 'IN' AND compliance_pack IS NULL;
UPDATE wfm.country_templates SET compliance_pack = 'EU_WTD' WHERE code IN ('DE', 'FR', 'ES', 'IE', 'NL', 'IT') AND compliance_pack IS NULL;
