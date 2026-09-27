-- Migration: 044_order_idempotency_delivery_fee
-- Purpose: (1) Server-authoritative idempotency for real Order creation.
--          (2) The merchant-charged delivery fee as a real, server-validated
--              component of the Order total.
--          (3) Order amounts become immutable once created.
-- Touches: public.orders (ADD COLUMN x2, ADD CONSTRAINT x2, UNIQUE INDEX,
--          TRIGGER), public.create_order_v2 (NEW),
--          public.guard_order_amounts_immutable (NEW)
-- Classification: tenant-private (inherits orders' organization_id scope)
--
-- ADDITIVE ONLY. No existing function body is replaced, no existing row is
-- rewritten. Both new columns are NULL on every existing order, and every
-- existing order already satisfies the new constraints (delivery_minor has only
-- ever been written as 0 — see migration 023/030).
--
-- ── WHY create_order_v2 AND NOT A THIRD create_order_v1 OVERLOAD ────────────
--
-- create_order_v1 already has two overloads (migrations 024 and 030) and every
-- parameter after p_items carries a DEFAULT. PostgreSQL requires every
-- parameter after a defaulted one to be defaulted too, so a third overload
-- could not make the idempotency key REQUIRED; and PostgREST resolves an RPC
-- call by its named arguments, so an overload whose extra parameters are all
-- defaulted matches the same call as migration 030's overload and the request
-- fails as ambiguous. A new name has exactly one signature, a required key and
-- a required delivery fee.
--
-- The v1 overloads are left in place, byte-for-byte, so an application build
-- that predates this migration keeps creating orders during a rolling deploy.
-- The server stops calling v1 in the same change that adds this migration
-- (src/server/orders/repository.ts). Revoking v1 from service_role is a
-- follow-up once no deployed build calls it.
--
-- ── IDEMPOTENCY DESIGN ──────────────────────────────────────────────────────
--
-- API_AND_EVENTS.md §22–23: "Same request + same key must not create duplicate
-- financial/business effects"; the store needs key, organization, operation,
-- request hash and result reference. The smallest robust store is the Order
-- row itself:
--   key              -> orders.idempotency_key
--   organization_id  -> orders.organization_id
--   operation        -> implicit (only order creation writes these columns)
--   request_hash     -> orders.idempotency_fingerprint (SHA-256, hex)
--   result_reference -> orders.id
-- Writing the key in the SAME INSERT as the order means there is no window in
-- which a key exists without its order or an order without its key, and no
-- second table whose rows could drift from the orders they describe.
--
-- Scope: UNIQUE (organization_id, idempotency_key). Two organizations using the
-- same key never collide. Within one organization a replay returns the stored
-- order ONLY when the stored created_by is the caller AND the stored
-- fingerprint equals this request's fingerprint. Anything else is
-- 'idempotency_conflict' carrying NO order id, number or amount — a member who
-- guessed a colleague's key learns nothing, and a caller who reused a key for a
-- different basket is told so instead of being handed an unrelated order.
--
-- Replay ordering: the lookup happens BEFORE catalog validation and BEFORE the
-- order number is allocated. A retry whose variant was archived after the first
-- attempt succeeded still returns the order that was created, and a replay
-- never allocates a number, writes a line or reaches the inventory ledger.
--
-- Concurrency: two concurrent requests with the same (organization, key) are
-- serialised by pg_advisory_xact_lock on a hash of that pair, taken before the
-- lookup. The second waits for the first to commit or roll back; its lookup is
-- a new statement and therefore a new READ COMMITTED snapshot, so it sees the
-- committed order and replays it. The unique index is the backstop: if the lock
-- were ever removed, a duplicate INSERT raises and rolls back instead of
-- creating a second order. A hash collision between two different keys only
-- serialises two unrelated creates; it never merges them.
--
-- ── DELIVERY FEE ────────────────────────────────────────────────────────────
--
-- orders.delivery_minor has existed since migration 023 (integer minor units,
-- CHECK >= 0, part of orders_total_is_derived) but no write path ever set it.
-- It is what the MERCHANT CHARGES THE CUSTOMER for delivery — never the
-- courier's cost to the merchant, which belongs to the Delivery provider layer
-- and is not modelled here. It is denominated in the order's currency, which is
-- the organization's currency; the caller cannot name a currency.
--
--   total_minor = subtotal_minor - discount_minor + delivery_minor
--
-- is computed by this function from catalog prices and is ALSO the existing
-- orders_total_is_derived CHECK, so no write path can store any other total.
-- Bounds: 0 <= delivery_minor <= 100000 for USD ($1,000.00) and <= 4000000 for
-- KHR (4,000,000 riel). A delivery fee is not bounded by the subtotal — a small
-- item can cost more to deliver than to buy.
--
-- Payment: order_payment_totals (migration 040) derives 'paid' from
-- received >= orders.total_minor, so the delivery fee is owed exactly like the
-- goods are. No payment function is changed here.
--
-- COD: deliveries.cod_amount_minor stays an independent operational amount the
-- courier collects (migration 027); it can legitimately differ from the order
-- total (part-paid order, courier collecting only the balance). Nothing here
-- derives one from the other. The UI states the difference explicitly.
--
-- ── ATOMICITY ───────────────────────────────────────────────────────────────
--
-- create_order_v2 is one plpgsql function, therefore one transaction to its
-- caller. Every business rejection (bad key, conflict, bad fee, unknown
-- variant, …) RETURNs before the first write. The order-number UPSERT, the
-- order INSERT and every line INSERT either all commit or all roll back —
-- order_number_sequences is a table, not a SEQUENCE, so a rolled-back create
-- does not even leave a gap in the numbering.

-- ── Columns & constraints ────────────────────────────────────────────────────

ALTER TABLE public.orders
  ADD COLUMN idempotency_key TEXT NULL,
  ADD COLUMN idempotency_fingerprint TEXT NULL;

-- Both or neither: a key without the request it named cannot detect a
-- mismatched replay, and a fingerprint without a key is meaningless.
ALTER TABLE public.orders
  ADD CONSTRAINT orders_idempotency_pair CHECK (
    (idempotency_key IS NULL) = (idempotency_fingerprint IS NULL)
  );

-- An opaque, random, URL-safe token (the client sends a UUID). The charset
-- bound keeps it out of any log-injection or path-building concern; the length
-- floor rejects low-entropy keys a colleague could guess.
ALTER TABLE public.orders
  ADD CONSTRAINT orders_idempotency_key_format CHECK (
    idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'
  );

COMMENT ON COLUMN public.orders.idempotency_key IS
  'Client-generated random key for one logical order-creation attempt (migration 044). Unique per organization. Never an authorization token — a replay also requires the same created_by and fingerprint.';

COMMENT ON COLUMN public.orders.idempotency_fingerprint IS
  'SHA-256 (hex) of the normalized create_order_v2 request that first used idempotency_key. A replay with a different fingerprint is refused as idempotency_conflict.';

COMMENT ON COLUMN public.orders.delivery_minor IS
  'Delivery fee the merchant charges the customer, integer minor units in orders.currency (migration 044). Never the courier cost. Part of orders_total_is_derived.';

-- Enforcement, not just lookup speed: this is the constraint that makes a
-- second order under one key impossible even if the RPC's lock were removed.
CREATE UNIQUE INDEX uniq_orders_idempotency_key_per_org
  ON public.orders(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Order amounts are immutable after creation ───────────────────────────────
--
-- No function in APSA updates an order's money after create: transitions write
-- status axes, deliveries write fulfillment, payments write payment/refund
-- axes. This trigger makes that an enforced property instead of an observed
-- one, so a future status/delivery/payment path cannot rewrite a total the
-- customer was quoted — including through a service-role write. Migration 040
-- already freezes currency/total once a Payment exists; this extends the freeze
-- to every amount from the moment of creation, and to the idempotency identity.

CREATE FUNCTION public.guard_order_amounts_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF (NEW.currency, NEW.subtotal_minor, NEW.discount_minor, NEW.delivery_minor,
      NEW.total_minor, NEW.idempotency_key, NEW.idempotency_fingerprint)
     IS DISTINCT FROM
     (OLD.currency, OLD.subtotal_minor, OLD.discount_minor, OLD.delivery_minor,
      OLD.total_minor, OLD.idempotency_key, OLD.idempotency_fingerprint)
  THEN
    RAISE EXCEPTION 'Order amounts and idempotency identity are immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_amounts_immutable BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_amounts_immutable();

REVOKE ALL ON FUNCTION public.guard_order_amounts_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

-- ── create_order_v2 ──────────────────────────────────────────────────────────
--
-- Identical pricing, tenant and line rules to create_order_v1 (migration 030),
-- plus: a REQUIRED idempotency key checked before anything else can happen,
-- and a REQUIRED, bounded delivery fee added into the derived total.

CREATE FUNCTION public.create_order_v2(
  p_organization_id         UUID,
  p_created_by              UUID,
  p_source                  TEXT,
  p_items                   JSONB,
  p_customer_id             UUID,
  p_location_id             UUID,
  p_discount_minor          BIGINT,
  p_delivery_minor          BIGINT,
  p_source_conversation_ref TEXT,
  p_idempotency_key         TEXT
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
  v_conv_ref     TEXT;
  v_request      JSONB;
  v_fingerprint  TEXT;
  v_existing     RECORD;
  v_max_delivery BIGINT;
BEGIN
  -- ── Structural input validation ───────────────────────────────────────────
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'create_order_v2: organization_id is required';
  END IF;

  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,128}$' THEN
    RETURN jsonb_build_object('status', 'invalid_idempotency_key');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('status', 'no_items');
  END IF;

  v_conv_ref := NULLIF(trim(coalesce(p_source_conversation_ref, '')), '');

  -- ── Request fingerprint ───────────────────────────────────────────────────
  -- Normalized so that a byte-different but logically identical retry (key
  -- order inside a line object, UUID letter case, extra unknown keys) is the
  -- same request, while every field that changes the resulting order — source,
  -- each line's variant/quantity/product and their order, customer, location,
  -- discount, delivery fee, conversation ref — changes the fingerprint.
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
    'source_conversation_ref', v_conv_ref
  );
  v_fingerprint := encode(sha256(convert_to(v_request::TEXT, 'UTF8')), 'hex');

  -- ── Idempotency gate: serialise, then look up ─────────────────────────────
  PERFORM pg_advisory_xact_lock(
    hashtextextended('create_order_v2:' || p_organization_id::TEXT || ':' || p_idempotency_key, 0)
  );

  SELECT id, order_number, created_by, idempotency_fingerprint
    INTO v_existing
  FROM public.orders
  WHERE organization_id = p_organization_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.created_by IS DISTINCT FROM p_created_by
       OR v_existing.idempotency_fingerprint IS DISTINCT FROM v_fingerprint THEN
      -- Deliberately carries nothing about the stored order.
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

  -- Currency is the ORGANIZATION's, never the caller's.
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

    -- Org-scoped: another tenant's variant is indistinguishable from none.
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
      RAISE EXCEPTION 'create_order_v2: product % missing for variant %',
        v_variant.product_id, v_variant.id;
    END IF;

    -- The unit price is the VARIANT's own catalog price, never caller input.
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

  -- The only total formula. orders_total_is_derived re-checks it on INSERT.
  v_total := v_subtotal - p_discount_minor + p_delivery_minor;

  -- ── PASS 2: write. Everything below succeeds together or not at all. ──────
  v_order_number := public.allocate_order_number(p_organization_id);

  INSERT INTO public.orders (
    organization_id, order_number, customer_id, location_id, source,
    currency, subtotal_minor, discount_minor, delivery_minor, total_minor,
    lifecycle_status, payment_status, fulfillment_status, created_by,
    source_conversation_ref, idempotency_key, idempotency_fingerprint
  ) VALUES (
    p_organization_id, v_order_number, p_customer_id, p_location_id,
    p_source::public.order_source,
    v_currency, v_subtotal, p_discount_minor, p_delivery_minor, v_total,
    'draft', 'unpaid', 'unfulfilled', p_created_by,
    v_conv_ref, p_idempotency_key, v_fingerprint
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

COMMENT ON FUNCTION public.create_order_v2(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT, BIGINT, TEXT, TEXT) IS
  'Idempotent draft-order creation (migration 044). Same (organization, key, principal, request) replays the stored order; same key with a different principal or request is idempotency_conflict. Total = subtotal - discount + delivery fee, all integer minor units, priced from the catalog.';

-- Server-only, exactly like create_order_v1: the function takes
-- p_organization_id and p_created_by, so EXECUTE for a JWT client would be a
-- cross-tenant order-creation primitive.
REVOKE EXECUTE ON FUNCTION public.create_order_v2(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT, BIGINT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_order_v2(UUID, UUID, TEXT, JSONB, UUID, UUID, BIGINT, BIGINT, TEXT, TEXT)
  TO service_role;
