-- Configuration: WFM groups (the queues that share one pool of agents) and queues.

CREATE TABLE IF NOT EXISTS wfm_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  code          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  timezone      text NOT NULL DEFAULT 'UTC',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  -- service targets used by every forecast, capacity plan and scenario for the group
  service_level numeric NOT NULL DEFAULT 0.8  CHECK (service_level > 0 AND service_level < 1),
  answer_sec    int     NOT NULL DEFAULT 20   CHECK (answer_sec > 0),
  shrinkage     numeric NOT NULL DEFAULT 0.3  CHECK (shrinkage >= 0 AND shrinkage <= 0.9),
  occupancy_cap numeric NOT NULL DEFAULT 0.85 CHECK (occupancy_cap > 0.3 AND occupancy_cap <= 1),
  method        text    NOT NULL DEFAULT 'erlang_c' CHECK (method IN ('erlang_c','erlang_a')),
  patience_sec  int     NOT NULL DEFAULT 120,
  blended       boolean NOT NULL DEFAULT false,      -- cross-skilled: voice + chat share one pool
  model         text    NOT NULL DEFAULT 'auto',
  fte_hours_week numeric NOT NULL DEFAULT 40,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS queues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id  uuid REFERENCES wfm_groups(id) ON DELETE SET NULL,
  name          text NOT NULL,
  code          text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('VOICE','CHAT','EMAIL','BACKOFFICE')),
  aht_default   int  NOT NULL DEFAULT 300 CHECK (aht_default > 0),
  concurrency   numeric NOT NULL DEFAULT 1 CHECK (concurrency >= 1),
  open_slot     int  NOT NULL DEFAULT 0  CHECK (open_slot BETWEEN 0 AND 96),   -- 15-minute slots; async work is spread over [open, close)
  close_slot    int  NOT NULL DEFAULT 96 CHECK (close_slot BETWEEN 0 AND 96),
  sla_target_seconds int NOT NULL DEFAULT 20,
  sla_target_percent int NOT NULL DEFAULT 80,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS queues_group ON queues (tenant_id, wfm_group_id);
