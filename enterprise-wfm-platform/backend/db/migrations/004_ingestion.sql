-- Staged ingestion (Rule 7: a file never mutates live data directly).
-- Upload -> parse/validate -> diff -> quality audit -> atomic commit -> optional rollback.

CREATE TABLE IF NOT EXISTS import_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  data_type       text NOT NULL,                     -- HISTORICAL_VOLUME | HISTORICAL_AHT | ACTUALS (interval data); others in later phases
  source_type     text NOT NULL DEFAULT 'CSV',
  file_name       text NOT NULL,
  file_size_kb    int  NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'PREPARING' CHECK (status IN
                    ('PREPARING','UPLOADING','MAPPING','VALIDATING','READY','IMPORTING','COMPLETED','COMPLETED_WITH_WARNINGS','FAILED','ROLLED_BACK')),
  total_records   int NOT NULL DEFAULT 0,
  valid_records   int NOT NULL DEFAULT 0,
  warning_records int NOT NULL DEFAULT 0,
  error_records   int NOT NULL DEFAULT 0,
  created_records int NOT NULL DEFAULT 0,
  updated_records int NOT NULL DEFAULT 0,
  skipped_records int NOT NULL DEFAULT 0,
  options         jsonb NOT NULL DEFAULT '{}',
  summary         jsonb NOT NULL DEFAULT '{}',       -- column mapping, diff, quality audit
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  can_rollback    boolean NOT NULL DEFAULT false,
  is_rolled_back  boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS import_jobs_tenant ON import_jobs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS import_rows (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id      uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  line        int  NOT NULL,                         -- line number in the uploaded file
  row_status  text NOT NULL CHECK (row_status IN ('VALID','WARNING','ERROR')),
  message     text,
  queue_id    uuid,
  day         date,
  slot        smallint,
  volume      int,
  aht_sec     int,
  abandoned   int,
  action      text CHECK (action IN ('NEW','UPDATE','UNCHANGED')),   -- filled by the diff stage
  -- what the live row looked like before commit, so a rollback can restore it exactly
  was_new       boolean,
  prev_volume   int,
  prev_aht_sec  int,
  prev_abandoned int
);
CREATE INDEX IF NOT EXISTS import_rows_job ON import_rows (job_id, row_status);
CREATE INDEX IF NOT EXISTS import_rows_key ON import_rows (job_id, queue_id, day, slot);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id        uuid REFERENCES import_jobs(id) ON DELETE CASCADE,
  severity      text NOT NULL CHECK (severity IN ('ERROR','WARNING','INFO')),
  category      text NOT NULL,
  entity_id     text NOT NULL,
  entity_name   text NOT NULL,
  issue         text NOT NULL,
  impact        text NOT NULL,
  remediation   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dq_tenant ON data_quality_issues (tenant_id, created_at DESC);
