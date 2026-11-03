-- A daily rollup of interval history: one row per queue per day (how many intervals are there, and their total volume).
-- "How much history does each queue have, and are there gaps" is asked on several screens every time they open. Answering it from interval_history means reading and
-- sorting every interval row (millions for a few years of many queues); from this table it reads one row per queue per day.
-- Statement-level triggers keep it exact however rows get in or out (imports, the live feed, rollbacks, deleting a queue), so no application code has to remember to.
CREATE TABLE IF NOT EXISTS interval_daily (
  tenant_id uuid   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id  uuid   NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  day       date   NOT NULL,
  intervals int    NOT NULL,
  volume    bigint NOT NULL,
  PRIMARY KEY (queue_id, day)
);
CREATE INDEX IF NOT EXISTS interval_daily_tenant_day ON interval_daily (tenant_id, day);

-- build it from what is there now (a one-time cost at upgrade; later changes are kept by the triggers below)
DELETE FROM interval_daily;
INSERT INTO interval_daily (tenant_id, queue_id, day, intervals, volume)
SELECT tenant_id, queue_id, day, count(*), sum(volume) FROM interval_history GROUP BY tenant_id, queue_id, day;

CREATE OR REPLACE FUNCTION interval_daily_add() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO interval_daily (tenant_id, queue_id, day, intervals, volume)
  SELECT tenant_id, queue_id, day, count(*), sum(volume) FROM new_rows GROUP BY tenant_id, queue_id, day
  ON CONFLICT (queue_id, day) DO UPDATE SET intervals = interval_daily.intervals + EXCLUDED.intervals, volume = interval_daily.volume + EXCLUDED.volume;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION interval_daily_remove() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE interval_daily d SET intervals = d.intervals - o.n, volume = d.volume - o.v
  FROM (SELECT queue_id, day, count(*) AS n, sum(volume) AS v FROM old_rows GROUP BY queue_id, day) o
  WHERE d.queue_id = o.queue_id AND d.day = o.day;
  DELETE FROM interval_daily WHERE intervals <= 0 AND (queue_id, day) IN (SELECT queue_id, day FROM old_rows);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION interval_daily_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- a changed row is the old one leaving and the new one arriving (this also covers a row that moved to another day or queue)
  UPDATE interval_daily d SET intervals = d.intervals - o.n, volume = d.volume - o.v
  FROM (SELECT queue_id, day, count(*) AS n, sum(volume) AS v FROM old_rows GROUP BY queue_id, day) o
  WHERE d.queue_id = o.queue_id AND d.day = o.day;
  INSERT INTO interval_daily (tenant_id, queue_id, day, intervals, volume)
  SELECT tenant_id, queue_id, day, count(*), sum(volume) FROM new_rows GROUP BY tenant_id, queue_id, day
  ON CONFLICT (queue_id, day) DO UPDATE SET intervals = interval_daily.intervals + EXCLUDED.intervals, volume = interval_daily.volume + EXCLUDED.volume;
  DELETE FROM interval_daily WHERE intervals <= 0 AND (queue_id, day) IN (SELECT queue_id, day FROM old_rows);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS interval_history_rollup_ins ON interval_history;
DROP TRIGGER IF EXISTS interval_history_rollup_upd ON interval_history;
DROP TRIGGER IF EXISTS interval_history_rollup_del ON interval_history;
CREATE TRIGGER interval_history_rollup_ins AFTER INSERT ON interval_history REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION interval_daily_add();
CREATE TRIGGER interval_history_rollup_upd AFTER UPDATE ON interval_history REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION interval_daily_change();
CREATE TRIGGER interval_history_rollup_del AFTER DELETE ON interval_history REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION interval_daily_remove();
