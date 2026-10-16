-- Each user's plan (dcloud/src/plans.ts): Free until billing says otherwise.
ALTER TABLE deskwisp.users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free_deskwisp'
  CHECK (plan IN ('free_deskwisp', 'pro_deskwisp', 'max_deskwisp'));
