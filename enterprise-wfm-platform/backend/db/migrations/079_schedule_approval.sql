-- Schedule approval. A draft can be submitted for review, approved or sent back; when the organisation requires approval, only an approved draft can be published.
-- The state sits beside the status (a schedule stays a DRAFT while it is under review), and each step remembers the revision it was given for, so a schedule that is
-- edited after it was submitted or approved is no longer the one that was reviewed and goes back to needing review.
ALTER TABLE schedule_versions
  ADD COLUMN IF NOT EXISTS approval_state text NOT NULL DEFAULT 'NONE' CHECK (approval_state IN ('NONE', 'SUBMITTED', 'APPROVED')),
  ADD COLUMN IF NOT EXISTS submitted_by text,
  ADD COLUMN IF NOT EXISTS submitted_by_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_rev int,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_by_id uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_rev int,
  ADD COLUMN IF NOT EXISTS review_note text;
