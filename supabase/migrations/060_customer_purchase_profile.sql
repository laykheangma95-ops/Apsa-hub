-- 060_customer_purchase_profile.sql
--
-- Customer Intelligence Foundation V1 — one customer's purchase profile,
-- DERIVED on read from APSA's authoritative commerce records. Nothing is
-- copied, cached or persisted: no table, no view, no materialized view. The
-- answer is rebuilt from orders / order_items / order_payment_totals /
-- payments / deliveries / customer_returns on every call, so it can never
-- drift from them.
--
-- WHY A FUNCTION (and not a view, materialized view or derived table)
--   * One customer at a time, behind a Customer Detail screen. Every input
--     is reached through an existing (organization_id, customer_id|order_id)
--     index, so the cost is bounded by that customer's own history.
--   * A materialized view or derived table would be a second copy of order,
--     payment and return truth that needs refresh/invalidation, and would
--     have no RLS (a materialized view cannot have any). Not justified at
--     APSA's current scale.
--   * One round trip from the server instead of one per metric (no N+1).
--
-- WHAT COUNTS (the full definitions are in src/server/customers/insights.ts)
--   * Committed commerce = orders.lifecycle_status IN ('confirmed','completed')
--     — exactly Analytics' QUALIFYING_LIFECYCLE_STATUSES. Draft orders are not
--     sales yet and are ignored. Cancelled orders are COUNTED (cancelled_order_count)
--     but contribute nothing else: no money, no products, no delivery/returns.
--   * Money is grouped by orders.currency and NEVER summed across currencies.
--     Received / refunded / net come from order_payment_totals (migration 040),
--     the same ledger Payments, Home and Analytics read.
--   * Product affinity reads the order line SNAPSHOTS (product_name_snapshot,
--     variant_name_snapshot) — never the live catalogue — so an archived or
--     renamed product still shows what the customer actually bought.
--   * Delivery state is the Deliveries domain's own rule: the newest attempt
--     per order (created_at DESC, id DESC).
--   * No conversation or message table is read. Provenance comes only from
--     orders.source and whether orders.source_conversation_ref is set.
--
-- SECTIONS THE CALLER MAY NOT SEE ARE NEVER READ
--   p_include_money / p_include_payments / p_include_delivery /
--   p_include_returns are decided by the server from the caller's resolved
--   grants. A section whose flag is false returns JSON null and its source
--   rows are not loaded at all — withheld, not masked after the fact.
--
-- SECURITY
--   * SECURITY INVOKER: runs with the caller's privileges. The only intended
--     caller is the server (service_role), which already holds SELECT on every
--     relation read here (048 for orders/order_items/payments/payment_events/
--     deliveries/customers, 040 for order_payment_totals, 056 for
--     customer_returns/customer_return_items). No privilege is widened.
--   * Tenant boundary: EVERY relation is filtered on organization_id =
--     p_organization_id, not only reached through a join, and the customer
--     must belong to that organization. A customer id from another
--     organization returns {"customer_found": false} — indistinguishable
--     from one that does not exist.
--   * p_organization_id is derived by the server from the caller's verified
--     active membership (src/api/customers.ts), never from client input.
--   * EXECUTE is revoked from PUBLIC, anon and authenticated and granted only
--     to service_role. No browser session can call it through PostgREST.
--     This migration is safe on its own and does not rely on 061.
--   * Creates no relation, so there is nothing to REVOKE table privileges on.
--
-- INDEXES (none added — every access path already exists)
--   orders              idx_orders_org_customer (023)
--   order_items         idx_order_items_order (023)
--   order_payment_totals filtered on order_id = ANY(this customer's orders)
--   payments            idx_payments_org_order (034)
--   deliveries          idx_deliveries_org_order (027)
--   customer_returns    idx_customer_returns_org_order (056)
--   customer_return_items uniq_customer_return_items_line (return_id, …) (056)
--
-- ROLLBACK
--   Additive. DROP FUNCTION public.customer_purchase_profile_v1(uuid, uuid,
--   boolean, boolean, boolean, boolean, integer); fully reverts it. Without
--   the function the Customer Detail insights section reports "unavailable";
--   nothing else depends on it.

CREATE OR REPLACE FUNCTION public.customer_purchase_profile_v1(
  p_organization_id  uuid,
  p_customer_id      uuid,
  p_include_money    boolean,
  p_include_payments boolean,
  p_include_delivery boolean,
  p_include_returns  boolean,
  p_top_products     integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH customer AS (
    SELECT c.id
    FROM public.customers c
    WHERE c.id = p_customer_id
      AND c.organization_id = p_organization_id
  ),
  customer_orders AS (
    SELECT o.id, o.currency, o.total_minor, o.source, o.source_conversation_ref,
           o.lifecycle_status, o.refund_status, o.created_at
    FROM public.orders o
    JOIN customer ON customer.id = o.customer_id
    WHERE o.organization_id = p_organization_id
      AND o.customer_id = p_customer_id
  ),
  -- Committed commerce: Analytics' QUALIFYING_LIFECYCLE_STATUSES.
  q AS (
    SELECT * FROM customer_orders
    WHERE lifecycle_status IN ('confirmed', 'completed')
  ),
  last_order AS (
    SELECT q.id, q.source, q.created_at
    FROM q
    ORDER BY q.created_at DESC, q.id DESC
    LIMIT 1
  ),
  lines AS (
    SELECT i.id AS line_id, i.order_id, i.product_id, i.variant_id,
           i.product_name_snapshot, i.variant_name_snapshot, i.quantity,
           i.created_at AS line_created_at, q.created_at AS order_created_at
    FROM public.order_items i
    JOIN q ON q.id = i.order_id
    WHERE i.organization_id = p_organization_id
  ),
  product_agg AS (
    SELECT product_id,
           SUM(quantity)::bigint      AS units,
           COUNT(DISTINCT order_id)   AS order_count,
           COUNT(DISTINCT variant_id) AS variant_count,
           MAX(order_created_at)      AS last_purchased_at
    FROM lines
    GROUP BY product_id
  ),
  -- The label is the snapshot on the customer's most recent line for it.
  product_label AS (
    SELECT DISTINCT ON (product_id) product_id, product_name_snapshot
    FROM lines
    ORDER BY product_id, order_created_at DESC, line_created_at DESC, line_id DESC
  ),
  variant_agg AS (
    SELECT DISTINCT ON (product_id, variant_id)
           product_id, variant_id, variant_name_snapshot,
           SUM(quantity) OVER (PARTITION BY product_id, variant_id) AS units,
           MAX(order_created_at) OVER (PARTITION BY product_id, variant_id) AS last_at
    FROM lines
    ORDER BY product_id, variant_id, order_created_at DESC, line_created_at DESC, line_id DESC
  ),
  -- Most-bought variant per product; ties → most recent, then variant id.
  top_variant AS (
    SELECT DISTINCT ON (product_id) product_id, variant_name_snapshot
    FROM variant_agg
    ORDER BY product_id, units DESC, last_at DESC, variant_id ASC
  ),
  -- Stable ranking: units, then orders, then recency, then product id.
  top_products AS (
    SELECT pa.product_id, pl.product_name_snapshot, tv.variant_name_snapshot,
           pa.units, pa.order_count, pa.variant_count, pa.last_purchased_at
    FROM product_agg pa
    JOIN product_label pl USING (product_id)
    JOIN top_variant tv USING (product_id)
    ORDER BY pa.units DESC, pa.order_count DESC, pa.last_purchased_at DESC, pa.product_id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_top_products, 5), 1), 10)
  ),
  last_order_products AS (
    SELECT DISTINCT ON (l.product_id) l.product_id, l.product_name_snapshot,
           l.line_created_at, l.line_id
    FROM lines l
    JOIN last_order lo ON lo.id = l.order_id
    ORDER BY l.product_id, l.line_created_at ASC, l.line_id ASC
  ),
  money AS (
    SELECT q.currency,
           COUNT(*)                                          AS order_count,
           SUM(q.total_minor)::bigint                        AS ordered_minor,
           SUM(t.received_minor)::bigint                     AS received_minor,
           SUM(t.refunded_minor)::bigint                     AS refunded_minor,
           SUM(t.net_minor)::bigint                          AS net_minor,
           SUM(GREATEST(q.total_minor - t.received_minor, 0))::bigint AS outstanding_minor
    FROM q
    JOIN public.order_payment_totals t
      ON t.order_id = q.id AND t.organization_id = p_organization_id
    WHERE p_include_money
      AND t.order_id = ANY (ARRAY(SELECT id FROM q))
    GROUP BY q.currency
  ),
  payment_methods AS (
    SELECT p.method::text AS method, COUNT(DISTINCT p.order_id) AS order_count
    FROM public.payments p
    JOIN q ON q.id = p.order_id
    WHERE p_include_payments
      AND p.organization_id = p_organization_id
      AND p.status NOT IN ('failed', 'reversed')
    GROUP BY p.method
  ),
  attempts AS (
    SELECT d.id, d.order_id, d.status, d.created_at
    FROM public.deliveries d
    JOIN q ON q.id = d.order_id
    WHERE p_include_delivery
      AND d.organization_id = p_organization_id
  ),
  latest_attempt AS (
    SELECT DISTINCT ON (order_id) order_id, status
    FROM attempts
    ORDER BY order_id, created_at DESC, id DESC
  ),
  returns AS (
    SELECT r.id, r.order_id, r.status
    FROM public.customer_returns r
    JOIN q ON q.id = r.order_id
    WHERE p_include_returns
      AND r.organization_id = p_organization_id
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM customer)
    THEN jsonb_build_object('customer_found', false)
    ELSE jsonb_build_object(
      'customer_found', true,
      'activity', (
        SELECT jsonb_build_object(
          'qualifying_order_count', (SELECT COUNT(*) FROM q),
          'confirmed_order_count',  (SELECT COUNT(*) FROM q WHERE lifecycle_status = 'confirmed'),
          'completed_order_count',  (SELECT COUNT(*) FROM q WHERE lifecycle_status = 'completed'),
          'cancelled_order_count',  (SELECT COUNT(*) FROM customer_orders WHERE lifecycle_status = 'cancelled'),
          'refunded_order_count',   (SELECT COUNT(*) FROM q WHERE refund_status <> 'none'),
          'first_order_at',         (SELECT MIN(created_at) FROM q),
          'last_order_at',          (SELECT created_at FROM last_order),
          'last_order_id',          (SELECT id FROM last_order),
          'last_order_source',      (SELECT source::text FROM last_order),
          'distinct_product_count', (SELECT COUNT(*) FROM product_agg),
          'total_units',            (SELECT COALESCE(SUM(units), 0) FROM product_agg),
          'conversation_linked_order_count',
                                    (SELECT COUNT(*) FROM q WHERE source_conversation_ref IS NOT NULL),
          'source_counts', COALESCE(
            (SELECT jsonb_object_agg(s.source, s.n)
             FROM (SELECT source::text AS source, COUNT(*) AS n FROM q GROUP BY source) s),
            '{}'::jsonb)
        )
      ),
      'top_products', COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
            'product_id', tp.product_id,
            'product_label', tp.product_name_snapshot,
            'top_variant_label', tp.variant_name_snapshot,
            'units', tp.units,
            'order_count', tp.order_count,
            'variant_count', tp.variant_count,
            'last_purchased_at', tp.last_purchased_at)
          ORDER BY tp.units DESC, tp.order_count DESC, tp.last_purchased_at DESC, tp.product_id ASC)
         FROM top_products tp),
        '[]'::jsonb),
      'last_order_products', COALESCE(
        (SELECT jsonb_agg(lp.product_name_snapshot ORDER BY lp.line_created_at, lp.line_id)
         FROM last_order_products lp),
        '[]'::jsonb),
      'money', CASE WHEN p_include_money THEN COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
            'currency', m.currency,
            'order_count', m.order_count,
            'ordered_minor', m.ordered_minor,
            'received_minor', m.received_minor,
            'refunded_minor', m.refunded_minor,
            'net_minor', m.net_minor,
            'outstanding_minor', m.outstanding_minor)
          ORDER BY m.currency)
         FROM money m),
        '[]'::jsonb) END,
      'payments', CASE WHEN p_include_payments THEN jsonb_build_object(
        'method_order_counts', COALESCE(
          (SELECT jsonb_object_agg(pm.method, pm.order_count) FROM payment_methods pm),
          '{}'::jsonb)) END,
      'delivery', CASE WHEN p_include_delivery THEN jsonb_build_object(
        'orders_with_delivery', (SELECT COUNT(*) FROM latest_attempt),
        'failed_attempt_count', (SELECT COUNT(*) FROM attempts WHERE status = 'failed'),
        'current_status_counts', COALESCE(
          (SELECT jsonb_object_agg(s.status, s.n)
           FROM (SELECT status::text AS status, COUNT(*) AS n FROM latest_attempt GROUP BY status) s),
          '{}'::jsonb)) END,
      'returns', CASE WHEN p_include_returns THEN jsonb_build_object(
        'return_count',          (SELECT COUNT(*) FROM returns),
        'returned_order_count',  (SELECT COUNT(DISTINCT order_id) FROM returns),
        'completed_return_count',(SELECT COUNT(*) FROM returns WHERE status = 'completed'),
        'completed_returned_units', (
          SELECT COALESCE(SUM(ri.quantity), 0)
          FROM public.customer_return_items ri
          JOIN returns r ON r.id = ri.return_id AND r.status = 'completed'
          WHERE ri.organization_id = p_organization_id)) END
    )
  END
$$;

COMMENT ON FUNCTION public.customer_purchase_profile_v1(uuid, uuid, boolean, boolean, boolean, boolean, integer) IS
  'Customer Intelligence V1: one customer''s purchase profile derived on read from orders, order_items, order_payment_totals, payments, deliveries and customer_returns. Organization-scoped; money per currency, never converted; no message content. Server (service_role) use only.';

REVOKE ALL ON FUNCTION public.customer_purchase_profile_v1(uuid, uuid, boolean, boolean, boolean, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_purchase_profile_v1(uuid, uuid, boolean, boolean, boolean, boolean, integer)
  TO service_role;
