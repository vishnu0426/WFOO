-- A new queue with too little interval history can borrow the daily pattern (how a day's calls spread over the hours) of a similar queue.
-- It uses the other queue's pattern only until it has enough days of its own; its own volume level always comes from its own history.
ALTER TABLE queues ADD COLUMN IF NOT EXISTS shape_from_queue_id uuid REFERENCES queues(id) ON DELETE SET NULL;
