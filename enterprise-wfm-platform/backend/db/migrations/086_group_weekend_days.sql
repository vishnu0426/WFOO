-- Which weekdays count as the weekend for one WFM group (Monday = 0 ... Sunday = 6). The company default lives in scheduling_policy.defaults ("weekendDays").
-- NULL means "use the company default". Weekend pay, fair sharing of weekend shifts and weekend-aware rotation checks follow it.
-- A customer with sites in different countries (Saturday and Sunday in India, Friday and Saturday in the Gulf) sets it per group.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS weekend_days smallint[] CHECK (weekend_days IS NULL OR (cardinality(weekend_days) BETWEEN 1 AND 3 AND weekend_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]));
