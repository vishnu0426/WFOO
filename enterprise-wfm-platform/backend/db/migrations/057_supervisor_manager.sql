-- Supervisors and managers.
-- A person is marked as a supervisor or a manager on their employee record: that only says they may be chosen for the job. It gives no access; access
-- comes from the role on their login. A team has a supervisor (teams.manager_id, as before) and a deputy; a WFM group has a manager.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_supervisor boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_manager boolean NOT NULL DEFAULT false;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS deputy_id uuid REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES employees(id) ON DELETE SET NULL;
-- team leads chosen before this existed were picked from everyone: mark them, so nothing already set up is refused
UPDATE employees SET is_supervisor = true WHERE id IN (SELECT manager_id FROM teams WHERE manager_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS employees_supervisor ON employees (tenant_id) WHERE is_supervisor;
CREATE INDEX IF NOT EXISTS employees_manager ON employees (tenant_id) WHERE is_manager;
