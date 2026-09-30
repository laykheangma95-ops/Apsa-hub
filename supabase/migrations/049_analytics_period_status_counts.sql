-- 049_analytics_period_status_counts.sql
--
-- WHY THIS EXISTS
--   Analytics' Business Summary (src/server/analytics/repository.ts) answered
--   its status mixes with one exact HEAD count per enum value: 4 lifecycle +
--   4 payment + 4 fulfillment + 3 refund statuses on `orders`, and 4 methods on
--   `payments` — 19 PostgREST requests on every open of the Analytics screen,
--   each a separate round trip from the server function to the database. This
--   function returns the same 19 numbers from ONE call, grouped in the
--   database.
--
-- SEMANTICS (identical to the HEAD counts it replaces)
--   * orders:   organization_id = p_organization_id
--               AND created_at >= p_from AND created_at < p_until
--               — every order created in the period, any lifecycle status.
--   * payments: same organization and created_at window, grouped by method.
--   A value with no rows is simply absent; the caller zero-fills every value
--   it knows. No money is read or returned — counts only.
--
-- SECURITY
--   * SECURITY INVOKER: runs with the caller's privileges and RLS. The only
--     intended caller is the server (service_role, which already holds SELECT on
--     orders and payments via 048). No privilege is widened.
--   * The organization is a parameter the server derives from the caller's
--     verified active membership (src/api/analytics.ts), never client input —
--     exactly the value the replaced `.eq("organization_id", …)` filters used.
--   * EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to
--     service_role, so no browser session can call it through PostgREST.
--
-- ROLLBACK
--   Additive. The application falls back to the per-value HEAD counts when this
--   function is absent (PGRST202 / 42883), so code and migration may ship in
--   either order, and `DROP FUNCTION public.analytics_period_status_counts_v1(uuid, timestamptz, timestamptz);`
--   fully reverts it.
--
-- INDEXES
--   orders: idx_orders_org_created_at (023) bounds the scan to the period.
--   payments: no (organization_id, created_at) index exists; the replaced HEAD
--   counts had the same access path, so this is no worse. Not added here.

CREATE OR REPLACE FUNCTION public.analytics_period_status_counts_v1(
  p_organization_id uuid,
  p_from            timestamptz,
  p_until           timestamptz
)
RETURNS TABLE (axis text, value text, row_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH period_orders AS (
    SELECT o.lifecycle_status, o.payment_status, o.fulfillment_status, o.refund_status
    FROM public.orders o
    WHERE o.organization_id = p_organization_id
      AND o.created_at >= p_from
      AND o.created_at <  p_until
  )
  SELECT
    CASE
      WHEN GROUPING(lifecycle_status)   = 0 THEN 'lifecycle_status'
      WHEN GROUPING(payment_status)     = 0 THEN 'payment_status'
      WHEN GROUPING(fulfillment_status) = 0 THEN 'fulfillment_status'
      ELSE                                     'refund_status'
    END AS axis,
    COALESCE(
      lifecycle_status::text,
      payment_status::text,
      fulfillment_status::text,
      refund_status::text
    ) AS value,
    COUNT(*) AS row_count
  FROM period_orders
  GROUP BY GROUPING SETS ((lifecycle_status), (payment_status), (fulfillment_status), (refund_status))

  UNION ALL

  SELECT 'payment_method', p.method::text, COUNT(*)
  FROM public.payments p
  WHERE p.organization_id = p_organization_id
    AND p.created_at >= p_from
    AND p.created_at <  p_until
  GROUP BY p.method
$$;

COMMENT ON FUNCTION public.analytics_period_status_counts_v1(uuid, timestamptz, timestamptz) IS
  'Analytics Business Summary status mixes for one organization and period: order counts per lifecycle/payment/fulfillment/refund status and payment counts per method. Counts only. Server (service_role) use only.';

REVOKE ALL ON FUNCTION public.analytics_period_status_counts_v1(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_period_status_counts_v1(uuid, timestamptz, timestamptz)
  TO service_role;
