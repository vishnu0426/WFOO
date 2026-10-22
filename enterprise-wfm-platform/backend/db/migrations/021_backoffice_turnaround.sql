-- Back-office queues can target a turnaround window longer than same-day (e.g. "95% within 3 business days")
-- instead of requiring every day's volume to be cleared that same day. Null/0 = same-day, the existing behaviour.
ALTER TABLE queues ADD COLUMN IF NOT EXISTS turnaround_hours int CHECK (turnaround_hours IS NULL OR (turnaround_hours >= 0 AND turnaround_hours <= 720));
