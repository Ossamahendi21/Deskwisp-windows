-- Deskwisp Mail (cloud/mail.ts): bots' email run by the cloud itself, in place of AgentMail, when
-- RESEND_API_KEY and DESKWISP_MAIL_DOMAIN are set. Mail comes in through Cloudflare Email Routing (a
-- Worker posts each email to /mail/inbound) and goes out through Resend. The cloud answers the same
-- calls AgentMail does (the few Deskwisp makes), so the app and the rest of the cloud work unchanged.
--
-- mail_pods: one per user (as an AgentMail pod), found again by client_id. mail_keys: a key that
-- reaches only its pod, kept as its SHA-256 (the key itself is shown once, and the session keeps it
-- sealed). mail_boxes: an inbox; its id is its address. mail_messages: every email in and out, per
-- inbox (`labels` has 'sent' or 'received'); rfc_id is its Message-ID header, for threading and for
-- an email delivered twice. mail_files: attachments, their bytes kept while they're small and new
-- (cloud/mail.ts sweeps old ones).
-- Run as deskwisp_app after 0013 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

CREATE TABLE IF NOT EXISTS deskwisp.mail_pods (
  pod_id     text PRIMARY KEY,
  name       text NOT NULL,
  client_id  text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deskwisp.mail_keys (
  key_hash   text PRIMARY KEY,
  pod_id     text NOT NULL REFERENCES deskwisp.mail_pods (pod_id) ON DELETE CASCADE,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deskwisp.mail_boxes (
  inbox_id     text PRIMARY KEY CHECK (inbox_id = lower(inbox_id)),
  pod_id       text NOT NULL REFERENCES deskwisp.mail_pods (pod_id) ON DELETE CASCADE,
  display_name text,
  client_id    text UNIQUE,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_boxes_pod ON deskwisp.mail_boxes (pod_id);

CREATE TABLE IF NOT EXISTS deskwisp.mail_messages (
  inbox_id    text NOT NULL REFERENCES deskwisp.mail_boxes (inbox_id) ON DELETE CASCADE,
  message_id  text NOT NULL,
  thread_id   text NOT NULL,
  labels      text[] NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now(),
  from_addr   text NOT NULL,
  to_addrs    text[] NOT NULL DEFAULT '{}',
  cc_addrs    text[] NOT NULL DEFAULT '{}',
  reply_to    text[] NOT NULL DEFAULT '{}',
  subject     text,
  preview     text,
  text_body   text,
  html_body   text,
  rfc_id      text,
  in_reply_to text,
  refs        text[] NOT NULL DEFAULT '{}',
  headers     jsonb NOT NULL DEFAULT '{}'::jsonb,
  dmarc       text,
  size        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS mail_messages_at ON deskwisp.mail_messages (inbox_id, at);
CREATE INDEX IF NOT EXISTS mail_messages_thread ON deskwisp.mail_messages (inbox_id, thread_id, at);
CREATE INDEX IF NOT EXISTS mail_messages_rfc ON deskwisp.mail_messages (inbox_id, rfc_id) WHERE rfc_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deskwisp.mail_files (
  attachment_id text PRIMARY KEY,
  inbox_id      text NOT NULL,
  message_id    text NOT NULL,
  filename      text,
  content_type  text,
  disposition   text,
  content_id    text,
  size          integer NOT NULL DEFAULT 0,
  data          bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inbox_id, message_id) REFERENCES deskwisp.mail_messages (inbox_id, message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail_files_message ON deskwisp.mail_files (inbox_id, message_id);
CREATE INDEX IF NOT EXISTS mail_files_kept ON deskwisp.mail_files (created_at) WHERE data IS NOT NULL;

INSERT INTO deskwisp.schema_migrations (version) VALUES ('0014_mail') ON CONFLICT DO NOTHING;

COMMIT;
