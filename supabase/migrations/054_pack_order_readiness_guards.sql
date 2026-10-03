-- Migration: 054_pack_order_readiness_guards
-- V1 Pack Order (PR #107): a delivery is 'ready' only while its order is
-- CURRENTLY packed, on every path, decided by ONE rule under row locks.
-- Forward-only; no tables or columns. Adds five functions and re-declares
-- transition_delivery_status_v1 (027) with a guard on '→ ready' and lock-ordered timestamps.
--
-- ── The one packed rule: order_currently_packed_v1 ───────────────────────────
-- The order is packed when its newest Pack Order marker (reason
-- 'pack_order_packed', written only by the Pack Order service) is newer than
-- the last time its fulfillment was reopened to 'unfulfilled'. Not a reopen:
--   * Pack Order's own re-record step (the row carries the marker)
--   * the move transition_delivery_status_v1 writes when a delivery attempt is
--     cancelled/failed: it shares that delivery row's transaction timestamp,
--     which no caller can set. A delivery cancelled BY a reopen is tagged
--     'system:order_fulfillment_reopened' and does not earn that exemption.
-- Every readiness path and the server's packed display call this function;
-- there is no second copy of the rule.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Every function here locks delivery → order, the order the project's delivery
-- RPCs already use (transition_delivery_status_v1). create_delivery_v1 takes
-- only the order lock. No path takes order → delivery, so none can deadlock.
--
-- ── Timestamps: one strategy ────────────────────────────────────────────────
-- The packed rule compares history timestamps, so they must follow the order in
-- which fulfillment events really commit. A history row's DEFAULT now() is the
-- transaction START time: a transaction that waited for a lock commits after
-- the lock holder yet would carry an older timestamp. Therefore every row the
-- rule reads — packed markers, reopens, retired (cancelled/failed) attempts —
-- is written by a function in this file with an explicit timestamp from
-- next_fulfillment_event_at_v1, taken only AFTER the order row lock is held.
-- Every such writer locks the same order row, so they serialize on it and the
-- timestamps are strictly increasing in commit order. Rows that are two halves
-- of one event (a delivery row and the order row it drives; a reopen and the
-- delivery it cancels) share one timestamp; consecutive steps of one operation
-- get +1µs each so their order is deterministic.
-- Mark Packed no longer writes its marker through transition_order_status_v1
-- (transaction-start time); with no delivery it uses record_order_packed_v1.

-- ── Event timestamp ─────────────────────────────────────────────────────────
-- Caller MUST hold the order's row lock. Strictly after every history row the
-- order already has (+1µs), and never behind the wall clock — so a clock tie
-- or skew can never reorder two fulfillment events of one order.
CREATE FUNCTION public.next_fulfillment_event_at_v1(
  p_organization_id UUID,
  p_order_id        UUID
)
RETURNS TIMESTAMPTZ
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT GREATEST(
    clock_timestamp(),
    COALESCE(
      (SELECT max(h.changed_at) FROM public.order_status_history h
       WHERE h.organization_id = p_organization_id AND h.order_id = p_order_id),
      '-infinity'::timestamptz
    ) + interval '1 microsecond',
    COALESCE(
      (SELECT max(dh.created_at)
       FROM public.delivery_status_history dh
       JOIN public.deliveries d ON d.id = dh.delivery_id
       WHERE d.organization_id = p_organization_id
         AND d.order_id = p_order_id
         AND dh.organization_id = p_organization_id),
      '-infinity'::timestamptz
    ) + interval '1 microsecond'
  );
$$;

-- Internal helper: only the SECURITY DEFINER functions below call it.
REVOKE EXECUTE ON FUNCTION public.next_fulfillment_event_at_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

-- ── Packed rule ─────────────────────────────────────────────────────────────
CREATE FUNCTION public.order_currently_packed_v1(
  p_organization_id UUID,
  p_order_id        UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_last_packed  TIMESTAMPTZ;
  v_last_cleared TIMESTAMPTZ;
BEGIN
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
    RETURN false;
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

  -- A tie fails closed.
  RETURN v_last_cleared IS NULL OR v_last_packed > v_last_cleared;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.order_currently_packed_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_currently_packed_v1(UUID, UUID)
  TO service_role;

-- ── Reopen order fulfillment ─────────────────────────────────────────────────
--
-- processing → unfulfilled ("packing stopped; back in the queue"), and in the
-- same transaction the order's 'ready' delivery is cancelled: a reopened order
-- must go through Pack Order again before Courier Handoff, so readiness may not
-- survive the reopen. pending/preparing deliveries are not ready and stay as
-- they are (readying them needs a current packed state); an in_transit delivery
-- has already been handed off and is not touched.
--
-- Race: the active delivery is looked up and locked BEFORE the order lock
-- (delivery → order). A delivery created or readied after that lookup but
-- before the order lock was ours would otherwise be missed, so once the order
-- is locked the active delivery is read again. While this transaction holds the
-- order lock no delivery can be created (create_delivery_v1 locks the order)
-- or change status (every transition locks the order), so the re-read is
-- final. If it differs from what was locked, nothing is written and the call
-- returns 'retry'; the caller runs the reopen again from the top.
--
-- The order row and the cancelled delivery row are one event and share one
-- timestamp from next_fulfillment_event_at_v1, taken after both locks are held.
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
  v_recheck      RECORD;
  v_has_recheck  BOOLEAN;
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

  -- Re-read under the order lock: a delivery that appeared, or changed status,
  -- between the lookup above and the order lock is caught here.
  SELECT id, status INTO v_recheck
  FROM public.deliveries
  WHERE organization_id = p_organization_id
    AND order_id = p_order_id
    AND status IN ('pending', 'preparing', 'ready', 'in_transit');
  v_has_recheck := FOUND;
  IF v_has_recheck IS DISTINCT FROM v_has_delivery
     OR (v_has_delivery AND (v_recheck.id <> v_delivery.id
                             OR v_recheck.status <> v_delivery.status)) THEN
    RETURN jsonb_build_object('status', 'retry');
  END IF;

  IF v_order.lifecycle_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'order_terminal');
  END IF;
  IF v_order.fulfillment_status <> 'processing' THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_order.fulfillment_status::TEXT);
  END IF;

  v_at := public.next_fulfillment_event_at_v1(p_organization_id, p_order_id);

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
-- is currently packed (order_currently_packed_v1) and only then moves the
-- delivery pending/preparing → ready. A reopen that commits first is seen here
-- and the call returns not_packed; a reopen that comes later waits for the
-- locks and then cancels the delivery this call readied.
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
  v_delivery RECORD;
  v_order    RECORD;
  v_at       TIMESTAMPTZ;
  v_ready_at TIMESTAMPTZ;
  v_reason   CONSTANT TEXT := 'system:pack_order_delivery_ready';
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

  IF NOT public.order_currently_packed_v1(p_organization_id, p_order_id) THEN
    RETURN jsonb_build_object('status', 'not_packed');
  END IF;

  -- After both locks: pending → preparing at v_at, preparing → ready one
  -- microsecond later, and the order row it drives shares the ready time.
  v_at := public.next_fulfillment_event_at_v1(p_organization_id, p_order_id);
  v_ready_at := v_at;
  IF v_delivery.status = 'pending' THEN
    UPDATE public.deliveries SET status = 'preparing' WHERE id = v_delivery.id;
    INSERT INTO public.delivery_status_history (
      organization_id, delivery_id, from_status, to_status, changed_by, reason, created_at
    ) VALUES (
      p_organization_id, v_delivery.id, 'pending', 'preparing', p_changed_by, v_reason, v_at
    );
    v_ready_at := v_at + interval '1 microsecond';
  END IF;
  UPDATE public.deliveries SET status = 'ready' WHERE id = v_delivery.id;
  INSERT INTO public.delivery_status_history (
    organization_id, delivery_id, from_status, to_status, changed_by, reason, created_at
  ) VALUES (
    p_organization_id, v_delivery.id, 'preparing', 'ready', p_changed_by, v_reason, v_ready_at
  );

  -- Same coarse Order fulfillment mapping as transition_delivery_status_v1.
  IF v_order.fulfillment_status <> 'processing' THEN
    UPDATE public.orders SET fulfillment_status = 'processing' WHERE id = p_order_id;
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment', v_order.fulfillment_status::TEXT,
      'processing', p_changed_by, 'Delivery status: ready', v_ready_at
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

