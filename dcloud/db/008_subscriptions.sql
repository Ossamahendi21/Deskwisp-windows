-- Each user's paid plan as Polar has it (dcloud/src/billing.ts syncSubscription): which subscription,
-- its tier and status, and the period it's in. deskwisp.users.plan stays what the plan is; this is where
-- it comes from, so the app can say when it renews or ends, and a payment that failed.
CREATE TABLE IF NOT EXISTS deskwisp.subscriptions (
  user_id              uuid PRIMARY KEY REFERENCES deskwisp.users(id) ON DELETE CASCADE,
  subscription_id      text NOT NULL,
  tier                 text NOT NULL CHECK (tier IN ('free_deskwisp', 'pro_deskwisp', 'max_deskwisp')),
  status               text NOT NULL,
  period_start         timestamptz,
  period_end           timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deskwisp_subscriptions_by_id ON deskwisp.subscriptions (subscription_id);
