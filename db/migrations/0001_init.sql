-- Deskwisp state, one row per Horafirm user. Run as deskwisp_app (the database owner) against the deskwisp database:
--   psql "$DESKWISP_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
-- Safe to run again.

BEGIN;

-- In horafirm-web's database the schema is made beforehand by the superuser, owned by deskwisp_app, which
-- can't create schemas there (db/provision.sql). CREATE SCHEMA IF NOT EXISTS would still need that
-- right, so only make it when it's missing (a database of Deskwisp' own).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'deskwisp') THEN
    CREATE SCHEMA deskwisp;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS deskwisp.schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The whole AppState (lib/types.ts) as JSONB, keyed by the Horafirm user id (state.account.user.id).
-- version is bumped on every save; a server only writes over the version it last read
-- (lib/server/persist-pg.ts), so two servers for one user can't silently overwrite each other.
CREATE TABLE IF NOT EXISTS deskwisp.app_state (
  user_id    text PRIMARY KEY,
  state      jsonb NOT NULL,
  version    bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- For "who was active lately" and stale-row sweeps.
CREATE INDEX IF NOT EXISTS app_state_updated_at ON deskwisp.app_state (updated_at);

-- Copies taken before "Start over" (resetState), like .data/backups on the desktop.
CREATE TABLE IF NOT EXISTS deskwisp.app_state_backups (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL,
  state      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_state_backups_user ON deskwisp.app_state_backups (user_id, created_at DESC);

-- The usage ledger (state.usage, lib/server/usage.ts) as rows, for reporting across users. A view,
-- not a table: the state row stays the one copy, so the two can't disagree. Make it a table fed by
-- the server when billing needs history beyond what the state keeps (the newest 20,000 events).
CREATE OR REPLACE VIEW deskwisp.usage_events AS
SELECT
  s.user_id,
  e->>'kind'                                      AS kind,
  to_timestamp((e->>'at')::double precision / 1000) AS at,
  e->>'botId'                                     AS bot_id,
  (e->>'qty')::double precision                   AS qty,
  e->>'model'                                     AS model,
  e->>'source'                                    AS source,
  (e->>'inputTokens')::bigint                     AS input_tokens,
  (e->>'outputTokens')::bigint                    AS output_tokens
FROM deskwisp.app_state s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.state->'usage', '[]'::jsonb)) AS e;

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0001_init') ON CONFLICT DO NOTHING;

COMMIT;
