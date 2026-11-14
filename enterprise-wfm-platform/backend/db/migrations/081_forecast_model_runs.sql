-- The model registry: one row for every model run behind a forecast version, so a forecast can be explained, audited and reproduced long after it was made.
-- It keeps what a reviewer needs to ask "what produced this number?": which model and which build of it, what data it learned from (a window and a fingerprint of the rows), how it was
-- configured, how it did when tested on days it had not seen, how its bands held up, and which special events were in force. The forecast figures themselves (P10, P50, P90 for every
-- interval) are in forecast_intervals under the same version.
CREATE TABLE IF NOT EXISTS forecast_model_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  forecast_version_id uuid NOT NULL REFERENCES forecast_versions(id) ON DELETE CASCADE,
  wfm_group_id     uuid REFERENCES wfm_groups(id) ON DELETE SET NULL,
  site_id          uuid REFERENCES sites(id) ON DELETE SET NULL,
  queue_id         uuid REFERENCES queues(id) ON DELETE SET NULL,          -- null: the group total
  channel          text,
  model_name       text NOT NULL,                                          -- the model that was used
  requested_model  text,                                                   -- what was asked for ('auto' lets the engine choose by backtest)
  model_version    text NOT NULL,                                          -- the model with a fingerprint of its configuration and of the libraries it ran on
  engine_version   text,
  library_versions jsonb NOT NULL DEFAULT '{}',
  training_start   date,
  training_end     date,
  training_rows    int,
  data_hash        text,                                                   -- SHA-256 of the history rows the model was given
  model_config     jsonb NOT NULL DEFAULT '{}',
  backtest         jsonb NOT NULL DEFAULT '[]',                            -- every candidate's walk-forward scores: WAPE, MASE, bias, MAE
  bands            jsonb NOT NULL DEFAULT '{}',                            -- how the P10-P90 band was made and how it held up on days it was not fitted to
  forecast_from    date,
  forecast_to      date,
  volume_p10       double precision,
  volume_p50       double precision,
  volume_p90       double precision,                                       -- totals over the whole forecast
  source_events    jsonb NOT NULL DEFAULT '[]',                            -- the special events in force: id, name, kind, dates, uplift, lead and lag
  events_hash      text,
  generated_by     text,
  generated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forecast_model_runs_version ON forecast_model_runs (tenant_id, forecast_version_id);
CREATE INDEX IF NOT EXISTS forecast_model_runs_queue ON forecast_model_runs (tenant_id, queue_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS forecast_model_runs_group ON forecast_model_runs (tenant_id, wfm_group_id, generated_at DESC);
