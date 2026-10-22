-- Two additions:
--  1. Rotating rosters (4-on-4-off, DuPont, Pitman, ...): a fixed repeating cycle assigned once and projected forward
--     indefinitely, for shift work scheduled by pattern rather than matched to a forecast each period (manufacturing,
--     security, healthcare, warehouse crews). A pattern is one crew's repeating sequence of shift templates (or days
--     off); other crews are the same sequence offset in time. Materialising a pattern writes ordinary rows into
--     schedule_versions/schedule_shifts (kind = 'ROTATION', source = 'ROTATION') so every existing screen -- the
--     timeline, publish, RTA adherence, multi-site rollup, audit -- already understands it.
--  2. Time & attendance: punches (clock in/out), independent of RTA agent-state, rolled into a payroll export.

ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'DEMAND';
ALTER TABLE schedule_versions DROP CONSTRAINT IF EXISTS schedule_versions_kind_check;
ALTER TABLE schedule_versions ADD CONSTRAINT schedule_versions_kind_check CHECK (kind IN ('DEMAND', 'ROTATION'));

ALTER TABLE schedule_shifts DROP CONSTRAINT IF EXISTS schedule_shifts_source_check;
ALTER TABLE schedule_shifts ADD CONSTRAINT schedule_shifts_source_check CHECK (source IN ('SOLVER', 'MANUAL', 'ROTATION'));

CREATE TABLE IF NOT EXISTS rotation_patterns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  name         text NOT NULL,
  cycle_days   smallint NOT NULL CHECK (cycle_days BETWEEN 2 AND 84),
  sequence     jsonb NOT NULL,                                    -- one crew's cycle: [templateId | null, ...], length = cycle_days
  crews        jsonb NOT NULL DEFAULT '[{"name":"Crew A","offsetDays":0}]',  -- other crews: the same sequence, offset by offsetDays
  anchor_date  date NOT NULL,                                     -- the date that is day 0 of the cycle
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version_id   uuid REFERENCES schedule_versions(id) ON DELETE SET NULL,   -- the evergreen ROTATION version its shifts live in
  materialized_through date,                                       -- shifts exist up to (and including) this date
  version      int NOT NULL DEFAULT 1,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wfm_group_id, name)
);

CREATE TABLE IF NOT EXISTS rotation_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pattern_id  uuid NOT NULL REFERENCES rotation_patterns(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  crew_name   text NOT NULL,
  UNIQUE (tenant_id, pattern_id, employee_id)
);
CREATE INDEX IF NOT EXISTS rotation_members_pattern ON rotation_members (tenant_id, pattern_id);

CREATE TABLE IF NOT EXISTS attendance_punches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day         date NOT NULL,
  clock_in    timestamptz NOT NULL,
  clock_out   timestamptz,
  source      text NOT NULL DEFAULT 'IMPORT' CHECK (source IN ('IMPORT', 'MANUAL')),
  note        text NOT NULL DEFAULT '',
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, day, clock_in),
  CHECK (clock_out IS NULL OR clock_out > clock_in)
);
CREATE INDEX IF NOT EXISTS attendance_punches_day ON attendance_punches (tenant_id, day);
