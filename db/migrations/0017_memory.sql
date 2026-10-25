-- Deskwisp's own long-term memory (cloud/memory.ts), where Honcho isn't used: each user's banks (one per
-- Deskwisp workspace, or one shared by several), the facts learned about them, and their card. The PC
-- app (lib/server/memory.ts), the cloud's own answers (agent.ts) and the phone app all read the same.
-- Run as deskwisp_app after 0016 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

CREATE TABLE IF NOT EXISTS deskwisp.memory_facts (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES deskwisp.cloud_accounts (user_id) ON DELETE CASCADE,
  bank       text NOT NULL,
  content    text NOT NULL CHECK (length(content) <= 1000),
  session_id text,
  level      text NOT NULL DEFAULT 'explicit',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_facts_bank ON deskwisp.memory_facts (user_id, bank, created_at DESC);

CREATE TABLE IF NOT EXISTS deskwisp.memory_cards (
  user_id    text NOT NULL REFERENCES deskwisp.cloud_accounts (user_id) ON DELETE CASCADE,
  bank       text NOT NULL,
  lines      jsonb NOT NULL DEFAULT '[]',
  pinned     jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bank)
);

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0017_memory') ON CONFLICT DO NOTHING;

COMMIT;
