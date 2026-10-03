-- Migration: 056_customer_returns
-- Purpose: Customer Returns foundation — a delivered order's items come back
--          through a short, server-authoritative lifecycle and re-enter stock
--          through the inventory ledger only:
--
--            requested → received → inspected → completed
--
-- Additive only. No existing table, column, policy, function or grant is
-- changed or dropped. One permission key is added: orders.return
-- (PERMISSIONS_MATRIX.md §14 — Owner ✅, Manager ✅; the ⚠️ conditional roles are
-- deliberately not granted, as in migrations 022 and 025, which deferred this
-- key "until the returns feature").
--
-- ── Model ────────────────────────────────────────────────────────────────────
--
-- Inventory stays a ledger. Nothing here stores, caches or overwrites a stock
-- balance; no stock moves until the return is COMPLETED.
--
--   customer_returns        — one return of one delivered order. Its `status`
--                             is the only mutable column, it only moves forward
--                             (trigger-enforced, service role included) and
--                             only through the RPCs below.
--   customer_return_items   — which order line comes back and how many (fixed
--                             at request). Inspection records how many of those
--                             units are damaged; completion links the ledger
--                             movements. Both freeze once completed.
--   customer_return_events  — APPEND-ONLY history: one row per step, with the
--                             actor and (for inspection) the recorded split.
--   inventory_movements     — at completion, per line: ONE `return` movement of
--                             +quantity at the location the sale was taken
--                             from, and — when some units are damaged — ONE
--                             `damage` movement of −damaged (migration 055).
--                             Resellable units therefore become available;
--                             damaged units are on the ledger but never
--                             sellable. Both reference the return line
--                             (reference_type 'customer_return_item').
--   audit_logs              — `orders.return_requested` at request and
--                             `inventory.customer_return` at completion, each in
--                             the same transaction as the write it describes.
--
-- Server authority (never the browser's quantities):
--   * the order must be this organization's, confirmed or completed (stock
--     actually left), and have a DELIVERED delivery;
--   * every line must belong to that order and have a recorded `sale` movement;
--   * the quantity requested for a line, across every return ever requested
--     for it, can never exceed the quantity ordered;
--   * a return is inspected line-by-line (every line, exactly once), and the
--     completion must name the inspection the merchant saw — if it changed in
--     between, completion is refused as `stale` and writes nothing.
--
-- Duplicates and races:
--   * a request carries a client-generated request key (UUID), held across
--     retries. (organization_id, request_key) is UNIQUE: an identical retry
--     replays, the same key with a different request is a conflict;
--   * receive / inspect / complete are idempotent by state: repeating a step
--     that already happened replays and writes nothing. Each step locks the
--     return row; request and complete also lock the order row first (order →
--     return; no path locks the other way round);
--   * the ledger's own unique (variant, movement type, reference) index makes a
--     second `return` or `damage` movement for one return line impossible;
--   * an order with a customer return can no longer be cancelled — cancellation
--     (migration 026) releases every sold line back to stock, which would count
--     returned units twice.
--
-- Not built here (by instruction): refunds, exchanges, return shipping labels,
-- courier return workflow, warehouse routing, approvals, batch processing,
-- photos, notes, supplier returns.

-- ── 1. Permission ────────────────────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  (
    'orders.return',
    'Request, receive, inspect and complete a customer return (restocks returned items)',
    'high'
  )
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_perm_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'   AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER' AND organization_id IS NULL;

  IF v_owner_id IS NULL OR v_manager_id IS NULL THEN
    RAISE EXCEPTION 'System roles OWNER/MANAGER not found — ensure migration 003 has been applied.';
  END IF;

  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'orders.return';

  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id)
      VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

-- ── 2. customer_returns ──────────────────────────────────────────────────────

CREATE TABLE public.customer_returns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Client-generated idempotency key; unique per organization (below).
  request_key      UUID NOT NULL,
  order_id         UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  -- The delivered delivery that made the order returnable.
  delivery_id      UUID NOT NULL REFERENCES public.deliveries(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'received', 'inspected', 'completed')),
  created_by       UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.customer_returns IS
  'Customer returns of delivered orders (migration 056). status moves forward only: requested → received → inspected → completed. Stock moves only at completion, through inventory_movements. History lives in customer_return_events.';

CREATE UNIQUE INDEX uniq_customer_returns_org_request_key
  ON public.customer_returns(organization_id, request_key);

CREATE INDEX idx_customer_returns_org_created
  ON public.customer_returns(organization_id, created_at DESC);

CREATE INDEX idx_customer_returns_org_order
  ON public.customer_returns(organization_id, order_id);

-- ── 3. customer_return_items ─────────────────────────────────────────────────

