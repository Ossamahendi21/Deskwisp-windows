-- How long each user's computers ran each month (dcloud/src/computers.ts counts it while a computer is
-- awake): what the plan's hours are held to. Owners are text, like computers.owner.
CREATE TABLE IF NOT EXISTS deskwisp.computer_time (
  owner      text NOT NULL,
  month      text NOT NULL,
  seconds    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, month)
);
