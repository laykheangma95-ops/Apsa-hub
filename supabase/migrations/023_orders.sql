-- Migration: 023_orders
-- Purpose: Production Order domain foundation — the central commerce entity.
-- Tables: orders, order_items, order_status_history, order_number_sequences
-- Classification: tenant-private (scoped to organization_id)
--
-- SOURCE OF TRUTH
--   DATA_MODEL.md §44 (Order), §45 (Order number), §46 (OrderItem),
--   §47 (OrderStatusHistory); MVP_ROADMAP.md §13 (Phase 7 — Universal Order
--   Engine); PERMISSIONS_MATRIX.md §14 (Orders); ARCHITECTURE.md (money rules).
--
-- SCOPE OF THIS PHASE (deliberate exclusions — do not "fill these in" later
-- without their own migration and phase):
--   - No Inventory integration. Nothing here writes inventory_movements. The
--     stock-consuming transition is IDENTIFIED and DOCUMENTED below but not
--     wired: see "FUTURE INVENTORY TRIGGER POINT".
--   - No payment records (Phase 8). payment_status is a status field only;
--     there is no payments table, no amount-paid tracking, no partial payment.
--   - No delivery/courier integration (Phase 10). delivery_minor exists as a
--     money column so the financial total is complete and never needs an
--     ALTER on a financial table later, but no code in this phase sets it to
--     anything but 0.
--   - No refunds and no returns. The corresponding statuses are intentionally
--     ABSENT from the enums rather than present-and-unreachable, so that an
--     unimplemented state can never be persisted.
--   - No taxes. No document in APSA's MVP scope defines tax handling, and an
--     unused column on a financial table is worse than a later migration.
--
-- MONEY (ARCHITECTURE.md — non-negotiable)
--   Every monetary column is an INTEGER minor unit (USD = cents, KHR = riel).
--   There is no NUMERIC/FLOAT money anywhere in this schema. Currency is
--   explicit and belongs to the ORDER, not the line: every line in an order is
--   denominated in orders.currency, and the create RPC rejects a variant whose
--   price_currency differs. Totals are re-derived server-side and additionally
--   constrained by DB CHECKs (see below) — a client-supplied total cannot be
--   stored even by a service-role write that tried.
--
-- TENANT ISOLATION
--   organization_id is NOT NULL on every table here and is always supplied by
--   the server from a verified membership. FKs alone only prove a referenced
--   row EXISTS — they do not prove it belongs to the same tenant. Triggers
--   below close that gap for customer/location/product/variant/order, so a
--   cross-tenant relationship is impossible even through a service-role write.
--
-- DELETE BEHAVIOUR (RESTRICT vs CASCADE — chosen deliberately)
--   orders.customer_id           -> RESTRICT  (financial history must not be
--                                   silently detached; customers are archived,
--                                   never hard-deleted — see migration 011)
--   orders.location_id           -> RESTRICT  (same reasoning)
--   order_items.product_id       -> RESTRICT
--   order_items.variant_id       -> RESTRICT
--   order_items.order_id         -> CASCADE   (items are part of the order
--                                   aggregate and are meaningless without it;
--                                   no DELETE path on orders exists anyway)
--   *.organization_id            -> CASCADE   (deleting a tenant deletes its
--                                   data — consistent with every other table)
--   created_by/changed_by        -> SET NULL  (a departed staff account must
--                                   not take order history with it)
--   Order lines additionally carry NAME/SKU SNAPSHOTS so that renaming or
--   archiving a catalog entry never rewrites what the customer actually bought.

-- ── Enums ─────────────────────────────────────────────────────────────────────
--
-- Three axes, not one. MVP_ROADMAP.md §13 sketches a single flat status list
-- (DRAFT/PENDING_PAYMENT/PAID/CONFIRMED/PACKING/.../REFUNDED) that mixes three
-- independent facts. That list cannot represent an ordinary Cambodian COD sale,
-- which is simultaneously "confirmed", "unpaid" and "processing". The existing
-- APSA UI already separates payment from fulfillment (src/types/index.ts:
-- PaymentStatus + FulfillmentStatus), so this schema keeps those two axes and
-- adds a third — lifecycle — for the facts neither axis can carry: whether the
-- order is a committed sale at all, and whether it was cancelled.

