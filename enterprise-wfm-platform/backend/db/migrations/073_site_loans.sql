-- Loans between sites: a person keeps their home group (and so their home site) and is lent to a group at another site for dates, with a reason.
-- While the loan runs the scheduler treats the person as part of the borrowing group's pool, and keeps them off their home group's schedule; outside the dates nothing changes.
CREATE TABLE IF NOT EXISTS site_loans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  home_group_id  uuid REFERENCES wfm_groups(id) ON DELETE SET NULL,     -- the person's primary group when the loan was made
  to_group_id    uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  start_day      date NOT NULL,
  end_day        date NOT NULL,                                          -- the last day at the borrowing group
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  ended_by       text,
  ended_at       timestamptz,
  CHECK (end_day >= start_day)
);
CREATE INDEX IF NOT EXISTS site_loans_employee ON site_loans (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS site_loans_to_group ON site_loans (tenant_id, to_group_id, start_day, end_day);
CREATE INDEX IF NOT EXISTS site_loans_home_group ON site_loans (tenant_id, home_group_id, start_day, end_day);
