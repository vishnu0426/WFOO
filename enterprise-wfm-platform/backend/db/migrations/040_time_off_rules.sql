-- Time off: dates when leave cannot be taken or is limited, and balances that build up over the year.
--
--  time_off_rules  BLACKOUT: nobody in the group (or anyone, when wfm_group_id is NULL) may take the listed leave types in the date range.
--                  CAP: at most max_off people of the group may be off on any one day in the range (tighter than the everyday percentage).
--                  strict = the request is refused outright; otherwise it goes to a manager with the reason. Sick leave is never blocked.
--  self_service_policy.accrual_mode  UPFRONT: the whole year's entitlement is available from 1 January (as before). MONTHLY: it builds up
--                  one twelfth a month, so a request for March can use three twelfths. carry_over_days: unused days brought in from last year, per type, up to this many.
CREATE TABLE IF NOT EXISTS time_off_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wfm_group_id uuid REFERENCES wfm_groups(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('BLACKOUT', 'CAP')),
  start_day    date NOT NULL,
  end_day      date NOT NULL,
  max_off      int CHECK (max_off IS NULL OR max_off >= 0),
  types        text[],
  strict       boolean NOT NULL DEFAULT false,
  reason       text NOT NULL DEFAULT '',
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_day >= start_day),
  CHECK (kind <> 'CAP' OR max_off IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS time_off_rules_range ON time_off_rules (tenant_id, start_day, end_day);

ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS accrual_mode text NOT NULL DEFAULT 'UPFRONT';
ALTER TABLE self_service_policy DROP CONSTRAINT IF EXISTS self_service_policy_accrual_mode_check;
ALTER TABLE self_service_policy ADD CONSTRAINT self_service_policy_accrual_mode_check CHECK (accrual_mode IN ('UPFRONT', 'MONTHLY'));
ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS carry_over_days jsonb NOT NULL DEFAULT '{}';
