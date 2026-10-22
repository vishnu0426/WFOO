-- Configuration: activity definitions and the company-wide scheduling policy (rules + default optimisation weights).

CREATE TABLE IF NOT EXISTS activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,
  short_code  text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'OTHER' CHECK (category IN ('WORK','BREAK','MEAL','TRAINING','MEETING','COACHING','ABSENCE','OTHER')),
  counts_as_work boolean NOT NULL DEFAULT false,   -- time spent on this is time available for queue work
  paid        boolean NOT NULL DEFAULT true,
  shrinkage   boolean NOT NULL DEFAULT false,      -- counted as shrinkage when planning
  color       text NOT NULL DEFAULT '#8AA4C8',
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name), UNIQUE (tenant_id, code)
);

-- One row per tenant. A null limit means "no company-wide limit": each employee's own contract still applies.
CREATE TABLE IF NOT EXISTS scheduling_policy (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  min_rest_hours       numeric CHECK (min_rest_hours BETWEEN 0 AND 24),
  max_weekly_hours     numeric CHECK (max_weekly_hours BETWEEN 1 AND 100),
  max_consecutive_days int     CHECK (max_consecutive_days BETWEEN 1 AND 14),
  max_days_per_week    int     CHECK (max_days_per_week BETWEEN 1 AND 7),
  weights              jsonb NOT NULL DEFAULT '{"understaffing":90,"overstaffing":30,"contractHours":50,"preferences":20,"fairness":30}',
  updated_by           text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
