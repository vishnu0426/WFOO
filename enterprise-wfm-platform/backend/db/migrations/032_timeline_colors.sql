-- The Schedule Timeline's shift colours (normal, manually-added, breaks-a-rule), admin-set instead of fixed in code.
ALTER TABLE scheduling_policy ADD COLUMN IF NOT EXISTS timeline_colors jsonb NOT NULL DEFAULT '{"shift":"#7B6CA6","manual":"#6B7F99","violation":"#C9605F"}'::jsonb;
