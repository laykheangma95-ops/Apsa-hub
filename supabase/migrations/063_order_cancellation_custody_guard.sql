-- Migration: 063_order_cancellation_custody_guard
-- Purpose: An order may be cancelled only while its goods are still in the
--          merchant's custody and no shipment is active. Decided under the
--          order row lock, in the same transaction as the cancellation.
--
-- ── The defect (reproduced against 001–061 on PGlite and PostgreSQL 16) ──────
-- transition_order_status_v1 (026 → 054 → 057) accepted lifecycle
-- confirmed → cancelled whatever had happened to the goods. Its cancellation
-- releases every sold line back to stock (026, STOCK_RELEASING_TRANSITION), so:
--   * a DELIVERED order, or one handed over at the counter (fulfillment
--     'fulfilled'), was cancelled and its units were restocked while the
--     customer kept them — phantom stock that can be sold a second time;
--   * an IN-TRANSIT order was restocked while the goods were with the courier,
--     and its delivery was frozen in 'in_transit' for good: every later
--     delivery transition (delivered / failed) returns 'order_terminal', so the
--     COD outcome can never be recorded;
--   * a pending / preparing / ready delivery was left active on a cancelled
--     order, equally frozen: it can be neither cancelled nor handed over;
--   * the fulfillment axis could reach 'cancelled' first (processing →
--     cancelled, orders.cancel) with a shipment in flight, after which the
--     lifecycle cancellation skipped 057's branch and restocked through the
--     legacy body anyway.
-- Lock-step races (handoff, delivered, counter fulfilment or Arrange Delivery
-- committing while the cancellation waits on the order lock) serialize
-- correctly on the order row; the waiting cancellation then acted on goods
-- that had already left. The missing piece was the rule, not the lock.
--
-- ── The rule: order_cancellation_block_v1 ────────────────────────────────────
-- Evaluated after the order row lock is held. Returns NULL when cancellation
-- is safe, otherwise why it is not:
--   'goods_with_customer'  fulfillment is 'fulfilled' (delivered, or handed
--                          over at the counter). The way back is a Customer
--                          Return (056), which restocks only what comes back.
--   'goods_dispatched'     a delivery is 'in_transit' or 'delivered': the goods
--                          left with the courier. Record the delivery outcome
--                          (delivered → return; failed → goods come back, the
--                          order returns to unfulfilled and may be cancelled).
--   'active_delivery'      a delivery is pending / preparing / ready: cancel
--                          that shipment first (its own audited flow), then the
--                          order. Nothing here cancels a shipment implicitly.
-- A 'failed' or 'cancelled' delivery does not block: the delivery domain has
-- already returned the order to 'unfulfilled' (054, transition_delivery_status_v1).
--
-- Every writer of deliveries.status or of orders.fulfillment_status takes this
-- order's row lock (create_delivery_v1, transition_delivery_status_v1,
-- reopen_order_fulfillment_v1, ready_packed_delivery_v1, record_order_packed_v1,
-- transition_order_status_v1); service_role holds SELECT only on deliveries
-- (048, 061). Reading deliveries after acquiring the order lock is therefore
-- authoritative, and the guard takes NO delivery row lock — so it adds no new
-- lock order (054's delivery → order discipline is untouched) and cannot
-- deadlock with a delivery transition.
--
-- ── Where it applies ─────────────────────────────────────────────────────────
--   lifecycle  confirmed → cancelled   refused with
--              {status: 'cancel_blocked', reason}; nothing written — no status,
--              no history, no stock movement.
--   fulfillment  * → cancelled         refused the same way, which closes the
--              fulfillment-first bypass above.
-- Not changed: draft → cancelled (a draft never consumed stock and cannot own a
-- delivery: create_delivery_v1 requires 'confirmed'); confirmation and its
-- atomic parcel (057); completion; stale / no_change / terminal / not_found
-- envelopes (a stale or cross-tenant call is answered exactly as before, ahead
-- of the guard); the customer-return trigger (056), kept as a backstop.
--
-- ── Not changed: money ───────────────────────────────────────────────────────
-- Payments, refunds and the order's payment / refund axes are untouched. This
-- migration reads no payment table and calls no payment function, so it is
-- independent of 062 (pending, PR #121), which re-declares only payment
-- functions. Whether a paid order may be cancelled before it is refunded is an
-- open project-owner decision and is deliberately NOT decided here.
--
-- Forward-only. No table, column, policy or grant on any relation changes.

-- ── The custody rule ─────────────────────────────────────────────────────────
-- Caller MUST hold the order's row lock (see above).
CREATE FUNCTION public.order_cancellation_block_v1(
  p_organization_id UUID,
  p_order_id        UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = p_order_id AND o.organization_id = p_organization_id
        AND o.fulfillment_status = 'fulfilled'
    ) THEN 'goods_with_customer'
    WHEN EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.organization_id = p_organization_id AND d.order_id = p_order_id
        AND d.status IN ('in_transit', 'delivered')
    ) THEN 'goods_dispatched'
    WHEN EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.organization_id = p_organization_id AND d.order_id = p_order_id
        AND d.status IN ('pending', 'preparing', 'ready')
    ) THEN 'active_delivery'
    ELSE NULL
  END;
$$;

-- Internal helper: only transition_order_status_v1 (SECURITY DEFINER) calls it.
REVOKE EXECUTE ON FUNCTION public.order_cancellation_block_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── transition_order_status_v1 (re-declared from 057) ────────────────────────
-- 057's body, unchanged except for the two guarded blocks marked "063".
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
  v_block   TEXT;
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

    -- 063: fulfillment cannot be called off once the goods left custody or
    -- while a shipment is active (under the order lock taken above).
    IF p_to = 'cancelled' THEN
      v_block := public.order_cancellation_block_v1(p_organization_id, p_order_id);
      IF v_block IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'cancel_blocked', 'reason', v_block);
      END IF;
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

    -- 063: a confirmed sale is cancelled — and its stock released — only while
    -- the goods are still in the merchant's custody and no shipment is active.
    -- Checked under the lock above and before any write. Applies whatever the
    -- fulfillment axis says, so a fulfillment that reached 'cancelled' first
    -- cannot route around it through the legacy body below. A stale, terminal
    -- or missing order skips this and gets its usual envelope.
    IF FOUND
       AND v_order.lifecycle_status::TEXT = p_expected_from
       AND v_order.lifecycle_status = 'confirmed' THEN
      v_block := public.order_cancellation_block_v1(p_organization_id, p_order_id);
      IF v_block IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'cancel_blocked', 'reason', v_block);
      END IF;
    END IF;

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
