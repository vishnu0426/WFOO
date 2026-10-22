-- Shift bidding. A round offers weekly patterns (a shift template starting at a set time on set days) with a capacity each.
-- People rank the patterns while the round is open; when it closes an allocation (seniority, lottery or balanced) decides who gets
-- what, and awarding it builds a draft schedule from the winning patterns for the manager to review and publish.

CREATE TABLE IF NOT EXISTS bid_rounds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id     uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED', 'AWARDED', 'CANCELLED')),
  method           text NOT NULL DEFAULT 'SENIORITY' CHECK (method IN ('SENIORITY', 'LOTTERY', 'BALANCED')),
  period_start     date NOT NULL,                        -- a Monday
  weeks            int NOT NULL DEFAULT 4 CHECK (weeks BETWEEN 1 AND 26),
  fill_unranked    boolean NOT NULL DEFAULT true,        -- give people who ranked too few patterns something that is left
  closes_at        timestamptz,
  seed             text NOT NULL DEFAULT '',
  awarded_version_id uuid REFERENCES schedule_versions(id) ON DELETE SET NULL,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bid_rounds_group ON bid_rounds (tenant_id, wfm_group_id, status);

CREATE TABLE IF NOT EXISTS bid_patterns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  round_id    uuid NOT NULL REFERENCES bid_rounds(id) ON DELETE CASCADE,
  name        text NOT NULL,
  template_id uuid NOT NULL REFERENCES shift_templates(id) ON DELETE RESTRICT,
  start_slot  int NOT NULL CHECK (start_slot BETWEEN 0 AND 95),
  work_days   int[] NOT NULL,                            -- Monday = 0
  capacity    int NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  position    int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bid_patterns_round ON bid_patterns (tenant_id, round_id, position);

CREATE TABLE IF NOT EXISTS bid_entries (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  round_id    uuid NOT NULL REFERENCES bid_rounds(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pattern_id  uuid NOT NULL REFERENCES bid_patterns(id) ON DELETE CASCADE,
  rank        int NOT NULL CHECK (rank >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, employee_id, pattern_id)
);

CREATE TABLE IF NOT EXISTS bid_awards (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  round_id    uuid NOT NULL REFERENCES bid_rounds(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pattern_id  uuid REFERENCES bid_patterns(id) ON DELETE SET NULL,
  rank        int,
  PRIMARY KEY (round_id, employee_id)
);
