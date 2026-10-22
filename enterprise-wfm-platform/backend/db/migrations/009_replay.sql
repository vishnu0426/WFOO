-- One row per change to a schedule version (generated, manually edited, published) with the numbers as they stood right after it.
-- Schedule Replay steps through these; the audit ledger keeps the who/why, this keeps the measured result.
CREATE TABLE IF NOT EXISTS schedule_revisions (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_id  uuid NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  n           int NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_name  text NOT NULL,
  actor_role  text NOT NULL,
  kind        text NOT NULL,                 -- GENERATE, EDIT, PUBLISH
  summary     text NOT NULL,
  reason      text,
  coverage    numeric(5,1),
  under_slots int,
  overtime_h  numeric(7,1),
  paid_h      numeric(8,1),
  shifts      int,
  people      int,
  violations  int,
  UNIQUE (version_id, n)
);
CREATE INDEX IF NOT EXISTS schedule_revisions_version ON schedule_revisions (tenant_id, version_id, n);
