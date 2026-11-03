-- Email and SMS alerts.
--
--  channel_settings    how this organisation sends email (an SMTP server) and SMS (any HTTP SMS gateway: the address, the headers and the body to send, with {{to}} and
--                      {{message}} filled in), and which kinds of notification go by email or SMS unless a person chooses otherwise. org_id, not tenant_id: the sender
--                      works across organisations and must see the settings before an organisation is known (see the note in 041).
--  channel_deliveries  the outbox: one row per message, retried with a growing delay, then marked failed. org_id for the same reason.
--  notification_prefs  one person's choice, per kind of notification, of email and SMS on top of the app inbox.
--  alert_rules         "when this happens, tell these roles by these channels": an event (the same names webhooks use), who, and how.
CREATE TABLE IF NOT EXISTS channel_settings (
  org_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  email       jsonb NOT NULL DEFAULT '{"enabled":false}',
  sms         jsonb NOT NULL DEFAULT '{"enabled":false}',
  defaults    jsonb NOT NULL DEFAULT '{}',          -- {"TIME_OFF": ["EMAIL"], "SCHEDULE": ["EMAIL","SMS"]}: kinds sent by these channels for everyone who has not chosen
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('EMAIL', 'SMS')),
  to_address      text NOT NULL,
  subject         text NOT NULL DEFAULT '',
  body            text NOT NULL,
  attachment      jsonb,                               -- {name, type, content} for a file sent with an email (a scheduled report)
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  ref             text,                                -- what caused it: a notification kind, an alert rule, a report
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS channel_deliveries_due ON channel_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS channel_deliveries_org ON channel_deliveries (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_prefs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL,
  email     boolean NOT NULL DEFAULT false,
  sms       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  event       text NOT NULL,                           -- an event name, or * for all
  roles       text[] NOT NULL,                         -- who is told: everyone with one of these roles
  channels    text[] NOT NULL,                         -- INBOX, EMAIL, SMS
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
