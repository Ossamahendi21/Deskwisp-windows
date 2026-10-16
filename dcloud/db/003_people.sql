-- People: who the owner of a workspace lets watch (View only) or use (Full access) its computers, from
-- the app's People sheet, in their browser at /watch. An invite is a row with no user yet and a token
-- for its link; accepting it (signed in with the invited email) fills in the user and drops the token.
-- Each computer also gets a second VNC password that only lets someone watch (x11vnc's view-only one).
-- Safe to run again.

ALTER TABLE deskwisp.computers ADD COLUMN IF NOT EXISTS view_password text;

CREATE TABLE IF NOT EXISTS deskwisp.members (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES deskwisp.workspaces(id) ON DELETE CASCADE,
  email         text NOT NULL,
  role          text NOT NULL CHECK (role IN ('member', 'admin')),
  user_id       uuid REFERENCES deskwisp.users(id) ON DELETE CASCADE,
  token         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS members_workspace_email ON deskwisp.members(workspace_id, lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS members_token ON deskwisp.members(token) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS members_user ON deskwisp.members(user_id);