CREATE TABLE public.customer_return_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  return_id              UUID NOT NULL REFERENCES public.customer_returns(id) ON DELETE RESTRICT,
  order_item_id          UUID NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  product_id             UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  variant_id             UUID NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  -- Copied from the order line: what the customer bought, frozen at sale time.
  product_name_snapshot  TEXT NOT NULL,
  variant_name_snapshot  TEXT,
  sku_snapshot           TEXT,
  quantity               INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  -- NULL until inspected; then how many of `quantity` are damaged.
  damaged_quantity       INTEGER CHECK (damaged_quantity BETWEEN 0 AND quantity),
  -- Set at completion: the `return` movement (+quantity) …
  return_movement_id     UUID REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  -- … and, exactly when some units are damaged, the `damage` movement (−damaged).
  damage_movement_id     UUID REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_return_items_completed_shape CHECK (
    return_movement_id IS NULL
    OR (damaged_quantity IS NOT NULL
        AND (damaged_quantity > 0) = (damage_movement_id IS NOT NULL))
  ),
  CONSTRAINT customer_return_items_damage_after_return CHECK (
    damage_movement_id IS NULL OR return_movement_id IS NOT NULL
  )
);

COMMENT ON TABLE public.customer_return_items IS
  'Customer return lines (migration 056): one order line and a quantity (fixed at request), the inspected damaged count, and the ledger movements written at completion.';

CREATE UNIQUE INDEX uniq_customer_return_items_line
  ON public.customer_return_items(return_id, order_item_id);

-- Remaining-quantity check: everything already requested for one order line.
CREATE INDEX idx_customer_return_items_org_order_item
  ON public.customer_return_items(organization_id, order_item_id);

-- ── 4. customer_return_events (append-only history) ──────────────────────────

CREATE TABLE public.customer_return_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  return_id        UUID NOT NULL REFERENCES public.customer_returns(id) ON DELETE RESTRICT,
  -- NULL denotes the request itself.
  from_status      TEXT CHECK (from_status IN ('requested', 'received', 'inspected', 'completed')),
  to_status        TEXT NOT NULL CHECK (to_status IN ('requested', 'received', 'inspected', 'completed')),
  actor            UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- Inspection: the recorded split. Completion: the movements written.
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Re-recording an inspection is the only step that may repeat a status.
  CONSTRAINT customer_return_events_changed CHECK (
    from_status IS NULL OR from_status <> to_status OR to_status = 'inspected'
  )
);

COMMENT ON TABLE public.customer_return_events IS
  'Append-only history of every customer return step (migration 056).';

CREATE INDEX idx_customer_return_events_return
  ON public.customer_return_events(return_id, created_at);

-- ── 5. Integrity triggers (the service role included) ────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_customer_return_history_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'customer return history is append-only and cannot be modified or deleted';
END;
$$;

CREATE TRIGGER customer_return_events_no_update
  BEFORE UPDATE ON public.customer_return_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_customer_return_history_modification();
CREATE TRIGGER customer_return_events_no_delete
  BEFORE DELETE ON public.customer_return_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_customer_return_history_modification();
CREATE TRIGGER customer_returns_no_delete
  BEFORE DELETE ON public.customer_returns
  FOR EACH ROW EXECUTE FUNCTION public.prevent_customer_return_history_modification();
CREATE TRIGGER customer_return_items_no_delete
  BEFORE DELETE ON public.customer_return_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_customer_return_history_modification();

-- A return's identity never changes, and its status only moves forward.
CREATE OR REPLACE FUNCTION public.guard_customer_return_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.request_key <> OLD.request_key
     OR NEW.order_id <> OLD.order_id
     OR NEW.delivery_id <> OLD.delivery_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'customer return identity is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'requested' AND NEW.status = 'received')
    OR (OLD.status = 'received' AND NEW.status = 'inspected')
    OR (OLD.status = 'inspected' AND NEW.status IN ('inspected', 'completed'))
  ) THEN
    RAISE EXCEPTION 'customer return status cannot move from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_returns_guard_update
  BEFORE UPDATE ON public.customer_returns
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_return_update();

-- A line's identity never changes; once completed it is frozen; movement links
-- are written once.
CREATE OR REPLACE FUNCTION public.guard_customer_return_item_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.return_id <> OLD.return_id
     OR NEW.order_item_id <> OLD.order_item_id
     OR NEW.product_id <> OLD.product_id
     OR NEW.variant_id <> OLD.variant_id
     OR NEW.product_name_snapshot <> OLD.product_name_snapshot
     OR NEW.variant_name_snapshot IS DISTINCT FROM OLD.variant_name_snapshot
     OR NEW.sku_snapshot IS DISTINCT FROM OLD.sku_snapshot
     OR NEW.quantity <> OLD.quantity
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'customer return line identity is immutable';
  END IF;
  IF OLD.return_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'a completed customer return line cannot be modified';
  END IF;
  IF OLD.damage_movement_id IS NOT NULL THEN
    RAISE EXCEPTION 'a completed customer return line cannot be modified';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER customer_return_items_guard_update
  BEFORE UPDATE ON public.customer_return_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_return_item_update();

