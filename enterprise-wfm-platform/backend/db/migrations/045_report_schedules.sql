-- Scheduled reports: a report (roster, coverage, attendance, payroll preview, time off) run on a timetable and sent as a CSV by email, with every run kept to download.
--   report_schedules  what to run, for which WFM group, over which dates (a named range such as LAST_WEEK, worked out on the day it runs), how often, and who gets it.
--   report_runs       one row per run with the file it produced.
-- org_id, not tenant_id, for the same reason as the job queue: the timer that runs reports works across organisations (see 041).
CREATE TABLE IF NOT EXISTS report_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  report        text NOT NULL CHECK (report IN ('ROSTER', 'COVERAGE', 'ATTENDANCE', 'PAYROLL_PREVIEW', 'TIME_OFF')),
  wfm_group_id  uuid REFERENCES wfm_groups(id) ON DELETE CASCADE,
  range_name    text NOT NULL,
  frequency     text NOT NULL CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  day_of_week   int CHECK (day_of_week BETWEEN 0 AND 6),            -- Monday = 0
  day_of_month  int CHECK (day_of_month BETWEEN 1 AND 31),
  hour          int NOT NULL CHECK (hour BETWEEN 0 AND 23),
  timezone      text NOT NULL DEFAULT 'UTC',
  recipients    jsonb NOT NULL DEFAULT '{"emails":[],"roles":[]}',
  enabled       boolean NOT NULL DEFAULT true,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  created_by    text,
  created_actor jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_schedules_due ON report_schedules (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS report_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id  uuid REFERENCES report_schedules(id) ON DELETE CASCADE,
  report       text NOT NULL,
  period_start date,
  period_end   date,
  status       text NOT NULL CHECK (status IN ('OK', 'FAILED')),
  row_count    int NOT NULL DEFAULT 0,
  error        text,
  file         text,
  sent_to      int NOT NULL DEFAULT 0,
  ran_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_runs_schedule ON report_runs (schedule_id, ran_at DESC);
