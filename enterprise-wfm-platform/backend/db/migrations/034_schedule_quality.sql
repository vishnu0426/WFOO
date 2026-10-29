-- Schedule quality: company defaults for consistent shifts and publish checks, per-person overrides, publish acknowledgements,
-- and which skill each queue's work needs (for skill-by-interval requirements).

-- Company-wide scheduling defaults, kept as one document so new options need no new columns:
-- { consistentTimes: { mode: 'OFF'|'PREFER'|'REQUIRE', startToleranceMin, endToleranceMin }, targetCoverage, enforcePublishChecks, breakSlackMin }
ALTER TABLE scheduling_policy ADD COLUMN IF NOT EXISTS defaults jsonb NOT NULL DEFAULT '{}';

-- Per-person override of the company default, and an optional assigned usual start time (15-minute slot of the day).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS shift_consistency text NOT NULL DEFAULT 'DEFAULT' CHECK (shift_consistency IN ('DEFAULT','REQUIRE','PREFER','OFF'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS fixed_start_slot int CHECK (fixed_start_slot BETWEEN 0 AND 95);

-- A planner who publishes a schedule with a known shortage or a stale forecast records who accepted it and why.
ALTER TABLE schedule_versions ADD COLUMN IF NOT EXISTS ack jsonb;

-- The skill a queue's contacts need. Queues that share a group but need different skills are staffed per skill.
ALTER TABLE queues ADD COLUMN IF NOT EXISTS skill_id uuid REFERENCES skills(id) ON DELETE SET NULL;
