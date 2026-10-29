-- Global Platform Audit Trail & Emergency Credential Security.
-- Tracks super admin sign-ins, tenant provisioning, workspace lifecycle, and credential reset events.
-- Exempt from tenant RLS so Super Admins have unified governance across all organizations.

CREATE TABLE IF NOT EXISTS wfm.platform_audit_log (
  id                  bigserial PRIMARY KEY,
  at                  timestamptz NOT NULL DEFAULT now(),
  admin_id            uuid REFERENCES wfm.platform_admins(id) ON DELETE SET NULL,
  admin_email         text NOT NULL,
  action              text NOT NULL, -- 'SIGN_IN', 'SIGN_IN_FAILED', 'SIGN_OUT', 'PROVISION_ORGANISATION', 'CREATE_WORKSPACE', 'UPDATE_ORGANISATION', 'EMERGENCY_CREDENTIAL_RESET', 'STATUS_CHANGE'
  target_tenant_id    uuid REFERENCES wfm.tenants(id) ON DELETE SET NULL,
  target_tenant_name  text,
  target_tenant_code  text,
  target_entity_type  text NOT NULL, -- 'PLATFORM_SESSION', 'ORGANISATION', 'WORKSPACE', 'ORGANISATION_ADMIN'
  target_entity_id    text,
  target_entity_name  text,
  ip_address          text,
  user_agent          text,
  details             jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILURE', 'WARNING'))
);

CREATE INDEX IF NOT EXISTS platform_audit_at_idx ON wfm.platform_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_tenant_idx ON wfm.platform_audit_log (target_tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_action_idx ON wfm.platform_audit_log (action, at DESC);

-- Emergency Credential Reset tokens table
CREATE TABLE IF NOT EXISTS wfm.emergency_password_resets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES wfm.tenants(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES wfm.users(id) ON DELETE CASCADE,
  token_hash             text NOT NULL UNIQUE,
  created_by_admin_id    uuid REFERENCES wfm.platform_admins(id) ON DELETE SET NULL,
  created_by_admin_email text NOT NULL,
  temp_password_hint     text,
  expires_at             timestamptz NOT NULL,
  used_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS emergency_resets_token_idx ON wfm.emergency_password_resets (token_hash);
CREATE INDEX IF NOT EXISTS emergency_resets_user_idx ON wfm.emergency_password_resets (user_id, expires_at);

ALTER TABLE wfm.users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
