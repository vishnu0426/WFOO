-- The fewest days off that must fall together (side by side) in each pay week. 0 = no rule, which is what everyone had before.
-- A person's own value, a company-wide value in the scheduling policy and a labour-law pack's rule are all read; the strictest one applies.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS min_days_off_together int NOT NULL DEFAULT 0 CHECK (min_days_off_together BETWEEN 0 AND 3);
ALTER TABLE scheduling_policy ADD COLUMN IF NOT EXISTS min_days_off_together int CHECK (min_days_off_together BETWEEN 0 AND 3);
