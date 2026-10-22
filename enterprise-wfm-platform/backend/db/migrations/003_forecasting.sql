-- Interval actuals and versioned forecasts. Forecasts are never overwritten: each is a numbered version with a lifecycle.

CREATE TABLE IF NOT EXISTS interval_history (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id    uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  day         date NOT NULL,            -- the queue's local calendar day
  slot        smallint NOT NULL CHECK (slot BETWEEN 0 AND 95),   -- 15-minute interval within that day
  starts_at   timestamptz NOT NULL,     -- the same instant in UTC (day + slot in the tenant's zone)
  volume      int NOT NULL CHECK (volume >= 0),
  aht_sec     int NOT NULL CHECK (aht_sec > 0),
  abandoned   int NOT NULL DEFAULT 0 CHECK (abandoned >= 0),
  source      text NOT NULL DEFAULT 'IMPORT',
  import_job_id uuid,
  PRIMARY KEY (queue_id, day, slot)
);
CREATE INDEX IF NOT EXISTS interval_history_tenant_day ON interval_history (tenant_id, day);

CREATE TABLE IF NOT EXISTS special_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id  uuid REFERENCES wfm_groups(id) ON DELETE CASCADE,   -- null = every group
  queue_id      uuid REFERENCES queues(id) ON DELETE CASCADE,       -- null = every queue in the group
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'campaign' CHECK (kind IN ('holiday','campaign','outage','other')),
  start_day     date NOT NULL,
  end_day       date NOT NULL CHECK (end_day >= start_day),
  uplift_pct    numeric NOT NULL DEFAULT 0     -- 0 = learn the effect from past events of the same kind
);
CREATE INDEX IF NOT EXISTS special_events_tenant ON special_events (tenant_id, start_day);

CREATE TABLE IF NOT EXISTS forecast_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id  uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  seq           int  NOT NULL,                       -- running number per group and kind: Short-term v1, v2, ...
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('SHORT','LONG')),
  type          text NOT NULL DEFAULT 'AI' CHECK (type IN ('AI','MANUAL','IMPORTED','ADJUSTED','INTRADAY')),
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PUBLISHED','ARCHIVED')),
  from_day      date NOT NULL,
  to_day        date NOT NULL,
  slots_per_day int  NOT NULL DEFAULT 96,
  model_req     text NOT NULL DEFAULT 'auto',
  parent_version_id uuid REFERENCES forecast_versions(id) ON DELETE SET NULL,
  rev           int  NOT NULL DEFAULT 0,             -- bumped by every adjustment; part of cache keys
  summary       jsonb NOT NULL DEFAULT '{}',         -- per-queue model leaderboard, backtest, notes
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_by  text, submitted_by_id uuid, submitted_at timestamptz,
  approved_by   text, approved_at  timestamptz,
  published_by  text, published_at timestamptz,
  UNIQUE (wfm_group_id, kind, seq)
);
CREATE INDEX IF NOT EXISTS forecast_versions_group ON forecast_versions (tenant_id, wfm_group_id, kind, seq DESC);

CREATE TABLE IF NOT EXISTS forecast_intervals (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_id  uuid NOT NULL REFERENCES forecast_versions(id) ON DELETE CASCADE,
  queue_id    uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  day         date NOT NULL,
  slot        smallint NOT NULL,                     -- -1 = the whole day (used by long-term versions and day bands)
  volume      real NOT NULL,
  aht_sec     real NOT NULL,
  p10         real NOT NULL,                         -- likely range: low
  p90         real NOT NULL,                         -- likely range: high
  manual      real,                                  -- planner adjustment (replaces volume when set)
  PRIMARY KEY (version_id, queue_id, day, slot)
);
CREATE INDEX IF NOT EXISTS forecast_intervals_tenant ON forecast_intervals (tenant_id, version_id, day);

CREATE TABLE IF NOT EXISTS forecast_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_id  uuid NOT NULL REFERENCES forecast_versions(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  params      jsonb NOT NULL DEFAULT '{}',           -- volumePct, ahtPct, serviceLevel, answerSec, shrinkage, occupancyCap, method, blended
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forecast_scenarios_version ON forecast_scenarios (tenant_id, version_id);
