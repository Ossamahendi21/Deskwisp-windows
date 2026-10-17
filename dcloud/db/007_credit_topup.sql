-- AI credit added once (a top-up): any whole-dollar amount from $5 to $1,000, paid through Polar
-- (dcloud/src/billing.ts), at face value. It goes to the credit that doesn't expire (free_micros, which
-- the app shows as "Plus $X that doesn't expire"), spent after the month's plan credit. Granted once per
-- payment: its reference ("polar:checkout:<id>") is unique, so the payment page coming back and Polar's
-- webhook can both say it was paid and it's added once.
ALTER TABLE public.deskwisp_ai_credit_grants DROP CONSTRAINT IF EXISTS deskwisp_ai_credit_grants_kind_check;
ALTER TABLE public.deskwisp_ai_credit_grants
  ADD CONSTRAINT deskwisp_ai_credit_grants_kind_check CHECK (kind IN ('free_signup', 'plan', 'topup'));

-- Add a paid top-up. Returns the micros added, or NULL when that payment was added before.
CREATE OR REPLACE FUNCTION public.deskwisp_ai_credit_grant_topup(p_user uuid, p_ref text, p_tier text, p_amount bigint) RETURNS bigint
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('deskwisp_ai_credit:' || p_user::text));
  INSERT INTO public.deskwisp_ai_credit_grants (user_id, kind, tier, amount_micros, stripe_invoice_id)
  VALUES (p_user, 'topup', p_tier, p_amount, p_ref)
  ON CONFLICT (stripe_invoice_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.deskwisp_ai_credit AS c (user_id, free_micros) VALUES (p_user, p_amount)
  ON CONFLICT (user_id) DO UPDATE SET free_micros = c.free_micros + p_amount, updated_at = now();
  RETURN p_amount;
END
$$;
