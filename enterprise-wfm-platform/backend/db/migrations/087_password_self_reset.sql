-- Signing-in help without an administrator: a person who forgot their password asks for a one-time code by email or SMS and chooses a new password.
--  channel_settings.password_reset  how the organisation allows it: OFF (ask an administrator, the default), EMAIL, SMS or EITHER (the person picks).
--  password_reset_codes             one row per code sent. Only a keyed hash of the code is kept, never the code. org_id, not tenant_id, like the other sender tables:
--                                   the code is looked up before anyone is signed in.
ALTER TABLE channel_settings ADD COLUMN IF NOT EXISTS password_reset text NOT NULL DEFAULT 'OFF' CHECK (password_reset IN ('OFF', 'EMAIL', 'SMS', 'EITHER'));

CREATE TABLE IF NOT EXISTS password_reset_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  code_hash   text NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_codes_user_idx ON password_reset_codes (user_id, created_at DESC);
