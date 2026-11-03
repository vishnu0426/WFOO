-- How many people each WFM group has (everyone eligible for it, and those whose main group it is). The WFM Groups list asks for this on every open; counting it meant
-- reading every person of the organisation (230 ms at 112,000 people, and growing with headcount). This table holds the counts and the database keeps them exact
-- whenever people are added, changed or removed, however that happens (a screen, a file import, a bulk edit, a script).
-- A person counts while their status is not TERMINATED, as the list always has.
CREATE TABLE IF NOT EXISTS group_people (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL,
  people         int  NOT NULL DEFAULT 0,
  primary_people int  NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id)
);

-- one row per (group, kind) for a set of people: kind 'e' = eligible, 'p' = primary
CREATE OR REPLACE FUNCTION group_people_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO group_people (tenant_id, group_id, people, primary_people)
    SELECT tenant_id, gid, sum(e)::int, sum(p)::int FROM (
      SELECT n.tenant_id, g AS gid, 1 AS e, 0 AS p FROM new_rows n CROSS JOIN LATERAL unnest(n.eligible_group_ids) g WHERE n.status <> 'TERMINATED'
      UNION ALL SELECT n.tenant_id, n.primary_group_id, 0, 1 FROM new_rows n WHERE n.status <> 'TERMINATED' AND n.primary_group_id IS NOT NULL) d
    GROUP BY tenant_id, gid
    ON CONFLICT (group_id) DO UPDATE SET people = group_people.people + EXCLUDED.people, primary_people = group_people.primary_people + EXCLUDED.primary_people;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO group_people (tenant_id, group_id, people, primary_people)
    SELECT tenant_id, gid, -sum(e)::int, -sum(p)::int FROM (
      SELECT o.tenant_id, g AS gid, 1 AS e, 0 AS p FROM old_rows o CROSS JOIN LATERAL unnest(o.eligible_group_ids) g WHERE o.status <> 'TERMINATED'
      UNION ALL SELECT o.tenant_id, o.primary_group_id, 0, 1 FROM old_rows o WHERE o.status <> 'TERMINATED' AND o.primary_group_id IS NOT NULL) d
    GROUP BY tenant_id, gid
    ON CONFLICT (group_id) DO UPDATE SET people = group_people.people + EXCLUDED.people, primary_people = group_people.primary_people + EXCLUDED.primary_people;
  ELSE
    -- an update is the old rows leaving and the new ones arriving; only a change in the net counts is written, so editing a phone number writes nothing
    INSERT INTO group_people (tenant_id, group_id, people, primary_people)
    SELECT tenant_id, gid, sum(e)::int, sum(p)::int FROM (
      SELECT n.tenant_id, g AS gid, 1 AS e, 0 AS p FROM new_rows n CROSS JOIN LATERAL unnest(n.eligible_group_ids) g WHERE n.status <> 'TERMINATED'
      UNION ALL SELECT n.tenant_id, n.primary_group_id, 0, 1 FROM new_rows n WHERE n.status <> 'TERMINATED' AND n.primary_group_id IS NOT NULL
      UNION ALL SELECT o.tenant_id, g, -1, 0 FROM old_rows o CROSS JOIN LATERAL unnest(o.eligible_group_ids) g WHERE o.status <> 'TERMINATED'
      UNION ALL SELECT o.tenant_id, o.primary_group_id, 0, -1 FROM old_rows o WHERE o.status <> 'TERMINATED' AND o.primary_group_id IS NOT NULL) d
    GROUP BY tenant_id, gid HAVING sum(e) <> 0 OR sum(p) <> 0
    ON CONFLICT (group_id) DO UPDATE SET people = group_people.people + EXCLUDED.people, primary_people = group_people.primary_people + EXCLUDED.primary_people;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS employees_group_people_ins ON employees;
DROP TRIGGER IF EXISTS employees_group_people_upd ON employees;
DROP TRIGGER IF EXISTS employees_group_people_del ON employees;

-- build it from the people there are now (later changes are kept by the triggers), then switch the triggers on in the same transaction
DELETE FROM group_people;
INSERT INTO group_people (tenant_id, group_id, people, primary_people)
SELECT tenant_id, gid, sum(e)::int, sum(p)::int FROM (
  SELECT e.tenant_id, g AS gid, 1 AS e, 0 AS p FROM employees e CROSS JOIN LATERAL unnest(e.eligible_group_ids) g WHERE e.status <> 'TERMINATED'
  UNION ALL SELECT e.tenant_id, e.primary_group_id, 0, 1 FROM employees e WHERE e.status <> 'TERMINATED' AND e.primary_group_id IS NOT NULL) d
GROUP BY tenant_id, gid;

CREATE TRIGGER employees_group_people_ins AFTER INSERT ON employees REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION group_people_apply();
CREATE TRIGGER employees_group_people_upd AFTER UPDATE ON employees REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION group_people_apply();
CREATE TRIGGER employees_group_people_del AFTER DELETE ON employees REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION group_people_apply();
