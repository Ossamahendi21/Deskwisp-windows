-- Free's AI credit comes every month ($1, dcloud/src/plans.ts), like a paid plan's, instead of once.
-- The balance (what cloud/ asks before each use, and GET /api/deskwisp/plan) gives it: a user on Free
-- with no plan credit running gets this month's, once per month (its "invoice" is free:<user>:<month>),
-- through the same grant the paid plans use, so nothing carries over. A paid plan's credit that's still
-- running after a move to Free is kept until it ends. No one-time credit for new users any more; what's
-- left of one given before stays (free_micros).
CREATE OR REPLACE FUNCTION public.deskwisp_ai_credit_balance(p_user uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_left  bigint;
  v_start timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF EXISTS (SELECT 1 FROM deskwisp.users WHERE id = p_user AND plan = 'free_deskwisp')
     AND NOT EXISTS (SELECT 1 FROM public.deskwisp_ai_credit WHERE user_id = p_user AND plan_expires_at > now()) THEN
    PERFORM public.deskwisp_ai_credit_grant_plan(
      p_user, 'free:' || p_user::text || ':' || to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM'),
      'free_deskwisp', 1000000, v_start, v_start + interval '1 month');
  END IF;
  SELECT (CASE WHEN plan_expires_at > now() THEN plan_micros ELSE 0 END) + free_micros
    INTO v_left
    FROM public.deskwisp_ai_credit WHERE user_id = p_user;
  RETURN COALESCE(v_left, 0);
END
$$;
