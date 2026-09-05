-- Migration: 024_order_rpc
-- Purpose: Atomic, server-authoritative Order write path.
-- Functions: allocate_order_number, create_order_v1, transition_order_status_v1
--
-- WHY RPCs AT ALL
--   Creating an order writes two tables (orders + order_items) and allocates a
--   human reference; transitioning a status writes two tables (orders +
--   order_status_history). Doing either as separate PostgREST calls from the
--   application means a failure between them leaves a half-order — an order
--   with no lines, or a status change with no history. supabase-js has no
--   client-side transaction, so the transaction has to live in the database.
--   These functions ARE that transaction: each is one statement from the
--   caller's point of view and either fully happens or does not happen at all.
--
-- WHY PRICING IS COMPUTED HERE
--   create_order_v1 accepts only (variant_id, quantity) per line. It never
--   accepts a price, a line total, a subtotal or a total. It reads the current
--   price from product_variants itself and derives every monetary value in SQL.
--   A client-supplied total therefore has nowhere to enter the system: there is
--   no parameter for it, and migration 023's CHECK constraints would reject a
--   mismatched total even if one somehow arrived.
--
-- SECURITY MODEL — READ BEFORE CHANGING ANY SIGNATURE
--   These functions take p_organization_id as a parameter, which is safe here
--   and ONLY here because EXECUTE is revoked from PUBLIC, anon and
--   authenticated: no JWT client can call them at all. The sole caller is the
--   APSA server domain (src/server/orders/service.ts) using the service role,
--   which passes ctx.organizationId — a value derived from a verified DB
--   membership, never from a request body.
--
--   Do NOT grant EXECUTE to `authenticated`. Doing so would hand every browser
--   session the ability to name its own organization_id and write into another
--   tenant. (This is the opposite of create_organization_for_founder in
--   migration 009, which is called BY a JWT client and therefore derives its
--   identity from auth.uid() and takes no id parameters.)
--
--   SET search_path = public, auth on every function prevents search_path
--   injection against a SECURITY DEFINER routine.
--
-- ERROR CONVENTION
--   Expected business outcomes RETURN a JSONB {status: '...'} the application
--   maps to an HTTP status. Impossible states RAISE, because they mean a bug or
--   an attack and must not be swallowed.

-- ── allocate_order_number ─────────────────────────────────────────────────────
--
-- Race-free per-(organization, year) allocation.
--
-- The INSERT ... ON CONFLICT DO UPDATE increments the counter IN THE DATABASE
-- and returns the new value in one statement. The row lock the UPDATE takes is
-- held until the surrounding transaction commits, so two concurrent orders in
-- the same organization serialize on that row and receive different numbers.
-- This is the specific reason it is not "SELECT MAX(order_number) + 1", which
-- takes no lock and hands the same number to both.

