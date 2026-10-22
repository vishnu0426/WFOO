-- Null means "pick automatically for contrast against the activity's colour" -- an admin only sets this to override that.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS text_color text;
