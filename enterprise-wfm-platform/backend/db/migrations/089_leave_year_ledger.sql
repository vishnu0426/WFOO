-- Leave balances become a record, not an estimate.
--   leave_year_balances  one row per person, leave type and year, written when the year is closed: what they were entitled to, what came in from the year before,
--                        what was adjusted by hand, what they used, what lapsed, and what carries into the next year. The next year starts from carried_out.
--   leave_adjustments    days added or taken off by hand (a grant, a correction, a payout), each with who did it and why.
--   carry_expiry         per leave type, "MM-DD": days carried in from last year must be used by this date or they lapse (empty = they never lapse).
-- Before a year is closed the balance still works the old way (last year's unused days, estimated), and says so.
ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS carry_expiry jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS leave_year_balances (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         text NOT NULL,
  year         int  NOT NULL,
  entitled     numeric(7,2) NOT NULL DEFAULT 0,
  carried_in   numeric(7,2) NOT NULL DEFAULT 0,
  adjusted     numeric(7,2) NOT NULL DEFAULT 0,
  used         numeric(7,2) NOT NULL DEFAULT 0,
  expired      numeric(7,2) NOT NULL DEFAULT 0,      -- carried-in days that were not used by the carry expiry date
  lapsed       numeric(7,2) NOT NULL DEFAULT 0,      -- unused days above the carry-over limit, lost at year end
  carried_out  numeric(7,2) NOT NULL DEFAULT 0,      -- what the next year starts with
  closed_at    timestamptz NOT NULL DEFAULT now(),
  closed_by    text NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, type, year)
);
CREATE INDEX IF NOT EXISTS leave_year_balances_year ON leave_year_balances (tenant_id, year);

CREATE TABLE IF NOT EXISTS leave_adjustments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         text NOT NULL,
  year         int  NOT NULL,
  days         numeric(7,2) NOT NULL CHECK (days <> 0),      -- positive adds days, negative takes them off
  kind         text NOT NULL CHECK (kind IN ('GRANT', 'DEDUCT', 'PAYOUT', 'CORRECTION')),
  reason       text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leave_adjustments_person ON leave_adjustments (tenant_id, employee_id, year);
