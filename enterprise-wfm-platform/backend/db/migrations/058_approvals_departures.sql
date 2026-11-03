-- Who approves first, cover while someone is away, who reports to whom, and people leaving.
-- Policy: a team's supervisor (or deputy, or whoever covers) decides their team's time off and swaps first; a request nobody has decided within
-- escalate_hours is flagged to the managers. limit_supervisors_to_teams (off until a business turns it on) keeps a Supervisor to their own teams' people.
ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS supervisor_first boolean NOT NULL DEFAULT true;
ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS escalate_hours int NOT NULL DEFAULT 24 CHECK (escalate_hours BETWEEN 1 AND 720);
ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS limit_supervisors_to_teams boolean NOT NULL DEFAULT false;
ALTER TABLE time_off ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE time_off ADD COLUMN IF NOT EXISTS decided_level text CHECK (decided_level IN ('SUPERVISOR', 'MANAGER'));
ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS decided_level text CHECK (decided_level IN ('SUPERVISOR', 'MANAGER'));

-- cover: someone takes over a supervisor's teams (approvals and "my teams") between two dates
CREATE TABLE IF NOT EXISTS approval_cover (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  to_employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  note             text NOT NULL DEFAULT '',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  cancelled_by     text,
  CHECK (ends_on >= starts_on),
  CHECK (from_employee_id <> to_employee_id)
);
CREATE INDEX IF NOT EXISTS approval_cover_to ON approval_cover (tenant_id, to_employee_id, starts_on, ends_on) WHERE cancelled_at IS NULL;

-- reporting lines and leaving
ALTER TABLE employees ADD COLUMN IF NOT EXISTS reports_to uuid REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_date date;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS termination_reason text;
CREATE INDEX IF NOT EXISTS employees_reports_to ON employees (tenant_id, reports_to);

-- tenants that already exist: managers and supervisors may decide their own team's requests
INSERT INTO role_permissions (tenant_id, role, permission)
  SELECT DISTINCT tenant_id, r.role, 'requests:approve' FROM role_permissions CROSS JOIN (VALUES ('WFM_ADMIN'), ('WFM_MANAGER'), ('SUPERVISOR_RTA')) AS r(role)
  ON CONFLICT DO NOTHING;
