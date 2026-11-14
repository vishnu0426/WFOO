-- Platform-level settings (mail server, public addresses, operator security) and two-factor sign-in for Super Admins.
-- Secrets inside a setting (for example the mail password) are stored encrypted by the application, never in clear text.

CREATE TABLE IF NOT EXISTS wfm.platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wfm.platform_admins
  ADD COLUMN IF NOT EXISTS totp_secret_enc  text,                       -- encrypted authenticator secret (pending until totp_enabled)
  ADD COLUMN IF NOT EXISTS totp_enabled     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS totp_enabled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_codes   jsonb NOT NULL DEFAULT '[]'; -- SHA-256 hashes of unused one-time recovery codes
