-- Workforce: teams, skills, employees, availability and time off.

CREATE TABLE IF NOT EXISTS teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,
  description text NOT NULL DEFAULT '',
  location    text NOT NULL DEFAULT '',
  manager_id  uuid,                                   -- an employee; foreign key added below (employees does not exist yet)
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name), UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,
  category    text NOT NULL DEFAULT 'PRODUCTS' CHECK (category IN ('CHANNELS','LANGUAGES','PRODUCTS','TIERS')),
  type        text NOT NULL DEFAULT 'CORE' CHECK (type IN ('CORE','SECONDARY','SPECIALTY')),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  requires_certification boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, name), UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_number text NOT NULL,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  email           text,
  phone           text NOT NULL DEFAULT '',
  timezone        text,                                -- blank = the organisation timezone
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ONBOARDING','ACTIVE','LEAVE','SUSPENDED','TERMINATED')),
  hire_date       date,
  team_id         uuid REFERENCES teams(id) ON DELETE SET NULL,
  location        text NOT NULL DEFAULT '',
  employment_type text NOT NULL DEFAULT 'FULL_TIME' CHECK (employment_type IN ('FULL_TIME','PART_TIME','CONTRACTOR','TEMPORARY')),
  -- contract and rules the scheduler must respect
  weekly_contract_hours numeric NOT NULL DEFAULT 40 CHECK (weekly_contract_hours >= 0),
  max_weekly_hours      numeric NOT NULL DEFAULT 40 CHECK (max_weekly_hours > 0),
  work_days_per_week    int     NOT NULL DEFAULT 5 CHECK (work_days_per_week BETWEEN 1 AND 7),
  min_rest_hours        numeric NOT NULL DEFAULT 11 CHECK (min_rest_hours >= 0),
  max_consecutive_days  int     NOT NULL DEFAULT 6 CHECK (max_consecutive_days BETWEEN 1 AND 14),
  allow_weekend         boolean NOT NULL DEFAULT true,
  allow_overnight       boolean NOT NULL DEFAULT false,
  -- who they can be scheduled for
  primary_group_id      uuid REFERENCES wfm_groups(id) ON DELETE SET NULL,
  eligible_group_ids    uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, employee_number)
);
CREATE INDEX IF NOT EXISTS employees_team ON employees (tenant_id, team_id);
CREATE INDEX IF NOT EXISTS employees_group ON employees (tenant_id, primary_group_id);
DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT teams_manager_fk FOREIGN KEY (manager_id) REFERENCES employees(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS employee_skills (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  proficiency int  NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  PRIMARY KEY (employee_id, skill_id)
);

-- Weekly availability. With no rows a person is available whenever a shift template allows.
-- AVAILABLE rows narrow the day to those windows; UNAVAILABLE rows remove a window; PREFERRED rows are a soft wish.
CREATE TABLE IF NOT EXISTS availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day_of_week int  NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- Monday = 0
  start_slot  int  NOT NULL CHECK (start_slot BETWEEN 0 AND 95),
  end_slot    int  NOT NULL CHECK (end_slot BETWEEN 1 AND 96),
  kind        text NOT NULL CHECK (kind IN ('AVAILABLE','UNAVAILABLE','PREFERRED')),
  effective_from date,
  effective_to   date,
  CHECK (end_slot > start_slot)
);
CREATE INDEX IF NOT EXISTS availability_emp ON availability (tenant_id, employee_id);

CREATE TABLE IF NOT EXISTS time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type        text NOT NULL DEFAULT 'VACATION' CHECK (type IN ('VACATION','SICK','PERSONAL','HOLIDAY','TRAINING','LEAVE','OTHER')),
  start_day   date NOT NULL,
  end_day     date NOT NULL,
  status      text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','CANCELLED')),
  reason      text NOT NULL DEFAULT '',
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_day >= start_day)
);
CREATE INDEX IF NOT EXISTS time_off_emp ON time_off (tenant_id, employee_id, start_day);
