-- Schedule generation without a forecast: an admin sets staffing directly as a few recurring weekly coverage windows
-- (day of week, start/end time, headcount) instead of a volume forecast. Expanded into the same per-15-minute-slot
-- headcount array the solver already consumes (see requirementForManual() in scheduleRoutes.ts), so nothing
-- downstream of that array (candidate building, the solver, coverage %, validation) needs to know which source it came from.

CREATE TABLE IF NOT EXISTS coverage_windows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid NOT NULL REFERENCES wfm_groups(id) ON DELETE CASCADE,
  day_of_week  int NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_slot   int NOT NULL CHECK (start_slot >= 0 AND start_slot < 96),
  end_slot     int NOT NULL CHECK (end_slot > start_slot AND end_slot <= 96),
  headcount    int NOT NULL CHECK (headcount >= 0 AND headcount <= 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coverage_windows_group ON coverage_windows (tenant_id, wfm_group_id);

-- Recorded on the version itself: forecast_version_id is already null for ROTATION-kind versions and gets silently
-- auto-filled with whichever forecast is published when omitted at generation, so it isn't a safe signal to branch on.
ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS coverage_source text NOT NULL DEFAULT 'FORECAST' CHECK (coverage_source IN ('FORECAST', 'MANUAL'));
