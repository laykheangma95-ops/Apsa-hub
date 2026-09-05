-- Migration: 025_order_permissions
-- Purpose: Add the two Order permission keys the production Order domain needs
--          that are not already seeded, per PERMISSIONS_MATRIX.md §14 (Orders).
--
-- REUSED, NOT RE-CREATED — already seeded by migration 003 and used as-is by
-- src/server/orders/service.ts:
--   orders.read      — list/get orders           (low)
--   orders.create    — create a draft order      (low)
--   orders.update    — move fulfillment_status   (medium)
--   orders.cancel    — cancel an order           (high)
--   payments.confirm — move payment_status       (high)
--
-- ADDED HERE — defined by PERMISSIONS_MATRIX.md §14 but never seeded:
--   orders.confirm        — commit a draft order to a real sale
--   orders.apply_discount — put a discount on an order at creation
--
-- WHY THESE TWO AND NOTHING ELSE
--   orders.confirm gates the single most consequential transition in the
--   domain: draft -> confirmed is what turns a chat draft or a POS cart into a
--   sale, and it is the transition that will consume stock once the Inventory
--   integration lands (see migration 023, "FUTURE INVENTORY TRIGGER POINT").
--   Folding it into the generic orders.update would mean anyone who can rename
--   a fulfillment state can also commit inventory — so it needs its own key,
--   and the matrix already gives it one.
--
--   orders.apply_discount gates giving money away. Without it, discount_minor
--   would be an unguarded money input on the create path.
--
--   No orders.update_status key is created: fulfillment transitions are exactly
--   "updating the order", which orders.update (migration 003) already covers,
--   and PERMISSIONS_MATRIX.md §14 does not define an update_status key.
--   Inventing one would add a third name for the same authority.
--
--   orders.change_price, orders.large_discount, orders.return and orders.refund
--   from §14 are NOT seeded: nothing in this phase can perform those actions,
--   and a permission that grants access to no code path is a permission nobody
--   can reason about at review time. They arrive with the features that need
--   them (price override, returns, Phase 8 payments/refunds).
--
-- Matrix rows implemented (✅ = assigned here, ⚠️ = conditional, deliberately
-- NOT granted outright — the same convention as migrations 019 and 022):
--   Permission               OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   orders.confirm             ✅      ✅       ✅       ✅         ⚠️
--   orders.apply_discount      ✅      ✅       ⚠️       ⚠️         ❌
--
-- OWNER is granted explicitly. Migration 003's "OWNER gets every permission"
-- seed was a one-time INSERT ... SELECT over the permissions that existed then;
-- it does not retroactively pick up keys added by later migrations.

-- ── Step 1: Insert permission rows ────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('orders.confirm',        'Confirm a draft order into a committed sale',  'high'),
  ('orders.apply_discount', 'Apply a discount to an order',                 'high')
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Assign permissions to system roles ────────────────────────────────

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_perm_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'   AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER' AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER' AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'   AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  -- orders.confirm — Owner, Manager, Cashier, Sales.
  -- Cashier and Sales are the people who actually take orders at the counter and
  -- in chat; withholding this would make the core APSA workflow require a
  -- manager for every sale.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'orders.confirm';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- orders.apply_discount — Owner + Manager only.
  -- Cashier/Sales are ⚠️ in the matrix: they should eventually get a CAPPED
  -- discount ("≤ 10%", per §14's note), which needs a configurable limit that
  -- does not exist yet. Granting the uncapped key now would be strictly more
  -- access than the matrix intends.
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'orders.apply_discount';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

END;
$$;
