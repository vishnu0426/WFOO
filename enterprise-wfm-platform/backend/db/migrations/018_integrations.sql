-- Integration Station: real, vendor-specific connectors for pulling ACD/CRM/HRMS/database data into forecasting and
-- RTA, built as a small set of generic delivery methods (API pull, stream subscribe, webhook, on-prem/database
-- relay, file/SFTP) with each named vendor a preset -- a name plus its real parameter set -- rather than one-off
-- code per vendor. See run.md / the Integration Station screen for the researched per-vendor field sets.
--
-- Known limitation, stated plainly rather than glossed over: connector credentials sit in `config` as tenant-scoped,
-- RLS-protected JSON, the same protection every other row in this schema has -- there is no separate secrets vault
-- here. A production deployment handling real customer ACD/CRM/HRMS credentials at scale would want one.

CREATE TABLE IF NOT EXISTS integration_connectors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid REFERENCES wfm_groups(id) ON DELETE CASCADE,   -- null = tenant-wide (an HRMS or CRM connector)
  category     text NOT NULL CHECK (category IN ('ACD', 'CRM', 'HRMS', 'DATABASE', 'ONPREM', 'SFTP')),
  method       text NOT NULL CHECK (method IN ('API_PULL', 'STREAM_SUBSCRIBE', 'WEBHOOK', 'ONPREM_RELAY', 'DATABASE', 'FILE_SFTP')),
  preset       text NOT NULL,                     -- e.g. GENESYS_CLOUD, AMAZON_CONNECT, WORKDAY, GENERIC_API
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'PAUSED', 'ERROR')),
  config       jsonb NOT NULL DEFAULT '{}',        -- preset-specific real fields; see the limitation note above
  api_key_hash text,                                -- relay-family (on-prem/database/SFTP) bearer auth, bcrypt like a login password
  webhook_secret text,                              -- HMAC signing secret for WEBHOOK connectors (must be reversible to verify a signature, unlike a login password)
  last_received_at timestamptz,
  last_error   text,
  backfill_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (backfill_status IN ('NOT_STARTED', 'IN_PROGRESS', 'DONE')),
  backfill_through date,
  watermark    text,                                -- live/incremental cursor: a DB watermark column value, an API pull cursor, etc.
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS integration_connectors_group ON integration_connectors (tenant_id, wfm_group_id);

-- Field mapping: how a raw vendor payload's fields translate to ours (volume, ahtSec, state, reason, ...),
-- pre-filled with a default per `preset` in application code, editable per connector.
CREATE TABLE IF NOT EXISTS integration_field_maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  target_field text NOT NULL,
  source_path  text NOT NULL,                       -- dotted path into the vendor payload, e.g. 'data.stats.nOffered'
  transform    text,                                 -- e.g. 'ms_to_s' (null = none)
  UNIQUE (connector_id, target_field)
);

-- Entity mapping: the part that cannot be guessed -- the vendor's own queue/employee/skill identifiers matched to
-- ours. Populated by the one-time matching step in the Integration Station UI.
CREATE TABLE IF NOT EXISTS integration_entity_maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES integration_connectors(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('queue', 'employee', 'skill')),
  source_id    text NOT NULL,
  source_label text NOT NULL DEFAULT '',
  target_id    uuid,
  UNIQUE (connector_id, entity_type, source_id)
);
CREATE INDEX IF NOT EXISTS integration_entity_maps_connector ON integration_entity_maps (tenant_id, connector_id);
