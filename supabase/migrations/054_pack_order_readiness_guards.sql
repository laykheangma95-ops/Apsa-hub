-- Migration: 054_pack_order_readiness_guards
-- V1 Pack Order (PR #107): make "packed" and delivery readiness consistent
-- under concurrency. Forward-only; adds two functions, no tables, no columns,
-- and changes no existing function.
--
-- Packed is CURRENT state. The order is packed when its newest Pack Order
-- marker (reason 'pack_order_packed', written only by the Pack Order service)
-- is newer than the last time its fulfillment was reopened to 'unfulfilled'.
-- Not a reopen:
--   * Pack Order's own re-record step (the row carries the marker)
--   * the move transition_delivery_status_v1 writes when a delivery attempt is
--     cancelled/failed: it shares that delivery row's transaction timestamp.
--     A delivery cancelled BY a reopen is tagged
--     'system:order_fulfillment_reopened' and does not earn that exemption.
-- The TypeScript twin of this rule is isOrderCurrentlyPacked in src/lib/pack.ts.
--
-- Lock order in both functions is delivery → order, the same order
-- transition_delivery_status_v1 uses, so the three never deadlock each other.

-- ── Reopen order fulfillment ─────────────────────────────────────────────────
--
-- processing → unfulfilled ("packing stopped; back in the queue"), and in the
-- same transaction the order's 'ready' delivery is cancelled: a reopened order
-- must go through Pack Order again before Courier Handoff, so readiness may not
-- survive the reopen. pending/preparing deliveries are not ready and stay as
-- they are (readying them needs a current packed state, see below); an
-- in_transit delivery has already been handed off and is not touched.
--
-- The order row and the cancelled delivery row share one explicit timestamp
-- taken after both locks are held, so the reopen is ordered after every
-- transaction that committed before it.
CREATE FUNCTION public.reopen_order_fulfillment_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_changed_by      UUID DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_delivery     RECORD;
  v_has_delivery BOOLEAN;
  v_order        RECORD;
  v_at           TIMESTAMPTZ;
  v_cancelled_id UUID := NULL;
BEGIN
  SELECT id, status INTO v_delivery
  FROM public.deliveries
  WHERE organization_id = p_organization_id
    AND order_id = p_order_id
    AND status IN ('pending', 'preparing', 'ready', 'in_transit')
  FOR UPDATE;
  v_has_delivery := FOUND;

  SELECT id, lifecycle_status, fulfillment_status INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_order.lifecycle_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'order_terminal');
  END IF;
  IF v_order.fulfillment_status <> 'processing' THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_order.fulfillment_status::TEXT);
  END IF;

  v_at := clock_timestamp();

  IF v_has_delivery AND v_delivery.status = 'ready' THEN
    UPDATE public.deliveries SET status = 'cancelled' WHERE id = v_delivery.id;
    INSERT INTO public.delivery_status_history (
      organization_id, delivery_id, from_status, to_status, changed_by, reason, created_at
    ) VALUES (
      p_organization_id, v_delivery.id, 'ready', 'cancelled', p_changed_by,
      'system:order_fulfillment_reopened', v_at
    );
    v_cancelled_id := v_delivery.id;
  END IF;

  UPDATE public.orders SET fulfillment_status = 'unfulfilled' WHERE id = p_order_id;
  INSERT INTO public.order_status_history (
    organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
  ) VALUES (
    p_organization_id, p_order_id, 'fulfillment', 'processing', 'unfulfilled', p_changed_by,
    NULLIF(trim(p_reason), ''), v_at
  );

  RETURN jsonb_build_object(
    'status', 'success', 'cancelled_delivery_id', v_cancelled_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reopen_order_fulfillment_v1(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_order_fulfillment_v1(UUID, UUID, UUID, TEXT)
  TO service_role;

-- ── Ready a packed order's delivery ─────────────────────────────────────────
--
-- Used by Arrange Delivery (auto-ready) and Retry delivery ready. With the
-- delivery and the order locked, it verifies in ONE transaction that the order
-- is currently packed (no newer reopen) and only then moves the delivery
-- pending/preparing → ready. A reopen that commits first is seen here and
-- the call returns not_packed; a reopen that comes later waits for the locks
-- and then cancels the delivery this call readied.
--
-- The rows it writes carry 'system:pack_order_delivery_ready', never the packed
-- marker: readying a delivery is not packing and can never recreate Packed.
CREATE FUNCTION public.ready_packed_delivery_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_delivery_id     UUID,
  p_changed_by      UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_delivery     RECORD;
  v_order        RECORD;
  v_last_packed  TIMESTAMPTZ;
  v_last_cleared TIMESTAMPTZ;
  v_reason       CONSTANT TEXT := 'system:pack_order_delivery_ready';
BEGIN
  SELECT id, status INTO v_delivery
  FROM public.deliveries
  WHERE id = p_delivery_id
    AND organization_id = p_organization_id
    AND order_id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_delivery.status IN ('ready', 'in_transit') THEN
    RETURN jsonb_build_object('status', 'already_ready', 'current', v_delivery.status::TEXT);
  END IF;
  IF v_delivery.status NOT IN ('pending', 'preparing') THEN
    RETURN jsonb_build_object('status', 'invalid_transition', 'current', v_delivery.status::TEXT);
  END IF;

  SELECT id, lifecycle_status, fulfillment_status INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_order.lifecycle_status <> 'confirmed'
     OR v_order.fulfillment_status IN ('fulfilled', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'invalid_order');
  END IF;

  -- Newest Pack Order marker, on the order or on any of its deliveries.
  SELECT max(marked.at) INTO v_last_packed
  FROM (
    SELECT h.changed_at AS at
    FROM public.order_status_history h
    WHERE h.organization_id = p_organization_id
      AND h.order_id = p_order_id
      AND h.axis = 'fulfillment'
      AND h.reason = 'pack_order_packed'
    UNION ALL
    SELECT dh.created_at
    FROM public.delivery_status_history dh
    JOIN public.deliveries d ON d.id = dh.delivery_id
    WHERE d.organization_id = p_organization_id
      AND d.order_id = p_order_id
      AND dh.organization_id = p_organization_id
      AND dh.reason = 'pack_order_packed'
  ) AS marked;
  IF v_last_packed IS NULL THEN
    RETURN jsonb_build_object('status', 'not_packed');
  END IF;

  -- Newest reopen: a move back to 'unfulfilled' that is neither Pack Order's
  -- re-record step nor a retired (cancelled/failed) delivery attempt.
  SELECT max(h.changed_at) INTO v_last_cleared
  FROM public.order_status_history h
  WHERE h.organization_id = p_organization_id
    AND h.order_id = p_order_id
    AND h.axis = 'fulfillment'
    AND h.to_status = 'unfulfilled'
    AND h.reason IS DISTINCT FROM 'pack_order_packed'
    AND NOT EXISTS (
      SELECT 1
      FROM public.delivery_status_history dh
      JOIN public.deliveries d ON d.id = dh.delivery_id
      WHERE d.organization_id = p_organization_id
        AND d.order_id = p_order_id
        AND dh.organization_id = p_organization_id
        AND dh.to_status IN ('cancelled', 'failed')
        AND dh.created_at = h.changed_at
        AND dh.reason IS DISTINCT FROM 'system:order_fulfillment_reopened'
    );
  IF v_last_cleared IS NOT NULL AND v_last_packed <= v_last_cleared THEN
    RETURN jsonb_build_object('status', 'not_packed');
  END IF;

  IF v_delivery.status = 'pending' THEN
    UPDATE public.deliveries SET status = 'preparing' WHERE id = v_delivery.id;
    INSERT INTO public.delivery_status_history (
      organization_id, delivery_id, from_status, to_status, changed_by, reason
    ) VALUES (
      p_organization_id, v_delivery.id, 'pending', 'preparing', p_changed_by, v_reason
    );
  END IF;
  UPDATE public.deliveries SET status = 'ready' WHERE id = v_delivery.id;
  INSERT INTO public.delivery_status_history (
    organization_id, delivery_id, from_status, to_status, changed_by, reason
  ) VALUES (
    p_organization_id, v_delivery.id, 'preparing', 'ready', p_changed_by, v_reason
  );

  -- Same coarse Order fulfillment mapping as transition_delivery_status_v1.
  IF v_order.fulfillment_status <> 'processing' THEN
    UPDATE public.orders SET fulfillment_status = 'processing' WHERE id = p_order_id;
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment', v_order.fulfillment_status::TEXT,
      'processing', p_changed_by, 'Delivery status: ready'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'success', 'from', v_delivery.status::TEXT, 'to', 'ready'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ready_packed_delivery_v1(UUID, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ready_packed_delivery_v1(UUID, UUID, UUID, UUID)
  TO service_role;
