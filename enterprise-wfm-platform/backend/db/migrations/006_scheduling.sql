-- Scheduling: shift templates, schedule versions and the shifts inside them.

CREATE TABLE IF NOT EXISTS shift_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  work_days   int[] NOT NULL DEFAULT '{0,1,2,3,4}',            -- Monday = 0
  earliest_start smallint NOT NULL CHECK (earliest_start BETWEEN 0 AND 95),   -- 15-minute slots of the day
  latest_start   smallint NOT NULL CHECK (latest_start BETWEEN 0 AND 95),
  start_step     smallint NOT NULL DEFAULT 2 CHECK (start_step BETWEEN 1 AND 16),   -- how often a start time is offered (2 = every 30 min)
  length_slots   smallint NOT NULL CHECK (length_slots BETWEEN 4 AND 56),           -- whole shift, meal included
  meal_slots     smallint NOT NULL DEFAULT 2 CHECK (meal_slots BETWEEN 0 AND 8),    -- unpaid meal
  break_count    smallint NOT NULL DEFAULT 2 CHECK (break_count BETWEEN 0 AND 4),
  break_slots    smallint NOT NULL DEFAULT 1 CHECK (break_slots BETWEEN 1 AND 4),   -- paid breaks
  flex_slots     smallint NOT NULL DEFAULT 2 CHECK (flex_slots BETWEEN 0 AND 8),    -- how far a meal or break may move to smooth coverage
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name), UNIQUE (tenant_id, code),
  CHECK (latest_start >= earliest_start)
);

CREATE TABLE IF NOT EXISTS schedule_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  seq         int  NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  forecast_version_id uuid REFERENCES forecast_versions(id) ON DELETE SET NULL,
  settings    jsonb NOT NULL DEFAULT '{}',        -- weights, time limit, template ids
  stats       jsonb NOT NULL DEFAULT '{}',        -- solver result and coverage summary
  rev         int  NOT NULL DEFAULT 0,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  published_by text, published_at timestamptz,
  UNIQUE (wfm_group_id, seq)
);
CREATE INDEX IF NOT EXISTS schedule_versions_group ON schedule_versions (tenant_id, wfm_group_id, seq DESC);

CREATE TABLE IF NOT EXISTS schedule_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_id  uuid NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day         date NOT NULL,
  template_id uuid REFERENCES shift_templates(id) ON DELETE SET NULL,
  start_slot  smallint NOT NULL CHECK (start_slot BETWEEN 0 AND 95),
  length_slots smallint NOT NULL CHECK (length_slots BETWEEN 1 AND 96),
  activities  jsonb NOT NULL DEFAULT '[]',        -- [{type:'MEAL'|'BREAK', startSlot, slots}]  startSlot counts from the day midnight
  source      text NOT NULL DEFAULT 'SOLVER' CHECK (source IN ('SOLVER','MANUAL')),
  UNIQUE (version_id, employee_id, day)
);
CREATE INDEX IF NOT EXISTS schedule_shifts_day ON schedule_shifts (tenant_id, version_id, day);
CREATE INDEX IF NOT EXISTS schedule_shifts_emp ON schedule_shifts (tenant_id, employee_id, day);
