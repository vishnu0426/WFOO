-- Add workspace_id to every operational tenant table. Existing rows belong to the organisation's default workspace.
-- Tables that are organisation-level (users, role permissions, workspaces, membership, organisation settings) intentionally
-- do not carry workspace_id. Everything else is scoped to exactly one workspace.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'wfm' AND c.column_name = 'tenant_id'
      AND c.table_name NOT IN ('users', 'role_permissions', 'workspaces', 'workspace_members', 'organization_settings')
  LOOP
    EXECUTE format('ALTER TABLE wfm.%I ADD COLUMN IF NOT EXISTS workspace_id uuid', t.table_name);
    EXECUTE format(
      'UPDATE wfm.%I x SET workspace_id = w.id FROM wfm.workspaces w WHERE w.tenant_id = x.tenant_id AND w.is_default AND x.workspace_id IS NULL',
      t.table_name);
    EXECUTE format(
      'ALTER TABLE wfm.%I ALTER COLUMN workspace_id SET DEFAULT (nullif(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t.table_name);
    EXECUTE format('ALTER TABLE wfm.%I ALTER COLUMN workspace_id SET NOT NULL', t.table_name);
    EXECUTE format(
      'ALTER TABLE wfm.%I ADD CONSTRAINT %I FOREIGN KEY (org_id, workspace_id) REFERENCES wfm.workspaces(org_id, id) ON DELETE CASCADE',
      t.table_name, left(t.table_name || '_workspace_fkey', 63));
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON wfm.%I (tenant_id, workspace_id)', left(t.table_name || '_workspace_idx', 63), t.table_name);
  END LOOP;
END $$;

-- Unique business keys become workspace-local. Role permissions and users stay organisation-wide.
DO $$
DECLARE r record; cols text; new_name text;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'wfm'
      AND con.contype IN ('p', 'u')
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'wfm' AND col.table_name = c.relname AND col.column_name = 'workspace_id')
      AND pg_get_constraintdef(con.oid) LIKE '%tenant_id%'
      AND pg_get_constraintdef(con.oid) NOT LIKE '%workspace_id%'
  LOOP
    cols := replace(substring(r.def from '\((.*)\)'), 'tenant_id', 'tenant_id, workspace_id');
    new_name := left(r.conname, 40) || '_' || substr(md5(r.conname), 1, 8) || '_ws';
    EXECUTE format('ALTER TABLE wfm.%I DROP CONSTRAINT %I', r.table_name, r.conname);
    EXECUTE format('ALTER TABLE wfm.%I ADD CONSTRAINT %I %s (%s)', r.table_name, new_name,
      CASE WHEN r.contype = 'p' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END, cols);
  END LOOP;
END $$;

-- This one is a unique expression index (case-insensitive state/reason), not a constraint.
DROP INDEX IF EXISTS wfm.rta_state_map_key;
CREATE UNIQUE INDEX rta_state_map_key ON wfm.rta_state_map (tenant_id, workspace_id, lower(state), lower(reason));

-- Integration connectors are looked up by id before a user session exists (connector API key / webhook signature).
-- The lookup is deliberately narrow and still verifies the key/secret in the gateway.
CREATE OR REPLACE FUNCTION wfm.integration_connector_lookup(p_id uuid)
RETURNS SETOF wfm.integration_connectors
LANGUAGE sql
SECURITY DEFINER
SET search_path = wfm, public
AS $$ SELECT * FROM wfm.integration_connectors WHERE id = p_id $$;
REVOKE ALL ON FUNCTION wfm.integration_connector_lookup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wfm.integration_connector_lookup(uuid) TO wfm_app;
