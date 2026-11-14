-- Access limited to regions or sites. A user with no rows here sees the whole organisation (as before). A user with rows sees only the WFM groups at those sites (or in those regions),
-- and the people, schedules, forecasts and queues that belong to them. The database enforces it on every request (see applyRowLevelSecurity), not only the screens.
CREATE TABLE IF NOT EXISTS user_scopes (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  text NOT NULL CHECK (scope_type IN ('REGION', 'SITE')),
  scope_id    uuid NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS user_scopes_user ON user_scopes (tenant_id, user_id);
