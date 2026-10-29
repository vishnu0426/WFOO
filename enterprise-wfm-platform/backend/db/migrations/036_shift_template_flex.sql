-- Shift templates: variable length, meal and break rules by length, a start window per weekday, who a template is offered to, and the dates it is in force.
-- A template with none of these set behaves exactly as before.
ALTER TABLE shift_templates
  ADD COLUMN IF NOT EXISTS min_length_slots smallint CHECK (min_length_slots IS NULL OR min_length_slots BETWEEN 4 AND 56),   -- shortest shift offered; NULL = fixed at length_slots
  ADD COLUMN IF NOT EXISTS length_step      smallint NOT NULL DEFAULT 2 CHECK (length_step BETWEEN 1 AND 16),                 -- gap between offered lengths (2 = 30 minutes)
  ADD COLUMN IF NOT EXISTS day_windows      jsonb,                    -- {"4": {"earliest": 20, "latest": 24}}: a different start window on that weekday (Monday = 0)
  ADD COLUMN IF NOT EXISTS length_rules     jsonb,                    -- [{"fromSlots": 20, "mealSlots": 2, "breakCount": 1, "breakSlots": 1}]: meal and breaks by shift length
  ADD COLUMN IF NOT EXISTS meal_paid        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS group_ids        uuid[],                   -- NULL or empty = offered to every group
  ADD COLUMN IF NOT EXISTS employment_types text[],                   -- NULL or empty = every contract type
  ADD COLUMN IF NOT EXISTS skill_ids        uuid[],                   -- NULL or empty = no skill needed; otherwise any one of them
  ADD COLUMN IF NOT EXISTS effective_from   date,
  ADD COLUMN IF NOT EXISTS effective_to     date;
