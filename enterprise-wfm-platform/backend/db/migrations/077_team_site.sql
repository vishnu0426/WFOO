-- A team can be based at a site. It is optional and only places the team on the Organisation page and its lists: people from any site can still be in any team.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE SET NULL;
