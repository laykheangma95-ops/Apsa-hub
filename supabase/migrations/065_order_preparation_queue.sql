-- ════════════════════════════════════════════════════════════════════════════
-- 065 — Order preparation queue: "packing still required", queryable as a set
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHY
-- The Orders screen's "Needs preparation" list and its exact count must agree
-- with the packed rule, and "packed" is not a column: it is
-- order_currently_packed_v1 (migration 054), a comparison of history rows.
-- Approximating it with fulfillment_status is wrong both ways:
--   * a delivery arranged BEFORE packing moves the order to 'processing', so an
--     unpacked order disappeared from a fulfillment = 'unfulfilled' list;
--   * a packed order whose delivery failed or was cancelled returns to
--     'unfulfilled', so a packed order appeared as packing work.
-- This view gives PostgREST one row per order still in the shop with the
-- packed rule already applied, so the paged list and the exact count are the
-- SAME predicate over the WHOLE organization.
--
-- WHAT IS IN IT
-- Only orders still in the shop and still in the sale:
--   lifecycle_status   = 'confirmed'
--   fulfillment_status IN ('unfulfilled', 'processing')
--   no delivery of the order is 'ready', 'in_transit' or 'delivered'
-- A ready delivery is the Waiting-for-pickup view's (migration 054: nothing
-- readies a delivery unless the order is packed); in_transit / delivered mean
-- the goods have left. Cancelled sales and cancelled fulfillments are out.
--
-- preparation_state, decided by order_currently_packed_v1 and nothing else:
--   'needs_packing'          not currently packed — Pack Order is the next step,
--                            whether or not a delivery is already arranged
--                            (pending / preparing) and whatever fulfillment says
--   'packed_needs_delivery'  currently packed, but no delivery is ready or out:
--                            none arranged, the last one failed or was
--                            cancelled, or one is pending / preparing and was
--                            never readied. Delivery recovery, not packing.
--
-- Parcels play no part: a parcel is identity (created / void, migration 050)
-- and neither packing nor delivery changes it.
--
-- SECURITY
-- security_invoker: the view reads with the querying role's privileges. It is
-- given to service_role only (the server's admin client) and revoked from every
-- browser-reachable role, like order_payment_totals (migration 040). The
-- server scopes every read by the organization it resolved from the session;
-- order_currently_packed_v1 is itself scoped by the row's own organization, so
-- a history row of another tenant can never make an order packed.
--
-- COST
-- The packed rule is a STABLE plpgsql function evaluated once per candidate row
-- (orders that pass the cheap column and delivery tests), never for drafts,
-- completed, cancelled or shipped orders. Callers also filter on
-- organization_id, which uses idx_orders_org_lifecycle / idx_orders_org_created_at.
--
-- DEPLOYMENT DEPENDENCY
-- The application release that reads this view (Orders "Needs preparation" and
-- "Packed · Needs delivery", PR #137) must not be deployed to an environment
-- until this migration is applied there; the reads fail closed (an error, never
-- a wrong list) when the view is missing. Order: after 064. Read-only: no table,
-- row, trigger or function is changed.
-- ════════════════════════════════════════════════════════════════════════════

CREATE VIEW public.order_preparation_queue_v1
WITH (security_invoker = true) AS
SELECT
  o.*,
  (CASE
     WHEN public.order_currently_packed_v1(o.organization_id, o.id)
       THEN 'packed_needs_delivery'
     ELSE 'needs_packing'
   END)::text AS preparation_state
FROM public.orders o
WHERE o.lifecycle_status = 'confirmed'
  AND o.fulfillment_status IN ('unfulfilled', 'processing')
  AND NOT EXISTS (
    SELECT 1
    FROM public.deliveries d
    WHERE d.organization_id = o.organization_id
      AND d.order_id = o.id
      AND d.status IN ('ready', 'in_transit', 'delivered')
  );

COMMENT ON VIEW public.order_preparation_queue_v1 IS
  'Confirmed orders still in the shop (no delivery ready, in transit or delivered), each with preparation_state from order_currently_packed_v1: needs_packing or packed_needs_delivery. Server (service_role) only. Migration 065.';

-- Read-only for everyone. A single-table view is auto-updatable, and a
-- project's default privileges (Supabase grants ALL on new relations) would
-- otherwise make it a second write path into orders — so service_role loses
-- everything but SELECT too.
REVOKE ALL ON public.order_preparation_queue_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_preparation_queue_v1 TO service_role;
