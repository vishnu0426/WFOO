-- Per-group activity settings, RTA state mapping, agent state events and the adherence grace period.

-- The company list in `activities` is shared; a group may switch an activity off or change its shrinkage / paid treatment for itself.
CREATE TABLE IF NOT EXISTS group_activities (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  activity_id  uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT true,
  shrinkage    boolean,          -- null = use the company setting
  paid         boolean,          -- null = use the company setting
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wfm_group_id, activity_id)
);

-- An activity can be left out of adherence (for example "Off queue admin" that supervisors do not police).
ALTER TABLE activities ADD COLUMN IF NOT EXISTS ignore_adherence boolean NOT NULL DEFAULT false;

-- Maps what the phone/ACD system reports (state + optional reason code) to an activity, as WFM products do.
-- activity_id null = "not working" (logged out / unavailable), which is in adherence when nothing is scheduled.
CREATE TABLE IF NOT EXISTS rta_state_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state       text NOT NULL,
  reason      text NOT NULL DEFAULT '',          -- '' = any reason code
  activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rta_state_map_key ON rta_state_map (tenant_id, lower(state), lower(reason));

CREATE TABLE IF NOT EXISTS agent_state_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  state       text NOT NULL,
  reason      text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_state_events_emp ON agent_state_events (tenant_id, employee_id, at DESC);
CREATE INDEX IF NOT EXISTS agent_state_events_time ON agent_state_events (tenant_id, at DESC);

ALTER TABLE scheduling_policy ADD COLUMN IF NOT EXISTS adherence_grace_minutes int NOT NULL DEFAULT 5 CHECK (adherence_grace_minutes BETWEEN 0 AND 60);
