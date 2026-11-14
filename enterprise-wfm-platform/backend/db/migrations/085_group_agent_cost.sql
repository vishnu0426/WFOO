-- What one paid agent hour costs, so the what-if scenarios can show a staffing cost beside the agents needed. Optional: without it the cost row stays empty.
ALTER TABLE wfm_groups ADD COLUMN IF NOT EXISTS agent_cost_per_hour numeric(10,2) CHECK (agent_cost_per_hour IS NULL OR agent_cost_per_hour >= 0);
