-- Migration: 053_stock_counts
-- Purpose: Stock Count foundation — record a physical count of one variant at
--          one location and reconcile the ledger to it, atomically and
--          duplicate-safely.
--
-- Additive only. No existing table, column, policy, function, grant or index is
-- changed or dropped, and no permission is added: a stock count is a stock
-- adjustment, authorized by the existing inventory.adjust key (migration 022,
-- OWNER + MANAGER) and checked server-side in src/server/inventory/stock-count.ts
-- before this RPC is ever called.
--
-- ── Model ────────────────────────────────────────────────────────────────────
--
-- Inventory stays a ledger. Nothing here stores, caches or overwrites a stock
-- balance:
--
--   stock_counts          — an IMMUTABLE observation: "at <time>, <member>
--                           counted <n> of <variant> at <location>, when the
--                           ledger said <m>". It is history, not stock. The
--                           balance is still SUM(inventory_movements).
--   inventory_movements   — when counted <> system, ONE `manual_adjustment`
--                           movement of (counted - system) is appended,
--                           referencing the count (reference_type
--                           'stock_count', reference_id = stock_counts.id).
--                           A count that matches the ledger writes no movement.
--   audit_logs            — every adjusting count writes the mandatory
--                           `inventory.adjust` audit row in the SAME transaction
--                           as the movement, so neither can exist without the
--                           other.
--
-- Scope of one count: (variant, location). location NULL means stock recorded
-- without a location (migration 021 allows it), and the system quantity is the
-- ledger sum for exactly that scope — the same scope the adjustment is written
-- to — so reconciling one location never disturbs another.
--
-- ── Concurrency and duplicates ───────────────────────────────────────────────
--
--   * Each confirmed count carries a client-generated count key (UUID), held
--     across retries of the same request. (organization_id, count_key) is
--     UNIQUE: a retry of the same request replays the recorded count and adds
--     nothing; the same key with a different request is a conflict and writes
--     nothing. Keyed per organization, so tenants never collide on or probe
--     each other's keys.
--   * The caller states the system quantity it showed the merchant
--     (p_expected_system_quantity). The RPC re-derives it from the ledger under
--     an advisory lock on (organization, variant, location) and refuses with
--     'stale' — writing nothing — if the ledger moved since the preview. The
--     adjustment is therefore always exactly the difference the merchant
--     confirmed.
--
-- Not built here (by instruction): cycle counting, warehouse zones, offline
-- mode, multi-user counting, batch counting, variance approval.

-- ── 1. stock_counts ──────────────────────────────────────────────────────────

CREATE TABLE public.stock_counts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Client-generated idempotency key; unique per organization (below).
  count_key         UUID NOT NULL,
  product_id        UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id        UUID NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  location_id       UUID REFERENCES public.locations(id) ON DELETE SET NULL,
  -- What the ledger said for (variant, location) when the count was recorded.
  system_quantity   INTEGER NOT NULL,
  -- What the merchant physically counted. Never negative.
  counted_quantity  INTEGER NOT NULL CHECK (counted_quantity BETWEEN 0 AND 1000000),
  -- Derived, never supplied: cannot disagree with the two figures above.
  difference        INTEGER GENERATED ALWAYS AS (counted_quantity - system_quantity) STORED,
  -- The ledger movement that reconciled this count; NULL when nothing differed.
  movement_id       UUID REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  created_by        UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_movement_iff_difference CHECK (
    (counted_quantity = system_quantity) = (movement_id IS NULL)
  )
);

COMMENT ON TABLE public.stock_counts IS
  'Immutable physical stock count observations (migration 053). History, not stock: on-hand is always SUM(inventory_movements). A count that differs from the ledger is reconciled by one manual_adjustment movement referenced by movement_id.';

CREATE UNIQUE INDEX uniq_stock_counts_org_count_key
  ON public.stock_counts(organization_id, count_key);

CREATE INDEX idx_stock_counts_org_variant_created
  ON public.stock_counts(organization_id, variant_id, created_at DESC);

-- Append-only, for everyone (the service role included).
CREATE OR REPLACE FUNCTION public.prevent_stock_count_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stock_counts are append-only and cannot be modified or deleted';
END;
$$;

CREATE TRIGGER stock_counts_no_update
  BEFORE UPDATE ON public.stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_stock_count_modification();

CREATE TRIGGER stock_counts_no_delete
  BEFORE DELETE ON public.stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_stock_count_modification();

-- RLS: members may read their organization's counts (same posture as the
-- ledger). JWT clients can never write; the only writer is
-- record_stock_count_v1 below.
ALTER TABLE public.stock_counts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock_counts_select_member"
  ON public.stock_counts FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "stock_counts_insert_blocked"
  ON public.stock_counts FOR INSERT
  WITH CHECK (false);

CREATE POLICY "stock_counts_no_update"
  ON public.stock_counts FOR UPDATE
  USING (false);