CREATE OR REPLACE FUNCTION public.allocate_order_number(
  p_organization_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_year   INTEGER := EXTRACT(YEAR FROM now() AT TIME ZONE 'UTC')::INTEGER;
  v_number BIGINT;
BEGIN
  INSERT INTO public.order_number_sequences (organization_id, year, last_number)
  VALUES (p_organization_id, v_year, 1)
  ON CONFLICT (organization_id, year)
  DO UPDATE SET last_number = public.order_number_sequences.last_number + 1
  RETURNING last_number INTO v_number;

  -- DATA_MODEL.md §45 format: APSA-2026-000123.
  RETURN 'APSA-' || v_year::TEXT || '-' || lpad(v_number::TEXT, 6, '0');
END;
$$;

-- ── create_order_v1 ───────────────────────────────────────────────────────────
--
-- p_items shape: [{"variant_id": "<uuid>", "quantity": <positive int>,
--                  "product_id": "<uuid>"   -- OPTIONAL cross-check only
--                 }, ...]
--
-- product_id is NOT trusted as input. The authoritative product for a line is
-- the variant's own product_id; when the caller supplies one it is compared and
-- a mismatch is rejected, so a caller cannot attach a line to a product that
-- did not sell it.
--
-- ATOMICITY / NO PARTIAL ORDERS
--   The function runs in two passes and writes NOTHING in the first one.
--   Pass 1 resolves and validates every line (ownership, sellability, currency,
--   quantity) and derives the totals. Only if all of that succeeds does pass 2
--   allocate the order number and insert the order with its lines.
--
--   This ordering is deliberate and load-bearing. A plain `RETURN` from a
--   plpgsql function does not roll anything back — the caller's transaction
--   commits whatever the function already wrote. Validating after the order row
--   existed would mean every rejected line left behind a real, numbered,
--   item-less order in the merchant's books. Because no write happens until the
--   inputs are known-good, a rejected create leaves no trace; and once pass 2
--   starts, any failure raises and the whole statement rolls back.

CREATE OR REPLACE FUNCTION public.create_order_v1(
  p_organization_id UUID,
  p_created_by      UUID,
  p_source          TEXT,
  p_items           JSONB,
  p_customer_id     UUID   DEFAULT NULL,
  p_location_id     UUID   DEFAULT NULL,
  p_discount_minor  BIGINT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_currency     TEXT;
  v_order_id     UUID;
  v_order_number TEXT;
  v_subtotal     BIGINT := 0;
  v_total        BIGINT;
  v_item         JSONB;
  v_line         JSONB;
  v_lines        JSONB := '[]'::JSONB;
  v_variant      RECORD;
  v_product_name TEXT;
  v_quantity     INTEGER;
  v_line_total   BIGINT;
  v_claimed_pid  UUID;
BEGIN
  -- ── Structural input validation ───────────────────────────────────────────
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'create_order_v1: organization_id is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('status', 'no_items');
  END IF;

  IF p_discount_minor IS NULL OR p_discount_minor < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_discount');
  END IF;

  -- ── Currency is the ORGANIZATION's, never the caller's ────────────────────
  SELECT default_currency INTO v_currency
  FROM public.organizations
  WHERE id = p_organization_id;

  IF v_currency IS NULL THEN
    RETURN jsonb_build_object('status', 'organization_not_found');
  END IF;

  -- ── Tenant ownership of the optional references ───────────────────────────
  --    Checked here as well as by migration 023's triggers so the caller gets a
  --    precise, non-leaking answer ("not found") instead of a raw trigger error.
  IF p_customer_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.customers
      WHERE id = p_customer_id AND organization_id = p_organization_id
    ) THEN
      RETURN jsonb_build_object('status', 'customer_not_found');
    END IF;
  END IF;

  IF p_location_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.locations
      WHERE id = p_location_id AND organization_id = p_organization_id
    ) THEN
      RETURN jsonb_build_object('status', 'location_not_found');
    END IF;
  END IF;

  -- ── PASS 1: resolve and validate every line. No writes. ───────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF jsonb_typeof(v_item -> 'quantity') <> 'number' THEN
      RETURN jsonb_build_object('status', 'invalid_quantity');
    END IF;

    v_quantity := (v_item ->> 'quantity')::NUMERIC::INTEGER;

    -- Reject 0, negatives, and non-integers such as 1.5 (which would otherwise
    -- silently round to a quantity the customer never ordered).
    IF v_quantity IS NULL
       OR v_quantity <= 0
       OR (v_item ->> 'quantity')::NUMERIC <> v_quantity THEN
      RETURN jsonb_build_object('status', 'invalid_quantity');
    END IF;

    -- The variant lookup is org-scoped: a variant belonging to another tenant
    -- is indistinguishable from one that does not exist.
    SELECT v.id, v.product_id, v.name, v.sku, v.price_amount, v.price_currency, v.status
      INTO v_variant
    FROM public.product_variants v
    WHERE v.id = (v_item ->> 'variant_id')::UUID
      AND v.organization_id = p_organization_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'variant_not_found',
                                'variant_id', v_item ->> 'variant_id');
    END IF;

    IF v_variant.status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('status', 'variant_not_sellable',
                                'variant_id', v_item ->> 'variant_id');
    END IF;

    -- Optional caller-supplied product_id is a cross-check, never the source.
    v_claimed_pid := NULLIF(v_item ->> 'product_id', '')::UUID;
    IF v_claimed_pid IS NOT NULL AND v_claimed_pid <> v_variant.product_id THEN
      RETURN jsonb_build_object('status', 'product_variant_mismatch',
                                'variant_id', v_item ->> 'variant_id');
    END IF;

    -- One currency per order. A variant priced in another currency cannot be
    -- summed into this order's totals without inventing an exchange rate, and
    -- ARCHITECTURE.md requires a recorded rate at conversion time — which this
    -- phase does not build.
    IF v_variant.price_currency <> v_currency THEN
      RETURN jsonb_build_object('status', 'currency_mismatch',
                                'variant_id', v_item ->> 'variant_id');
    END IF;

    -- Name snapshot, taken now so the line records what the catalog said at
    -- sale time even if the product is renamed a minute later.
    SELECT p.name_km INTO v_product_name
    FROM public.products p
    WHERE p.id = v_variant.product_id
      AND p.organization_id = p_organization_id;

    IF v_product_name IS NULL THEN
      -- A variant whose product is missing or in another tenant is impossible
      -- under migration 018's integrity trigger: this is corruption, not input.
      RAISE EXCEPTION 'create_order_v1: product % missing for variant %',
        v_variant.product_id, v_variant.id;
    END IF;

    v_line_total := v_variant.price_amount::BIGINT * v_quantity;
    v_subtotal   := v_subtotal + v_line_total;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id',            v_variant.product_id,
      'variant_id',            v_variant.id,
      'product_name_snapshot', v_product_name,
      'variant_name_snapshot', NULLIF(v_variant.name, ''),
      'sku_snapshot',          v_variant.sku,
      'unit_price_minor',      v_variant.price_amount::BIGINT,
      'quantity',              v_quantity,
      'line_total_minor',      v_line_total
    ));
  END LOOP;

  -- Totals are derived from the resolved lines, never from caller input.
  IF p_discount_minor > v_subtotal THEN
    RETURN jsonb_build_object('status', 'discount_exceeds_subtotal');
  END IF;

  v_total := v_subtotal - p_discount_minor;

  -- ── PASS 2: write. Everything below succeeds together or not at all. ──────
  v_order_number := public.allocate_order_number(p_organization_id);

  INSERT INTO public.orders (
    organization_id, order_number, customer_id, location_id, source,
    currency, subtotal_minor, discount_minor, delivery_minor, total_minor,
    lifecycle_status, payment_status, fulfillment_status, created_by
  ) VALUES (
    p_organization_id, v_order_number, p_customer_id, p_location_id,
    p_source::public.order_source,
    v_currency, v_subtotal, p_discount_minor, 0, v_total,
    'draft', 'unpaid', 'unfulfilled', p_created_by
  )
  RETURNING id INTO v_order_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines)
  LOOP
    INSERT INTO public.order_items (
      organization_id, order_id, product_id, variant_id,
      product_name_snapshot, variant_name_snapshot, sku_snapshot,
      unit_price_minor, quantity, line_total_minor
    ) VALUES (
      p_organization_id,
      v_order_id,
      (v_line ->> 'product_id')::UUID,
      (v_line ->> 'variant_id')::UUID,
      v_line ->> 'product_name_snapshot',
      v_line ->> 'variant_name_snapshot',
      v_line ->> 'sku_snapshot',
      (v_line ->> 'unit_price_minor')::BIGINT,
      (v_line ->> 'quantity')::INTEGER,
      (v_line ->> 'line_total_minor')::BIGINT
    );
  END LOOP;

  RETURN jsonb_build_object(
    'status',       'success',
    'order_id',     v_order_id,
    'order_number', v_order_number
  );
