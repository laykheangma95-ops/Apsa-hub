-- Migration: 026_order_inventory_integration
-- Purpose: Make the authoritative Order lifecycle transition write the Inventory
--          ledger movements it implies, in the SAME transaction.
-- Function: transition_order_status_v1 (CREATE OR REPLACE — signature unchanged)
--
-- This migration adds NO table, NO column, NO index and NO enum value. It
-- replaces one function body. Migrations 021 (ledger) and 023–025 (orders) are
-- untouched.
--
-- ── WHAT THIS WIRES ──────────────────────────────────────────────────────────
--
--   lifecycle draft -> confirmed   STOCK-CONSUMING
--     one inventory_movements row per order line:
--       movement_type  = 'sale'
--       quantity_delta = -order_items.quantity
--       product/variant = the line's own (snapshot-free, the real FK)
--       location_id    = the ORDER's location_id (may be NULL)
--       created_by     = p_changed_by (the server-verified actor)
--       reference      = ('order_item', order_items.id)
--
--   lifecycle confirmed -> cancelled   STOCK-RELEASING
--     one compensating row per line THAT ACTUALLY CONSUMED STOCK:
--       movement_type  = 'return'
--       quantity_delta = +order_items.quantity
--       same product/variant/location, same item-level reference
--
--   lifecycle draft -> cancelled       NO MOVEMENT
--     a draft never consumed anything, so there is nothing to give back. This
--     is not a special case in the code — it simply matches neither branch.
--
--   Every other transition on every other axis writes no movement at all.
--   Payment and fulfillment do not move stock (see migration 023's rationale:
--   COD means money arrives days late, and fulfillment is after the goods have
--   already gone).
--
-- ── WHY THE REFERENCE IS ITEM-LEVEL, NOT ORDER-LEVEL ─────────────────────────
--
-- Migration 021's idempotency index is
--   UNIQUE (organization_id, variant_id, movement_type, reference_type, reference_id)
--   WHERE reference_id IS NOT NULL
--
-- Keying on ('order', order_id) would make that index collide with itself the
-- moment one order contains two lines of the same variant — a completely
-- ordinary basket (two of the same shirt added separately, or the same variant
-- at two different discounts). The second line's 'sale' would be silently
-- swallowed by the deduplication meant to protect against retries, and the
-- merchant would sell stock the ledger never recorded leaving.
--
-- ('order_item', order_items.id) is unique per line by construction, so:
--   two lines, same variant, one order   -> two distinct keys -> both recorded
--   the same confirmation replayed       -> identical key     -> deduplicated
--   'sale' and 'return' for one line     -> differ by movement_type -> coexist
--
-- The existing index therefore already supports this design exactly as
-- migration 021 anticipated ("when Order integration needs it, the caller will
-- pass a line-level reference_id rather than the order id — no schema change
-- required here"). No new index, and 021's protection is not weakened.
--
-- ── IDEMPOTENCY: TWO INDEPENDENT GATES ───────────────────────────────────────
--
--   1. The status gate. A retried confirmation arrives with p_expected_from =
--      'draft' while the stored status is already 'confirmed', so the function
--      returns 'stale' and never reaches the ledger. A retried cancellation
--      hits the terminal check and returns 'terminal'. The movement code is
--      unreachable on a replay.
--   2. ON CONFLICT DO NOTHING on 021's unique index. Even if some future caller
--      reached the insert twice for one line, the duplicate is dropped rather
--      than double-counted — and dropped WITHOUT aborting the transaction,
--      which a bare unique violation would do.
--
-- Both gates are needed. The first is the real one; the second is what makes a
-- bug in the first a no-op instead of a stock corruption.
--
-- ── STOCK AVAILABILITY: THE EXISTING POLICY IS PRESERVED ─────────────────────
--
-- APSA's ledger has never constrained stock to be non-negative: migration 021's
-- only quantity CHECK is `quantity_delta <> 0`, and inventory_stock is a plain
-- SUM over the ledger with no floor. Confirming an order for more units than
-- are on hand therefore SUCCEEDS and drives the derived balance negative.
--
-- That behaviour is deliberately kept as-is here. Introducing a stock check at
-- confirmation would be a new reservation/oversell policy, which is a product
-- decision this phase has not been asked to make — and a wrong one would block
-- real Cambodian merchants who routinely sell from stock they have not yet
-- entered. Negative stock stays VISIBLE (a negative quantity_on_hand is a
-- legible signal in the ledger) rather than being silently prevented.
--
-- ── ATOMICITY ────────────────────────────────────────────────────────────────
--
-- All of it — the status UPDATE, the order_status_history row, the fulfillment
-- cascade on cancellation, and every inventory_movements row — happens inside
-- ONE plpgsql function, which is one statement to the caller and therefore one
-- transaction. There is no application-level "transition, then adjust stock"
-- sequence anywhere, so there is no window in which a crash can leave a
-- confirmed order with untouched stock, or a cancelled order still holding it.
-- If any movement insert raises (e.g. 021's cross-tenant integrity trigger),
-- the status change rolls back with it.
--
-- ── AUTHORIZATION ────────────────────────────────────────────────────────────
--
-- The human action is the ORDER transition; the movement is its consequence.
-- orders.confirm alone is enough to consume stock and orders.cancel alone is
-- enough to release it — neither requires inventory.adjust, because the
-- merchant is not adjusting inventory, they are selling. The Order service
-- deliberately does NOT call the Inventory service (which would impose
-- inventory.adjust and its mandatory audit on every sale); the ledger write
-- lives in the database precisely so it can be a trusted consequence rather
-- than a second authorization.
--
-- MANUAL inventory adjustments are unchanged: still inventory.adjust, still a
-- required reason, still a fail-closed mandatory audit, still going through
-- src/server/inventory/service.ts.
--
-- ── TENANT ISOLATION ─────────────────────────────────────────────────────────
--
-- Nothing here takes an id from a client. p_organization_id comes from a
-- verified DB membership (src/api/orders.ts has no organizationId parameter at
-- all) and p_changed_by from a validated session.
--
--   - the order is loaded WHERE organization_id = p_organization_id, so a
--     cross-org order id is 'not_found' and no branch below is ever reached;
--   - lines are read WHERE order_id = <that order> AND organization_id =
--     p_organization_id, so a line grafted onto another tenant's order is
--     invisible;
--   - product_id / variant_id are copied from the line's own FK columns, never
--     supplied, and migration 023's trigger already proved they belong to this
--     org;
--   - location_id is copied from the order, which migration 023's trigger
--     already proved belongs to this org;
--   - and migration 021's check_inventory_movement_integrity trigger re-proves
--     all of it on every INSERT, raising (and so rolling back the transition)
--     if any of it is false.
--
-- Org A cannot reach Org B's inventory through any of these paths.
--
-- ── LEDGER REMAINS APPEND-ONLY ───────────────────────────────────────────────
--
-- Only INSERT appears below. No UPDATE of inventory_movements, no DELETE, no
-- stock column, no write to inventory_stock (which is a VIEW and has no storage
-- to write to). A cancellation is a NEW compensating movement, not an edit of
-- the sale it reverses — both rows survive, which is what makes the ledger an
-- audit trail rather than a balance.

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
  v_order     RECORD;
  v_current   TEXT;
  v_movements INTEGER := 0;
BEGIN
  IF p_axis NOT IN ('lifecycle', 'payment', 'fulfillment') THEN
    RAISE EXCEPTION 'transition_order_status_v1: unknown axis %', p_axis;
  END IF;

  -- FOR UPDATE: hold the row for the rest of the transaction so the read of the
  -- current status and the write that depends on it cannot interleave. This is
  -- also what serialises two concurrent confirmations of the same order, and
  -- therefore what stops both of them writing 'sale' movements.
  SELECT id, lifecycle_status, payment_status, fulfillment_status, location_id
    INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Deliberately identical to a genuinely nonexistent order: a cross-tenant
    -- guess must not be distinguishable from a bad id.
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  v_current := CASE p_axis
    WHEN 'lifecycle'   THEN v_order.lifecycle_status::TEXT
    WHEN 'payment'     THEN v_order.payment_status::TEXT
    ELSE                    v_order.fulfillment_status::TEXT
  END;

  IF v_current <> p_expected_from THEN
    -- Someone else moved it first. The caller re-reads and re-decides rather
    -- than overwriting a decision it never saw. This is ALSO the primary
    -- idempotency gate for stock: a replayed confirmation lands here.
    RETURN jsonb_build_object('status', 'stale', 'current', v_current);
  END IF;

  IF v_current = p_to THEN
    RETURN jsonb_build_object('status', 'no_change', 'current', v_current);
  END IF;

  -- Terminal lifecycle states freeze the whole order. A cancelled order cannot
  -- later become paid, and a completed one cannot be re-fulfilled. Enforced
  -- here as well as in the state machine because it is the invariant most
  -- damaging to get wrong: it is what stops money and stock moving on an order
  -- that is finished. It is also what makes a replayed cancellation a no-op.
  IF v_order.lifecycle_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object('status', 'terminal',
                              'lifecycle', v_order.lifecycle_status::TEXT);
  END IF;

  -- 'completed' means paid AND fulfilled. It is a conclusion, never a claim.
  IF p_axis = 'lifecycle' AND p_to = 'completed' THEN
    IF v_order.payment_status <> 'paid' OR v_order.fulfillment_status <> 'fulfilled' THEN
      RETURN jsonb_build_object('status', 'preconditions_unmet',
                                'payment', v_order.payment_status::TEXT,
                                'fulfillment', v_order.fulfillment_status::TEXT);
    END IF;
  END IF;

  -- Apply the transition. The enum cast rejects any status name that is not a
  -- real member of the axis, so an invalid target cannot be persisted even if a
  -- caller skipped the TypeScript state machine.
  IF p_axis = 'lifecycle' THEN
    UPDATE public.orders SET lifecycle_status = p_to::public.order_lifecycle_status
    WHERE id = p_order_id;
  ELSIF p_axis = 'payment' THEN
    UPDATE public.orders SET payment_status = p_to::public.order_payment_status
    WHERE id = p_order_id;
  ELSE
    UPDATE public.orders SET fulfillment_status = p_to::public.order_fulfillment_status
    WHERE id = p_order_id;
  END IF;

  INSERT INTO public.order_status_history (
    organization_id, order_id, axis, from_status, to_status, changed_by, reason
  ) VALUES (
    p_organization_id, p_order_id, p_axis::public.order_status_axis,
    v_current, p_to, p_changed_by, p_reason
  );

  -- Cross-axis consequence: cancelling the order cancels its fulfillment in the
  -- same transaction. Leaving fulfillment at 'unfulfilled' or 'processing' on a
  -- cancelled order would show it in the merchant's "to pack" queue forever.
  IF p_axis = 'lifecycle' AND p_to = 'cancelled'
     AND v_order.fulfillment_status <> 'cancelled' THEN
    UPDATE public.orders SET fulfillment_status = 'cancelled' WHERE id = p_order_id;

    INSERT INTO public.order_status_history (
      organization_id, order_id, axis, from_status, to_status, changed_by, reason
    ) VALUES (
      p_organization_id, p_order_id, 'fulfillment',
      v_order.fulfillment_status::TEXT, 'cancelled', p_changed_by,
      'Order cancelled'
    );
  END IF;

  -- ── INVENTORY CONSEQUENCE ───────────────────────────────────────────────────
  -- Reached only after the status change and its history row are already
  -- written in this same transaction. Anything that raises below takes all of
  -- that down with it.

  IF p_axis = 'lifecycle' AND v_current = 'draft' AND p_to = 'confirmed' THEN
    -- STOCK-CONSUMING. Quantity comes from the PERSISTED line, never from any
    -- caller: this function has no quantity parameter, and order_items.quantity
    -- was itself derived and CHECK-constrained positive by create_order_v1.
    INSERT INTO public.inventory_movements (
      organization_id, product_id, variant_id, location_id,
      quantity_delta, movement_type, reference_type, reference_id,
      reason, created_by
    )
    SELECT
      oi.organization_id,
      oi.product_id,
      oi.variant_id,
      v_order.location_id,
      -oi.quantity,
      'sale'::public.inventory_movement_type,
      'order_item'::TEXT,
      oi.id,
      NULL::TEXT,
      p_changed_by
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.organization_id = p_organization_id
    ON CONFLICT (organization_id, variant_id, movement_type, reference_type, reference_id)
      WHERE reference_id IS NOT NULL
    DO NOTHING;

    GET DIAGNOSTICS v_movements = ROW_COUNT;

  ELSIF p_axis = 'lifecycle' AND v_current = 'confirmed' AND p_to = 'cancelled' THEN
    -- STOCK-RELEASING. One compensating movement per line that actually
    -- consumed stock.
    --
    -- The EXISTS clause is not decoration. An order confirmed BEFORE this
    -- migration was deployed has no 'sale' movements at all; restocking it on
    -- cancellation would invent units that never left. Releasing exactly what
    -- was consumed — and nothing else — is what makes this a compensating entry
    -- rather than a second, unrelated stock event.
    INSERT INTO public.inventory_movements (
      organization_id, product_id, variant_id, location_id,
      quantity_delta, movement_type, reference_type, reference_id,
      reason, created_by
    )
    SELECT
      oi.organization_id,
      oi.product_id,
      oi.variant_id,
      v_order.location_id,
      oi.quantity,
      'return'::public.inventory_movement_type,
      'order_item'::TEXT,
      oi.id,
      NULL::TEXT,
      p_changed_by
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND oi.organization_id = p_organization_id
      AND EXISTS (
        SELECT 1
        FROM public.inventory_movements m
        WHERE m.organization_id = oi.organization_id
          AND m.variant_id      = oi.variant_id
          AND m.movement_type   = 'sale'
          AND m.reference_type  = 'order_item'
          AND m.reference_id    = oi.id
      )
    ON CONFLICT (organization_id, variant_id, movement_type, reference_type, reference_id)
      WHERE reference_id IS NOT NULL
    DO NOTHING;

    GET DIAGNOSTICS v_movements = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('status', 'success', 'axis', p_axis,
                            'from', v_current, 'to', p_to,
                            'stock_movements', v_movements);
END;
$$;

COMMENT ON FUNCTION public.transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT) IS
  'Atomic Order status transition. Writes the status change, its history row, the fulfillment cascade on cancellation, and the implied append-only inventory_movements (sale on draft->confirmed, return on confirmed->cancelled) in ONE transaction.';

-- ── Privileges (unchanged, restated so they do not depend on REPLACE semantics)
--
-- CREATE OR REPLACE preserves the existing ACL, but restating it here means the
-- end state of this migration is readable on its own and cannot drift if the
-- function is ever recreated rather than replaced.
--
-- anon / authenticated MUST NOT hold EXECUTE. This function takes
-- p_organization_id and now moves stock as well as status: EXECUTE for a
-- browser session would be a cross-tenant primitive that both rewrites another
-- tenant's orders AND writes their inventory ledger. It is reachable only by
-- service_role, i.e. only from src/server/orders/repository.ts.
--
-- Note that this migration grants NOTHING new. No JWT client gains any ability
-- to write inventory_movements: migration 021 revoked INSERT/UPDATE/DELETE on
-- that table from anon and authenticated and blocks INSERT by policy, and this
-- function's own EXECUTE stays revoked from them. The only new capability
-- anywhere is service_role's, through a function it could already call.

REVOKE EXECUTE ON FUNCTION public.transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT)
  TO service_role;
