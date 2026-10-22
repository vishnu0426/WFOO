-- Voluntary time off (VTO) and overtime offers. A manager (or the forecast) opens an offer for a window of a day; eligible people are
-- invited in the order the organisation chose; the first valid acceptances fill it and the published schedule changes.

CREATE TABLE IF NOT EXISTS offer_policy (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  vto_ordering       text NOT NULL DEFAULT 'ROUND_ROBIN'  CHECK (vto_ordering IN ('SENIORITY', 'FIRST_COME', 'FEWEST_HOURS', 'MOST_HOURS', 'ROUND_ROBIN', 'RANDOM')),
  overtime_ordering  text NOT NULL DEFAULT 'FEWEST_HOURS' CHECK (overtime_ordering IN ('SENIORITY', 'FIRST_COME', 'FEWEST_HOURS', 'MOST_HOURS', 'ROUND_ROBIN', 'RANDOM')),
  reverse_seniority  boolean NOT NULL DEFAULT false,      -- seniority ordering: least senior first
  wave_size          int NOT NULL DEFAULT 0 CHECK (wave_size BETWEEN 0 AND 500),   -- 0 = invite everyone at once
  wave_minutes       int NOT NULL DEFAULT 10 CHECK (wave_minutes BETWEEN 1 AND 1440),
  offer_minutes      int NOT NULL DEFAULT 120 CHECK (offer_minutes BETWEEN 5 AND 10080),  -- how long an offer stays open
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS offers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id    uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  version_id      uuid NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('VTO', 'OVERTIME')),
  day             date NOT NULL,
  start_slot      int NOT NULL CHECK (start_slot BETWEEN 0 AND 95),
  end_slot        int NOT NULL CHECK (end_slot BETWEEN 1 AND 96),
  spots           int NOT NULL CHECK (spots BETWEEN 1 AND 500),
  filled          int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FILLED', 'EXPIRED', 'CANCELLED')),
  note            text NOT NULL DEFAULT '',
  ordering        text NOT NULL,
  wave_size       int NOT NULL DEFAULT 0,
  wave_minutes    int NOT NULL DEFAULT 10,
  wave            int NOT NULL DEFAULT 0,               -- the last wave that was invited
  wave_started_at timestamptz,
  closes_at       timestamptz NOT NULL,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_slot > start_slot)
);
CREATE INDEX IF NOT EXISTS offers_open ON offers (tenant_id, status, day);

CREATE TABLE IF NOT EXISTS offer_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_id     uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rank         int NOT NULL,
  wave         int NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'INVITED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SKIPPED')),
  warnings     jsonb NOT NULL DEFAULT '[]',
  note         text,
  invited_at   timestamptz,
  responded_at timestamptz,
  UNIQUE (offer_id, employee_id)
);
CREATE INDEX IF NOT EXISTS offer_invites_emp ON offer_invites (tenant_id, employee_id, status);
