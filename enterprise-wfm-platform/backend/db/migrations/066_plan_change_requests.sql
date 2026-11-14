-- A customer's administrator can ask to move to another plan (Licence & Subscription). The request joins the existing capacity requests: a Super Admin approves
-- it (the plan's limits and modules are applied) or rejects it with a note the customer can read.

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'wfm.license_capacity_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%resource_type%'
  LOOP
    EXECUTE format('ALTER TABLE wfm.license_capacity_requests DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE wfm.license_capacity_requests
  ADD CONSTRAINT license_requests_resource_type_check CHECK (resource_type IN ('EMPLOYEES', 'USERS', 'SITES', 'MODULES', 'PLAN'));

ALTER TABLE wfm.license_capacity_requests
  ADD COLUMN IF NOT EXISTS requested_plan text,                          -- the plan code asked for (resource_type PLAN)
  ADD COLUMN IF NOT EXISTS decision_note  text NOT NULL DEFAULT '';      -- the Super Admin's note on approving or rejecting
