-- Scheduled forecast refresh. For a group's short-term or long-term forecast: on a schedule (weekly or daily, at an hour in the group's own time zone) the platform checks that the data is fresh,
-- measures how the live forecast really did against what happened, builds a new DRAFT forecast from the latest history, compares it with the live one, and tells the people who approve forecasts.
-- It only ever creates a draft: a person reviews, submits and publishes it.
CREATE TABLE IF NOT EXISTS forecast_refresh_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id          uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  kind                  text NOT NULL CHECK (kind IN ('SHORT', 'LONG')),
  enabled               boolean NOT NULL DEFAULT false,
  frequency             text NOT NULL DEFAULT 'WEEKLY' CHECK (frequency IN ('DAILY', 'WEEKLY')),
  day_of_week           smallint NOT NULL DEFAULT 0 CHECK (day_of_week BETWEEN 0 AND 6),          -- Monday 0 ... Sunday 6, in the group's time zone
  hour                  smallint NOT NULL DEFAULT 6 CHECK (hour BETWEEN 0 AND 23),                  -- local hour of the group from which it may run
  horizon_weeks         int CHECK (horizon_weeks BETWEEN 1 AND 18),                                 -- short-term; null = the same length as the live forecast
  horizon_days          int CHECK (horizon_days BETWEEN 30 AND 730),                                -- long-term; null = the same length as the live forecast
  stale_after_days      int NOT NULL DEFAULT 3 CHECK (stale_after_days BETWEEN 1 AND 60),          -- skip (and say so) when the newest data is older than this
  archive_old_drafts    boolean NOT NULL DEFAULT true,                                              -- an earlier automatic draft nobody has touched is archived when a newer one is made
  last_run_day          date,                                                                       -- the group's local day of the last scheduled attempt, so it runs once per occasion
  last_run_at           timestamptz,
  updated_by            text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wfm_group_id, kind)
);

CREATE TABLE IF NOT EXISTS forecast_refresh_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settings_id   uuid NOT NULL REFERENCES forecast_refresh_settings(id) ON DELETE CASCADE,
  wfm_group_id  uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  trigger       text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL')),
  status        text NOT NULL CHECK (status IN ('RUNNING', 'CREATED', 'SKIPPED', 'FAILED')),
  reason        text NOT NULL DEFAULT '',
  version_id    uuid REFERENCES forecast_versions(id) ON DELETE SET NULL,
  report        jsonb NOT NULL DEFAULT '{}',
  started_by    text NOT NULL DEFAULT 'Auto-refresh',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS forecast_refresh_runs_by_settings ON forecast_refresh_runs (tenant_id, settings_id, started_at DESC);
-- one run at a time for one schedule, whichever gateway process starts it
CREATE UNIQUE INDEX IF NOT EXISTS forecast_refresh_runs_one_running ON forecast_refresh_runs (tenant_id, settings_id) WHERE status = 'RUNNING';
