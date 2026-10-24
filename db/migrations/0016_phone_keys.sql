-- Bots' phone numbers on the user's own AgentPhone account (cloud/phone-key.ts): the user pays AgentPhone
-- for their numbers, calls and texts, and gives Deskwisp their API key, which every AgentPhone call of
-- theirs then uses (proxy.ts) in place of Deskwisp's. Kept sealed (crypto.ts), with its last four
-- characters to show which key it is.
-- Run as deskwisp_app after 0015 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

CREATE TABLE IF NOT EXISTS deskwisp.phone_keys (
  user_id    text PRIMARY KEY REFERENCES deskwisp.cloud_accounts (user_id) ON DELETE CASCADE,
  key_sealed text NOT NULL,
  last4      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0016_phone_keys') ON CONFLICT DO NOTHING;

COMMIT;