-- ── Generic delivery transitions: '→ ready' needs a packed order ─────────────
--
-- Re-declares transition_delivery_status_v1 (027) unchanged except for two
-- things: its history rows take their time from next_fulfillment_event_at_v1
-- after both locks (see the header), and a transition to 'ready' requires
-- order_currently_packed_v1, checked
-- under the delivery and order locks this function already takes. The generic
-- delivery API ("Mark ready") can therefore never ready an unpacked or reopened
-- order's delivery.
--
-- The single exception is the transition Mark Packed itself makes: it carries
-- the reserved packed marker as its reason and IS the act of packing — the row
-- it writes is what makes the order packed. Only the Pack Order service writes
-- that reason: the generic order and delivery APIs reject it (and the whole
-- 'system:' namespace) before calling this function, and the function is
-- executable by service_role only.
CREATE OR REPLACE FUNCTION public.transition_delivery_status_v1(
  p_organization_id UUID,
  p_delivery_id     UUID,
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
  v_delivery          RECORD;
  v_order             RECORD;
  v_current           TEXT;
  v_order_fulfillment public.order_fulfillment_status;
  v_allowed           BOOLEAN := false;
  v_at                TIMESTAMPTZ;
BEGIN
  SELECT id, order_id, status INTO v_delivery
  FROM public.deliveries
  WHERE id = p_delivery_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  v_current := v_delivery.status::TEXT;
  IF v_current <> p_expected_from THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_current);
  END IF;
  IF v_current = p_to THEN
    RETURN jsonb_build_object('status', 'no_change', 'current', v_current);
  END IF;
  IF v_current IN ('delivered', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'terminal', 'current', v_current);
  END IF;

  v_allowed := CASE v_current
    WHEN 'pending'    THEN p_to IN ('preparing', 'cancelled')
    WHEN 'preparing'  THEN p_to IN ('ready', 'cancelled')
    WHEN 'ready'      THEN p_to IN ('in_transit', 'cancelled')
    WHEN 'in_transit' THEN p_to IN ('delivered', 'failed')
    ELSE false
  END;
  IF NOT v_allowed THEN RETURN jsonb_build_object('status', 'invalid_transition'); END IF;

  SELECT id, lifecycle_status, fulfillment_status INTO v_order
  FROM public.orders
  WHERE id = v_delivery.order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_order.lifecycle_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'order_terminal');
  END IF;

  -- Added by 054: readiness requires a currently packed order (see above).
  IF p_to = 'ready'
     AND p_reason IS DISTINCT FROM 'pack_order_packed'
     AND NOT public.order_currently_packed_v1(p_organization_id, v_delivery.order_id) THEN
    RETURN jsonb_build_object('status', 'not_packed');
  END IF;

  v_order_fulfillment := CASE
    WHEN p_to IN ('preparing', 'ready', 'in_transit') THEN 'processing'::public.order_fulfillment_status
    WHEN p_to = 'delivered' THEN 'fulfilled'::public.order_fulfillment_status
    -- Cancelling a Delivery retires only this attempt. The confirmed Order
    -- remains eligible for a replacement Delivery and retains its inventory.
    WHEN p_to = 'cancelled' THEN 'unfulfilled'::public.order_fulfillment_status
    WHEN p_to = 'failed' THEN 'unfulfilled'::public.order_fulfillment_status
    ELSE NULL
  END;

  -- Never overwrite an independently terminal Order fulfillment state.
  IF v_order.fulfillment_status IN ('fulfilled', 'cancelled')
     AND v_order.fulfillment_status <> v_order_fulfillment THEN
    RETURN jsonb_build_object('status', 'order_fulfillment_terminal');
  END IF;

  -- Added by 054: the event time is taken after both locks (see the header);
  -- the delivery row and the order row it drives are one event and share it.
  v_at := public.next_fulfillment_event_at_v1(p_organization_id, v_order.id);

  UPDATE public.deliveries SET status = p_to::public.delivery_status
  WHERE id = p_delivery_id;
  INSERT INTO public.delivery_status_history (
    organization_id, delivery_id, from_status, to_status, changed_by, reason, created_at
  ) VALUES (
    p_organization_id, p_delivery_id, v_current::public.delivery_status,
    p_to::public.delivery_status, p_changed_by, NULLIF(trim(p_reason), ''), v_at
  );

  IF v_order.fulfillment_status <> v_order_fulfillment THEN
    UPDATE public.orders SET fulfillment_status = v_order_fulfillment WHERE id = v_order.id;
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
    ) VALUES (
      p_organization_id, v_order.id, 'fulfillment',
      v_order.fulfillment_status::TEXT, v_order_fulfillment::TEXT,
      p_changed_by, 'Delivery status: ' || p_to, v_at
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'success', 'from', v_current, 'to', p_to,
    'order_fulfillment', v_order_fulfillment::TEXT
  );
