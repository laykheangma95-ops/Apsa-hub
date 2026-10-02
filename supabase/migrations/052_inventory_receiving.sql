-- Migration: 052_inventory_receiving
-- Purpose: Receiving Inventory foundation — make a scanned stock receipt
--          duplicate-safe at the database, and let it carry an optional
--          free-text supplier label.
--
-- Additive only. No table is created, no existing column, policy, function,
-- grant or index is changed or dropped, and no permission is added: receiving
-- is authorized by the existing inventory.receive_stock key (migration 022,
-- OWNER + MANAGER), enforced server-side in src/server/inventory/receiving.ts.
--
-- ── 1. Receipt idempotency ───────────────────────────────────────────────────
--
-- A receipt is ONE `restock` movement in the existing append-only ledger
-- (migration 021) with reference_type = 'inventory_receipt' and reference_id =
-- a client-generated receipt key (a random UUID, one per confirmed receipt;
-- retries of the same receipt resend the same key).
--
-- Migration 021's uniq_inventory_movements_reference already makes
-- (organization, variant, movement_type, reference) unique, which stops the
-- same key from adding stock twice to the SAME variant. It does not stop one
-- key from being spent on two DIFFERENT variants. The index below closes that:
-- within an organization a receipt key identifies exactly one movement, full
-- stop. The server treats a unique violation on it as "this receipt was
-- already recorded" and replays the original movement (same request) or
-- refuses with a conflict (different request) — it never writes a second row.
--
-- Keyed by organization: two tenants can never collide on, or probe, each
-- other's keys.
--
-- ── 2. Supplier label ────────────────────────────────────────────────────────
--
-- `supplier_name` is an optional free-text label on the movement ("who did
-- this stock come from"). It is deliberately NOT a supplier record: there is no
-- suppliers table, no supplier id, no foreign key and no supplier management
-- (ARCHITECTURE.md "Deferred products": supplier records are not built). When
-- a Supplier domain exists (DATA_MODEL.md §42), it adds its own reference; this
-- label stays as the human-entered history it always was.
--
-- Only receiving movements (initial / restock) may carry one, and it is
-- bounded and non-blank so the ledger never stores an empty or unbounded
-- string.

ALTER TABLE public.inventory_movements
  ADD COLUMN supplier_name TEXT;

ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_supplier_name_valid CHECK (
    supplier_name IS NULL
    OR (
      movement_type IN ('initial', 'restock')
      AND char_length(btrim(supplier_name)) BETWEEN 1 AND 120
      AND supplier_name = btrim(supplier_name)
    )
  );

COMMENT ON COLUMN public.inventory_movements.supplier_name IS
  'Optional free-text supplier label for a receiving movement (initial/restock). Not a supplier record — no supplier entity exists in V1.';

-- A receipt reference is always an inbound restock of a positive quantity.
-- Holds the receiving path to its own meaning: nothing can file a sale, an
-- adjustment or a negative quantity under a receipt key.
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_receipt_shape CHECK (
    reference_type IS DISTINCT FROM 'inventory_receipt'
    OR (movement_type = 'restock' AND quantity_delta > 0)
  );

CREATE UNIQUE INDEX uniq_inventory_movements_receipt_key
  ON public.inventory_movements(organization_id, reference_id)
  WHERE reference_type = 'inventory_receipt';

COMMENT ON INDEX public.uniq_inventory_movements_receipt_key IS
  'One ledger movement per receipt key per organization. Duplicate/retried receipts are rejected here and replayed by the server.';
