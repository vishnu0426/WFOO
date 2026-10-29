-- Which weekday a pay week begins on. The company default lives in scheduling_policy.defaults ("payWeekStart", Monday = 0 ... Sunday = 6, Monday when absent).
-- A WFM group can override it; NULL means "use the company default". Weekly hours, days per week and overtime are counted per pay week.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS pay_week_start smallint CHECK (pay_week_start IS NULL OR pay_week_start BETWEEN 0 AND 6);
