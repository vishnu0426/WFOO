-- A split shift: two parts of the day with an unpaid gap between them (the gap is stored as the template's unpaid meal, up to six hours long).
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS split_shift boolean NOT NULL DEFAULT false;
-- the meal column also holds a split shift's gap, which can be longer than a meal
ALTER TABLE shift_templates DROP CONSTRAINT IF EXISTS shift_templates_meal_slots_check;
ALTER TABLE shift_templates ADD CONSTRAINT shift_templates_meal_slots_check CHECK (meal_slots BETWEEN 0 AND 24);
