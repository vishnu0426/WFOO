-- How old the newest history may be before the Forecast Builder calls it out of date. A group that imports weekly sets this higher so it is not warned every day.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS history_stale_days integer NOT NULL DEFAULT 3 CHECK (history_stale_days BETWEEN 1 AND 60);
