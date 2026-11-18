-- A colour a planner can give a shift template, so shifts of that template are told apart on the Schedule Timeline.
-- Display only: nothing in scheduling rules, the solver, payroll or real-time adherence reads it. NULL keeps the organisation-wide shift colour.
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS color text CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$');
