-- Migration: 066_pack_order_round_guard
-- Pack Order: Mark Packed refuses confirmations ticked in an EARLIER packing
-- round. Forward-only; no tables or columns. Adds two functions.
--
-- ── Why ─────────────────────────────────────────────────────────────────────
-- A reopen (reopen_order_fulfillment_v1, 054) makes a packed order unpacked
-- again with the SAME parcel and the SAME order lines. A Pack Order screen that
-- was loaded before another member packed and reopened the order still shows
-- its old ticks, and Mark Packed only sends per-line counts — which match. The
-- server accepted them and recorded the order packed from confirmations made
-- for the previous round.
--
-- ── Packing round: order_pack_round_v1 ──────────────────────────────────────
-- The number of Pack Order packed markers (reason 'pack_order_packed') on the
-- order's fulfillment history and on the history of every delivery of the
-- order — the same two sources order_currently_packed_v1 reads. History is
-- append-only, so the round grows exactly when the order is packed (on either
-- path) and never otherwise. One scalar, computed in the database: no row page
-- limit can drop delivery history from it. It is not the packed rule; that
-- stays in order_currently_packed_v1.
--
-- ── Mark Packed: mark_order_packed_v1 ───────────────────────────────────────
-- The one write Mark Packed makes, in one transaction:
--   1. lock delivery → order, the order every 054 writer uses (no deadlock);
--   2. re-read the active delivery under the order lock ('retry' if it moved,
--      exactly like reopen_order_fulfillment_v1);
--   3. compare the round with p_expected_round, the round the packer's screen
--      was started in: any other value → 'stale_round', nothing written;
--   4. pack through the EXISTING writers, unchanged:
--        no delivery  → record_order_packed_v1
--        delivery     → transition_delivery_status_v1 pending → preparing →
--                       ready, each step tagged with the marker (what the
--                       service did step by step before, now in one
--                       transaction: a failed step rolls back the earlier one)
-- Every writer of packed markers and every reopen takes this order row lock
-- (054), so between step 3 and step 4 no pack or reopen can commit: the round
-- check and the packing write are atomic. A NULL or negative expected round is
-- refused ('round_required') — it is never read as round zero.
--
-- Executable by service_role only, like every 054 function.

CREATE FUNCTION public.order_pack_round_v1(
  p_organization_id UUID,
  p_order_id        UUID
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    (SELECT count(*)
     FROM public.order_status_history h
     WHERE h.organization_id = p_organization_id
       AND h.order_id = p_order_id
       AND h.axis = 'fulfillment'
       AND h.reason = 'pack_order_packed')
    +
    (SELECT count(*)
     FROM public.delivery_status_history dh
     JOIN public.deliveries d ON d.id = dh.delivery_id
     WHERE d.organization_id = p_organization_id
       AND d.order_id = p_order_id
       AND dh.organization_id = p_organization_id
       AND dh.reason = 'pack_order_packed')
  )::INTEGER;
$$;

REVOKE EXECUTE ON FUNCTION public.order_pack_round_v1(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_pack_round_v1(UUID, UUID)
  TO service_role;

CREATE FUNCTION public.mark_order_packed_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_changed_by      UUID,
  p_expected_round  INTEGER
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
  v_round        INTEGER;
  v_step         JSONB;
  v_marker       CONSTANT TEXT := 'pack_order_packed';
BEGIN
  IF p_expected_round IS NULL OR p_expected_round < 0 THEN
    RETURN jsonb_build_object('status', 'round_required');
  END IF;

  SELECT id, status INTO v_delivery
  FROM public.deliveries
  WHERE organization_id = p_organization_id
    AND order_id = p_order_id
    AND status IN ('pending', 'preparing', 'ready', 'in_transit')
  FOR UPDATE;
  v_has_delivery := FOUND;

  PERFORM 1
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  -- Re-read under the order lock (create_delivery_v1 takes only the order lock).
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

  -- The round, read while no pack or reopen can commit.
  v_round := public.order_pack_round_v1(p_organization_id, p_order_id);
  IF v_round <> p_expected_round THEN
    RETURN jsonb_build_object('status', 'stale_round', 'current_round', v_round);
  END IF;

  IF NOT v_has_delivery THEN
    RETURN public.record_order_packed_v1(p_organization_id, p_order_id, p_changed_by);
  END IF;

  IF v_delivery.status IN ('ready', 'in_transit') THEN
    RETURN jsonb_build_object('status', 'already_ready', 'delivery_id', v_delivery.id);
  END IF;

  BEGIN
    IF v_delivery.status = 'pending' THEN
      v_step := public.transition_delivery_status_v1(
        p_organization_id, v_delivery.id, 'pending', 'preparing', p_changed_by, v_marker);
      IF v_step->>'status' <> 'success' THEN
        RAISE EXCEPTION USING ERRCODE = 'PK066', MESSAGE = v_step->>'status';
      END IF;
    END IF;
    v_step := public.transition_delivery_status_v1(
      p_organization_id, v_delivery.id, 'preparing', 'ready', p_changed_by, v_marker);
    IF v_step->>'status' <> 'success' THEN
      RAISE EXCEPTION USING ERRCODE = 'PK066', MESSAGE = v_step->>'status';
    END IF;
  EXCEPTION WHEN SQLSTATE 'PK066' THEN
    -- The block's writes are rolled back; report the step that refused.
    RETURN jsonb_build_object('status', SQLERRM, 'delivery_id', v_delivery.id);
  END;

  RETURN jsonb_build_object('status', 'success', 'delivery_id', v_delivery.id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_order_packed_v1(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_packed_v1(UUID, UUID, UUID, INTEGER)
  TO service_role;
