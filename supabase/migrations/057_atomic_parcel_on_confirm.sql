-- Migration: 057_atomic_parcel_on_confirm
-- Purpose: Create the order's APSA Parcel ATOMICALLY with order confirmation
--          (CORRECTION-003). Before this, the service created the parcel
--          best-effort after the confirmation had committed, so a confirmed
--          order could exist without its parcel and a later operation (Arrange
--          Delivery) could end up creating it.
--
-- What changes:
--   1. new_apsa_parcel_code_v1() — the opaque APSA:PCL:v1:<22 base64url> code,
--      identical in shape to src/lib/barcode/parcel-code.ts (128 bits from two
--      gen_random_uuid() values, core PostgreSQL — no extension needed).
--   2. transition_order_status_v1 (re-declared from 054 — body copied verbatim)
--      gains ONE branch: lifecycle -> 'confirmed' locks the order, runs the
--      existing confirm, then retrieves or creates the order's active parcel in
--      the same transaction and returns parcel_id / parcel_code. A parcel insert
--      failure rolls back the confirmation, its stock movements and history.
--      Every other axis/transition behaves exactly as in 054.
--
-- Historical orders confirmed before this migration are backfilled separately
-- (058_backfill_apsa_parcels.sql). Additive: no table, column or policy changes.

-- ── Parcel code generator ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.new_apsa_parcel_code_v1()
RETURNS TEXT
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT 'APSA:PCL:v1:' || rtrim(
    translate(
      encode(decode(md5(gen_random_uuid()::text || gen_random_uuid()::text), 'hex'), 'base64'),
      '+/', '-_'),
    '=');
$fn$;

REVOKE EXECUTE ON FUNCTION public.new_apsa_parcel_code_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.new_apsa_parcel_code_v1() TO service_role;

-- ── transition_order_status_v1: confirm creates the APSA Parcel atomically ───

CREATE OR REPLACE FUNCTION public.transition_order_status_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_axis            TEXT,
  p_expected_from   TEXT,
  p_to              TEXT,
  p_changed_by      UUID DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order   RECORD;
  v_current TEXT;
  v_at      TIMESTAMPTZ;
  v_result  JSONB;
  v_parcel  RECORD;
BEGIN
  IF p_axis IN ('payment', 'refund') THEN
    RETURN jsonb_build_object('status', 'payment_domain_required');
  END IF;

  IF p_axis = 'fulfillment' THEN
    SELECT id, lifecycle_status, fulfillment_status INTO v_order
    FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

    v_current := v_order.fulfillment_status::TEXT;
    IF v_current <> p_expected_from THEN
      RETURN jsonb_build_object('status', 'stale', 'current', v_current);
    END IF;
    IF v_current = p_to THEN
      RETURN jsonb_build_object('status', 'no_change', 'current', v_current);
    END IF;
    IF v_order.lifecycle_status IN ('cancelled', 'completed') THEN
      RETURN jsonb_build_object('status', 'terminal',
                                'lifecycle', v_order.lifecycle_status::TEXT);
    END IF;

    v_at := public.next_fulfillment_event_at_v1(p_organization_id, p_order_id);
    UPDATE public.orders SET fulfillment_status = p_to::public.order_fulfillment_status
    WHERE id = p_order_id;
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment', v_current, p_to, p_changed_by, p_reason, v_at
    );
    RETURN jsonb_build_object('status', 'success', 'axis', p_axis,
                              'from', v_current, 'to', p_to, 'stock_movements', 0);
  END IF;

  -- Confirmation = the order enters fulfillment, so its APSA Parcel is created
  -- in the SAME transaction (CORRECTION-003). The order row is locked first;
  -- the existing confirm (stock 'sale' movements, history) runs under that
  -- lock; then the order's one active parcel is retrieved or created. Any
  -- failure raises, and the whole confirmation — lifecycle, stock movements,
  -- fulfillment history — rolls back with it. No confirmed order without a
  -- parcel can be committed.
  IF p_axis = 'lifecycle' AND p_to = 'confirmed' THEN
    PERFORM 1 FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id
    FOR UPDATE;

    v_result := public.transition_order_before_payment_authority_v1(
      p_organization_id, p_order_id, p_axis, p_expected_from, p_to, p_changed_by, p_reason);
    IF v_result->>'status' <> 'success' THEN
      RETURN v_result;
    END IF;

    SELECT id, parcel_code INTO v_parcel
    FROM public.parcels
    WHERE organization_id = p_organization_id AND order_id = p_order_id AND status <> 'void'
    LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO public.parcels (organization_id, order_id, parcel_code, status, created_by)
      VALUES (p_organization_id, p_order_id, public.new_apsa_parcel_code_v1(), 'created',
              p_changed_by)
      RETURNING id, parcel_code INTO v_parcel;
    END IF;

    RETURN v_result || jsonb_build_object('parcel_id', v_parcel.id,
                                          'parcel_code', v_parcel.parcel_code);
  END IF;

  IF p_axis = 'lifecycle' AND p_to = 'cancelled' THEN
    SELECT id, lifecycle_status, fulfillment_status INTO v_order
    FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id
    FOR UPDATE;
    IF FOUND
       AND v_order.lifecycle_status::TEXT = p_expected_from
       AND v_order.lifecycle_status NOT IN ('cancelled', 'completed')
       AND v_order.fulfillment_status <> 'cancelled' THEN
      v_at := public.next_fulfillment_event_at_v1(p_organization_id, p_order_id);
      INSERT INTO public.order_status_history (
        organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
      ) VALUES (
        p_organization_id, p_order_id, 'fulfillment', v_order.fulfillment_status::TEXT,
        'cancelled', p_changed_by, 'Order cancelled', v_at
      );
      UPDATE public.orders SET fulfillment_status = 'cancelled' WHERE id = p_order_id;

      v_result := public.transition_order_before_payment_authority_v1(
        p_organization_id, p_order_id, p_axis, p_expected_from, p_to, p_changed_by, p_reason);
      IF v_result->>'status' <> 'success' THEN
        RAISE EXCEPTION 'transition_order_status_v1: cancellation pre-check disagreed: %', v_result;
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  RETURN public.transition_order_before_payment_authority_v1(
    p_organization_id, p_order_id, p_axis, p_expected_from, p_to, p_changed_by, p_reason);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT)
  TO service_role;
