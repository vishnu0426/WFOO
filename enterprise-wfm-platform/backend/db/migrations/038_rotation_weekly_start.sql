-- Rotation patterns: a second kind, "weekly templates" (a list of weekly shift templates, each worked for some weeks, then the next), and a
-- starting position for each person.
--   kind = 'DAY_CYCLE' is what existed before. kind = 'WEEKLY' stores its steps here and ALSO the day cycle they unroll to in sequence / cycle_days,
--   so generating shifts is the same code for both. Day 0 of a weekly cycle is the first day of a pay week.
--   start_cycle_day: the day of the cycle (0 = the first) a person is on when they join (their effective_from date, else the anchor date). NULL = they
--   follow their crew's offset, as before.
ALTER TABLE rotation_patterns ADD COLUMN IF NOT EXISTS kind  text NOT NULL DEFAULT 'DAY_CYCLE';
ALTER TABLE rotation_patterns DROP CONSTRAINT IF EXISTS rotation_patterns_kind_check;
ALTER TABLE rotation_patterns ADD CONSTRAINT rotation_patterns_kind_check CHECK (kind IN ('DAY_CYCLE', 'WEEKLY'));
ALTER TABLE rotation_patterns ADD COLUMN IF NOT EXISTS steps jsonb;     -- WEEKLY: [{"name": "Days", "weeks": 2, "days": [templateId | null x 7]}]
ALTER TABLE rotation_members  ADD COLUMN IF NOT EXISTS start_cycle_day smallint CHECK (start_cycle_day IS NULL OR start_cycle_day >= 0);
