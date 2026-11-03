-- Direct interval feed health. Every message that arrives on POST /data/ingest or the NATS subject leaves one receipt: when, how many rows,
-- how many were kept and why the rest were turned away. The feed screen reads this to show "last received", "rejected today" and a late flag.
-- Receipts are kept for 30 days (pruned as new ones arrive); the rows themselves live in interval_history as before.
CREATE TABLE IF NOT EXISTS feed_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  received_at   timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL CHECK (source IN ('API', 'NATS')),
  rows_received int NOT NULL,
  rows_accepted int NOT NULL,
  rows_rejected int NOT NULL,
  errors        jsonb NOT NULL DEFAULT '[]'     -- first 50 rejected rows: [{index, queue, message}]
);
CREATE INDEX IF NOT EXISTS feed_receipts_recent ON feed_receipts (tenant_id, received_at DESC);

-- How long without data before the direct feed (and each connector) counts as late.
CREATE TABLE IF NOT EXISTS feed_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  late_after_min int NOT NULL DEFAULT 30 CHECK (late_after_min BETWEEN 5 AND 1440),
  updated_by     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
