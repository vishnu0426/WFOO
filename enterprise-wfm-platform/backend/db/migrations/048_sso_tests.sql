-- The last successful "Try sign-in" for an organisation. Single sign-on can only be switched on (or passwords switched off) for a configuration that has been tried:
-- the fingerprint is a keyed hash of the provider address, client ID, client secret and scopes, so changing any of them needs a new try. No secret is stored here.
CREATE TABLE IF NOT EXISTS sso_tests (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  fingerprint  text NOT NULL,
  login        text,
  tested_by    text,
  tested_at    timestamptz NOT NULL DEFAULT now()
);
