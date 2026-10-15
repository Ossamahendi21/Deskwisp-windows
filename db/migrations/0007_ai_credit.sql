-- AI credit (cloud/credit.ts, cloud/pricing.ts): what each metered use cost Horafirm, so it can be taken
-- from the user's AI credit (horafirm-web's public.deskwisp_ai_credit, granted to deskwisp_app by horafirm-web's
-- 20261022_deskwisp_plans.sql), and the model an Agents API session runs on, so its turns are priced at
-- it. Run as deskwisp_app after 0006 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- What the use cost, in micro-dollars (1 cent = 10,000), at what OpenAI, AgentPhone, Twilio or
-- Typesafe charge Horafirm. A row seen more than once (recordUsageFor) holds the most it was priced at.
ALTER TABLE deskwisp.cloud_usage ADD COLUMN IF NOT EXISTS cost_micros bigint NOT NULL DEFAULT 0;

-- An Agents API session's model (agent.model when it was made), for pricing its turns.
ALTER TABLE deskwisp.cloud_objects ADD COLUMN IF NOT EXISTS model text;

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0007_ai_credit') ON CONFLICT DO NOTHING;

COMMIT;
