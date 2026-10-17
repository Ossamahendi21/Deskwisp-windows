-- Polar's own id for the user's customer (from their subscription): the portal and the customer's
-- subscriptions are asked for by it, since a customer made before Deskwisp named it by our id has none of ours.
ALTER TABLE deskwisp.subscriptions ADD COLUMN IF NOT EXISTS customer_id text;