END;
$$;

-- CREATE OR REPLACE keeps the existing ACL; restated so this file is
-- self-describing (and the migration safety check sees the REVOKE).
REVOKE EXECUTE ON FUNCTION public.transition_delivery_status_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_delivery_status_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT)
  TO service_role;

-- ── Mark Packed with no delivery ────────────────────────────────────────────
--
-- Records the packed marker on the order's fulfillment history. Replaces the
-- generic transition_order_status_v1 for this one write, because that function
-- stamps history with the transaction-START time: a Mark Packed that waited
-- behind a reopen would commit later but carry an older marker, and the packed
-- rule would wrongly see the order as not packed. Here the time is taken after
-- the locks (next_fulfillment_event_at_v1), like every other writer above.
--
-- Locks delivery → order like the rest of this file. An order with an active
-- delivery is packed through that delivery (transition_delivery_status_v1 with
-- the marker), so finding one — before or after the order lock — returns
-- 'has_delivery' and writes nothing.
--
--   unfulfilled → processing           one marker row
--   processing  (no delivery)          processing → unfulfilled → processing,
--                                      both rows tagged, +1µs apart (a
--                                      processing → processing row is not a
--                                      transition)
CREATE FUNCTION public.record_order_packed_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_changed_by      UUID DEFAULT NULL
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
  v_marker       CONSTANT TEXT := 'pack_order_packed';
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

  -- Re-read under the order lock (a delivery may have been arranged meanwhile).
  IF v_has_delivery OR EXISTS (
    SELECT 1 FROM public.deliveries
    WHERE organization_id = p_organization_id
      AND order_id = p_order_id
      AND status IN ('pending', 'preparing', 'ready', 'in_transit')
  ) THEN
    RETURN jsonb_build_object('status', 'has_delivery');
  END IF;

  IF v_order.lifecycle_status <> 'confirmed' THEN
    RETURN jsonb_build_object('status', 'invalid_order');
  END IF;
  IF v_order.fulfillment_status NOT IN ('unfulfilled', 'processing') THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_order.fulfillment_status::TEXT);
  END IF;

  v_at := public.next_fulfillment_event_at_v1(p_organization_id, p_order_id);

  IF v_order.fulfillment_status = 'processing' THEN
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment', 'processing', 'unfulfilled', p_changed_by,
      v_marker, v_at
    );
    v_at := v_at + interval '1 microsecond';
  ELSE
    UPDATE public.orders SET fulfillment_status = 'processing' WHERE id = p_order_id;
  END IF;
  INSERT INTO public.order_status_history (
    organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
  ) VALUES (
    p_organization_id, p_order_id, 'fulfillment', 'unfulfilled', 'processing', p_changed_by,
    v_marker, v_at
  );

  RETURN jsonb_build_object('status', 'success');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_order_packed_v1(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_order_packed_v1(UUID, UUID, UUID)
  TO service_role;
