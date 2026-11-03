-- Real-time adherence for large groups.

-- Indexes for how people are looked up. "Who is in this group" is `primary_group_id = g OR g = ANY(eligible_group_ids)` all over the product; an OR with an
-- ANY() cannot use an index, so those queries are now written `eligible_group_ids @> ARRAY[g]` (the primary group is always inside the eligible list) and this GIN
-- index serves them. The other two serve the status filter and "who has this skill".
CREATE INDEX IF NOT EXISTS employees_eligible_groups ON employees USING gin (eligible_group_ids);
CREATE INDEX IF NOT EXISTS employees_status ON employees (tenant_id, status);
CREATE INDEX IF NOT EXISTS employee_skills_skill ON employee_skills (skill_id);
-- Agent events only ever grow; old ones are pruned by time (see ADHERENCE_EVENT_RETENTION_DAYS). A BRIN index on the time is tiny and makes that prune cheap.
CREATE INDEX IF NOT EXISTS agent_state_events_at_brin ON agent_state_events USING brin (at);

-- One row per person per finished day: how much of the scheduled time they spent in adherence. History reports read this instead of re-judging a day.
CREATE TABLE IF NOT EXISTS adherence_daily (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id  uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  day           date NOT NULL,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  team          text,
  scheduled_min int  NOT NULL,
  adherent_min  int  NOT NULL,
  PRIMARY KEY (wfm_group_id, day, employee_id)
);
-- Which days have been judged and kept (a day nobody was scheduled on has no rows in adherence_daily, and must not be judged again every time).
CREATE TABLE IF NOT EXISTS adherence_days (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  day          date NOT NULL,
  built_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wfm_group_id, day)
);
CREATE INDEX IF NOT EXISTS adherence_daily_day ON adherence_daily (tenant_id, wfm_group_id, day);
CREATE INDEX IF NOT EXISTS adherence_daily_employee ON adherence_daily (employee_id, day);

-- When a supervisor is told that someone has been out of adherence for too long.
CREATE TABLE IF NOT EXISTS adherence_settings (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  alert_after_min int NOT NULL DEFAULT 10 CHECK (alert_after_min BETWEEN 1 AND 240),
  enabled         boolean NOT NULL DEFAULT true,
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One alert per person per stretch out of adherence: `since` is when the state they are stuck in began, so a person who stays out is not told about again.
CREATE TABLE IF NOT EXISTS adherence_alerts (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day         date NOT NULL,
  since       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, day, since)
);
CREATE INDEX IF NOT EXISTS adherence_alerts_age ON adherence_alerts (tenant_id, created_at);

-- A person's own saved filter sets for a screen ("my night team, out of adherence").
CREATE TABLE IF NOT EXISTS saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  screen     text NOT NULL,
  name       text NOT NULL,
  filters    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, screen, name)
);
