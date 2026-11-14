-- Attendance exceptions. A manager can excuse a missed punch, a late arrival, an early leave or an open punch for one person on one day, with a reason; the day then stops counting as a
-- problem and shows who excused it and why. `paid` records whether the scheduled hours are to be paid for an excused missed day.
CREATE TABLE IF NOT EXISTS attendance_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day           date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('missed', 'late', 'early', 'open')),
  reason_code   text NOT NULL CHECK (reason_code IN ('APPROVED_ABSENCE', 'CLOCK_FAULT', 'SYSTEM_OUTAGE', 'WORKED_ELSEWHERE', 'MANAGER_OVERRIDE', 'OTHER')),
  note          text NOT NULL DEFAULT '',
  paid          boolean NOT NULL DEFAULT false,
  level         text NOT NULL DEFAULT 'MANAGER' CHECK (level IN ('SUPERVISOR', 'MANAGER')),
  excused_by    text NOT NULL,
  excused_by_id uuid,
  excused_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_id, day, kind)
);
CREATE INDEX IF NOT EXISTS attendance_exceptions_day ON attendance_exceptions (tenant_id, day);

-- One digest of unexcused exceptions per group per day goes to the people who look after those teams; this remembers which have been sent so a restart does not send them again.
CREATE TABLE IF NOT EXISTS attendance_digest_log (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  day          date NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  exceptions   int NOT NULL DEFAULT 0,
  notified     int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, wfm_group_id, day)
);
