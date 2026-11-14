-- The plan catalogue and the country templates, both managed by Super Admins (Settings in the Super Admin portal).
--
--  plans              what each plan includes: the range of employee seats it covers, user, site and workspace limits, the modules, grace and trial length, an optional list price.
--                     A licence copies these numbers when it is issued, so editing a plan never changes a customer on its own ("Apply to customers" does that, after a preview).
--  country_templates  the suggestions the New organisation form fills in when a country is chosen. Only suggestions: they pre-fill a form and change nothing afterwards.

CREATE TABLE IF NOT EXISTS wfm.plans (
  code              text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  seats_min         int NOT NULL DEFAULT 1 CHECK (seats_min >= 1),
  seats_max         int NOT NULL CHECK (seats_max >= seats_min),
  max_users         int NOT NULL CHECK (max_users >= 1),
  max_sites         int NOT NULL CHECK (max_sites >= 1),
  max_workspaces    int NOT NULL CHECK (max_workspaces >= 1),
  modules           text[] NOT NULL DEFAULT '{}',
  grace_period_days int NOT NULL DEFAULT 14 CHECK (grace_period_days BETWEEN 0 AND 365),
  trial_days        int NOT NULL DEFAULT 30 CHECK (trial_days BETWEEN 1 AND 365),
  list_price        numeric CHECK (list_price IS NULL OR list_price >= 0),     -- per employee seat per month; reporting only
  price_currency    text NOT NULL DEFAULT 'USD',
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  is_custom         boolean NOT NULL DEFAULT false,                             -- the Custom plan: limits are negotiated for each customer
  sort_order        int NOT NULL DEFAULT 100,
  updated_by        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wfm.plans (code, name, description, seats_min, seats_max, max_users, max_sites, max_workspaces, modules, grace_period_days, trial_days, is_custom, sort_order) VALUES
  ('STARTER', 'Starter', 'Forecasting and scheduling for a single small team.', 1, 100, 20, 2, 1,
     ARRAY['FORECASTING','SCHEDULING','EMPLOYEE_SELF_SERVICE','REPORTING'], 14, 30, false, 10),
  ('PROFESSIONAL', 'Professional', 'Adds live intraday management, adherence, time off and shift bidding.', 1, 500, 100, 10, 3,
     ARRAY['FORECASTING','SCHEDULING','INTRADAY','ADHERENCE','TIME_OFF','SHIFT_BIDDING','EMPLOYEE_SELF_SERVICE','REPORTING'], 14, 30, false, 20),
  ('ENTERPRISE', 'Enterprise', 'Every module, for large operations.', 1, 2000, 300, 25, 5,
     ARRAY['FORECASTING','SCHEDULING','INTRADAY','ADHERENCE','TIME_OFF','SHIFT_BIDDING','EMPLOYEE_SELF_SERVICE','REPORTING','AI_COPILOT'], 14, 30, false, 30),
  ('ENTERPRISE_PLUS', 'Enterprise Plus', 'Every module, for very large and multi-site operations.', 1, 10000, 1000, 100, 20,
     ARRAY['FORECASTING','SCHEDULING','INTRADAY','ADHERENCE','TIME_OFF','SHIFT_BIDDING','EMPLOYEE_SELF_SERVICE','REPORTING','AI_COPILOT'], 14, 30, false, 40),
  ('CUSTOM', 'Custom', 'Negotiated terms. The limits and modules are set for each customer.', 1, 1000000, 1000000, 1000000, 1000000,
     ARRAY['FORECASTING','SCHEDULING','INTRADAY','ADHERENCE','TIME_OFF','SHIFT_BIDDING','EMPLOYEE_SELF_SERVICE','REPORTING','AI_COPILOT'], 14, 30, true, 90)
ON CONFLICT (code) DO NOTHING;

-- What a licence remembers about how it was agreed.
ALTER TABLE wfm.licenses
  ADD COLUMN IF NOT EXISTS custom_terms  boolean NOT NULL DEFAULT false,   -- limits or modules differ from the plan
  ADD COLUMN IF NOT EXISTS custom_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_trial      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS term_months   int;

CREATE TABLE IF NOT EXISTS wfm.country_templates (
  code            text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),     -- ISO 3166 two-letter code; also selects the public-holiday data
  name            text NOT NULL UNIQUE,
  timezone        text NOT NULL,
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  locale          text NOT NULL DEFAULT 'en',
  pay_week_start  smallint NOT NULL DEFAULT 0 CHECK (pay_week_start BETWEEN 0 AND 6),     -- Monday = 0 ... Sunday = 6
  weekend_days    smallint[] NOT NULL DEFAULT '{5,6}' CHECK (cardinality(weekend_days) BETWEEN 1 AND 3),
  add_holidays    boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 100,
  updated_by      text NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wfm.country_templates (code, name, timezone, currency, locale, pay_week_start, weekend_days, sort_order) VALUES
  ('IN', 'India', 'Asia/Kolkata', 'INR', 'en-IN', 0, '{5,6}', 10),
  ('US', 'United States', 'America/New_York', 'USD', 'en', 6, '{5,6}', 20),
  ('GB', 'United Kingdom', 'Europe/London', 'GBP', 'en-GB', 0, '{5,6}', 30),
  ('SG', 'Singapore', 'Asia/Singapore', 'SGD', 'en', 0, '{5,6}', 40),
  ('AE', 'United Arab Emirates', 'Asia/Dubai', 'AED', 'en', 0, '{5,6}', 50),
  ('SA', 'Saudi Arabia', 'Asia/Riyadh', 'SAR', 'en', 6, '{4,5}', 60),
  ('PH', 'Philippines', 'Asia/Manila', 'PHP', 'en', 0, '{5,6}', 70),
  ('AU', 'Australia', 'Australia/Sydney', 'AUD', 'en-GB', 0, '{5,6}', 80),
  ('CA', 'Canada', 'America/Toronto', 'CAD', 'en', 6, '{5,6}', 90),
  ('DE', 'Germany', 'Europe/Berlin', 'EUR', 'de', 0, '{5,6}', 100),
  ('FR', 'France', 'Europe/Paris', 'EUR', 'fr', 0, '{5,6}', 110),
  ('ES', 'Spain', 'Europe/Paris', 'EUR', 'es', 0, '{5,6}', 120),
  ('IE', 'Ireland', 'Europe/London', 'EUR', 'en-GB', 0, '{5,6}', 130),
  ('NL', 'Netherlands', 'Europe/Paris', 'EUR', 'en-GB', 0, '{5,6}', 140),
  ('IT', 'Italy', 'Europe/Paris', 'EUR', 'en-GB', 0, '{5,6}', 150)
ON CONFLICT (code) DO NOTHING;
