-- Migration: 047_order_shipping_snapshot
-- Purpose: Give an order an ORDER-AUTHORITATIVE shipping destination snapshot,
--          so a parcel/packing label prints the destination the order was placed
--          for — not the customer's current, mutable on-file default, which may
--          have changed since (PR #80 final review).
-- Touches: public.orders (ADD COLUMN x3, ADD CONSTRAINT x3),
--          public.create_order_v3 (NEW), public.update_order_shipping_v1 (NEW).
-- Classification: tenant-private (inherits orders' organization_id scope).
--
-- ADDITIVE ONLY. No existing function body is replaced, no existing row is
-- rewritten. All three columns are NULL on every existing order and every
-- existing order already satisfies the new (length-only) CHECK constraints. An
-- order created before this migration therefore has NO snapshot; the label path
-- treats that as "shipping address not confirmed" and blocks a first-time print
-- until a human confirms the destination (see getParcelLabelData). We do NOT
-- back-fill old orders with the customer's current address and pretend it is
-- historical truth — that is exactly the defect this migration closes.
--
-- ── WHY A SNAPSHOT ON THE ORDER (and not "read the customer's address") ───────
--
-- The customer profile's address is mutable and shared across all of that
-- customer's orders. Reading it at print time means:
--   * editing the customer's default later silently rewrites where an already
--     placed parcel is addressed, and
--   * a parcel sent to a one-off destination (a gift to a relative in another
--     province) can never be expressed at all.
-- Copying the destination onto the order at creation makes the order the source
-- of truth for its own parcel. A later customer-profile edit cannot change it.
--
-- The snapshot is three plain text fields rather than the structured
-- customer_addresses shape: a label prints one destination block, the order does
-- not need to re-query sangkat/khan/province independently, and keeping it flat
-- means there is exactly one string to print and one string to confirm. The
-- fields are nullable together — an in-store pickup / no-delivery order has no
-- shipping destination and leaves all three NULL, which is a valid state.
--
-- ── WHY create_order_v3 AND NOT AN EDIT TO create_order_v2 ────────────────────
--
-- Same reasoning migration 044 gives for v2-over-v1: PostgREST resolves an RPC
-- by its named arguments and PostgreSQL requires every parameter after a
-- defaulted one to be defaulted too, so an overload cannot make the new fields
-- REQUIRED and an all-defaulted overload would collide with v2's signature. A
-- new name has exactly one signature. v2 is left in place byte-for-byte so a
-- build mid-deploy keeps working; the server switches to v3 in the same change
-- that adds this migration (src/server/orders/repository.ts).
--
-- Idempotency is preserved and EXTENDED: v3 folds the normalized shipping
-- snapshot into the request fingerprint, so
--   same key + same commerce payload + same address  -> replay (same order)
--   same key + same commerce payload + different address -> idempotency_conflict
-- A lost-response retry can never silently re-address a parcel, and the snapshot
-- is written in the SAME INSERT as the order — there is no window in which a
-- successfully created order lacks the snapshot the request carried.

-- ── Columns & constraints ────────────────────────────────────────────────────

ALTER TABLE public.orders
  ADD COLUMN shipping_name    TEXT NULL,
  ADD COLUMN shipping_phone   TEXT NULL,
  ADD COLUMN shipping_address TEXT NULL;

-- Length-only guards. Semantic validation (non-blank when a destination is
-- supplied, phone shape, no control characters) is the application layer's — see
-- src/server/orders/service.ts — so these are deliberately loose upper bounds
-- that every historical NULL and every reasonable Cambodian address satisfies.
ALTER TABLE public.orders
  ADD CONSTRAINT orders_shipping_name_len    CHECK (shipping_name    IS NULL OR char_length(shipping_name)    <= 200),
  ADD CONSTRAINT orders_shipping_phone_len   CHECK (shipping_phone   IS NULL OR char_length(shipping_phone)   <= 40),
  ADD CONSTRAINT orders_shipping_address_len CHECK (shipping_address IS NULL OR char_length(shipping_address) <= 1000);

COMMENT ON COLUMN public.orders.shipping_name IS
  'Order shipping destination snapshot: recipient name, captured at order creation and editable before fulfillment (migration 047). Order-authoritative; independent of the customer profile. NULL for pickup / pre-047 orders.';
COMMENT ON COLUMN public.orders.shipping_phone IS
  'Order shipping destination snapshot: recipient phone (migration 047). NULL when none supplied.';
COMMENT ON COLUMN public.orders.shipping_address IS
  'Order shipping destination snapshot: single formatted address line, the authoritative parcel destination (migration 047). NULL for pickup / pre-047 / not-yet-confirmed orders.';

-- ── create_order_v3 ──────────────────────────────────────────────────────────
--
-- Identical to create_order_v2 (migration 044) in pricing, tenant, line and
-- idempotency rules, plus an OPTIONAL shipping destination snapshot folded into
-- both the request fingerprint and the order INSERT.

CREATE FUNCTION public.create_order_v3(
  p_organization_id         UUID,
  p_created_by              UUID,
  p_source                  TEXT,
  p_items                   JSONB,
  p_customer_id             UUID,
  p_location_id             UUID,
  p_discount_minor          BIGINT,
  p_delivery_minor          BIGINT,
  p_source_conversation_ref TEXT,
  p_idempotency_key         TEXT,
  p_shipping_name           TEXT,
  p_shipping_phone          TEXT,
  p_shipping_address        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_currency       TEXT;
  v_order_id       UUID;
  v_order_number   TEXT;
  v_subtotal       BIGINT := 0;
  v_total          BIGINT;
  v_item           JSONB;
  v_line           JSONB;
  v_lines          JSONB := '[]'::JSONB;
  v_variant        RECORD;
  v_product_name   TEXT;
  v_quantity       INTEGER;
  v_line_total     BIGINT;
  v_claimed_pid    UUID;
  v_conv_ref       TEXT;
  v_ship_name      TEXT;
  v_ship_phone     TEXT;
  v_ship_address   TEXT;
  v_request        JSONB;
  v_fingerprint    TEXT;
  v_existing       RECORD;
  v_max_delivery   BIGINT;
BEGIN
  -- ── Structural input validation ───────────────────────────────────────────
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'create_order_v3: organization_id is required';
  END IF;

  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' THEN
    RETURN jsonb_build_object('status', 'invalid_idempotency_key');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('status', 'no_items');
  END IF;

  v_conv_ref := NULLIF(trim(coalesce(p_source_conversation_ref, '')), '');

  -- Normalize the shipping snapshot. Empty/whitespace becomes NULL so a blank
  -- field never differs from "not supplied" in the fingerprint. Length caps
  -- mirror the CHECK constraints so a too-long value is rejected here rather
  -- than raising deep in the INSERT.
  v_ship_name    := NULLIF(trim(coalesce(p_shipping_name, '')), '');
  v_ship_phone   := NULLIF(trim(coalesce(p_shipping_phone, '')), '');
  v_ship_address := NULLIF(trim(coalesce(p_shipping_address, '')), '');
  IF char_length(coalesce(v_ship_name, '')) > 200
     OR char_length(coalesce(v_ship_phone, '')) > 40
     OR char_length(coalesce(v_ship_address, '')) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid_shipping');
  END IF;

  -- ── Request fingerprint (now includes the shipping snapshot) ──────────────
  v_request := jsonb_build_object(
    'source',                  p_source,
    'items', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'variant_id', lower(e ->> 'variant_id'),
          'quantity',   e -> 'quantity',
          'product_id', lower(NULLIF(e ->> 'product_id', ''))
        ) ORDER BY ord
      )
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, ord)
    ),
    'customer_id',             p_customer_id,
    'location_id',             p_location_id,
    'discount_minor',          p_discount_minor,
    'delivery_minor',          p_delivery_minor,
    'source_conversation_ref', v_conv_ref,
    'shipping_name',           v_ship_name,
    'shipping_phone',          v_ship_phone,
    'shipping_address',        v_ship_address
  );
  v_fingerprint := encode(sha256(convert_to(v_request::TEXT, 'UTF8')), 'hex');

  -- ── Idempotency gate: serialise, then look up ─────────────────────────────
  PERFORM pg_advisory_xact_lock(
    hashtextextended('create_order_v3:' || p_organization_id::TEXT || ':' || p_idempotency_key, 0)
  );

  SELECT id, order_number, created_by, idempotency_fingerprint
    INTO v_existing
  FROM public.orders
  WHERE organization_id = p_organization_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.created_by IS DISTINCT FROM p_created_by
       OR v_existing.idempotency_fingerprint IS DISTINCT FROM v_fingerprint THEN
      -- A different principal, a different basket, OR a different shipping
      -- address all land here — a retry can never silently re-address a parcel.
      RETURN jsonb_build_object('status', 'idempotency_conflict');
    END IF;

    RETURN jsonb_build_object(
      'status',       'success',
      'replayed',     true,
      'order_id',     v_existing.id,
      'order_number', v_existing.order_number
    );
  END IF;

  -- ── Money inputs ──────────────────────────────────────────────────────────
  IF p_discount_minor IS NULL OR p_discount_minor < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_discount');
  END IF;

  SELECT default_currency INTO v_currency
  FROM public.organizations
  WHERE id = p_organization_id;

  IF v_currency IS NULL THEN
    RETURN jsonb_build_object('status', 'organization_not_found');
  END IF;

  v_max_delivery := CASE v_currency WHEN 'KHR' THEN 4000000 ELSE 100000 END;
  IF p_delivery_minor IS NULL OR p_delivery_minor < 0 OR p_delivery_minor > v_max_delivery THEN
    RETURN jsonb_build_object('status', 'invalid_delivery_fee');
  END IF;

  -- ── Tenant ownership of the optional references ───────────────────────────
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
    IF jsonb_typeof(v_item -> 'quantity') IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('status', 'invalid_quantity');
    END IF;

    v_quantity := (v_item ->> 'quantity')::NUMERIC::INTEGER;

    IF v_quantity IS NULL
       OR v_quantity <= 0
       OR (v_item ->> 'quantity')::NUMERIC <> v_quantity THEN
      RETURN jsonb_build_object('status', 'invalid_quantity');
    END IF;

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

    v_claimed_pid := NULLIF(v_item ->> 'product_id', '')::UUID;
    IF v_claimed_pid IS NOT NULL AND v_claimed_pid <> v_variant.product_id THEN
      RETURN jsonb_build_object('status', 'product_variant_mismatch',
                                'variant_id', v_item ->> 'variant_id');
    END IF;

    IF v_variant.price_currency <> v_currency THEN
      RETURN jsonb_build_object('status', 'currency_mismatch',
                                'variant_id', v_item ->> 'variant_id');
    END IF;

    SELECT p.name_km INTO v_product_name
    FROM public.products p
    WHERE p.id = v_variant.product_id
      AND p.organization_id = p_organization_id;

    IF v_product_name IS NULL THEN
      RAISE EXCEPTION 'create_order_v3: product % missing for variant %',
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

  IF p_discount_minor > v_subtotal THEN
    RETURN jsonb_build_object('status', 'discount_exceeds_subtotal');
  END IF;

  v_total := v_subtotal - p_discount_minor + p_delivery_minor;

  -- ── PASS 2: write. Everything below succeeds together or not at all. ──────
  v_order_number := public.allocate_order_number(p_organization_id);

  INSERT INTO public.orders (
    organization_id, order_number, customer_id, location_id, source,
    currency, subtotal_minor, discount_minor, delivery_minor, total_minor,
    lifecycle_status, payment_status, fulfillment_status, created_by,
    source_conversation_ref, idempotency_key, idempotency_fingerprint,
    shipping_name, shipping_phone, shipping_address
  ) VALUES (
    p_organization_id, v_order_number, p_customer_id, p_location_id,
    p_source::public.order_source,
    v_currency, v_subtotal, p_discount_minor, p_delivery_minor, v_total,
    'draft', 'unpaid', 'unfulfilled', p_created_by,
    v_conv_ref, p_idempotency_key, v_fingerprint,
    v_ship_name, v_ship_phone, v_ship_address
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
    'replayed',     false,
    'order_id',     v_order_id,
    'order_number', v_order_number
  );
