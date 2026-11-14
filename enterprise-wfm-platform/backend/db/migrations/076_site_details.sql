-- Sites, as a place a customer can set up in one step: a manager, and the country as a code so its holidays, labour-law pack and time zone can be offered automatically.
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS manager_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS country_code text NOT NULL DEFAULT '';
