-- Forecast self-learning: what the models learned from their own misses, and a log of every time they looked.

-- Per group switch. When on, learned weekday corrections are applied to new forecasts and drift creates a draft reforecast.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS auto_learn boolean NOT NULL DEFAULT true;

-- A multiplier per queue and weekday (0 = Monday), learned from how published forecasts compared with what really arrived.
CREATE TABLE IF NOT EXISTS forecast_feedback (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  queue_id     uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  dow          smallint NOT NULL CHECK (dow BETWEEN 0 AND 6),
  factor       numeric(6,4) NOT NULL CHECK (factor > 0),
  samples      int NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, dow)
);
CREATE INDEX IF NOT EXISTS forecast_feedback_group ON forecast_feedback (tenant_id, wfm_group_id);

CREATE TABLE IF NOT EXISTS learning_runs (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  trigger      text NOT NULL,                       -- DATA (new actuals arrived), MANUAL
  days         int NOT NULL DEFAULT 0,              -- days that had both a published forecast and real volume
  wape         numeric(7,4),
  bias         numeric(7,4),
  drift        boolean NOT NULL DEFAULT false,
  action       text NOT NULL,                       -- NONE, CORRECTIONS_UPDATED, DRAFT_CREATED
  version_id   uuid REFERENCES forecast_versions(id) ON DELETE SET NULL,
  note         text
);
CREATE INDEX IF NOT EXISTS learning_runs_group ON learning_runs (tenant_id, wfm_group_id, at DESC);
