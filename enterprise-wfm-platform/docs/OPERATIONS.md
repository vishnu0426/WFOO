# What-if, payroll, email and SMS, reports, follow the sun

## What-if (Scheduling > Schedule Quality > "What if...")

Runs several situations on the same days of a schedule through the stress test (`simulation.py`): more calls, longer calls, a share of people off. For each it reports service level, hang-ups, how busy people are and the chance of meeting the target, and finds by trying (six rounds of halving) about how many more or fewer people on the phones would just meet the target, as a percent of those scheduled and as people. That headcount is an estimate: it scales everyone on shift together, it is not a roster. API: `POST /scheduling/versions/:id/what-if`.

## Payroll (Workforce > Payroll)

A pay period becomes pay codes per person: regular, overtime, night, weekend, holiday and each kind of paid leave. Settings: the code for each, when night starts and ends (may cross midnight), daily and weekly overtime limits (weekly defaults to the person's contract hours), whether night and weekend hours **replace** regular pay or **stack** on top as supplements, rounding (two decimals, tenth, quarter hour), and whether hours come from clock punches, the schedule, or punches where a person has some. Each hour gets one category in this order: holiday, overtime, night, weekend, regular; weekly overtime is taken from the end of the week, from regular hours first. A day belongs to the day a shift starts, in the person's group time zone.

A run is a frozen copy of what was worked out. It can be recalculated while a draft, must be approved to be exported (approval locks it), cannot overlap another approved run for the same people (it would pay the days twice), and is blocked while anyone has clocked in and never out. Other warnings need a stated reason to approve. Export is CSV, as totals per person and code or day by day, and the first export is recorded. Everything is audited. Pure arithmetic is in `payMath.ts` and tested without a database.

**Not covered:** pay rates and cost (this produces hours by code, not money), and jurisdiction rules beyond what the settings express (for example tiered overtime multipliers, split-shift premiums, or "seventh consecutive day" rules). Leave is paid for Monday to Friday at the person's contract hours divided by their working days; a person with an unusual pattern needs a manual correction.

## Email and SMS (Administration > Alerts & Reports)

**Choose a provider; the boxes change to match.** Email: Custom SMTP (any mail server or relay, with a choice of encryption), Gmail / Google Workspace, Microsoft 365, Amazon SES, SendGrid, Mailgun, Brevo, Postmark, Mailjet, Zoho Mail (all through SMTP, only the credentials are asked for), and Resend, SendGrid and Postmark through their web APIs. SMS: Twilio, Vonage, MessageBird / Bird, Plivo, Infobip, Telnyx, Amazon SNS, Textlocal, and "Any web gateway" (a carrier, Kannel, Gammu or any service with an HTTP interface: you write the address, headers and body, with `{{to}}` and `{{message}}` filled in). The catalogue is `providers.ts`; adding a provider is one entry.

- Secrets (passwords, API keys, tokens, gateway headers) are saved but never sent back to the screen; leave a secret box empty to keep it. Choosing another provider starts its boxes empty, so nothing typed for one provider can be sent to another.
- "Save and send test" saves, sends one message, and says what the provider answered, in plain words, including refusals that arrive inside an apparently successful reply.
- **Honest limit:** these providers' request formats were written from their published documentation and are tested against local stand-ins that behave as documented (`providers.test.ts`, `ops.test.ts`). No real account at any provider was used. Send a test with your real credentials before relying on one. Microsoft is retiring password sign-in for SMTP in some tenants; if yours has, use Custom SMTP with your organisation's relay. Indian carriers may require a registered sender and message template (DLT) before any provider will deliver; that is registered with the carrier, not here.
- The provider names are their owners' trademarks and are listed only so you can pick the service you already use. No provider's software is included or required, and the platform is not tied to any.
- Email goes through an outbox: queued, tried again (30 s, 2 min, 10 min, 1 h), then marked failed; failed ones can be retried from the Sent messages tab. A message over 5 MB of attachment is refused with a reason.
- Which notifications also go by email or SMS: the organisation sets defaults per kind, and each person can override them (`GET/PUT /channels/me`). Their own choice wins. Phone numbers come from the employee record (the CSV import reads a `phone` column).
- **Alert rules** say "when this event happens, tell these roles by these channels". Events are the same names webhooks use. A person with no email or phone is skipped for that channel.
- Settings saved before providers existed are converted on read (a host becomes Custom SMTP, a gateway address becomes Any web gateway); nobody has to retype anything.
- Secrets are encrypted at rest (see below).

## Scheduled reports (Administration > Alerts & Reports)

Five reports: roster, coverage against the forecast, attendance, payroll hours (preview) and time off. A report runs now (rows on screen or CSV) or on a timetable: daily, weekly or monthly at a local hour in the group's time zone, over a named range worked out on the day it runs (yesterday, last week, last month, next 7 days, next week...). The CSV is emailed to addresses and roles, and the last 60 runs are kept to download. Spreadsheet formula injection is guarded (a text cell starting `=`, `+`, `-` or `@` is prefixed). Daylight saving and half-hour time zones are handled (`reportTime.ts`, tested).

## Follow the sun (Scheduling > Follow the Sun)

Pick two or more groups at different sites with published schedules. They are put on one UTC clock: combined need against combined cover for every hour, the typical day hour by hour with who covers which hour, the runs of hours where need is not met, and a what-if that slides one site's whole roster up to four hours earlier or later to show where a gap would close. This assumes the people can help across the groups you pick, and it says so on screen; the slide ignores each person's own hours and availability, so use it to see the gap, then plan the real change in the schedule.

## Repeated weeks in a long plan

A repeated week no longer just copies the next week of the cycle in turn. Each repeated week copies the solved week whose daily demand looks most like its own, but only when another week fits clearly better (3 points of difference), so people's rotations are not shuffled for a trivial gain. A week that resembles no solved week (more than 20% apart) is reported by date as one to solve properly. Time off, availability, rest and weekly-hour limits are still applied to every repeated shift.

## Secrets at rest

Mail and SMS credentials, webhook signing secrets, the single sign-on client secret and connector credentials are encrypted in the database with AES-256-GCM (`secrets.ts`): a fresh random nonce for every value, tampering detected, and each value tagged with a short fingerprint of the key that wrote it. They are decrypted only in memory, at the moment they are used, and are never returned by any screen or API (a screen is only told whether one is saved). API keys and passwords are not stored at all, only one-way hashes.

- **The key.** Set `SECRETS_KEY` (`openssl rand -hex 32`) in the server settings. Keep it out of the database and out of database backups, or the encryption protects nothing. If it is not set, a key is derived from `JWT_SECRET` so nothing breaks, but then changing `JWT_SECRET` makes saved secrets unreadable; the Stored secrets card on Administration > API & Single Sign-On says so.
- **Upgrading.** At every start-up, anything saved as plain text by an earlier version, or under a previous key, is rewritten under the current key (safe to repeat, never blocks start-up). The same can be run from the card ("Encrypt now") or `POST /security/secrets/reencrypt`. `GET /security/secrets` counts what is encrypted, under an old key, plain or unreadable, and never returns a secret.
- **Rotating.** Move the old key to `SECRETS_KEY_PREVIOUS` (comma separated for several), put the new one in `SECRETS_KEY`, restart. Everything is re-encrypted under the new key; the old one can be removed afterwards.
- **A wrong or lost key** does not stop the service: an unreadable secret is treated as not set, logged, counted on the card, and the screen asks for it again.
- **What this does and does not protect.** It protects the database, its backups and anyone reading rows directly. It does not protect against someone who has both the database and the server's settings, or who can run code in the gateway. For stronger separation put `SECRETS_KEY` in your platform's secret store rather than a file.

## Single sign-on: choosing the provider (Administration > API & Single Sign-On)

Pick Microsoft Entra ID, Okta, Google Workspace, Keycloak, Auth0, OneLogin, PingOne, JumpCloud, or "Any OpenID Connect provider". The boxes change to what that provider needs (tenant ID, domain, realm...), the provider address is built from them on the server (`ssoProviders.ts`), the usual claim names and scopes are filled in, and the steps for the provider's own admin screen are shown with this platform's redirect address. Changing provider clears the boxes and the secret. Google can be limited to one email domain. "Test the connection" fetches the provider's published settings and warns when the provider names itself differently from the address built (sign-ins would be refused).

Limits are shown on screen per provider: Google sends no groups; Entra sends group IDs and drops the list past about 200 groups; Okta, Keycloak, Auth0, OneLogin and JumpCloud send groups only when you add the claim. OpenID Connect only (no SAML). The provider formats were written from published documentation and tested against a local stand-in, not real accounts.

### Setting up single sign-on step by step, and trying it safely

The card runs top to bottom: (1) copy the redirect address into your provider (a link opens the provider's own admin screen), optionally paste the provider's address and press Detect to pick the provider and fill its boxes, (2) choose the provider and fill its boxes, with the address that will be used shown under them, (3) **Try sign-in**, (4) the role table, (5) switch on.

- **Redirect address.** `PUBLIC_URL` in `backend/.env` is the address people use in the browser (in development `http://localhost:3000`, which passes `/api` to the gateway). Single sign-on registers `<PUBLIC_URL>/api/v1/auth/sso/callback`, SCIM uses `<PUBLIC_URL>/scim/v2`, and `APP_URL` is where people land after signing in. Without `PUBLIC_URL` the address is taken from the request, which behind a proxy may be the internal one. In production set it to the real https address, and register exactly that in the provider.
- **Try sign-in** opens the provider's sign-in in a small window using the values on screen (saved or not). Nobody is signed in and nothing is switched on. The screen then shows every detail the provider sent (technical fields hidden, long values shortened), which one was used as "who they are" and as "their groups", the groups found (press + to add one to the role table), and plainly what would happen to the person who just signed in: sign in as which role, be created, or be refused and why. Hints say when groups are IDs, when no groups claim arrived, or when no group is mapped. The window's page shows no sign-in details, a test link works once and expires after 10 minutes, and a result can only be read by an administrator of the same organisation.
- **The gate.** Switching single sign-on on, or switching passwords off, is refused (400, "Try sign-in first") unless a real sign-in has worked for exactly this provider address, Client ID, Client secret and scopes (a keyed hash of them is kept in `sso_tests`, never the values). Saving it switched off is always allowed; a setup that was already on is not re-tested unless one of those four changes. The administrator's password always works, whatever is set.
- **Detect** recognises Entra (issuer or sts.windows.net), Okta, Google, Keycloak (`.../realms/<realm>`), Auth0, OneLogin, PingOne (.com) and JumpCloud addresses, with or without `/.well-known/openid-configuration`; anything else valid and https stays "any provider". A custom Okta authorization server (`/oauth2/...`) is kept exactly as typed.

### Single sign-on in the employee portal

The portal (port 3001 in development) shows the organisation's single sign-on button on its sign-in page when single sign-on is on. It asks `GET /auth/sso/<organisation code, or _>/info` as the organisation code is typed; if the server does not answer, the password form is shown (never a dead end).

- **Settings (`backend/.env`).** `PORTAL_URL` is the portal's address; `APP_URL` the admin app's; `PUBLIC_URL` the address the provider returns to (registered once in the provider). The sign-in link names a target only (`?to=portal`; anything else means the admin app), and the address always comes from these settings, so a link cannot send a signed-in person to another site. When the portal is on a different host from the gateway, set `PUBLIC_URL`: the sign-in cookie is set where the sign-in starts, so it must start and end on the same address, and the `info` answer gives the portal that absolute start address.
- **What the screen shows.** Password only (single sign-on off); the button plus the password form (passwords still allowed); the button with an "Administrator sign-in" link (passwords switched off); or, if passwords are off but `PORTAL_URL` is not set, a message that the portal is not set up for single sign-on, again with the administrator link.
- **Coming back.** The gateway returns the person to the portal with the token after `#`, which the browser never sends to a server. The portal removes it from the address bar and history at once, asks who the token belongs to, and refuses an account that has no portal access. A failure comes back to the same page with the reason.
- **Employee link.** The portal needs the login tied to an employee record. At sign-in, an account with no link is linked to the one employee record with the same email that no other login uses; two employees with the same email, or none, link nothing (never guessed). A new login created at first sign-in is linked the same way. "Try sign-in" tells the administrator which of these will happen for the person who tried.
- **Not covered: the mobile app.** It still signs in with passwords only. Switching "Still allow passwords" off blocks it (the card says so). Single sign-on in the app needs a different flow (a return link into the app) and is not built.

## Signing in without knowing the organisation code

Employees should not have to know a code. The sign-in screens (employee portal and admin app) work out the organisation in this order:

1. **A link:** `https://portal.example.com/?org=ACME`. This is what the Employees screen gives you, with the temporary password, when you create a login (use *Copy message to send*). It needs `PORTAL_URL` in `backend/.env`.
2. **A path:** `https://portal.example.com/org/acme`. The web server must send unknown paths to `index.html`, as it already does for the single-page app.
3. **A host name:** `https://acme.example.com`, only when the portal is built with `VITE_ORG_FROM_SUBDOMAIN=true`. Needs a wildcard DNS record and certificate. Set `PORTAL_URL_TEMPLATE=https://{org}.example.com` so the links match. Generic first parts (`www`, `portal`, `app`, `my`, `wfm`...) and IP addresses are never read as an organisation.
4. **The last organisation used on this device** (remembered after a successful sign-in; forgotten if the server no longer knows it).
5. **The only organisation**, when the server hosts just one: no code is asked for at all.

If none of those apply, the person types the code (checked as they leave the box) or chooses **Don't know it? Find my organisation** and types their work email or username. They are shown the organisations that have an active account for it, and pick one if there are several. A work email also works as the username at sign-in when it belongs to exactly one account in that organisation.

- `LOGIN_DISCOVERY=false` switches the email lookup off (it tells whoever asks that an account exists; it is limited to 15 lookups per address per 15 minutes, and code checks to 60).
- Errors say what to do: *"We couldn't find that organisation. Check the code on your welcome message, or ask your manager."*
- The mobile app already remembers the server and organisation; it shows the same server messages.

## Supervisors, approvals, cover and leavers

- **Marking people.** On an employee, *Is a supervisor* / *Is a manager* only says they may be chosen as a team's supervisor (or deputy) or a WFM group's manager. It gives no access: access is the role on their login (Users & roles). A Supervisor-role login can decide requests because the role holds the `requests:approve` permission.
- **First line.** With *Supervisor decides first* on (Configuration › Self-service rules), a request from someone in a team goes to that team's supervisor, deputy, or whoever covers them today; they alone (and managers and schedulers) can decide it. A team with no supervisor goes straight to the managers. A supervisor cannot decide their own request. After *Tell the managers after* hours (24 by default) with no decision, the managers are told once and the request shows **Overdue**. The decision records the level (supervisor or manager) in the request and the history.
- **Cover.** Workforce › Teams › *Hand over teams*: between two dates one person takes over a supervisor's teams (they are told, and decide requests and see "My teams" in adherence). The person covering needs a login with the Supervisor role. A manager, a scheduler or the supervisor themselves can set and end it.
- **Limit supervisors to their teams** (off by default). When on, a Supervisor sees only the people of the teams they supervise (and themselves) in employees, the person pickers, time off and swap lists, and can add intraday exceptions, gap fixes and break moves only for them. Switch it on once every Supervisor is a team's supervisor or deputy, or they would see nobody. The schedule and coverage views remain group-wide, and live events and alert settings are not limited.
- **Employee edits need a reason** for anything except contact details (email, phone, extension, location, time zone). It is stored in the history with the name of whoever made the change.
- **Leaving.** Set the status to Terminated, with a last working day and a reason. Every shift after that day is removed from draft and published schedules (their coverage figures and revision history are updated). On the last day (at once, if it has passed) the person is marked Terminated, their login is switched off, their waiting requests and open swaps are cancelled, the people who report to them move to their manager, and cover involving them ends. A last day still to come keeps them active until then; a background check finishes it. Someone who still supervises a team or manages a group cannot leave until someone else holds the job. Their login stays off if they are re-hired: re-enable it from Users.
- **Reporting lines.** *Reports to* on the employee (a person cannot report to themselves, to someone who left, or in a circle). Teams › *Set reporting lines* puts a whole team under its supervisor. Workforce › Org chart shows the tops of the branches, opens a level at a time, shows the chain above anyone, lists people with no line, and exports every line as a file.

