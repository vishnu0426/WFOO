-- How a shift that runs over a daylight-saving change is paid when the hours come from the schedule (punched hours are real elapsed time already).
--   SCHEDULED: the hours the shift was scheduled for (the default, what was always paid).
--   WORKED:    the hours really elapsed: an hour less when the clocks go forward, an hour more when they go back.
ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS dst_pay text NOT NULL DEFAULT 'SCHEDULED' CHECK (dst_pay IN ('SCHEDULED', 'WORKED'));
