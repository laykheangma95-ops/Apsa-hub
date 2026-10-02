-- Migration: 051_courier_handoff_permission
-- Purpose: Add the delivery.handoff permission for the Courier Handoff workflow.
--
-- The handoff confirms a packed parcel has been physically given to a courier.
-- It is a distinct capability from delivery.update (which is Owner/Manager only
-- for general status transitions) because the physical handoff is typically
-- performed by operational staff (cashiers, sales, packers) who need to confirm
-- the courier has the parcel without having general delivery-lifecycle authority.
--
-- Granted to: OWNER, MANAGER, CASHIER, SALES (the roles that handle physical parcels).
-- NOT granted to: CUSTOMER_SERVICE (they do not physically hand off parcels).
--
-- Additive only. No existing table, column, policy, function, or grant is changed.

INSERT INTO public.permissions (key, description, risk_level) VALUES
  (
    'delivery.handoff',
    'Confirm a packed parcel has been physically handed to the courier (ready → in_transit)',
    'medium'
  )
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  v_owner_id   UUID;
  v_manager_id UUID;
  v_cashier_id UUID;
  v_sales_id   UUID;
  v_handoff_id UUID;
  v_role       UUID;
BEGIN
  SELECT id INTO v_owner_id   FROM public.roles WHERE system_role = 'OWNER'   AND organization_id IS NULL;
  SELECT id INTO v_manager_id FROM public.roles WHERE system_role = 'MANAGER' AND organization_id IS NULL;
  SELECT id INTO v_cashier_id FROM public.roles WHERE system_role = 'CASHIER' AND organization_id IS NULL;
  SELECT id INTO v_sales_id   FROM public.roles WHERE system_role = 'SALES'   AND organization_id IS NULL;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'System role OWNER not found — ensure migration 003 has been applied.';
  END IF;

  SELECT id INTO v_handoff_id FROM public.permissions WHERE key = 'delivery.handoff';

  FOREACH v_role IN ARRAY ARRAY[v_owner_id, v_manager_id, v_cashier_id, v_sales_id] LOOP
    INSERT INTO public.role_permissions (role_id, permission_id)
      VALUES (v_role, v_handoff_id) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
