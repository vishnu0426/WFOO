-- Scheduled reports can be sent as a PDF as well as (or instead of) a CSV, with the organisation's logo on the first line.
--   tenants.logo            the logo as a data URL (PNG or JPEG, kept small), shown on PDF reports
--   report_schedules.format CSV, PDF or BOTH (payroll reports stay CSV: the payroll file is a data export, not something to read)
--   report_runs.pdf         the PDF of a run, as base64
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo text;
ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'CSV' CHECK (format IN ('CSV', 'PDF', 'BOTH'));
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS pdf text;
