-- Long schedules (up to 52 weeks) are built in the background, window by window, and published a window at a time.
--
--  schedule_jobs     a durable work queue. Any gateway instance can claim a job (FOR UPDATE SKIP LOCKED); a job that stops heartbeating is
--                    put back in the queue, so a restart or a crash loses nothing. The owner column is org_id, not tenant_id, on purpose:
--                    the worker has to see every organisation's queue, which row-level security (keyed on tenant_id) would hide. Every API
--                    read filters on org_id.
--  publish_through   a schedule can be published up to a date. Shifts after it stay planned: not shown to staff, not used for adherence,
--                    and open to being re-solved on a newer forecast. NULL = the whole schedule is published, as before.
--  source PATTERN    shifts repeated from a solved cycle for weeks that are not solved yet (the rotation-line part of a long plan).

ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS publish_through date;

ALTER TABLE schedule_shifts DROP CONSTRAINT IF EXISTS schedule_shifts_source_check;
ALTER TABLE schedule_shifts ADD CONSTRAINT schedule_shifts_source_check CHECK (source IN ('SOLVER', 'MANUAL', 'ROTATION', 'PATTERN'));

CREATE TABLE IF NOT EXISTS schedule_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id     uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('PLAN', 'RESOLVE')),
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED')),
  params           jsonb NOT NULL,                        -- the request body, as validated when the job was created
  actor            jsonb NOT NULL,                        -- who asked: {userId, name, role, tenantId}
  progress         jsonb NOT NULL DEFAULT '{}',           -- {done, total, note, etaSec, windows: [...]}
  version_id       uuid REFERENCES schedule_versions(id) ON DELETE SET NULL,   -- the schedule being built / the result
  error            text,
  cancel_requested boolean NOT NULL DEFAULT false,
  attempts         int NOT NULL DEFAULT 0,
  worker           text,
  heartbeat_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS schedule_jobs_queue ON schedule_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS schedule_jobs_org ON schedule_jobs (org_id, created_at DESC);
