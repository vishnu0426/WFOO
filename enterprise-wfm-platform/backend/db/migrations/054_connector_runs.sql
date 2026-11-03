-- Connector runs and schedules. Every time a connector delivers or is polled (a push to /live, /backfill or /webhook, a scheduled pull, a file pick-up, or
-- someone pressing "Run now") one row is written here, so the Data Feeds page can show a run history instead of only "last received".
CREATE TABLE IF NOT EXISTS integration_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id  uuid NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  trigger       text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL', 'PUSH')),
  kind          text NOT NULL CHECK (kind IN ('PULL', 'FILE', 'LIVE', 'BACKFILL', 'WEBHOOK')),
  status        text NOT NULL CHECK (status IN ('OK', 'PARTIAL', 'FAILED')),
  rows_in       int NOT NULL DEFAULT 0,
  rows_ok       int NOT NULL DEFAULT 0,
  rows_rejected int NOT NULL DEFAULT 0,
  message       text
);
CREATE INDEX IF NOT EXISTS integration_runs_recent ON integration_runs (connector_id, started_at DESC);

-- How often the server itself polls the source (API pull, SFTP folder). NULL = not scheduled (the source pushes to us, or it is run by hand).
ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS schedule_min int CHECK (schedule_min IS NULL OR schedule_min BETWEEN 5 AND 1440);
ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS next_run_at timestamptz;

-- Files already picked up from a connector's SFTP folder, so the same file is never staged twice (a changed size or time counts as a new file).
CREATE TABLE IF NOT EXISTS integration_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id  uuid NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  file_name     text NOT NULL,
  file_size     bigint NOT NULL,
  file_mtime    timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('STAGED', 'NEEDS_ATTENTION')),
  import_job_id uuid,
  message       text,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, file_name, file_size, file_mtime)
);
