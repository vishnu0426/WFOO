-- A WFM group can name the rotation pattern it normally follows. The value points at a ready-made pattern (its short id, such as "continental") or at a pattern saved in the
-- organisation's library (its id). It is only a default: Rotation Patterns and Generate Schedule start from it, and every group still has its own people and roster.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS default_rotation_ref text;
