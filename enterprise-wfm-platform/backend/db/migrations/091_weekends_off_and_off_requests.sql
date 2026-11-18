-- Full weekends off each calendar month, and people's own requests for days off together.
--   employees.min_weekends_off_month        the fewest full weekends (the group's weekend days, all off) a person has in each calendar month. 0 = no rule.
--   scheduling_policy.min_weekends_off_month  the same for everyone, NULL = none. A labour-pack rule (MIN_WEEKENDS_OFF_MONTH) can also set it; the strictest applies.
--   off_requests  what a person asks for, decided like time off:
--     WEEKEND_OFF  the weekends that fall in these dates are off, together. Once approved the scheduler treats them as time off.
--     STANDING     "from now on, at least N days off together / N weekends off a month". Once approved it can only raise the person's own limits, never lower them.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS min_weekends_off_month int NOT NULL DEFAULT 0 CHECK (min_weekends_off_month BETWEEN 0 AND 4);
ALTER TABLE scheduling_policy ADD COLUMN IF NOT EXISTS min_weekends_off_month int CHECK (min_weekends_off_month BETWEEN 0 AND 4);

CREATE TABLE IF NOT EXISTS off_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('WEEKEND_OFF', 'STANDING')),
  start_day           date,                                   -- WEEKEND_OFF: the dates asked for
  end_day             date,
  min_days_together   int CHECK (min_days_together BETWEEN 1 AND 3),         -- STANDING: what is asked for (either or both)
  min_weekends_month  int CHECK (min_weekends_month BETWEEN 1 AND 4),
  status              text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  reason              text NOT NULL DEFAULT '',
  decided_by          text,
  decided_at          timestamptz,
  decision_note       text NOT NULL DEFAULT '',
  escalated_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'WEEKEND_OFF' AND start_day IS NOT NULL AND end_day IS NOT NULL AND end_day >= start_day)
      OR (kind = 'STANDING' AND (min_days_together IS NOT NULL OR min_weekends_month IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS off_requests_emp ON off_requests (tenant_id, employee_id, status);
CREATE INDEX IF NOT EXISTS off_requests_open ON off_requests (tenant_id, status) WHERE status = 'REQUESTED';
