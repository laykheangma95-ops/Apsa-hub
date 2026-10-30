-- Migration: 065_order_parcel_workflow
-- Purpose: Order and Parcel workflow — staff can see which orders need work,
--          a packed parcel records where it waits for the courier, and a
--          mistaken packing can be undone (with a reason) only while the
--          parcel is still in the shop.
--
-- ── What this adds ───────────────────────────────────────────────────────────
--   1. parcel_pack_records — append-only: what was packed (package count,
--      optional weight) and the optional shelf / bin it waits on. Written only
--      by record_parcel_pack_details_v1 at Mark Packed. Packing a record never
--      changes payment, hand-off, delivery or completion: it is a description
--      of the parcel, not a status.
--   2. undo_order_packing_v1 — "Undo packing" for a mistaken Mark Packed.
--      Requires a reason; refused once the parcel has left with the courier
--      (a delivery in_transit or delivered, or fulfillment 'fulfilled'). The
--      clearing history row carries the reason and an audit_logs row is written
--      in the same transaction — if the audit row cannot be written, nothing is.
--   3. reopen_order_fulfillment_v1 (054) re-declared with the same custody rule:
--      it now refuses with 'handed_off' while the order's delivery is
--      in_transit. Before this, the generic processing → unfulfilled move could
--      mark a parcel already in courier custody as "back in the queue".
--   4. list_order_work_queue_v1 — the three work queues (payment due, not yet
--      prepared, packed and waiting for courier hand-off), with each order's
--      packed state decided by the one packed rule (order_currently_packed_v1).
--
-- All functions: SECURITY DEFINER, service_role only, organization-scoped by
-- their first argument (the server passes the membership-derived org, never a
-- client value). Lock order is 054's: delivery → order.

-- ── 1. parcel_pack_records ──────────────────────────────────────────────────
CREATE TABLE public.parcel_pack_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  parcel_id        UUID NOT NULL REFERENCES public.parcels(id) ON DELETE RESTRICT,
  package_count    INTEGER NOT NULL CHECK (package_count BETWEEN 1 AND 50),
  weight_grams     INTEGER CHECK (weight_grams IS NULL OR weight_grams BETWEEN 1 AND 100000),
  storage_location TEXT CHECK (
    storage_location IS NULL OR char_length(storage_location) BETWEEN 1 AND 40
  ),
  recorded_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.parcel_pack_records IS
  'Append-only: parcel details captured at Mark Packed (package count, weight, shelf/bin). Shown only while the order is currently packed (order_currently_packed_v1). Never UPDATE.';

CREATE INDEX idx_parcel_pack_records_order
  ON public.parcel_pack_records(organization_id, order_id, recorded_at DESC);

CREATE FUNCTION public.parcel_pack_records_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'parcel_pack_records is append-only';
END;
$$;

CREATE TRIGGER parcel_pack_records_no_update
  BEFORE UPDATE ON public.parcel_pack_records
  FOR EACH ROW EXECUTE FUNCTION public.parcel_pack_records_append_only();

ALTER TABLE public.parcel_pack_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.parcel_pack_records FROM PUBLIC, anon, authenticated;
-- Written only through record_parcel_pack_details_v1; the server only reads.
REVOKE ALL ON TABLE public.parcel_pack_records FROM service_role;
GRANT SELECT ON TABLE public.parcel_pack_records TO service_role;