CREATE POLICY "stock_counts_no_delete"
  ON public.stock_counts FOR DELETE
  USING (false);

REVOKE INSERT, UPDATE, DELETE ON public.stock_counts FROM anon, authenticated;
-- The server reads counts; it writes them only through the RPC.
GRANT SELECT ON public.stock_counts TO service_role;

-- ── 2. Ledger shape for count adjustments ────────────────────────────────────

-- A stock-count reference is always a manual adjustment: nothing can file a
-- sale, a restock or a receipt under a count.
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_stock_count_shape CHECK (
    reference_type IS DISTINCT FROM 'stock_count'
    OR movement_type = 'manual_adjustment'
  );

-- One ledger movement per count record per organization.
CREATE UNIQUE INDEX uniq_inventory_movements_stock_count
  ON public.inventory_movements(organization_id, reference_id)
  WHERE reference_type = 'stock_count';

COMMENT ON INDEX public.uniq_inventory_movements_stock_count IS
  'At most one ledger movement reconciles a given stock count (migration 053).';

-- ── 3. record_stock_count_v1 ─────────────────────────────────────────────────
--
-- Returns JSONB with `status`:
--   recorded           — count stored (and, if it differed, adjusted + audited)
--   replayed           — this exact request was already recorded; nothing new
--   count_conflict     — key already spent on a different request; nothing written
--   variant_not_found  — not an ACTIVE variant of this organization
--   location_not_found — not a location of this organization
--   stale              — the ledger moved since the preview; nothing written
-- and, for recorded/replayed, the count row's fields.

CREATE FUNCTION public.record_stock_count_v1(
  p_organization_id          UUID,
  p_actor                    UUID,
  p_count_key                UUID,
  p_variant_id               UUID,
  p_location_id              UUID,
  p_counted_quantity         INTEGER,
  p_expected_system_quantity INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_existing  public.stock_counts%ROWTYPE;
  v_count     public.stock_counts%ROWTYPE;
  v_variant   RECORD;
  v_system    INTEGER;
  v_movement  UUID;
  v_count_id  UUID;
BEGIN
  IF p_organization_id IS NULL OR p_actor IS NULL OR p_count_key IS NULL
     OR p_variant_id IS NULL OR p_expected_system_quantity IS NULL THEN
    RAISE EXCEPTION 'record_stock_count_v1: organization, actor, count key, variant and expected system quantity are required';
  END IF;
  IF p_counted_quantity IS NULL OR p_counted_quantity < 0 OR p_counted_quantity > 1000000 THEN
    RAISE EXCEPTION 'record_stock_count_v1: counted quantity must be between 0 and 1000000';
  END IF;

  -- Serialize every attempt that uses this key in this organization.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('stock_count_key:' || p_organization_id::text || ':' || p_count_key::text, 0)
  );

  SELECT * INTO v_existing
  FROM public.stock_counts
  WHERE organization_id = p_organization_id AND count_key = p_count_key;

  IF FOUND THEN
    IF v_existing.variant_id = p_variant_id
       AND v_existing.location_id IS NOT DISTINCT FROM p_location_id
       AND v_existing.counted_quantity = p_counted_quantity
       AND v_existing.system_quantity = p_expected_system_quantity
       AND v_existing.created_by = p_actor THEN
      RETURN jsonb_build_object('status', 'replayed') || to_jsonb(v_existing);
    END IF;
    RETURN jsonb_build_object('status', 'count_conflict');
  END IF;

  SELECT id, product_id INTO v_variant
  FROM public.product_variants
  WHERE id = p_variant_id
    AND organization_id = p_organization_id
    AND status = 'ACTIVE';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'variant_not_found');
  END IF;

  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.locations
    WHERE id = p_location_id AND organization_id = p_organization_id
  ) THEN
    RETURN jsonb_build_object('status', 'location_not_found');
  END IF;

  -- Serialize counts of the same (variant, location) so two concurrent counts
  -- cannot both reconcile against the same pre-count balance.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'stock_count_scope:' || p_organization_id::text || ':' || p_variant_id::text
        || ':' || coalesce(p_location_id::text, 'none'),
      0
    )
  );

  SELECT coalesce(sum(quantity_delta), 0)::INTEGER INTO v_system
  FROM public.inventory_movements
  WHERE organization_id = p_organization_id
    AND variant_id = p_variant_id
    AND location_id IS NOT DISTINCT FROM p_location_id;

  IF v_system <> p_expected_system_quantity THEN
    RETURN jsonb_build_object('status', 'stale', 'system_quantity', v_system);
  END IF;

  v_count_id := gen_random_uuid();

  IF p_counted_quantity <> v_system THEN
    INSERT INTO public.inventory_movements(
      organization_id, product_id, variant_id, location_id, quantity_delta,
      movement_type, reference_type, reference_id, reason, created_by
    ) VALUES (
      p_organization_id, v_variant.product_id, p_variant_id, p_location_id,
      p_counted_quantity - v_system,
      'manual_adjustment', 'stock_count', v_count_id, 'Stock count', p_actor
    )
    RETURNING id INTO v_movement;
  END IF;

  INSERT INTO public.stock_counts(
    id, organization_id, count_key, product_id, variant_id, location_id,
    system_quantity, counted_quantity, movement_id, created_by
  ) VALUES (
    v_count_id, p_organization_id, p_count_key, v_variant.product_id, p_variant_id,
    p_location_id, v_system, p_counted_quantity, v_movement, p_actor
  )
  RETURNING * INTO v_count;

  -- Mandatory audit for a stock adjustment, in the same transaction: if this
  -- insert fails, the movement and the count roll back with it.
  IF v_movement IS NOT NULL THEN
    INSERT INTO public.audit_logs(
      organization_id, actor_user_id, action, resource_type, resource_id,
      before_json, after_json, reason
    ) VALUES (
      p_organization_id, p_actor, 'inventory.adjust', 'inventory_movements', p_variant_id::text,
      jsonb_build_object('system_quantity', v_system),
      jsonb_build_object(
        'product_id', v_variant.product_id,
        'variant_id', p_variant_id,
        'location_id', p_location_id,
        'counted_quantity', p_counted_quantity,
        'quantity_delta', p_counted_quantity - v_system,
        'movement_id', v_movement,
        'stock_count_id', v_count_id
      ),
      'Stock count'
    );
  END IF;

  RETURN jsonb_build_object('status', 'recorded') || to_jsonb(v_count);
