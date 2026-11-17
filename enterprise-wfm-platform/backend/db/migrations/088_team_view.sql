-- "Who is working today" in the employee portal and the app. Team leads (a team's supervisor, deputy or cover, and a group's manager) always see their people:
-- who works, who is off, who is on leave and what kind. This setting decides what everyone else sees, for their own team only.
--   MANAGERS      only team leads (the default: nobody learns who is off or on leave from a colleague)
--   PEERS_NOW     colleagues see who in their team is on shift right now, names only
--   PEERS_ROSTER  colleagues see their team's roster for the next week (leave shows only as "off")
ALTER TABLE self_service_policy ADD COLUMN IF NOT EXISTS team_view text NOT NULL DEFAULT 'MANAGERS' CHECK (team_view IN ('MANAGERS', 'PEERS_NOW', 'PEERS_ROSTER'));
