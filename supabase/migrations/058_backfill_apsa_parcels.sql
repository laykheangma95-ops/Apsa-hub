-- Migration: 058_backfill_apsa_parcels
-- Purpose: One-time backfill of the APSA Parcel for orders that entered
--          fulfillment before 057 made parcel creation atomic with
--          confirmation (CORRECTION-003). Separate from 057 on purpose: the
--          runtime path never creates a parcel outside confirmation.
--
-- Every confirmed or completed order without an active (non-void) parcel gets
-- exactly one, with a fresh opaque code. Idempotent: re-running inserts nothing
-- (the NOT EXISTS guard and uniq_parcels_org_order_active both prevent a
-- second active parcel). Draft and cancelled orders are untouched.

INSERT INTO public.parcels (organization_id, order_id, parcel_code, status, created_by)
SELECT o.organization_id, o.id, public.new_apsa_parcel_code_v1(), 'created', NULL
FROM public.orders o
WHERE o.lifecycle_status IN ('confirmed', 'completed')
  AND NOT EXISTS (
    SELECT 1 FROM public.parcels p
    WHERE p.organization_id = o.organization_id
      AND p.order_id = o.id
      AND p.status <> 'void'
  );
