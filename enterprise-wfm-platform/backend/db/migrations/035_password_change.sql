-- Forced password change: a person given a temporary password (new account, administrator reset, bootstrap administrator)
-- must choose their own before they can use anything else. Existing people are not affected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
