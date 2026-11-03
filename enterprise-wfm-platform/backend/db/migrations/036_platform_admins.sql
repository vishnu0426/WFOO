-- Platform / Super Admin accounts.
-- Platform admins manage organisations, their workspaces, and initial organisation admins.
-- This table has NO tenant_id and is strictly exempt from tenant row-level security.

CREATE TABLE IF NOT EXISTS wfm.platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_admins_email_idx ON wfm.platform_admins (lower(email));
