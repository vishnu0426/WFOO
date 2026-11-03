-- What a queue's history "volume" means. OFFERED: every call that arrived (the usual case). ANSWERED: only calls an agent handled, so the callers who
-- gave up (the abandoned column) are missing from the demand and are added back. abandon_repeat_pct is the share of those callers who ring again
-- and are therefore already counted in a later interval.
ALTER TABLE queues ADD COLUMN IF NOT EXISTS volume_basis text NOT NULL DEFAULT 'OFFERED' CHECK (volume_basis IN ('OFFERED','ANSWERED'));
ALTER TABLE queues ADD COLUMN IF NOT EXISTS abandon_repeat_pct int NOT NULL DEFAULT 0 CHECK (abandon_repeat_pct BETWEEN 0 AND 100);
