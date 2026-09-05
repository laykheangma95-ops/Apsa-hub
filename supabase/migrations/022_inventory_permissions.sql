-- Migration: 022_inventory_permissions
-- Purpose: Insert inventory.* permission keys and assign them to system roles per
--          PERMISSIONS_MATRIX.md §13 (Inventory).
--
-- Permission keys (canonical, V1 scope):
--   inventory.read           — view current stock (inventory_stock)
--   inventory.view_movements — view movement history (inventory_movements)
--   inventory.adjust         — record a manual_adjustment movement (high-risk, audited)
--   inventory.receive_stock  — record initial / restock movements
--
-- transfer / mark_damage / override_reservation from PERMISSIONS_MATRIX.md §13 are
-- POST-MVP (no transfer/damage/reservation movement types exist in V1) and are
-- intentionally not seeded here.
--
-- Matrix (✅ = full, ⚠️ = conditional / application-layer extra check — not
-- assigned directly here, same convention as 019_product_permissions.sql):
--   Permission                   OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   inventory.read                 ✅      ✅       ✅       ✅        ⚠️
--   inventory.view_movements       ✅      ✅       ⚠️       ⚠️        ❌
--   inventory.adjust               ✅      ✅       ❌       ❌        ❌
--   inventory.receive_stock        ✅      ✅       ❌       ❌        ❌

-- ── Step 1: Insert permission rows ────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('inventory.read',           'View current stock levels',                           'low'),
  ('inventory.view_movements', 'View inventory movement history',                     'medium'),
  ('inventory.adjust',         'Record a manual stock adjustment',                    'high'),
  ('inventory.receive_stock',  'Record initial stock or a restock movement',          'medium')
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

  -- inventory.read — Owner, Manager, Cashier, Sales (Customer Service is ⚠️ conditional)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'inventory.read';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- inventory.view_movements — Owner + Manager only (Cashier/Sales are ⚠️ conditional)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'inventory.view_movements';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- inventory.adjust — Owner + Manager only
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'inventory.adjust';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- inventory.receive_stock — Owner + Manager only
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'inventory.receive_stock';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

END;
$$;
