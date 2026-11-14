-- A saved Follow the Sun view also remembers how it was looked at: the zone the times were shown in, and whether it was the current or the next week.
ALTER TABLE sun_views
  ADD COLUMN IF NOT EXISTS display_tz  text NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS week_choice text CHECK (week_choice IN ('THIS', 'NEXT'));
