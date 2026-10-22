-- Separate from last_received_at (a message arrived) and last_error (something went wrong): this is set the moment
-- a STREAM_SUBSCRIBE connector's NATS subscription actually opens, so "connected, nothing has arrived yet" is
-- visibly different from "never even connected" -- today both looked identical (all three fields null).
ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS connected_at timestamptz;
