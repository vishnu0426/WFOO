-- A scheduled connector can run at a set time of day and on chosen weekdays, not only every N minutes.
--   schedule_min : minutes between runs (1440 for a daily run), as before
--   schedule_at  : "HH:MM" in the organisation's time zone; set = one run a day at that time
--   schedule_days: ISO weekdays the connector may run on (1 = Monday ... 7 = Sunday); NULL = every day
ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS schedule_at text CHECK (schedule_at IS NULL OR schedule_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS schedule_days smallint[] CHECK (schedule_days IS NULL OR (cardinality(schedule_days) BETWEEN 1 AND 7 AND schedule_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]));