END;
$$;

COMMENT ON FUNCTION public.record_stock_count_v1(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER) IS
  'Record one physical stock count (migration 053). Idempotent per (organization, count key); refuses with stale if the ledger moved since the preview; appends one audited manual_adjustment movement when counted differs from the ledger. Never writes a balance.';

-- Server-only: the function takes p_organization_id and p_actor, so EXECUTE
-- for a JWT client would be a cross-tenant stock-adjustment primitive.
REVOKE EXECUTE ON FUNCTION public.record_stock_count_v1(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_stock_count_v1(UUID, UUID, UUID, UUID, UUID, INTEGER, INTEGER)
  TO service_role;

-- ── 4. search_stock_count_variants_v1 ────────────────────────────────────────
--
-- Manual-search fallback when a barcode cannot be scanned: ACTIVE variants of
-- non-archived products in ONE organization whose product name (Khmer or
-- English), variant name, SKU or barcode contains the query. Identity only —
-- no price, no cost. The query is matched literally (LIKE wildcards in it are
-- escaped), exact SKU/barcode matches first.

CREATE FUNCTION public.search_stock_count_variants_v1(
  p_organization_id UUID,
  p_query           TEXT,
  p_limit           INTEGER
)
RETURNS TABLE (
  variant_id      UUID,
  product_id      UUID,
  product_name_km TEXT,
  product_name_en TEXT,
  variant_name    TEXT,
  sku             TEXT,
  barcode         TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      btrim(coalesce(p_query, '')) AS raw,
      '%' || replace(replace(replace(btrim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern
  )
  SELECT v.id, p.id, p.name_km, p.name_en, v.name, v.sku, v.barcode
  FROM public.product_variants v
  JOIN public.products p
    ON p.id = v.product_id AND p.organization_id = v.organization_id
  CROSS JOIN q
  WHERE v.organization_id = p_organization_id
    AND v.status = 'ACTIVE'
    AND p.status <> 'ARCHIVED'
    AND char_length(q.raw) BETWEEN 1 AND 100
    AND (
      p.name_km ILIKE q.pattern ESCAPE '\'
      OR coalesce(p.name_en, '') ILIKE q.pattern ESCAPE '\'
      OR coalesce(v.name, '') ILIKE q.pattern ESCAPE '\'
      OR coalesce(v.sku, '') ILIKE q.pattern ESCAPE '\'
      OR coalesce(v.barcode, '') ILIKE q.pattern ESCAPE '\'
    )
  ORDER BY
    (lower(coalesce(v.sku, '')) = lower(q.raw) OR coalesce(v.barcode, '') = q.raw) DESC,
    p.name_km ASC,
    v.name ASC,
    v.id ASC
  LIMIT least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

COMMENT ON FUNCTION public.search_stock_count_variants_v1(UUID, TEXT, INTEGER) IS
  'Stock count manual search (migration 053): active variants of one organization by product name, variant name, SKU or barcode. Identity only. Literal match; at most 50 rows.';

REVOKE EXECUTE ON FUNCTION public.search_stock_count_variants_v1(UUID, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.search_stock_count_variants_v1(UUID, TEXT, INTEGER)
  TO service_role;
