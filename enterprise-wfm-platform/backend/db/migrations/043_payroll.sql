-- Payroll export: a pay period is turned into pay codes (regular, overtime, night, weekend, holiday, each kind of paid leave), checked, approved and exported.
--
--  payroll_settings  one row per organisation: the code for each kind of hour, when night starts and ends, when overtime starts, whether premium hours stack on
--                    top of regular pay or replace it, how hours are rounded, and whether hours come from clock punches, from the schedule, or punches where there are some.
--  payroll_runs      one row per pay period run: a frozen copy of what was worked out (lines per person and code, a daily breakdown, warnings), and its state:
--                    DRAFT can be recalculated, APPROVED is locked (no other approved run may overlap it for the same people), EXPORTED has been handed to payroll.
CREATE TABLE IF NOT EXISTS payroll_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  pay_codes            jsonb NOT NULL DEFAULT '{"REGULAR":"REG","OVERTIME":"OT","NIGHT":"NIGHT","WEEKEND":"WKND","HOLIDAY":"HOL","VACATION":"VAC","SICK":"SICK","PERSONAL":"PERS","HOLIDAY_LEAVE":"HOLPAID","TRAINING":"TRN","LEAVE":"LEAVE","OTHER":"OTHER"}',
  paid_leave           text[] NOT NULL DEFAULT ARRAY['VACATION','SICK','HOLIDAY','PERSONAL','TRAINING'],
  night_from           text NOT NULL DEFAULT '22:00',
  night_to             text NOT NULL DEFAULT '06:00',
  daily_overtime_after numeric CHECK (daily_overtime_after IS NULL OR daily_overtime_after > 0),     -- hours in a day; NULL = no daily overtime
  weekly_overtime_after numeric CHECK (weekly_overtime_after IS NULL OR weekly_overtime_after > 0),  -- hours in a pay week; NULL = the person's contract hours
  stacking             text NOT NULL DEFAULT 'EXCLUSIVE' CHECK (stacking IN ('EXCLUSIVE', 'STACKED')),
  rounding             text NOT NULL DEFAULT 'NONE' CHECK (rounding IN ('NONE', 'TENTH', 'QUARTER')),
  hours_source         text NOT NULL DEFAULT 'ACTUAL_ELSE_SCHEDULED' CHECK (hours_source IN ('ACTUAL', 'SCHEDULED', 'ACTUAL_ELSE_SCHEDULED')),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id  uuid REFERENCES wfm_groups(id) ON DELETE SET NULL,       -- NULL = everyone
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'EXPORTED')),
  settings      jsonb NOT NULL,
  lines         jsonb NOT NULL DEFAULT '[]',
  daily         jsonb NOT NULL DEFAULT '[]',
  warnings      jsonb NOT NULL DEFAULT '[]',
  totals        jsonb NOT NULL DEFAULT '{}',
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   text,
  approved_at   timestamptz,
  approval_note text,
  exported_at   timestamptz,
  exported_by   text
);
CREATE INDEX IF NOT EXISTS payroll_runs_period ON payroll_runs (tenant_id, period_start, period_end);