-- ── 6. RLS and grants ────────────────────────────────────────────────────────
-- Members may read their organization's returns (same posture as the ledger
-- and stock_counts). JWT clients can never write; the only writers are the
-- service-role RPCs below.

ALTER TABLE public.customer_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_return_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_returns_select_member"
  ON public.customer_returns FOR SELECT
  USING (public.is_active_member_of(organization_id));
CREATE POLICY "customer_returns_insert_blocked"
  ON public.customer_returns FOR INSERT
  WITH CHECK (false);
CREATE POLICY "customer_returns_no_update"
  ON public.customer_returns FOR UPDATE
  USING (false);
CREATE POLICY "customer_returns_no_delete"
  ON public.customer_returns FOR DELETE
  USING (false);

CREATE POLICY "customer_return_items_select_member"
  ON public.customer_return_items FOR SELECT
  USING (public.is_active_member_of(organization_id));
CREATE POLICY "customer_return_items_insert_blocked"
  ON public.customer_return_items FOR INSERT
  WITH CHECK (false);
CREATE POLICY "customer_return_items_no_update"
  ON public.customer_return_items FOR UPDATE
  USING (false);
CREATE POLICY "customer_return_items_no_delete"
  ON public.customer_return_items FOR DELETE
  USING (false);

CREATE POLICY "customer_return_events_select_member"
  ON public.customer_return_events FOR SELECT
  USING (public.is_active_member_of(organization_id));
CREATE POLICY "customer_return_events_insert_blocked"
  ON public.customer_return_events FOR INSERT
  WITH CHECK (false);
CREATE POLICY "customer_return_events_no_update"
  ON public.customer_return_events FOR UPDATE
  USING (false);
CREATE POLICY "customer_return_events_no_delete"
  ON public.customer_return_events FOR DELETE
  USING (false);

REVOKE INSERT, UPDATE, DELETE ON public.customer_returns FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.customer_return_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.customer_return_events FROM anon, authenticated;
-- The server reads returns; it writes them only through the RPCs.
GRANT SELECT ON public.customer_returns TO service_role;
GRANT SELECT ON public.customer_return_items TO service_role;
GRANT SELECT ON public.customer_return_events TO service_role;

-- ── 7. Ledger shape for return movements ─────────────────────────────────────

-- A customer-return reference is only ever a positive `return` or a negative
-- `damage`: nothing can file a sale, restock or adjustment under a return line.
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_customer_return_shape CHECK (
    reference_type IS DISTINCT FROM 'customer_return_item'
    OR (movement_type = 'return' AND quantity_delta > 0)
    OR (movement_type = 'damage' AND quantity_delta < 0)
  );

-- V1: damaged stock is recorded only by a customer return. Any other damage
-- write-off is a later, separately-authorized feature. (IS NOT DISTINCT FROM,
-- not =: a NULL reference_type must fail this check, not pass it as unknown.)
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_damage_shape CHECK (
    movement_type <> 'damage'
    OR reference_type IS NOT DISTINCT FROM 'customer_return_item'
  );

-- ── 8. No cancellation after a customer return ──────────────────────────────
-- Cancelling a confirmed order (migration 026) appends a `return` for every
-- sold line. If units are coming back through a customer return, that would
-- put them back twice. Both paths lock the order row first, so this check
-- always sees a committed return.

