-- Optional, admin-set placement for a template's meal/breaks, set by dragging them onto the shift timeline in the UI.
-- NULL (the default) keeps today's behavior: placeActivities() auto-centers the meal and evenly spreads breaks,
-- staggered to smooth coverage. When set, that anchor is used as the center of the same flex-window search instead
-- of the auto-computed one -- the generator can still nudge it within flex_slots, it just starts from where the
-- admin put it rather than the middle of the shift.
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS meal_anchor_slot smallint CHECK (meal_anchor_slot IS NULL OR meal_anchor_slot >= 0);
ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS break_anchor_slots smallint[];  -- one element per break (by index), NULL entries stay auto-placed
