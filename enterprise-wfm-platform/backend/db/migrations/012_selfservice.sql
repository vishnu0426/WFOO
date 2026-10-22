-- Employee self-service: an inbox, push tokens for the mobile app, the rules that let simple requests be approved automatically,
-- and shift swaps / giveaways between colleagues.

-- Everyone who is linked to an employee may use the self-service app; agents get nothing else (they must not read the whole schedule).
INSERT INTO role_permissions (tenant_id, role, permission)
  SELECT t.id, r.role, 'self:use' FROM tenants t CROSS JOIN (VALUES ('WFM_ADMIN'), ('WFM_MANAGER'), ('FORECAST_PLANNER'), ('SCHEDULER'), ('SUPERVISOR_RTA'), ('ANALYST'), ('AGENT')) AS r(role)
  ON CONFLICT DO NOTHING;
DELETE FROM role_permissions WHERE role = 'AGENT' AND permission = 'schedule:read';

CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,                          -- TIME_OFF, SWAP, SCHEDULE, OFFER, BID, INFO
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}',            -- what to open when tapped, for example {"screen":"swap","id":"..."}
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (tenant_id, user_id, id DESC);

CREATE TABLE IF NOT EXISTS push_tokens (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL,
  platform   text NOT NULL DEFAULT 'unknown',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token)
);
CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens (tenant_id, user_id);

-- One row per organisation: what can be approved without a manager, and how much cover may be given up.
CREATE TABLE IF NOT EXISTS self_service_policy (
  tenant_id                  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  time_off_auto_approve      boolean NOT NULL DEFAULT false,
  time_off_min_notice_days   int NOT NULL DEFAULT 7 CHECK (time_off_min_notice_days BETWEEN 0 AND 365),
  time_off_max_off_percent   int NOT NULL DEFAULT 20 CHECK (time_off_max_off_percent BETWEEN 0 AND 100),  -- share of a WFM group that may be off on one day
  entitlements               jsonb NOT NULL DEFAULT '{"VACATION": 18, "PERSONAL": 3, "SICK": 12}',        -- days a year per type; a type not listed has no balance
  agent_can_edit_availability boolean NOT NULL DEFAULT false,                                              -- false: agents can only add preferred hours
  swap_auto_approve          boolean NOT NULL DEFAULT false,
  swap_max_extra_gap_slots   int NOT NULL DEFAULT 0 CHECK (swap_max_extra_gap_slots >= 0),               -- 15-minute intervals of extra under-cover a swap may cause and still be automatic
  swap_min_notice_hours      int NOT NULL DEFAULT 24 CHECK (swap_min_notice_hours >= 0),
  swap_board_hours           int NOT NULL DEFAULT 72 CHECK (swap_board_hours >= 1),                       -- how long an offered shift stays on the board
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE time_off ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'MANAGER';        -- MANAGER or SELF
ALTER TABLE time_off ADD COLUMN IF NOT EXISTS auto_decided boolean NOT NULL DEFAULT false;
ALTER TABLE time_off ADD COLUMN IF NOT EXISTS decision_note text;

-- A shift trade. SWAP: two people exchange shifts. GIVEAWAY: a shift goes on the board and someone takes it.
CREATE TABLE IF NOT EXISTS shift_swaps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version_id         uuid NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('SWAP', 'GIVEAWAY')),
  requester_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  requester_shift_id uuid NOT NULL REFERENCES schedule_shifts(id) ON DELETE CASCADE,
  partner_id         uuid REFERENCES employees(id) ON DELETE CASCADE,
  partner_shift_id   uuid REFERENCES schedule_shifts(id) ON DELETE CASCADE,
  status             text NOT NULL CHECK (status IN ('OPEN', 'PENDING_PARTNER', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  note               text NOT NULL DEFAULT '',
  decision_reason    text,
  decided_by         text,
  decided_at         timestamptz,
  auto_approved      boolean NOT NULL DEFAULT false,
  checks             jsonb NOT NULL DEFAULT '{}',    -- what the rules said when it was last evaluated
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_swaps_status ON shift_swaps (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS shift_swaps_people ON shift_swaps (tenant_id, requester_id, partner_id);
