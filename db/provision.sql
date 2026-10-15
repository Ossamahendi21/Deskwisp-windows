-- One-time setup of Deskwisp' place in a Postgres database: its own login (deskwisp_app) and its own schema
-- (deskwisp) inside a database that already exists. Horafirm runs it in horafirm-web's production database
-- (`horafirm`); a self-hoster can use any database. Not run by the app. Run as a superuser, connected to
-- the database Deskwisp goes in:
--   psql "<superuser url to that database>" -v ON_ERROR_STOP=1 -v deskwisp_app_password="$DESKWISP_APP_PASSWORD" -f db/provision.sql
-- The password comes in as a psql variable so it's never written in this file or the shell history.
-- Safe to run again (it sets the password again).

-- The login: it can sign in, own its schema and nothing else. Deskwisp Cloud keeps a pool of 10.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskwisp_app') AS make_role \gset
\if :make_role
CREATE ROLE deskwisp_app LOGIN PASSWORD :'deskwisp_app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 50;
\else
ALTER ROLE deskwisp_app LOGIN PASSWORD :'deskwisp_app_password';
\endif

-- Keep a stuck query or a forgotten transaction from holding a database other apps share, and keep
-- unqualified names inside Deskwisp' own schema.
ALTER ROLE deskwisp_app SET statement_timeout = '15s';
ALTER ROLE deskwisp_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE deskwisp_app SET search_path = deskwisp;

SELECT format('GRANT CONNECT ON DATABASE %I TO deskwisp_app', current_database()) \gexec

-- Deskwisp' tables live here (db/migrations, applied by deskwisp_app). deskwisp_app gets no grants on the other
-- schemas, so it can't read or change the other app's tables.
CREATE SCHEMA IF NOT EXISTS deskwisp AUTHORIZATION deskwisp_app;

-- The one exception to "no grants on the other schemas": Deskwisp' AI credit (cloud/credit.ts; each use
-- is priced in deskwisp.cloud_usage by db/migrations/0007_ai_credit.sql), which lives in horafirm-web's
-- schema so horafirm-web (its Stripe webhook) and Deskwisp Cloud share one balance. Only
-- its two tables; horafirm-web's migration 20261022_deskwisp_plans.sql makes them and grants the same when
-- deskwisp_app exists then. This grants them again for a database where deskwisp_app came after it, and
-- does nothing where they don't exist yet.
SELECT to_regclass('public.deskwisp_ai_credit') IS NOT NULL AND to_regclass('public.deskwisp_ai_credit_grants') IS NOT NULL AS has_ai_credit \gset
\if :has_ai_credit
GRANT SELECT, INSERT, UPDATE ON public.deskwisp_ai_credit, public.deskwisp_ai_credit_grants TO deskwisp_app;
GRANT USAGE ON SEQUENCE public.deskwisp_ai_credit_grants_id_seq TO deskwisp_app;
\endif

-- What deskwisp_app could still reach outside its schema: functions anyone may run. A SECURITY DEFINER
-- one runs as its owner, so each listed here needs a look before Deskwisp Cloud goes live in this
-- database (REVOKE EXECUTE … FROM PUBLIC, and GRANT it back to the roles that use it).
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS public_security_definer_function,
       pg_get_userbyid(p.proowner) AS runs_as
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'deskwisp')
  AND has_function_privilege('deskwisp_app', p.oid, 'EXECUTE')
ORDER BY 1;
