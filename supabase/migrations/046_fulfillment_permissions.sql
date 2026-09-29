-- Migration: 046_fulfillment_permissions
-- Purpose: Add the NARROW fulfillment.print_label capability so operational
--          packing staff (Cashier / Sales) can print parcel labels without
--          being granted general customer-sensitive access (PR #80 review §20).
--
-- Problem this fixes:
--   getParcelLabelData previously required customers.view_sensitive, which
--   migration 016 grants to OWNER + MANAGER only. That left the very people who
--   pack orders — cashiers and sales/fulfillment staff — unable to print a
--   shipping label, while the only workaround (granting them
--   customers.view_sensitive) would hand them the entire customer PII surface
--   elsewhere. This introduces a dedicated, minimal grant instead.
--
-- Scope of the grant:
--   fulfillment.print_label authorizes printing a parcel label, which exposes
--   ONLY the shipping fields (customer name, phone, delivery address) for an
--   order being packed. It does NOT grant customers.view_sensitive and confers
--   no access to customer profiles, lifetime spend, exports, or any other
--   sensitive customer data. The server (src/server/fulfillment/service.ts)
--   reads exactly those three fields and nothing more.
--
-- Additive and minimal: one new permission key and its role grants. No table,
-- column, policy, or existing grant is changed.
--
-- Matrix:
--   Permission                 OWNER  MANAGER  CASHIER  SALES  CUSTOMER_SERVICE
--   fulfillment.print_label      ✅      ✅       ✅       ✅         —
--
-- CUSTOMER_SERVICE is excluded: that role works the inbox, not the packing
-- bench, and has no fulfillment surface.

-- ── Step 1: Insert the permission row ─────────────────────────────────────────

INSERT INTO public.permissions (key, description, risk_level) VALUES
  (
    'fulfillment.print_label',
    'Print a parcel/shipping label (customer name, phone, delivery address for fulfillment only)',
    'medium'
  )
ON CONFLICT (key) DO NOTHING;

-- ── Step 2: Assign to operational roles ───────────────────────────────────────

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

  -- fulfillment.print_label — Owner + Manager + Cashier + Sales (everyone who packs)
  SELECT id INTO v_perm_id FROM public.permissions WHERE key = 'fulfillment.print_label';
  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
