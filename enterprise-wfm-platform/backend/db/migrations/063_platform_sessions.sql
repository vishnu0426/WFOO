-- Super Admin account settings: a display name, password-change tracking, and a record of each sign-in so
-- sessions can be listed and revoked. Tokens issued before this migration have no row here and stay valid
-- until they expire; a session row with revoked_at set is refused.

ALTER TABLE wfm.platform_admins
  ADD COLUMN IF NOT EXISTS display_name        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_login_at       timestamptz;

CREATE TABLE IF NOT EXISTS wfm.platform_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES wfm.platform_admins(id) ON DELETE CASCADE,
  jti          text NOT NULL UNIQUE,
  ip_address   text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS platform_sessions_admin_idx ON wfm.platform_sessions (admin_id, created_at DESC);
