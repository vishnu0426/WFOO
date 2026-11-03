-- Single sign-on with OpenID Connect (authorization code + PKCE), one provider per organisation.
--   group_roles   maps a group name from the identity provider to a platform role, e.g. {"WFM-Schedulers": "SCHEDULER"}. The first group that matches wins.
--   jit           create the user on first sign-in when none exists (with the mapped role, else default_role). Off: only existing users can sign in with SSO.
--   sync_role     on every sign-in, set the user's role from their groups (the identity provider stays the source of truth).
--   password_login  keep the password form for this organisation. Off: everyone but the administrator account must use SSO.
CREATE TABLE IF NOT EXISTS sso_providers (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL DEFAULT 'Single sign-on',
  issuer          text NOT NULL,
  client_id       text NOT NULL,
  client_secret   text NOT NULL DEFAULT '',
  scopes          text NOT NULL DEFAULT 'openid profile email',
  username_claim  text NOT NULL DEFAULT 'email',
  group_claim     text NOT NULL DEFAULT 'groups',
  group_roles     jsonb NOT NULL DEFAULT '{}',
  default_role    text NOT NULL DEFAULT 'AGENT' CHECK (default_role IN ('WFM_ADMIN','WFM_MANAGER','FORECAST_PLANNER','SCHEDULER','SUPERVISOR_RTA','ANALYST','AGENT')),
  jit             boolean NOT NULL DEFAULT false,
  sync_role       boolean NOT NULL DEFAULT false,
  password_login  boolean NOT NULL DEFAULT true,
  enabled         boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