CREATE OR REPLACE FUNCTION public.prevent_cancel_after_customer_return()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.lifecycle_status = 'cancelled'
     AND OLD.lifecycle_status IS DISTINCT FROM 'cancelled'
     AND EXISTS (
       SELECT 1 FROM public.customer_returns r
       WHERE r.organization_id = NEW.organization_id AND r.order_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'order_has_customer_return: an order with a customer return cannot be cancelled';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_cancel_after_customer_return() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER orders_no_cancel_after_customer_return
  BEFORE UPDATE OF lifecycle_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_cancel_after_customer_return();

-- ── 9. Inspection lines: one canonical form ──────────────────────────────────
--
-- p_lines: JSON array (1..100) of
--   { "return_item_id": <uuid>, "damaged_quantity": <integer 0..100000> }
-- with each return_item_id at most once. Returns the canonical (sorted) form,
-- or NULL when malformed. Used by inspect (what to record) and complete (what
-- the merchant saw), so both compare exactly the same shape.

CREATE FUNCTION public.customer_return_inspection_lines_v1(p_lines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_elem JSONB;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 100 THEN
    RETURN NULL;
  END IF;

  FOR v_elem IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_elem -> 'return_item_id') IS DISTINCT FROM 'string'
       OR (v_elem ->> 'return_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_elem -> 'damaged_quantity') IS DISTINCT FROM 'number'
       OR (v_elem ->> 'damaged_quantity') !~ '^(0|[1-9][0-9]{0,5})$' THEN
      RETURN NULL;
    END IF;
    IF (v_elem ->> 'damaged_quantity')::INTEGER > 100000 THEN
      RETURN NULL;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM jsonb_array_elements(p_lines))
     <> (SELECT count(DISTINCT (e ->> 'return_item_id')::UUID) FROM jsonb_array_elements(p_lines) e) THEN
    RETURN NULL;
  END IF;

  RETURN (
    SELECT jsonb_agg(
             jsonb_build_object(
               'return_item_id', (e ->> 'return_item_id')::UUID,
               'damaged_quantity', (e ->> 'damaged_quantity')::INTEGER
             )
             ORDER BY (e ->> 'return_item_id')::UUID
           )
    FROM jsonb_array_elements(p_lines) e
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.customer_return_inspection_lines_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_return_inspection_lines_v1(JSONB) TO service_role;

-- The inspection currently recorded on a return, in the same canonical form.
CREATE FUNCTION public.customer_return_current_inspection_v1(p_return_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_agg(
           jsonb_build_object('return_item_id', i.id, 'damaged_quantity', i.damaged_quantity)
           ORDER BY i.id
         )
  FROM public.customer_return_items i
  WHERE i.return_id = p_return_id;
$$;

REVOKE EXECUTE ON FUNCTION public.customer_return_current_inspection_v1(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_return_current_inspection_v1(UUID) TO service_role;

-- ── 10. request_customer_return_v1 ───────────────────────────────────────────
--
-- p_items: JSON array (1..100) of { "order_item_id": <uuid>, "quantity": <1..100000> },
-- each order_item_id at most once.
--
-- Returns JSONB with `status`:
--   requested                   — return created (status 'requested'), audited
--   replayed                    — this exact request was already recorded
--   request_conflict            — key already spent on a different request
--   invalid_items               — malformed or duplicate lines; nothing written
--   order_not_found             — not an order of this organization
--   order_not_returnable        — the order is not confirmed/completed
--   order_not_delivered         — the order has no delivered delivery
--   item_not_in_order           — a line is not part of the order
--   item_not_returnable         — a line's stock never left (no sale movement)
--   quantity_exceeds_remaining  — more than is still returnable for a line
-- and, for requested/replayed, `return_id`.

CREATE FUNCTION public.request_customer_return_v1(
  p_organization_id UUID,
  p_actor           UUID,
  p_request_key     UUID,
  p_order_id        UUID,
  p_items           JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_elem         JSONB;
  v_lines        JSONB;
  v_existing     public.customer_returns%ROWTYPE;
  v_prior        JSONB;
  v_order        RECORD;
  v_delivery_id  UUID;
  v_line         RECORD;
  v_requested    INTEGER;
  v_return_id    UUID;
BEGIN
  IF p_organization_id IS NULL OR p_actor IS NULL OR p_request_key IS NULL OR p_order_id IS NULL THEN
    RAISE EXCEPTION 'request_customer_return_v1: organization, actor, request key and order are required';
  END IF;

  -- ── Shape (the server validated it too; this is the authority)
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 100 THEN
    RETURN jsonb_build_object('status', 'invalid_items');
  END IF;

  FOR v_elem IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_elem -> 'order_item_id') IS DISTINCT FROM 'string'
       OR (v_elem ->> 'order_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_elem -> 'quantity') IS DISTINCT FROM 'number'
       OR (v_elem ->> 'quantity') !~ '^[1-9][0-9]{0,5}$' THEN
      RETURN jsonb_build_object('status', 'invalid_items');
    END IF;
    -- Cast only once the text is known to be a small positive integer.
    IF (v_elem ->> 'quantity')::INTEGER > 100000 THEN
      RETURN jsonb_build_object('status', 'invalid_items');
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM jsonb_array_elements(p_items))
     <> (SELECT count(DISTINCT (e ->> 'order_item_id')::UUID) FROM jsonb_array_elements(p_items) e) THEN
    RETURN jsonb_build_object('status', 'invalid_items');
  END IF;

  -- Canonical form of the request, for replay comparison.
  SELECT jsonb_agg(
           jsonb_build_object(
             'order_item_id', (e ->> 'order_item_id')::UUID,
             'quantity', (e ->> 'quantity')::INTEGER
           )
           ORDER BY (e ->> 'order_item_id')::UUID
         )
  INTO v_lines
  FROM jsonb_array_elements(p_items) e;

  -- ── Idempotency: serialize every attempt that uses this key in this org.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer_return_key:' || p_organization_id::text || ':' || p_request_key::text, 0)
  );

  SELECT * INTO v_existing
  FROM public.customer_returns
  WHERE organization_id = p_organization_id AND request_key = p_request_key;

  IF FOUND THEN
    SELECT jsonb_agg(
             jsonb_build_object('order_item_id', i.order_item_id, 'quantity', i.quantity)
             ORDER BY i.order_item_id
           )
    INTO v_prior
    FROM public.customer_return_items i
    WHERE i.return_id = v_existing.id;

    IF v_existing.order_id = p_order_id
       AND v_existing.created_by = p_actor
       AND v_prior = v_lines THEN
      RETURN jsonb_build_object('status', 'replayed', 'return_id', v_existing.id);
    END IF;
    RETURN jsonb_build_object('status', 'request_conflict');
  END IF;

  -- ── The order, inside this organization only. Locked: requests of one order
  -- (and its cancellation) serialize here.
  SELECT id, lifecycle_status INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'order_not_found');
  END IF;
  IF v_order.lifecycle_status NOT IN ('confirmed', 'completed') THEN
    RETURN jsonb_build_object('status', 'order_not_returnable',
                              'lifecycle', v_order.lifecycle_status::TEXT);
  END IF;

  -- In Transit → Delivered must have happened. `delivered` is terminal, so the
  -- row cannot change under us and needs no lock.
  SELECT d.id INTO v_delivery_id
  FROM public.deliveries d
  WHERE d.organization_id = p_organization_id
    AND d.order_id = v_order.id
    AND d.status = 'delivered'
  ORDER BY d.updated_at DESC, d.id DESC
  LIMIT 1;
  IF v_delivery_id IS NULL THEN
    RETURN jsonb_build_object('status', 'order_not_delivered');
  END IF;

  -- ── Every line: belongs to this order, stock actually left, still returnable.
  FOR v_line IN
    SELECT r.order_item_id, r.quantity AS requested,
           oi.id AS line_id, oi.quantity AS ordered, oi.variant_id
    FROM (
      SELECT (e ->> 'order_item_id')::UUID AS order_item_id, (e ->> 'quantity')::INTEGER AS quantity
      FROM jsonb_array_elements(p_items) e
    ) r
    LEFT JOIN public.order_items oi
      ON oi.id = r.order_item_id
     AND oi.order_id = v_order.id
     AND oi.organization_id = p_organization_id
    ORDER BY r.order_item_id
  LOOP
    IF v_line.line_id IS NULL THEN
      RETURN jsonb_build_object('status', 'item_not_in_order', 'order_item_id', v_line.order_item_id);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.inventory_movements m
      WHERE m.organization_id = p_organization_id
        AND m.variant_id      = v_line.variant_id
        AND m.movement_type   = 'sale'
        AND m.reference_type  = 'order_item'
        AND m.reference_id    = v_line.line_id
    ) THEN
      RETURN jsonb_build_object('status', 'item_not_returnable', 'order_item_id', v_line.order_item_id);
    END IF;

    SELECT coalesce(sum(i.quantity), 0)::INTEGER INTO v_requested
    FROM public.customer_return_items i
    WHERE i.organization_id = p_organization_id AND i.order_item_id = v_line.line_id;

    IF v_line.requested > v_line.ordered - v_requested THEN
      RETURN jsonb_build_object(
        'status', 'quantity_exceeds_remaining',
        'order_item_id', v_line.order_item_id,
        'remaining', greatest(v_line.ordered - v_requested, 0)
      );
    END IF;
  END LOOP;

  -- ── Write: header, lines, history, audit.
  v_return_id := gen_random_uuid();

  INSERT INTO public.customer_returns(
    id, organization_id, request_key, order_id, delivery_id, status, created_by
  ) VALUES (
    v_return_id, p_organization_id, p_request_key, v_order.id, v_delivery_id, 'requested', p_actor
  );

  INSERT INTO public.customer_return_items(
    organization_id, return_id, order_item_id, product_id, variant_id,
    product_name_snapshot, variant_name_snapshot, sku_snapshot, quantity
  )
  SELECT p_organization_id, v_return_id, oi.id, oi.product_id, oi.variant_id,
         oi.product_name_snapshot, oi.variant_name_snapshot, oi.sku_snapshot,
         (e ->> 'quantity')::INTEGER
  FROM jsonb_array_elements(p_items) e
  JOIN public.order_items oi
    ON oi.id = (e ->> 'order_item_id')::UUID
   AND oi.order_id = v_order.id
   AND oi.organization_id = p_organization_id;

  INSERT INTO public.customer_return_events(
    organization_id, return_id, from_status, to_status, actor, detail
  ) VALUES (
    p_organization_id, v_return_id, NULL, 'requested', p_actor, jsonb_build_object('lines', v_lines)
  );

  INSERT INTO public.audit_logs(
    organization_id, actor_user_id, action, resource_type, resource_id,
    before_json, after_json, reason
  ) VALUES (
    p_organization_id, p_actor, 'orders.return_requested', 'customer_returns', v_return_id::text,
    NULL,
    jsonb_build_object('order_id', v_order.id, 'delivery_id', v_delivery_id, 'lines', v_lines),
    'Customer return requested'
  );

  RETURN jsonb_build_object('status', 'requested', 'return_id', v_return_id);
END;
$$;

COMMENT ON FUNCTION public.request_customer_return_v1(UUID, UUID, UUID, UUID, JSONB) IS
  'Request a customer return of a delivered order (migration 056). Idempotent per (organization, request key); validates order, delivered delivery, line ownership, sale movement and remaining quantity under the order lock. Writes no stock.';

REVOKE EXECUTE ON FUNCTION public.request_customer_return_v1(UUID, UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_customer_return_v1(UUID, UUID, UUID, UUID, JSONB)
  TO service_role;

-- ── 11. receive_customer_return_v1 ───────────────────────────────────────────
--
-- Returns JSONB with `status`:
--   received          — requested → received
--   replayed          — already received (or further); nothing written
--   return_not_found  — not a return of this organization
-- and `return_id` / `return_status` when found.

CREATE FUNCTION public.receive_customer_return_v1(
  p_organization_id UUID,
  p_actor           UUID,
  p_return_id       UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_return public.customer_returns%ROWTYPE;
BEGIN
  IF p_organization_id IS NULL OR p_actor IS NULL OR p_return_id IS NULL THEN
    RAISE EXCEPTION 'receive_customer_return_v1: organization, actor and return are required';
  END IF;

  SELECT * INTO v_return
  FROM public.customer_returns
  WHERE id = p_return_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'return_not_found');
  END IF;

  IF v_return.status <> 'requested' THEN
    RETURN jsonb_build_object('status', 'replayed', 'return_id', v_return.id,
                              'return_status', v_return.status);
  END IF;

  UPDATE public.customer_returns SET status = 'received', updated_at = now()
  WHERE id = v_return.id;

  INSERT INTO public.customer_return_events(
    organization_id, return_id, from_status, to_status, actor
  ) VALUES (p_organization_id, v_return.id, 'requested', 'received', p_actor);

  RETURN jsonb_build_object('status', 'received', 'return_id', v_return.id,
                            'return_status', 'received');
END;
$$;

COMMENT ON FUNCTION public.receive_customer_return_v1(UUID, UUID, UUID) IS
  'Mark a requested customer return as physically received (migration 056). Idempotent by state. Writes no stock.';

REVOKE EXECUTE ON FUNCTION public.receive_customer_return_v1(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_customer_return_v1(UUID, UUID, UUID)
  TO service_role;

-- ── 12. inspect_customer_return_v1 ───────────────────────────────────────────
--
-- p_lines: every line of the return exactly once, as
--   { "return_item_id": <uuid>, "damaged_quantity": <0..line quantity> }.
-- Resellable units are the rest of the line.
--
-- Returns JSONB with `status`:
--   inspected          — inspection recorded (received → inspected, or re-recorded)
--   replayed           — this exact inspection is already recorded
--   invalid_lines      — malformed, incomplete, foreign or over-quantity lines
--   not_received       — the return has not been received yet
--   already_completed  — the return is completed; inspection is frozen
--   return_not_found   — not a return of this organization

CREATE FUNCTION public.inspect_customer_return_v1(
  p_organization_id UUID,
  p_actor           UUID,
  p_return_id       UUID,
  p_lines           JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_return   public.customer_returns%ROWTYPE;
  v_lines    JSONB;
  v_count    INTEGER;
  v_matched  INTEGER;
BEGIN
  IF p_organization_id IS NULL OR p_actor IS NULL OR p_return_id IS NULL THEN
    RAISE EXCEPTION 'inspect_customer_return_v1: organization, actor and return are required';
  END IF;

  SELECT * INTO v_return
  FROM public.customer_returns
  WHERE id = p_return_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'return_not_found');
  END IF;

  IF v_return.status = 'requested' THEN
    RETURN jsonb_build_object('status', 'not_received', 'return_status', v_return.status);
  END IF;
  IF v_return.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed', 'return_status', v_return.status);
  END IF;

  v_lines := public.customer_return_inspection_lines_v1(p_lines);
  IF v_lines IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_lines');
  END IF;

  -- Every line of THIS return, exactly once, none over its quantity.
  SELECT count(*) INTO v_count FROM public.customer_return_items WHERE return_id = v_return.id;
  SELECT count(*) INTO v_matched
  FROM jsonb_array_elements(v_lines) e
  JOIN public.customer_return_items i
    ON i.id = (e ->> 'return_item_id')::UUID
   AND i.return_id = v_return.id
   AND (e ->> 'damaged_quantity')::INTEGER <= i.quantity;
  IF v_matched <> v_count OR v_matched <> jsonb_array_length(v_lines) THEN
    RETURN jsonb_build_object('status', 'invalid_lines');
  END IF;

  IF v_return.status = 'inspected'
     AND public.customer_return_current_inspection_v1(v_return.id) = v_lines THEN
    RETURN jsonb_build_object('status', 'replayed', 'return_id', v_return.id,
                              'return_status', v_return.status);
  END IF;

  UPDATE public.customer_return_items i
  SET damaged_quantity = (e ->> 'damaged_quantity')::INTEGER
  FROM jsonb_array_elements(v_lines) e
  WHERE i.id = (e ->> 'return_item_id')::UUID
    AND i.return_id = v_return.id;

  UPDATE public.customer_returns SET status = 'inspected', updated_at = now()
  WHERE id = v_return.id;

  INSERT INTO public.customer_return_events(
    organization_id, return_id, from_status, to_status, actor, detail
  ) VALUES (
    p_organization_id, v_return.id, v_return.status, 'inspected', p_actor,
    jsonb_build_object('lines', v_lines)
  );

  RETURN jsonb_build_object('status', 'inspected', 'return_id', v_return.id,
                            'return_status', 'inspected');
END;
$$;

COMMENT ON FUNCTION public.inspect_customer_return_v1(UUID, UUID, UUID, JSONB) IS
  'Record the inspection of a received customer return (migration 056): per line, how many units are damaged; the rest are resellable. Re-recordable until completion. Writes no stock.';

REVOKE EXECUTE ON FUNCTION public.inspect_customer_return_v1(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_customer_return_v1(UUID, UUID, UUID, JSONB)
  TO service_role;

-- ── 13. complete_customer_return_v1 ──────────────────────────────────────────
--
-- p_expected: the inspection the merchant confirmed, in the inspection-line
-- shape. Completion writes the ledger for exactly that inspection, or nothing.
--
-- Returns JSONB with `status`:
--   completed            — movements + history + audit written
--   replayed             — already completed with this inspection; nothing written
--   already_completed    — already completed with a different inspection
--   stale                — the inspection changed since it was shown; nothing written
--   invalid_lines        — p_expected is malformed
--   not_inspected        — the return has not been inspected yet
--   order_not_returnable — the order is no longer confirmed/completed
--   return_not_found     — not a return of this organization

CREATE FUNCTION public.complete_customer_return_v1(
  p_organization_id UUID,
  p_actor           UUID,
  p_return_id       UUID,
  p_expected        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order_id    UUID;
  v_order       RECORD;
  v_return      public.customer_returns%ROWTYPE;
  v_expected    JSONB;
  v_current     JSONB;
  v_item        RECORD;
  v_sale_loc    UUID;
  v_ret_mov     UUID;
  v_dmg_mov     UUID;
  v_movements   JSONB := '[]'::JSONB;
  v_resellable  INTEGER := 0;
  v_damaged     INTEGER := 0;
BEGIN
  IF p_organization_id IS NULL OR p_actor IS NULL OR p_return_id IS NULL THEN
    RAISE EXCEPTION 'complete_customer_return_v1: organization, actor and return are required';
  END IF;

  v_expected := public.customer_return_inspection_lines_v1(p_expected);
  IF v_expected IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_lines');
  END IF;

  SELECT order_id INTO v_order_id
  FROM public.customer_returns
  WHERE id = p_return_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'return_not_found');
  END IF;

  -- Order first, then the return (the same order as request_customer_return_v1).
  SELECT id, lifecycle_status INTO v_order
  FROM public.orders
  WHERE id = v_order_id AND organization_id = p_organization_id
  FOR UPDATE;

  SELECT * INTO v_return
  FROM public.customer_returns
  WHERE id = p_return_id AND organization_id = p_organization_id
  FOR UPDATE;

  v_current := public.customer_return_current_inspection_v1(v_return.id);

  IF v_return.status = 'completed' THEN
    IF v_current = v_expected THEN
      RETURN jsonb_build_object('status', 'replayed', 'return_id', v_return.id,
                                'return_status', v_return.status);
    END IF;
    RETURN jsonb_build_object('status', 'already_completed', 'return_status', v_return.status);
  END IF;
  IF v_return.status <> 'inspected' THEN
    RETURN jsonb_build_object('status', 'not_inspected', 'return_status', v_return.status);
  END IF;
  IF v_current IS DISTINCT FROM v_expected THEN
    RETURN jsonb_build_object('status', 'stale', 'return_status', v_return.status);
  END IF;
  IF v_order.lifecycle_status NOT IN ('confirmed', 'completed') THEN
    RETURN jsonb_build_object('status', 'order_not_returnable',
                              'lifecycle', v_order.lifecycle_status::TEXT);
  END IF;

  -- ── Ledger: per line, back to exactly where the sale took it from.
  FOR v_item IN
    SELECT i.* FROM public.customer_return_items i
    WHERE i.return_id = v_return.id
    ORDER BY i.id
  LOOP
    SELECT m.location_id INTO v_sale_loc
    FROM public.inventory_movements m
    WHERE m.organization_id = p_organization_id
      AND m.variant_id      = v_item.variant_id
      AND m.movement_type   = 'sale'
      AND m.reference_type  = 'order_item'
      AND m.reference_id    = v_item.order_item_id;

    INSERT INTO public.inventory_movements(
      organization_id, product_id, variant_id, location_id, quantity_delta,
      movement_type, reference_type, reference_id, reason, created_by
    ) VALUES (
      p_organization_id, v_item.product_id, v_item.variant_id, v_sale_loc, v_item.quantity,
      'return', 'customer_return_item', v_item.id, 'Customer return', p_actor
    )
    RETURNING id INTO v_ret_mov;

    v_dmg_mov := NULL;
    IF v_item.damaged_quantity > 0 THEN
      INSERT INTO public.inventory_movements(
        organization_id, product_id, variant_id, location_id, quantity_delta,
        movement_type, reference_type, reference_id, reason, created_by
      ) VALUES (
        p_organization_id, v_item.product_id, v_item.variant_id, v_sale_loc, -v_item.damaged_quantity,
        'damage', 'customer_return_item', v_item.id, 'Damaged customer return', p_actor
      )
      RETURNING id INTO v_dmg_mov;
    END IF;

    UPDATE public.customer_return_items
    SET return_movement_id = v_ret_mov, damage_movement_id = v_dmg_mov
    WHERE id = v_item.id;

    v_resellable := v_resellable + (v_item.quantity - v_item.damaged_quantity);
    v_damaged := v_damaged + v_item.damaged_quantity;
    v_movements := v_movements || jsonb_build_array(jsonb_build_object(
      'return_item_id', v_item.id,
      'variant_id', v_item.variant_id,
      'location_id', v_sale_loc,
      'return_movement_id', v_ret_mov,
      'damage_movement_id', v_dmg_mov
    ));
  END LOOP;

  UPDATE public.customer_returns SET status = 'completed', updated_at = now()
  WHERE id = v_return.id;

  INSERT INTO public.customer_return_events(
    organization_id, return_id, from_status, to_status, actor, detail
  ) VALUES (
    p_organization_id, v_return.id, 'inspected', 'completed', p_actor,
    jsonb_build_object('resellable', v_resellable, 'damaged', v_damaged, 'movements', v_movements)
  );

  -- Mandatory audit for a stock change, in the same transaction: if this
  -- insert fails, the movements and the completion roll back with it.
  INSERT INTO public.audit_logs(
    organization_id, actor_user_id, action, resource_type, resource_id,
    before_json, after_json, reason
  ) VALUES (
    p_organization_id, p_actor, 'inventory.customer_return', 'customer_returns', v_return.id::text,
    jsonb_build_object('status', 'inspected'),
    jsonb_build_object(
      'order_id', v_return.order_id,
      'resellable', v_resellable,
      'damaged', v_damaged,
      'lines', v_expected,
      'movements', v_movements
    ),
    'Customer return completed'
  );

  RETURN jsonb_build_object('status', 'completed', 'return_id', v_return.id,
                            'return_status', 'completed',
                            'resellable', v_resellable, 'damaged', v_damaged);
END;
$$;

COMMENT ON FUNCTION public.complete_customer_return_v1(UUID, UUID, UUID, JSONB) IS
  'Complete an inspected customer return (migration 056): per line one return (+quantity) movement, plus one damage (−damaged) movement when some units are damaged, history and audit, atomically. Refuses as stale if the inspection changed since it was shown. Idempotent by state. Never writes a balance.';

-- Server-only: these functions take p_organization_id and p_actor, so EXECUTE
-- for a JWT client would be a cross-tenant stock-writing primitive.
REVOKE EXECUTE ON FUNCTION public.complete_customer_return_v1(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_customer_return_v1(UUID, UUID, UUID, JSONB)
  TO service_role;
