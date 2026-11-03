-- Which identity provider was picked from the list, and what was typed for it (tenant ID, domain, realm...). Never secrets: the client secret has its own column.
ALTER TABLE sso_providers ADD COLUMN IF NOT EXISTS preset text NOT NULL DEFAULT 'generic';
ALTER TABLE sso_providers ADD COLUMN IF NOT EXISTS preset_values jsonb NOT NULL DEFAULT '{}';
