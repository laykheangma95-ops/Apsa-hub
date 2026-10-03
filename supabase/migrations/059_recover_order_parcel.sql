-- Migration: 059_recover_order_parcel
-- Purpose: ONE atomic authority for creating the APSA Parcel of an order that
--          is already confirmed but has none (CORRECTION-003 recovery).
--
-- A confirmed order can be left without its parcel when confirmation commits
-- on a database where the parcel is written after the transition (the pre-057
-- path) and that write fails. Recovering it used to be "read lifecycle in the
-- service → await → service-role parcel insert": a cancellation committing in
-- between gave a CANCELLED order an active parcel.
--
-- recover_order_parcel_v1 does the whole decision under the order row lock:
--   1. lock the order row (organization from the trusted server context);
--   2. re-read lifecycle AFTER the lock;
--   3. not confirmed → refuse, write nothing;
--   4. an active parcel exists → return it ('exists'), write nothing;
--   5. otherwise create exactly one active parcel ('created').
-- Cancellation (transition_order_status_v1, 057) locks the same row FOR
-- UPDATE, so the two serialize: whichever takes the lock first decides, and
-- the other sees its committed result. Two recoveries serialize the same way;
-- uniq_parcels_org_order_active remains the last line of defence.
--
-- No status change, no stock movement, no history row: recovery completes the
-- parcel that confirmation already owed; it is not a lifecycle transition.
-- Additive: no table, column or policy changes. service_role only.

CREATE OR REPLACE FUNCTION public.recover_order_parcel_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_actor           UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lifecycle TEXT;
  v_parcel    RECORD;
BEGIN
  SELECT lifecycle_status::TEXT INTO v_lifecycle
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_lifecycle <> 'confirmed' THEN
    RETURN jsonb_build_object('status', 'not_confirmed', 'current', v_lifecycle);
  END IF;

  SELECT id, parcel_code INTO v_parcel
  FROM public.parcels
  WHERE organization_id = p_organization_id AND order_id = p_order_id AND status <> 'void'
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'exists',
                              'parcel_id', v_parcel.id, 'parcel_code', v_parcel.parcel_code);
  END IF;

  INSERT INTO public.parcels (organization_id, order_id, parcel_code, status, created_by)
  VALUES (p_organization_id, p_order_id, public.new_apsa_parcel_code_v1(), 'created', p_actor)
  RETURNING id, parcel_code INTO v_parcel;

  RETURN jsonb_build_object('status', 'created',
                            'parcel_id', v_parcel.id, 'parcel_code', v_parcel.parcel_code);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.recover_order_parcel_v1(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_order_parcel_v1(UUID, UUID, UUID) TO service_role;
