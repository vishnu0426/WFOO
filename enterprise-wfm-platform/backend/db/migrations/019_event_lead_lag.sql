-- A campaign's real-world effect rarely switches on and off at its exact dates: volume often builds in the days
-- before (announcements, pre-orders) and tails off after. lead_days/lag_days let the forecast ramp the uplift in
-- and out around the event's own date range instead of applying it as a hard on/off window.
ALTER TABLE special_events ADD COLUMN IF NOT EXISTS lead_days smallint NOT NULL DEFAULT 0 CHECK (lead_days >= 0 AND lead_days <= 60);
ALTER TABLE special_events ADD COLUMN IF NOT EXISTS lag_days  smallint NOT NULL DEFAULT 0 CHECK (lag_days >= 0 AND lag_days <= 60);
