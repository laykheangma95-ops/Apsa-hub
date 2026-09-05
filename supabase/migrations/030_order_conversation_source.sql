-- Migration: 030_order_conversation_source
-- Purpose: Preserve conversation provenance on an order without coupling the
--          Order domain to a Conversation table that does not exist yet.
-- Touches: public.orders (ALTER), public.create_order_v1 (REPLACE)
-- Classification: tenant-private (inherits orders' organization_id scope)
--
-- SOURCE OF TRUTH
--   Phase brief "CONVERSATION -> ORDER LINKAGE": APSA must later be able to
--   answer which Conversation, which Customer, which staff actor, when, and
--   which channel created an order — WITHOUT copying the private conversation
--   content into the order record.
--
-- WHY A LOOSE TEXT REFERENCE, NOT A FOREIGN KEY
--   The Conversation domain (Inbox) has no production table yet — it is
--   entirely client-side mock data (src/lib/mock/conversations.ts). A FK to a
--   table that does not exist cannot be written, and inventing one here would
--   be starting the Conversation backend as a side effect of the Order
--   migration, which is not this phase's scope. `source_conversation_ref` is
--   therefore an opaque, nullable, tenant-scoped identifier: whatever the
--   calling layer used to name the conversation at the time (today: nothing,
--   because no production conversation exists to reference; once Inbox is
--   productionized, its real conversation id). No code reads structure out of
--   this column — it is provenance, not a relationship.
--
-- WHAT IS ALREADY COVERED, SO NOT DUPLICATED HERE
--   - Customer: orders.customer_id (migration 023)
--   - Staff actor: orders.created_by (migration 023)
--   - When: orders.created_at (migration 023)
--   - Channel/provider: orders.source (migration 023's order_source enum)
--   This migration adds only the one fact those columns cannot express: which
--   conversation thread the order came from.
--
-- PAYMENT DOMAIN: untouched. This migration does not reference payments, does
-- not touch migrations 028-029, and adds no payment-related column anywhere.

ALTER TABLE public.orders
  ADD COLUMN source_conversation_ref TEXT NULL;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_conversation_ref_not_blank
  CHECK (source_conversation_ref IS NULL OR length(trim(source_conversation_ref)) > 0);

COMMENT ON COLUMN public.orders.source_conversation_ref IS
  'Opaque provenance identifier for the conversation thread that produced this order, if any. Not a foreign key (no production Conversation table exists yet). Never the full conversation content — see migration 030.';

-- Read pattern: "which orders came from this conversation" (Inbox side, once
-- productionized). Partial index — most orders (POS, manual) have no ref.
CREATE INDEX idx_orders_org_conversation_ref
  ON public.orders(organization_id, source_conversation_ref)
  WHERE source_conversation_ref IS NOT NULL;

-- ── create_order_v1: add the one new, optional, backward-compatible param ────
--
-- Every existing positional/named caller that does not pass
-- p_source_conversation_ref keeps working unchanged: the parameter defaults to
-- NULL, exactly like p_customer_id/p_location_id/p_discount_minor already do.
-- Everything else in this function is byte-for-byte identical to migration 024.

CREATE OR REPLACE FUNCTION public.create_order_v1(
  p_organization_id UUID,
  p_created_by      UUID,
  p_source          TEXT,
  p_items           JSONB,
  p_customer_id     UUID   DEFAULT NULL,
  p_location_id     UUID   DEFAULT NULL,
  p_discount_minor  BIGINT DEFAULT 0,
  p_source_conversation_ref TEXT DEFAULT NULL
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

  -- A blank/whitespace-only reference is stored as NULL, matching the CHECK
  -- constraint above and sparing every reader a trim() of its own.
  v_conv_ref := NULLIF(trim(coalesce(p_source_conversation_ref, '')), '');

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
    lifecycle_status, payment_status, fulfillment_status, created_by,
    source_conversation_ref
  ) VALUES (
    p_organization_id, v_order_number, p_customer_id, p_location_id,
    p_source::public.order_source,
    v_currency, v_subtotal, p_discount_minor, 0, v_total,
    'draft', 'unpaid', 'unfulfilled', p_created_by,
    v_conv_ref
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

COMMENT ON FUNCTION public.create_order_v1 IS
  'Creates a draft order + lines atomically, pricing every line from product_variants. Adds an optional opaque source_conversation_ref (migration 030) for provenance only — never a relationship, never conversation content.';
