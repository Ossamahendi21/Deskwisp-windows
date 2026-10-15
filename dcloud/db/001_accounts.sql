-- Deskwisp Cloud: users (Clerk), their apps' keys, sign-ins under way, workspaces and computers.
-- Everything lives in the "deskwisp" schema. An app key is never stored, only its SHA-256.

CREATE SCHEMA IF NOT EXISTS deskwisp;

CREATE TABLE deskwisp.users (
  id          uuid PRIMARY KEY,
  clerk_id    text NOT NULL UNIQUE,
  email       text,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deskwisp.app_keys (
  key_hash     text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES deskwisp.users(id) ON DELETE CASCADE,
  label        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX app_keys_user ON deskwisp.app_keys(user_id);

CREATE TABLE deskwisp.device_codes (
  id          uuid PRIMARY KEY,
  device_hash text NOT NULL UNIQUE,
  user_code   text NOT NULL UNIQUE,
  hostname    text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  user_id     uuid REFERENCES deskwisp.users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Owners are text: a user's id, or the name given to a key in DESKWISP_API_KEYS (development).
CREATE TABLE deskwisp.workspaces (
  id          uuid PRIMARY KEY,
  owner       text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspaces_owner_name ON deskwisp.workspaces(owner, lower(btrim(name)));

CREATE TABLE deskwisp.computers (
  id            uuid PRIMARY KEY,
  owner         text NOT NULL,
  workspace_id  uuid NOT NULL REFERENCES deskwisp.workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  box_id        text NOT NULL,
  provider      text NOT NULL,
  vnc_password  text NOT NULL,
  cpu           integer NOT NULL,
  ram           integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX computers_owner ON deskwisp.computers(owner);
