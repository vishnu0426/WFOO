-- The schedule revision that was last published. A published schedule with rev above this has edits that are live but not re-checked.
ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS published_rev int;
UPDATE schedule_versions SET published_rev = rev WHERE status = 'PUBLISHED' AND published_rev IS NULL;
