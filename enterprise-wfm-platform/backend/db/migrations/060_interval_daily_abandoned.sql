-- The history-quality screen needs the abandoned-call total of every queue as well as the volume. It read it by scanning a year of interval rows for every queue
-- (seconds for a big group, and it grows with history). The daily rollup (058) now keeps abandoned calls too, kept exact by the same triggers.
ALTER TABLE interval_daily ADD COLUMN IF NOT EXISTS abandoned bigint NOT NULL DEFAULT 0;

UPDATE interval_daily d SET abandoned = a.n
FROM (SELECT queue_id, day, sum(coalesce(abandoned, 0))::bigint AS n FROM interval_history GROUP BY queue_id, day) a
WHERE d.queue_id = a.queue_id AND d.day = a.day;

CREATE OR REPLACE FUNCTION interval_daily_add() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO interval_daily (tenant_id, queue_id, day, intervals, volume, abandoned)
  SELECT tenant_id, queue_id, day, count(*), sum(volume), sum(coalesce(abandoned, 0)) FROM new_rows GROUP BY tenant_id, queue_id, day
  ON CONFLICT (queue_id, day) DO UPDATE SET intervals = interval_daily.intervals + EXCLUDED.intervals, volume = interval_daily.volume + EXCLUDED.volume, abandoned = interval_daily.abandoned + EXCLUDED.abandoned;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION interval_daily_remove() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE interval_daily d SET intervals = d.intervals - o.n, volume = d.volume - o.v, abandoned = d.abandoned - o.a
  FROM (SELECT queue_id, day, count(*) AS n, sum(volume) AS v, sum(coalesce(abandoned, 0)) AS a FROM old_rows GROUP BY queue_id, day) o
  WHERE d.queue_id = o.queue_id AND d.day = o.day;
  DELETE FROM interval_daily WHERE intervals <= 0 AND (queue_id, day) IN (SELECT queue_id, day FROM old_rows);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION interval_daily_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE interval_daily d SET intervals = d.intervals - o.n, volume = d.volume - o.v, abandoned = d.abandoned - o.a
  FROM (SELECT queue_id, day, count(*) AS n, sum(volume) AS v, sum(coalesce(abandoned, 0)) AS a FROM old_rows GROUP BY queue_id, day) o
  WHERE d.queue_id = o.queue_id AND d.day = o.day;
  INSERT INTO interval_daily (tenant_id, queue_id, day, intervals, volume, abandoned)
  SELECT tenant_id, queue_id, day, count(*), sum(volume), sum(coalesce(abandoned, 0)) FROM new_rows GROUP BY tenant_id, queue_id, day
  ON CONFLICT (queue_id, day) DO UPDATE SET intervals = interval_daily.intervals + EXCLUDED.intervals, volume = interval_daily.volume + EXCLUDED.volume, abandoned = interval_daily.abandoned + EXCLUDED.abandoned;
  DELETE FROM interval_daily WHERE intervals <= 0 AND (queue_id, day) IN (SELECT queue_id, day FROM old_rows);
  RETURN NULL;
END $$;
