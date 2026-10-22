-- Three small, independent additions to an employee's profile: a preferred shift template (informational, pre-fills
-- the add-shift form), and a per-employee compliance rule-pack override (most specific scope, above team/group/tenant).

ALTER TABLE employees ADD COLUMN IF NOT EXISTS preferred_template_id uuid REFERENCES shift_templates(id) ON DELETE SET NULL;

ALTER TABLE compliance_assignments DROP CONSTRAINT IF EXISTS compliance_assignments_scope_type_check;
ALTER TABLE compliance_assignments ADD CONSTRAINT compliance_assignments_scope_type_check CHECK (scope_type IN ('TENANT', 'GROUP', 'TEAM', 'EMPLOYEE'));
