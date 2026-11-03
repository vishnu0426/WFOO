-- The people list is sorted by name by default. Without an index in that order the database sorted every person of the organisation to hand back one page:
-- 150 ms in the database for 112,000 people, over half a second through the API, growing with the headcount. With it the first page is read straight off the index.
CREATE INDEX IF NOT EXISTS employees_name_order ON employees (tenant_id, last_name, first_name, id);
