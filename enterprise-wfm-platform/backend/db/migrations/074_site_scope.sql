-- Holidays and labour-law rules at site level.
--  special_events.site_id           a holiday (or any event) that belongs to one site applies to every WFM group at that site. With neither a site nor a group it applies to everyone, as before.
--  compliance_assignments           a labour-law pack can be assigned to a region or a site too. The most specific wins: person, team, group, site, region, organisation.
ALTER TABLE special_events ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS special_events_site ON special_events (tenant_id, site_id) WHERE site_id IS NOT NULL;

ALTER TABLE compliance_assignments DROP CONSTRAINT IF EXISTS compliance_assignments_scope_type_check;
ALTER TABLE compliance_assignments ADD CONSTRAINT compliance_assignments_scope_type_check CHECK (scope_type IN ('TENANT', 'REGION', 'SITE', 'GROUP', 'TEAM', 'EMPLOYEE'));
