-- Migration: 016_customer_permissions
-- Purpose: Insert customer.* permission keys and assign them to system roles per
--          PERMISSIONS_MATRIX.md §8 (Customer Access).
--
-- Permission keys (canonical):
--   customers.read            — view customer list and basic profile
--   customers.create          — create a new customer record
--   customers.update_basic    — edit display name, phone, email, language
--   customers.add_note        — add a staff note to a customer
--   customers.tag             — assign/remove tags on a customer
--   customers.view_sensitive  — view phone numbers, addresses, lifetime spend
--   customers.export          — export customer list (mandatory audit)
--   customers.export_sensitive — export with PII fields (owner only, mandatory audit)
--   customers.merge           — merge duplicate customer records (privileged)
--   customers.archive         — archive (soft-delete) a customer
--
-- Matrix (✅ = full, ⚠️ = conditional / application-layer extra check):
--   Permission                OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   customers.read              ✅      ✅       ✅       ✅        ✅
--   customers.create            ✅      ✅       ✅       ✅        ✅
--   customers.update_basic      ✅      ✅       ⚠️       ⚠️        ⚠️
--   customers.add_note          ✅      ✅       ✅       ✅        ✅
--   customers.tag               ✅      ✅       ✅       ✅        ✅
--   customers.view_sensitive    ✅      ✅       —        —         —
--   customers.export            ✅      ⚠️       —        —         —
--   customers.export_sensitive  ✅      —        —        —         —
--   customers.merge             ✅      ⚠️       —        —         —
--   customers.archive           ✅      ✅       —        ⚠️        ⚠️

-- ── Step 1: Insert permission rows ────────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('customers.read',             'View customer list and basic profile',              'low'),
  ('customers.create',           'Create a new customer record',                      'low'),
  ('customers.update_basic',     'Edit customer display name, phone, email, language','low'),
  ('customers.add_note',         'Add a staff note to a customer',                   'low'),
  ('customers.tag',              'Assign or remove tags on a customer',               'low'),
  ('customers.view_sensitive',   'View customer phone, address, and lifetime spend',  'medium'),
  ('customers.export',           'Export customer list (audit required)',              'high'),
  ('customers.export_sensitive', 'Export customer PII fields (owner only)',           'critical'),
  ('customers.merge',            'Merge duplicate customer records',                  'high'),
  ('customers.archive',          'Archive (soft-delete) a customer record',           'medium')
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Assign permissions to system roles ────────────────────────────────

DO $$
DECLARE
  -- System role IDs (organization_id IS NULL = system template)
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_cs_id      UUID;

  -- Permission IDs
  v_perm_id UUID;

  -- Role arrays per permission key
  v_roles UUID[];
  v_role  UUID;
BEGIN
  -- Resolve system role IDs
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'            AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER'          AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER'          AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'            AND organization_id IS NULL;
  SELECT id INTO v_cs_id      FROM public.roles WHERE system_role = 'CUSTOMER_SERVICE' AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  -- customers.read — all roles
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.read';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- customers.create — all roles
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.create';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- customers.update_basic — all roles (application layer applies extra checks for Cashier)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.update_basic';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- customers.add_note — all roles
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.add_note';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- customers.tag — all roles
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.tag';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id, v_cs_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- customers.view_sensitive — Owner + Manager only
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.view_sensitive';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

  -- customers.export — Owner only (Manager conditional — application layer enforces extra approval)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.export';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- customers.export_sensitive — Owner only
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.export_sensitive';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- customers.merge — Owner only (Manager conditional — application layer enforces)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.merge';
  INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_owner_id, v_perm_id) ON CONFLICT DO NOTHING;

  -- customers.archive — Owner + Manager (Sales/CS conditional — application layer)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'customers.archive';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;

END;
$$;
