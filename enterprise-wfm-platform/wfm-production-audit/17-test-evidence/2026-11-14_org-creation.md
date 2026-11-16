# Test org creation – 2026-11-14 (super-admin portal :3002)

Org `AUDITTR0042` "AUDIT TR0042 (synthetic test)", India / Asia/Kolkata / INR, Custom licence 200,000 seats, all modules.
Baseline before: 1 org, 2 workspaces, 5 tenant users, 385/500 seats (My Organisation, code ORG).
After: 2 orgs, 3 workspaces, 6 tenant users (the invited test administrator).

| ID | Severity | Status | Finding |
|---|---|---|---|
| AUD-01 | LOW | Needs confirming in the org calendar | "Add India's public holidays" was **unticked** before submit (checked in the page), yet the result said "12 public holidays were added". |
| AUD-02 | LOW | Unconfirmed (may be my input not registering) | Administrator full name was filled ("Audit Admin TR0042") but the result page showed "Name:" blank; the summary panel listed only the email. |
| AUD-03 | LOW | Unconfirmed | With no mail server, the one-time set-password link is shown only on the result page. After leaving it, "+ Admin" offers to create a *new* admin with a typed password; no "resend invitation" seen yet. |
| AUD-04 | INFO | Ops | Email is not set up on the server, so invitations, notifications and password resets by email cannot be tested there. |
