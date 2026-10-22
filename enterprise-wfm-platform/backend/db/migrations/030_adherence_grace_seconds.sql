-- Adherence now judges every second instead of every minute, so the grace window can be set in seconds.
ALTER TABLE scheduling_policy ADD COLUMN IF NOT EXISTS adherence_grace_seconds int;
UPDATE scheduling_policy SET adherence_grace_seconds = adherence_grace_minutes * 60 WHERE adherence_grace_seconds IS NULL;
ALTER TABLE scheduling_policy ALTER COLUMN adherence_grace_seconds SET DEFAULT 300;
ALTER TABLE scheduling_policy ALTER COLUMN adherence_grace_seconds SET NOT NULL;
ALTER TABLE scheduling_policy ADD CONSTRAINT scheduling_policy_grace_seconds_range CHECK (adherence_grace_seconds BETWEEN 0 AND 3600);
ALTER TABLE scheduling_policy DROP COLUMN adherence_grace_minutes;
