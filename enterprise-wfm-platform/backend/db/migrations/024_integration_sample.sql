-- The last raw payload a connector received (any ingest path: NATS stream, webhook, or a manual test POST),
-- kept independently of last_error so the drag-and-drop field mapper always has something real to build from,
-- even once the mapping is fixed and errors stop.
ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS last_sample jsonb;
