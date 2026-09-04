-- Migration: 019_product_permissions
-- Purpose: Insert product.* permission keys and assign them to system roles per
--          PERMISSIONS_MATRIX.md §12 (Product Access).
--
-- Permission keys (canonical):
--   products.read              — view product catalog, variant details
--   products.create            — create new products and variants
--   products.update_basic      — edit product name, description, category, variant name
--   products.update_price      — change variant price_amount / price_currency
--   products.view_cost         — see variant cost_amount / cost_currency
--   products.update_cost       — change variant cost_amount / cost_currency
--   products.archive           — archive (soft-delete) a product or variant
--   products.manage_categories — create/edit/archive product categories
--
-- Matrix (✅ = full, ⚠️ = conditional / application-layer extra check):
--   Permission                   OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   products.read                  ✅      ✅       ✅       ✅        ✅
--   products.create                ✅      ✅       —        —         —
--   products.update_basic          ✅      ✅       —        —         —
--   products.update_price          ✅      ⚠️       —        —         —
--   products.view_cost             ✅      ⚠️       —        —         —
--   products.update_cost           ✅      ⚠️       —        —         —
--   products.archive               ✅      ✅       —        —         —
--   products.manage_categories     ✅      ✅       —        —         —

-- ── Step 1: Insert permission rows ────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('products.read',              'View product catalog and variant details',             'low'),
  ('products.create',            'Create new products and variants',                    'low'),
  ('products.update_basic',      'Edit product name, description, category',            'low'),
  ('products.update_price',      'Change variant selling price',                        'medium'),
  ('products.view_cost',         'View variant cost / margin data',                     'medium'),
  ('products.update_cost',       'Change variant cost data',                            'medium'),
  ('products.archive',           'Archive (soft-delete) a product or variant',          'medium'),
  ('products.manage_categories', 'Create, edit, and archive product categories',        'low')
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Assign permissions to system roles ────────────────────────────────

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_cs_id      UUID;
  v_perm_id    UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'            AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER'          AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER'          AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'            AND organization_id IS NULL;
  SELECT id INTO v_cs_id      FROM public.roles WHERE system_role = 'CUSTOMER_SERVICE' AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  -- products.read — all roles (including Cashier, Sales, CS for POS product lookup)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.read';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- products.create — Owner + Manager only
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.create';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- products.update_basic — Owner + Manager only
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.update_basic';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- products.update_price — Owner only (Manager conditional — application layer enforces)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.update_price';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- products.view_cost — Owner only (Manager conditional — application layer enforces)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.view_cost';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- products.update_cost — Owner only (Manager conditional — application layer enforces)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.update_cost';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- products.archive — Owner + Manager
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.archive';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- products.manage_categories — Owner + Manager
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'products.manage_categories';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

END;
$$;