-- Lifecycle: the order's own commitment state.
--   draft      — being built (chat draft, POS cart in progress). Not a sale yet.
--   confirmed  — the merchant has committed to this sale.
--   completed  — terminal success: paid AND fulfilled.
--   cancelled  — terminal failure: the sale will not happen.
CREATE TYPE public.order_lifecycle_status AS ENUM (
  'draft',
  'confirmed',
  'completed',
  'cancelled'
);

-- Payment: has the money arrived. No refund/partial states in this phase —
-- both need the Payment Records domain (Phase 8) to mean anything.
CREATE TYPE public.order_payment_status AS ENUM (
  'unpaid',
  'pending',
  'paid',
  'failed'
);

-- Fulfillment: has the customer received the goods. Deliberately COARSE.
-- The mock UI's packing/ready/in_transit/delivered are courier-granularity
-- states; per ARCHITECTURE.md ("provider abstractions — no courier field names
-- in domain types") those belong to the Delivery domain, which will hold its
-- own detailed status and drive this coarse field. Mapping for the future
-- Delivery integration: packing/ready/in_transit -> processing, delivered ->
-- fulfilled.
CREATE TYPE public.order_fulfillment_status AS ENUM (
  'unfulfilled',
  'processing',
  'fulfilled',
  'cancelled'
);

-- Where the order came from. DATA_MODEL.md §44 / MVP_ROADMAP.md §13.
-- The mock UI carries BOTH `channel` and `source`, which is redundant — a POS
-- sale has no social channel and a Facebook order has no separate source.
-- Production uses one field. Future sources (TIKTOK, MINI_STORE, MARKETPLACE,
-- SWIPE, API, FOOD) are added by ALTER TYPE ... ADD VALUE when those channels
-- actually exist; adding unreachable values now would let an order claim a
-- source APSA cannot service.
CREATE TYPE public.order_source AS ENUM (
  'POS',
  'FACEBOOK',
  'INSTAGRAM',
  'TELEGRAM',
  'MANUAL'
);

-- Which status axis a history row describes.
CREATE TYPE public.order_status_axis AS ENUM (
  'lifecycle',
  'payment',
  'fulfillment'
);

-- ── orders ────────────────────────────────────────────────────────────────────

CREATE TABLE public.orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Human-readable business reference (DATA_MODEL.md §45), e.g. APSA-2026-000123.
  -- NEVER a security identifier: every lookup in src/server/orders/* is by UUID
  -- id + organization_id. This column exists so merchants and customers can
  -- talk about an order out loud. Allocation is race-free — see migration 024.
  order_number        TEXT NOT NULL CHECK (length(trim(order_number)) > 0),

  -- Guest sales are allowed: POS counter sales frequently have no customer
  -- record, and forcing one would create junk customers. Social-channel orders
  -- always have a customer because they came from a conversation.
  customer_id         UUID REFERENCES public.customers(id) ON DELETE RESTRICT,

  -- Which physical/virtual location sold this. Nullable while single-location
  -- merchants are the norm. Recorded now because the future inventory
  -- integration must know WHICH location's stock a confirmed order consumes.
  location_id         UUID REFERENCES public.locations(id) ON DELETE RESTRICT,

  source              public.order_source NOT NULL,

  -- Money. Integer minor units; currency is the order's, not the line's.
  currency            TEXT NOT NULL CHECK (currency IN ('USD', 'KHR')),
  subtotal_minor      BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor      BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  -- Always 0 in this phase. Owned by the future Delivery domain.
  delivery_minor      BIGINT NOT NULL DEFAULT 0 CHECK (delivery_minor >= 0),
  total_minor         BIGINT NOT NULL CHECK (total_minor >= 0),

  lifecycle_status    public.order_lifecycle_status    NOT NULL DEFAULT 'draft',
  payment_status      public.order_payment_status      NOT NULL DEFAULT 'unpaid',
  fulfillment_status  public.order_fulfillment_status  NOT NULL DEFAULT 'unfulfilled',

  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A discount can never exceed what is being discounted.
  CONSTRAINT orders_discount_within_subtotal CHECK (discount_minor <= subtotal_minor),

  -- SERVER-AUTHORITATIVE TOTAL. The database itself refuses to store a total
  -- that is not the arithmetic result of its components, so an injected
  -- "total_minor" is rejected at the storage layer and not merely ignored by
  -- application code. subtotal_minor = SUM(order_items.line_total_minor) is
  -- computed inside the create RPC (migration 024), which is the only write
  -- path that exists.
  CONSTRAINT orders_total_is_derived CHECK (
    total_minor = subtotal_minor - discount_minor + delivery_minor
  )
);

COMMENT ON TABLE public.orders IS
  'Central commerce entity. Three independent status axes (lifecycle/payment/fulfillment). Money is integer minor units; total is DB-constrained to equal subtotal - discount + delivery.';

COMMENT ON COLUMN public.orders.order_number IS
  'Human-readable business reference only (DATA_MODEL.md §45). Never used as a security identifier — all authorization lookups use id + organization_id.';

-- Human reference is unique per tenant, not globally: two merchants may both
-- have APSA-2026-000001 and neither should be able to probe the other's.
CREATE UNIQUE INDEX uniq_orders_number_per_org
  ON public.orders(organization_id, order_number);

CREATE INDEX idx_orders_org_created_at
  ON public.orders(organization_id, created_at DESC);

CREATE INDEX idx_orders_org_customer
  ON public.orders(organization_id, customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX idx_orders_org_lifecycle
  ON public.orders(organization_id, lifecycle_status);

CREATE INDEX idx_orders_org_payment
  ON public.orders(organization_id, payment_status);

CREATE INDEX idx_orders_org_fulfillment
  ON public.orders(organization_id, fulfillment_status);

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── order_items ───────────────────────────────────────────────────────────────

CREATE TABLE public.order_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id              UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id            UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  variant_id            UUID NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,

  -- Snapshots (DATA_MODEL.md §46): what the customer actually bought, frozen at
  -- sale time. Renaming or archiving the catalog entry later must never rewrite
  -- an order's history.
  product_name_snapshot TEXT NOT NULL CHECK (length(trim(product_name_snapshot)) > 0),
  variant_name_snapshot TEXT,
  sku_snapshot          TEXT,

  -- Money: integer minor units, denominated in the parent order's currency.
  unit_price_minor      BIGINT  NOT NULL CHECK (unit_price_minor >= 0),
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  line_total_minor      BIGINT  NOT NULL CHECK (line_total_minor >= 0),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- SERVER-AUTHORITATIVE LINE TOTAL, enforced by the database rather than
  -- trusted from any caller.
  CONSTRAINT order_items_line_total_is_derived CHECK (
    line_total_minor = unit_price_minor * quantity
  )
);

COMMENT ON TABLE public.order_items IS
  'Order lines with product/variant/SKU snapshots. line_total_minor is DB-constrained to unit_price_minor * quantity. Quantity is a positive integer by constraint.';

CREATE INDEX idx_order_items_order
  ON public.order_items(order_id);

CREATE INDEX idx_order_items_org
  ON public.order_items(organization_id);

-- Supports the future inventory integration ("which orders consumed this
-- variant") and product performance reads.
CREATE INDEX idx_order_items_org_variant
  ON public.order_items(organization_id, variant_id);

-- ── order_status_history ──────────────────────────────────────────────────────
--
-- DATA_MODEL.md §47: "Never silently rewrite order history." Every accepted
-- transition on every axis appends exactly one immutable row here, written in
-- the SAME transaction as the status change (migration 024). A status field
-- with no transition record is a status change that never happened.
--
-- from_status/to_status are TEXT rather than a union of the three status enums
-- because a single column cannot be three enum types. The axis column says how
-- to read them, and the state machine that produces them is authoritative
-- (src/server/orders/state-machine.ts).

CREATE TABLE public.order_status_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  axis             public.order_status_axis NOT NULL,
  from_status      TEXT NOT NULL,
  to_status        TEXT NOT NULL,
  changed_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason           TEXT,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A transition to the state you were already in is not a transition.
  CONSTRAINT order_status_history_actually_changed CHECK (from_status <> to_status)
);

COMMENT ON TABLE public.order_status_history IS
  'Append-only record of every order status transition. Written in the same transaction as the status change. Never UPDATE or DELETE.';

CREATE INDEX idx_order_status_history_order
  ON public.order_status_history(order_id, changed_at DESC);

CREATE INDEX idx_order_status_history_org
  ON public.order_status_history(organization_id, changed_at DESC);

-- ── order_number_sequences ────────────────────────────────────────────────────
--
-- Race-free, org-scoped, per-year allocation of the human-readable reference.
--
-- Explicitly NOT "SELECT MAX(order_number) + 1": that pattern reads a value,
-- releases nothing, and lets two concurrent transactions compute the same next
-- number — under the unique index one of them simply fails, and under no index
-- two orders silently share a reference. Instead, allocation is an UPSERT that
-- INCREMENTS IN PLACE (migration 024). The row lock taken by the UPDATE is held
-- for the rest of the transaction, so concurrent allocators serialize and each
-- receives a distinct number.
--
-- A native Postgres SEQUENCE is not used: sequences are global objects, and one
-- per (organization, year) would mean unbounded DDL driven by tenant signups.

CREATE TABLE public.order_number_sequences (
  organization_id  UUID    NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  year             INTEGER NOT NULL CHECK (year >= 2000 AND year <= 9999),
  last_number      BIGINT  NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (organization_id, year)
);

COMMENT ON TABLE public.order_number_sequences IS
  'Per-organization, per-year counter for human-readable order numbers. Allocated by atomic UPSERT-increment in create_order_v1 — never by SELECT MAX + 1.';

-- ── Cross-tenant integrity ────────────────────────────────────────────────────
--
-- The FK constraints above prove only that the referenced rows EXIST. They do
-- not prevent Org A from attaching Org B's customer, location, product or
-- variant. These triggers do, and they fire for service-role writes too — so
-- the guarantee does not depend on the application layer being correct.

CREATE OR REPLACE FUNCTION public.check_order_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.customers
      WHERE id = NEW.customer_id
        AND organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION
        'order customer_id must belong to the same organization as the order (cross_tenant_customer)';
    END IF;
  END IF;

  IF NEW.location_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.locations
      WHERE id = NEW.location_id
        AND organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION
        'order location_id must belong to the same organization as the order (cross_tenant_location)';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.check_order_cross_tenant_refs();

CREATE OR REPLACE FUNCTION public.check_order_item_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- The line must belong to the same tenant as its order.
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = NEW.order_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'order_item organization_id must match the parent order organization_id (cross_tenant_order)';
  END IF;

  -- The variant must belong to the same tenant AND to the stated product.
  -- Checking both in one EXISTS also rules out "org A's product with org A's
  -- variant that actually belongs to a different product".
  IF NOT EXISTS (
    SELECT 1 FROM public.product_variants
    WHERE id = NEW.variant_id
      AND product_id = NEW.product_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'order_item variant_id must belong to product_id and to the same organization (cross_tenant_variant)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products
    WHERE id = NEW.product_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'order_item product_id must belong to the same organization (cross_tenant_product)';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_item_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.check_order_item_cross_tenant_refs();

CREATE OR REPLACE FUNCTION public.check_order_status_history_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = NEW.order_id
      AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'order_status_history organization_id must match the parent order organization_id (cross_tenant_order)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_status_history_integrity_check
  BEFORE INSERT ON public.order_status_history
  FOR EACH ROW EXECUTE FUNCTION public.check_order_status_history_integrity();

-- ── Row-Level Security ────────────────────────────────────────────────────────
--
-- SECURITY POSTURE (same as inventory_movements, migration 021, and for the
-- same reason): JWT clients get tenant-scoped READ only. They cannot INSERT,
-- UPDATE or DELETE.
--
-- Membership is not authorization. A Cashier holding a browser session belongs
-- to the tenant, but that says nothing about whether they may confirm an order,
-- mark it paid, or cancel it. If PostgREST accepted a direct write here, a
-- client could set lifecycle_status = 'confirmed' straight from the browser and
-- bypass EVERY control that makes this domain safe: the permission check, the
-- state machine's transition table, the status-history record, and — once the
-- Inventory integration lands — the stock movement that a confirmation is
-- supposed to cause. The state machine has to be unbypassable, so the only
-- write path is the server domain (src/server/orders/service.ts) via the
-- service role, which bypasses RLS by design.
--
-- Hard DELETE is blocked on all three tables: order history is financial
-- history. Cancellation is a status, not a deletion.

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orders_select_member"
  ON public.orders FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "orders_insert_blocked"
  ON public.orders FOR INSERT
  WITH CHECK (false);

CREATE POLICY "orders_update_blocked"
  ON public.orders FOR UPDATE
  USING (false);

CREATE POLICY "orders_no_delete"
  ON public.orders FOR DELETE
  USING (false);

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "order_items_select_member"
  ON public.order_items FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "order_items_insert_blocked"
  ON public.order_items FOR INSERT
  WITH CHECK (false);

CREATE POLICY "order_items_update_blocked"
  ON public.order_items FOR UPDATE
  USING (false);

CREATE POLICY "order_items_no_delete"
  ON public.order_items FOR DELETE
  USING (false);

ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "order_status_history_select_member"
  ON public.order_status_history FOR SELECT
  USING (public.is_active_member_of(organization_id));

CREATE POLICY "order_status_history_insert_blocked"
  ON public.order_status_history FOR INSERT
  WITH CHECK (false);

CREATE POLICY "order_status_history_no_update"
  ON public.order_status_history FOR UPDATE
  USING (false);

CREATE POLICY "order_status_history_no_delete"
  ON public.order_status_history FOR DELETE
  USING (false);

-- The number allocator is server-internal bookkeeping — clients have no reason
-- to read it, and being able to read it would leak a tenant's order volume.
ALTER TABLE public.order_number_sequences ENABLE ROW LEVEL SECURITY;
-- No policies: every JWT-client operation is denied by default under RLS.
-- The service role bypasses RLS and is the only caller.

-- Defense in depth: RLS and GRANTs are independent gates and a write needs
-- BOTH. Revoking the privilege means a future permissive policy — or a policy
-- accidentally dropped in a later migration — still cannot re-open a direct
-- client write path. SELECT stays granted where a select policy exists above.
REVOKE INSERT, UPDATE, DELETE ON public.orders               FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.order_items          FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.order_status_history FROM anon, authenticated;
REVOKE ALL                     ON public.order_number_sequences FROM anon, authenticated;

-- ── FUTURE INVENTORY TRIGGER POINT (documented, NOT implemented) ──────────────
--
-- The stock-consuming transition is:
--
--     lifecycle_status: 'draft' -> 'confirmed'
--
-- and its inverse (stock-releasing) transition is:
--
--     lifecycle_status: 'confirmed' -> 'cancelled'
--
-- WHY THIS TRANSITION, and not payment or fulfillment:
--
--   Not 'paid'. Cash on delivery is the dominant payment method for Cambodian
--   social commerce: the money arrives days after the goods leave. Consuming
--   stock at payment would let a merchant confirm and ship ten COD orders for
--   an item they have one of, because none of them is paid yet.
--
--   Not 'fulfilled'. By the time an order is fulfilled the goods are already
--   with the customer. Stock that is only decremented on fulfillment is stock
--   that was oversold at every moment before it — the merchant learns about
--   the shortage while packing, which is exactly the failure APSA exists to
--   prevent.
--
--   'confirmed' is the moment the merchant commits the goods to this customer,
--   and therefore the moment those units stop being available to anyone else.
--   It is also the one transition that both channels share: a POS sale
--   confirms at checkout, a chat order confirms when the merchant accepts it.
--
-- WHEN IMPLEMENTED, the integration will (in ONE transaction with the status
-- change) write one inventory_movements row per order line:
--     movement_type  = 'sale'
--     quantity_delta = -order_items.quantity
--     reference_type = 'order'
--     reference_id   = orders.id
--     location_id    = orders.location_id
-- and the mirror on cancellation:
--     movement_type  = 'return'   (releasing committed stock)
--     quantity_delta = +order_items.quantity
--
-- Migration 021's uniq_inventory_movements_reference index already keys on
-- (organization_id, variant_id, movement_type, reference_type, reference_id),
-- which makes a retried confirmation idempotent and still permits the later
-- cancellation movement for the same order. No inventory schema change is
-- needed to land this; only the wiring, its own tests, and the decision about
-- whether a confirmation may proceed when stock is insufficient — a product
-- question, out of scope for this phase.
