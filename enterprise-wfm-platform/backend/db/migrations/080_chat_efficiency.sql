-- How much of 1/concurrency of a single chat's handle time a concurrent chat really takes. 1 = chats at once cost nothing extra; the engine's default was a fixed 0.85.
-- A group measures its own and sets it here, so the chat staffing follows what its agents really manage.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS chat_efficiency numeric(4,3) NOT NULL DEFAULT 0.85 CHECK (chat_efficiency BETWEEN 0.3 AND 1);