END;
$$;

-- ── transition_order_status_v1 ────────────────────────────────────────────────
--
-- WHERE THE STATE MACHINE LIVES
--   The transition TABLE (which status may follow which, and who may perform
--   it) is authoritative in TypeScript: src/server/orders/state-machine.ts. It
--   is pure, exhaustively tested, and shared by every future caller.
--
--   This function enforces the four things only the database can guarantee, and
--   it enforces them regardless of which server code calls it:
--     1. Atomicity — the status change and its history row commit together.
--     2. Tenant scope — an order in another organization is "not found".
--     3. Optimistic concurrency — the update applies only if the current status
--        is still the one the caller validated against, so two concurrent
--        transitions cannot both succeed from the same starting state.
--     4. Terminal and cross-axis invariants (below), which depend on reading
--        all three axes under a row lock.

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
BEGIN
  IF p_axis NOT IN ('lifecycle', 'payment', 'fulfillment') THEN
    RAISE EXCEPTION 'transition_order_status_v1: unknown axis %', p_axis;
  END IF;

  -- FOR UPDATE: hold the row for the rest of the transaction so the read of the
  -- current status and the write that depends on it cannot interleave.
  SELECT id, lifecycle_status, payment_status, fulfillment_status
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
    -- than overwriting a decision it never saw.
    RETURN jsonb_build_object('status', 'stale', 'current', v_current);
  END IF;

  IF v_current = p_to THEN
    RETURN jsonb_build_object('status', 'no_change', 'current', v_current);
  END IF;

  -- Terminal lifecycle states freeze the whole order. A cancelled order cannot
  -- later become paid, and a completed one cannot be re-fulfilled. Enforced
  -- here as well as in the state machine because it is the invariant most
  -- damaging to get wrong: it is what stops money and (later) stock moving on
  -- an order that is finished.
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
  --
  -- FUTURE INVENTORY TRIGGER POINT — see migration 023. The reverse edge
  -- ('confirmed' -> 'cancelled') is where committed stock is released, and
  -- ('draft' -> 'confirmed') is where it is consumed. Neither writes
  -- inventory_movements yet; that wiring is the next phase.
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

  RETURN jsonb_build_object('status', 'success', 'axis', p_axis,
                            'from', v_current, 'to', p_to);
END;
$$;

-- ── Privileges ────────────────────────────────────────────────────────────────
--
-- No JWT client may call any of these. They accept an organization_id, so a
-- grant to `authenticated` would be a direct cross-tenant write primitive.
-- The service role is not listed because it bypasses these checks by design;
-- it needs no explicit grant.

REVOKE EXECUTE ON FUNCTION public.allocate_order_number(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.create_order_v1(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT)
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.transition_order_status_v1(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
