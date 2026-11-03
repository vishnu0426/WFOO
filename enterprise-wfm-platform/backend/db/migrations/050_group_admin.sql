-- WFM group administration.
-- Aliases: the other names a queue goes by in the phone system or in exported files. An import row that names a queue by any of them lands on this
-- queue, so a file with many queues maps reliably without renaming anything in the source system. Unique across the organisation (checked by the API).
ALTER TABLE queues ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS queues_aliases_idx ON queues USING gin (aliases);
