-- What to do with each event type a connector sends. New event types are recorded as PENDING the first time they arrive,
-- so nothing needs a code change: someone sets each one to a state, or to SKIP.
CREATE TABLE IF NOT EXISTS integration_event_rules (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id  uuid NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  action        text NOT NULL DEFAULT 'PENDING' CHECK (action IN ('PENDING', 'STATE', 'SKIP')),
  state         text,
  reason        text,
  seen_count    int NOT NULL DEFAULT 0,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, event_type)
);
