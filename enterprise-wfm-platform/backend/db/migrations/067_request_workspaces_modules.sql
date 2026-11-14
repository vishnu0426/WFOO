-- Customer requests for more sites and workspaces, and for modules they do not have yet. (Employee, user and plan requests already exist.)
-- A module request names the modules in requested_modules; the others ask for a number more of something.

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'wfm.license_capacity_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%resource_type%'
  LOOP
    EXECUTE format('ALTER TABLE wfm.license_capacity_requests DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE wfm.license_capacity_requests
  ADD CONSTRAINT license_requests_resource_type_check CHECK (resource_type IN ('EMPLOYEES', 'USERS', 'SITES', 'WORKSPACES', 'MODULES', 'PLAN'));

ALTER TABLE wfm.license_capacity_requests
  ADD COLUMN IF NOT EXISTS requested_modules text[] NOT NULL DEFAULT '{}';

-- One waiting request of each kind per customer: it keeps a customer from filling the queue, and makes "waiting" mean something.
CREATE UNIQUE INDEX IF NOT EXISTS license_requests_one_pending_per_kind ON wfm.license_capacity_requests (tenant_id, resource_type) WHERE status = 'PENDING';
