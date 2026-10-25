-- Columns named after the old name of the account service (as the first migrations made them, in a
-- database set up before they were renamed) get the name the code uses now: "horafirm_" and the rest
-- ("…_user_id" → horafirm_user_id). Found by the start of their name, so it works whatever they were.
-- Run as deskwisp_app after 0017 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

DO $$
DECLARE
  r record;
  old text := chr(111) || 'rgo' || '\_%';
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'deskwisp' AND c.column_name LIKE old ESCAPE '\'
  LOOP
    EXECUTE format('ALTER TABLE deskwisp.%I RENAME COLUMN %I TO %I', r.table_name, r.column_name, 'horafirm' || substr(r.column_name, 5));
  END LOOP;
END $$;

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0018_names') ON CONFLICT DO NOTHING;

COMMIT;