END;
$$;

COMMENT ON FUNCTION public.create_order_v3(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'Idempotent draft-order creation with an order-authoritative shipping destination snapshot (migration 047). Extends create_order_v2: the normalized shipping name/phone/address are part of the request fingerprint and are written in the same INSERT as the order, so the same key with a different address is an idempotency_conflict, never a silent re-address.';

REVOKE EXECUTE ON FUNCTION public.create_order_v3(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_order_v3(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

-- ── update_order_shipping_v1 ──────────────────────────────────────────────────
--
-- The ONE write path that mutates an existing order's shipping snapshot. It is a
-- narrow, specific RPC — NOT a generic order UPDATE — for the same reason the
-- order repository has no generic update: a broad update primitive would let a
-- caller step around the state machine. This one touches only the three shipping
-- columns and nothing else.
--
-- It is the authority behind two flows:
--   * confirming the destination of a pre-047 order that has no snapshot, and
--   * correcting a destination before the parcel goes out.
--
-- It refuses once the order is terminal (completed / cancelled) or its
-- fulfillment is terminal (fulfilled / cancelled): a shipped or closed parcel's
-- historical destination is not casually rewritten (§10). The order-amounts
-- immutability trigger (migration 044) is unaffected — this never touches an
-- amount or the idempotency identity.
--
-- The returned envelope carries only PRESENCE booleans (had_* / has_*), never a
-- raw name/phone/address, so the caller can write a PII-safe audit row from it.

CREATE FUNCTION public.update_order_shipping_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_actor           UUID,
  p_shipping_name   TEXT,
  p_shipping_phone  TEXT,
  p_shipping_address TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order        RECORD;
  v_ship_name    TEXT;
  v_ship_phone   TEXT;
  v_ship_address TEXT;
BEGIN
  IF p_organization_id IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'update_order_shipping_v1: organization_id and order_id are required';
  END IF;

  v_ship_name    := NULLIF(trim(coalesce(p_shipping_name, '')), '');
  v_ship_phone   := NULLIF(trim(coalesce(p_shipping_phone, '')), '');
  v_ship_address := NULLIF(trim(coalesce(p_shipping_address, '')), '');
  IF char_length(coalesce(v_ship_name, '')) > 200
     OR char_length(coalesce(v_ship_phone, '')) > 40
     OR char_length(coalesce(v_ship_address, '')) > 1000 THEN
    RETURN jsonb_build_object('status', 'invalid_shipping');
  END IF;

  -- Lock the row so a concurrent transition cannot move the order into a
  -- terminal state between this read and the UPDATE below.
  SELECT id, lifecycle_status, fulfillment_status,
         shipping_name, shipping_phone, shipping_address
    INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'order_not_found');
  END IF;

  IF v_order.lifecycle_status IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'order_terminal');
  END IF;

  IF v_order.fulfillment_status IN ('fulfilled', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'fulfillment_terminal');
  END IF;

  UPDATE public.orders
     SET shipping_name    = v_ship_name,
         shipping_phone   = v_ship_phone,
         shipping_address = v_ship_address
   WHERE id = p_order_id AND organization_id = p_organization_id;

  RETURN jsonb_build_object(
    'status',        'success',
    'order_id',      p_order_id,
    'had_name',      v_order.shipping_name    IS NOT NULL,
    'had_phone',     v_order.shipping_phone   IS NOT NULL,
    'had_address',   v_order.shipping_address IS NOT NULL,
    'has_name',      v_ship_name    IS NOT NULL,
    'has_phone',     v_ship_phone   IS NOT NULL,
    'has_address',   v_ship_address IS NOT NULL
  );
END;
$$;

COMMENT ON FUNCTION public.update_order_shipping_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT) IS
  'Set/confirm/correct an order shipping destination snapshot before fulfillment (migration 047). Narrow: touches only the three shipping columns. Refused once lifecycle or fulfillment is terminal. Returns presence booleans only — never raw PII — for a safe audit row.';

REVOKE EXECUTE ON FUNCTION public.update_order_shipping_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_order_shipping_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;
