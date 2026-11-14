-- Organisation onboarding profile: company details, contacts, addresses and contract references captured when a
-- Super Admin creates an organisation. All columns are optional at the database level (existing organisations
-- have none of it); the onboarding form enforces which ones are required.

ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS country                  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS industry                 text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS company_size             text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS registration_id          text NOT NULL DEFAULT '',   -- company registration or tax number
  ADD COLUMN IF NOT EXISTS website                  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_phone            text NOT NULL DEFAULT '',   -- phone of the primary contact (name and email already exist)
  ADD COLUMN IF NOT EXISTS billing_contact_name     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS billing_contact_email    text,
  ADD COLUMN IF NOT EXISTS security_contact_name    text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS security_contact_email   text,
  ADD COLUMN IF NOT EXISTS registered_address       jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS billing_address          jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS billing_same_as_registered boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS contract_ref             text NOT NULL DEFAULT '',   -- contract or purchase order number
  ADD COLUMN IF NOT EXISTS account_owner            text NOT NULL DEFAULT '',   -- who looks after this customer on our side
  ADD COLUMN IF NOT EXISTS internal_notes           text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS terms_accepted_at        timestamptz,
  ADD COLUMN IF NOT EXISTS is_trial                 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarded_by             text NOT NULL DEFAULT '';
