-- Two gaps named after comparing rotation patterns with UKG/SAP-tier products:
--  1. Holiday awareness: a pattern can now skip generating a work shift on a day marked as a holiday
--     (the same special_events used by forecasting), with an off switch for crews that do work holidays.
--  2. Effective-dated crew membership: a person can join or leave a crew on a specific date, and materializing
--     (or just saving membership) reconciles the already-generated future to match, without touching the past.

ALTER TABLE rotation_patterns ADD COLUMN IF NOT EXISTS observes_holidays boolean NOT NULL DEFAULT true;

ALTER TABLE rotation_members ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE rotation_members ADD COLUMN IF NOT EXISTS effective_to date;
ALTER TABLE rotation_members DROP CONSTRAINT IF EXISTS rotation_members_effective_check;
ALTER TABLE rotation_members ADD CONSTRAINT rotation_members_effective_check CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);