-- ── record_parcel_pack_details_v1 ───────────────────────────────────────────
-- Called by Mark Packed after every scan check passed and BEFORE the packed
-- marker is written. A record whose packing then fails is never shown: details
-- are displayed only while the order is currently packed, and the next Mark
-- Packed writes a newer record.
CREATE FUNCTION public.record_parcel_pack_details_v1(
  p_organization_id  UUID,
  p_order_id         UUID,
  p_recorded_by      UUID,
  p_package_count    INTEGER,
  p_weight_grams     INTEGER DEFAULT NULL,
  p_storage_location TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order    RECORD;
  v_parcel   UUID;
  v_location TEXT := NULLIF(trim(p_storage_location), '');
  v_id       UUID;
BEGIN
  IF p_package_count IS NULL OR p_package_count < 1 OR p_package_count > 50
     OR (p_weight_grams IS NOT NULL AND (p_weight_grams < 1 OR p_weight_grams > 100000))
     OR (v_location IS NOT NULL AND char_length(v_location) > 40) THEN
    RETURN jsonb_build_object('status', 'invalid_details');
  END IF;

  SELECT id, lifecycle_status, fulfillment_status INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_order.lifecycle_status <> 'confirmed'
     OR v_order.fulfillment_status NOT IN ('unfulfilled', 'processing') THEN
    RETURN jsonb_build_object('status', 'invalid_order');
  END IF;

  SELECT id INTO v_parcel
  FROM public.parcels
  WHERE organization_id = p_organization_id AND order_id = p_order_id AND status <> 'void'
  LIMIT 1;
  IF v_parcel IS NULL THEN RETURN jsonb_build_object('status', 'no_parcel'); END IF;

  INSERT INTO public.parcel_pack_records (
    organization_id, order_id, parcel_id, package_count, weight_grams, storage_location,
    recorded_by
  ) VALUES (
    p_organization_id, p_order_id, v_parcel, p_package_count, p_weight_grams, v_location,
    p_recorded_by
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', 'success', 'record_id', v_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_parcel_pack_details_v1(UUID, UUID, UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_parcel_pack_details_v1(UUID, UUID, UUID, INTEGER, INTEGER, TEXT)
  TO service_role;

-- ── 2. undo_order_packing_v1 ────────────────────────────────────────────────
-- Same locking and re-read discipline as reopen_order_fulfillment_v1 (054).
--   processing   → unfulfilled, reason on the row (a 'ready' delivery is
--                  cancelled in the same event, exactly like a reopen)
--   unfulfilled  (packed, after a cancelled / failed delivery attempt):
--                  unfulfilled → processing → unfulfilled, +1µs apart; the
--                  status ends where it was and the reason is on the clearing row
-- Refusals write nothing: not_found, order_terminal, actor_required,
-- reason_required, handed_off, not_packed, stale, retry.
CREATE FUNCTION public.undo_order_packing_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_changed_by      UUID,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_reason       TEXT := NULLIF(trim(p_reason), '');
  v_delivery     RECORD;
  v_has_delivery BOOLEAN;
  v_recheck      RECORD;
  v_has_recheck  BOOLEAN;
  v_order        RECORD;
  v_at           TIMESTAMPTZ;
  v_cancelled_id UUID := NULL;
BEGIN
  IF p_changed_by IS NULL THEN
    RETURN jsonb_build_object('status', 'actor_required');
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RETURN jsonb_build_object('status', 'reason_required');
  END IF;

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

  -- Courier custody: once handed off, the parcel is not the shop's to undo.
  IF v_order.fulfillment_status = 'fulfilled'
     OR (v_has_delivery AND v_delivery.status = 'in_transit')
     OR EXISTS (
       SELECT 1 FROM public.deliveries
       WHERE organization_id = p_organization_id AND order_id = p_order_id
         AND status = 'delivered'
     ) THEN
    RETURN jsonb_build_object('status', 'handed_off');
  END IF;

  IF v_order.lifecycle_status <> 'confirmed'
     OR v_order.fulfillment_status NOT IN ('unfulfilled', 'processing') THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_order.fulfillment_status::TEXT);
  END IF;

  IF NOT public.order_currently_packed_v1(p_organization_id, p_order_id) THEN
    RETURN jsonb_build_object('status', 'not_packed');
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

  IF v_order.fulfillment_status = 'processing' THEN
    UPDATE public.orders SET fulfillment_status = 'unfulfilled' WHERE id = p_order_id;
  ELSE
    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment', 'unfulfilled', 'processing', p_changed_by,
      'system:packing_undone', v_at
    );
    v_at := v_at + interval '1 microsecond';
  END IF;
  INSERT INTO public.order_status_history (
    organization_id, order_id, axis, from_status, to_status, changed_by, reason, changed_at
  ) VALUES (
    p_organization_id, p_order_id, 'fulfillment', 'processing', 'unfulfilled', p_changed_by,
    v_reason, v_at
  );

  BEGIN
    INSERT INTO public.audit_logs (
      organization_id, actor_user_id, action, resource_type, resource_id,
      before_json, after_json, reason
    ) VALUES (
      p_organization_id, p_changed_by, 'orders.packing_undone', 'orders', p_order_id::TEXT,
      jsonb_build_object(
        'fulfillment_status', v_order.fulfillment_status::TEXT,
        'packed', true,
        'delivery_status', CASE WHEN v_has_delivery THEN v_delivery.status::TEXT END
      ),
      jsonb_build_object(
        'fulfillment_status', 'unfulfilled',
        'packed', false,
        'cancelled_delivery_id', v_cancelled_id
      ),
      v_reason
    );
  EXCEPTION WHEN OTHERS THEN
    -- Re-raised: the whole undo rolls back with it (062's audit atomicity).
    RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
  END;

  RETURN jsonb_build_object('status', 'success', 'cancelled_delivery_id', v_cancelled_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.undo_order_packing_v1(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_order_packing_v1(UUID, UUID, UUID, TEXT)
  TO service_role;

-- ── 3. reopen_order_fulfillment_v1: refuse once handed off ──────────────────
-- Re-declared from 054 unchanged except for the 'handed_off' refusal.
CREATE OR REPLACE FUNCTION public.reopen_order_fulfillment_v1(
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
  -- New in 065: the parcel is with the courier; record the delivery outcome
  -- instead (failed → the goods come back and the order returns to unfulfilled).
  IF v_has_delivery AND v_delivery.status = 'in_transit' THEN
    RETURN jsonb_build_object('status', 'handed_off');
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

-- ── 4. list_order_work_queue_v1 ─────────────────────────────────────────────
--   payment_due       confirmed, payment unpaid / pending / failed (COD included;
--                     the latest delivery's COD amount is returned so it can be
--                     labelled). Drafts are not sales and are not listed.
--   not_prepared      confirmed, fulfillment unfulfilled / processing, NOT
--                     currently packed, not with the courier. Includes orders
--                     whose delivery was arranged before packing (processing).
--   awaiting_handoff  confirmed, fulfillment unfulfilled / processing, currently
--                     packed, not yet with the courier. Oldest packed first.
-- Pack details are returned only for a currently packed order. Bounded: at
-- most 200 rows, oldest first, so the longest-waiting work is never cut off.
CREATE FUNCTION public.list_order_work_queue_v1(
  p_organization_id UUID,
  p_queue           TEXT,
  p_limit           INTEGER DEFAULT 100
)
RETURNS TABLE (
  order_id               UUID,
  order_number           TEXT,
  created_at             TIMESTAMPTZ,
  currency               TEXT,
  total_minor            BIGINT,
  customer_id            UUID,
  lifecycle_status       TEXT,
  payment_status         TEXT,
  refund_status          TEXT,
  fulfillment_status     TEXT,
  packed                 BOOLEAN,
  active_delivery_id     UUID,
  active_delivery_status TEXT,
  latest_delivery_status TEXT,
  any_delivered          BOOLEAN,
  cod_amount_minor       BIGINT,
  parcel_code            TEXT,
  package_count          INTEGER,
  weight_grams           INTEGER,
  storage_location       TEXT,
  packed_recorded_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH candidates AS (
    SELECT o.*
    FROM public.orders o
    WHERE o.organization_id = p_organization_id
      AND o.lifecycle_status = 'confirmed'
      AND CASE p_queue
            WHEN 'payment_due' THEN o.payment_status IN ('unpaid', 'pending', 'failed')
            WHEN 'not_prepared' THEN o.fulfillment_status IN ('unfulfilled', 'processing')
            WHEN 'awaiting_handoff' THEN o.fulfillment_status IN ('unfulfilled', 'processing')
            ELSE false
          END
  ),
  enriched AS (
    SELECT
      c.id, c.order_number, c.created_at, c.currency, c.total_minor, c.customer_id,
      c.lifecycle_status::TEXT AS lifecycle_status,
      c.payment_status::TEXT AS payment_status,
      c.refund_status::TEXT AS refund_status,
      c.fulfillment_status::TEXT AS fulfillment_status,
      (c.fulfillment_status IN ('unfulfilled', 'processing')
        AND public.order_currently_packed_v1(p_organization_id, c.id)) AS is_packed,
      ad.id AS ad_id, ad.status::TEXT AS ad_status,
      ld.status::TEXT AS ld_status, ld.cod_amount_minor AS ld_cod,
      EXISTS (
        SELECT 1 FROM public.deliveries d
        WHERE d.organization_id = p_organization_id AND d.order_id = c.id
          AND d.status = 'delivered'
      ) AS delivered_any,
      p.parcel_code AS p_code,
      pr.package_count AS pr_count, pr.weight_grams AS pr_weight,
      pr.storage_location AS pr_location, pr.recorded_at AS pr_at
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT d.id, d.status FROM public.deliveries d
      WHERE d.organization_id = p_organization_id AND d.order_id = c.id
        AND d.status IN ('pending', 'preparing', 'ready', 'in_transit')
      ORDER BY d.created_at DESC LIMIT 1
    ) ad ON true
    LEFT JOIN LATERAL (
      SELECT d.status, d.cod_amount_minor FROM public.deliveries d
      WHERE d.organization_id = p_organization_id AND d.order_id = c.id
      ORDER BY d.created_at DESC LIMIT 1
    ) ld ON true
    LEFT JOIN LATERAL (
      SELECT pa.parcel_code FROM public.parcels pa
      WHERE pa.organization_id = p_organization_id AND pa.order_id = c.id
        AND pa.status <> 'void'
      LIMIT 1
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT r.package_count, r.weight_grams, r.storage_location, r.recorded_at
      FROM public.parcel_pack_records r
      WHERE r.organization_id = p_organization_id AND r.order_id = c.id
      ORDER BY r.recorded_at DESC LIMIT 1
    ) pr ON true
  )
  SELECT
    e.id, e.order_number, e.created_at, e.currency, e.total_minor, e.customer_id,
    e.lifecycle_status, e.payment_status, e.refund_status, e.fulfillment_status,
    e.is_packed, e.ad_id, e.ad_status, e.ld_status, e.delivered_any, e.ld_cod, e.p_code,
    CASE WHEN e.is_packed THEN e.pr_count END,
    CASE WHEN e.is_packed THEN e.pr_weight END,
    CASE WHEN e.is_packed THEN e.pr_location END,
    CASE WHEN e.is_packed THEN e.pr_at END
  FROM enriched e
  WHERE CASE p_queue
          WHEN 'payment_due' THEN true
          WHEN 'not_prepared' THEN NOT e.is_packed AND e.ad_status IS DISTINCT FROM 'in_transit'
          WHEN 'awaiting_handoff' THEN e.is_packed AND e.ad_status IS DISTINCT FROM 'in_transit'
          ELSE false
        END
  ORDER BY
    CASE WHEN p_queue = 'awaiting_handoff' AND e.is_packed THEN e.pr_at END ASC NULLS LAST,
    e.created_at ASC,
    e.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
$$;

REVOKE EXECUTE ON FUNCTION public.list_order_work_queue_v1(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_order_work_queue_v1(UUID, TEXT, INTEGER)
  TO service_role;
