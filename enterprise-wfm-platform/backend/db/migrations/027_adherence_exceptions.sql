-- A supervisor's explanation for a stretch of out-of-adherence time (coaching, a system issue, a meeting...). Recorded
-- against the person and the day, in that person's local minutes, so the timeline can show the stretch as covered.
-- excused = the explanation is accepted and the time is not held against the person's adherence; a note alone is not an excuse.
CREATE TABLE IF NOT EXISTS adherence_exceptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day          date NOT NULL,
  from_minute  int NOT NULL CHECK (from_minute >= 0 AND from_minute < 1440),
  to_minute    int NOT NULL CHECK (to_minute > from_minute AND to_minute <= 1440),
  category     text NOT NULL CHECK (category IN ('COACHING', 'TRAINING', 'SYSTEM_ISSUE', 'MEETING', 'OTHER')),
  note         text NOT NULL,
  excused      boolean NOT NULL DEFAULT false,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adherence_exceptions_day ON adherence_exceptions (tenant_id, day, employee_id);
