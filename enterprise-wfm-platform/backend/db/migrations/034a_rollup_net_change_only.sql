-- Migration 035 (workspaces) adds a workspace_id column to every table and fills it with an UPDATE. On a database that already has the daily history rollup (058 to 060), that UPDATE fired
-- the rollup trigger, which took the rows out and put them back and so tried to write rollup rows with no workspace yet: "null value in column workspace_id of interval_daily".
-- A change that moves no volume (a column added, a phone number edited) must not touch the rollup at all. This makes the update trigger apply only the net difference per queue and day.
-- It sorts before 035 on purpose, and does nothing on a database that has no rollup yet (058 creates the same, correct, version for a new database).
DO $$
BEGIN
  IF to_regclass('wfm.interval_daily') IS NULL THEN RETURN; END IF;
  EXECUTE $f$
    CREATE OR REPLACE FUNCTION wfm.interval_daily_change() RETURNS trigger LANGUAGE plpgsql AS $b$
    BEGIN
      WITH o AS (SELECT queue_id, day, count(*) AS n, sum(volume) AS v, sum(coalesce(abandoned, 0)) AS a FROM old_rows GROUP BY queue_id, day),
           w AS (SELECT tenant_id, queue_id, day, count(*) AS n, sum(volume) AS v, sum(coalesce(abandoned, 0)) AS a FROM new_rows GROUP BY tenant_id, queue_id, day),
           d AS (SELECT coalesce(w.tenant_id, (SELECT tenant_id FROM old_rows x WHERE x.queue_id = o.queue_id LIMIT 1)) AS tenant_id, coalesce(w.queue_id, o.queue_id) AS queue_id, coalesce(w.day, o.day) AS day,
                        coalesce(w.n, 0) - coalesce(o.n, 0) AS dn, coalesce(w.v, 0) - coalesce(o.v, 0) AS dv, coalesce(w.a, 0) - coalesce(o.a, 0) AS da
                 FROM w FULL JOIN o ON o.queue_id = w.queue_id AND o.day = w.day)
      UPDATE wfm.interval_daily t SET intervals = t.intervals + d.dn, volume = t.volume + d.dv, abandoned = t.abandoned + d.da
      FROM d WHERE t.queue_id = d.queue_id AND t.day = d.day AND (d.dn <> 0 OR d.dv <> 0 OR d.da <> 0);
      -- a queue and day that was not there before (rows moved to a new day) gets its row; only then is anything inserted
      INSERT INTO wfm.interval_daily (tenant_id, queue_id, day, intervals, volume, abandoned)
      SELECT w.tenant_id, w.queue_id, w.day, w.n, w.v, w.a FROM (SELECT tenant_id, queue_id, day, count(*) AS n, sum(volume) AS v, sum(coalesce(abandoned, 0)) AS a FROM new_rows GROUP BY tenant_id, queue_id, day) w
      WHERE NOT EXISTS (SELECT 1 FROM wfm.interval_daily t WHERE t.queue_id = w.queue_id AND t.day = w.day)
      ON CONFLICT (queue_id, day) DO NOTHING;
      DELETE FROM wfm.interval_daily t WHERE t.intervals <= 0 AND (t.queue_id, t.day) IN (SELECT queue_id, day FROM old_rows);
      RETURN NULL;
    END $b$
  $f$;
END $$;
