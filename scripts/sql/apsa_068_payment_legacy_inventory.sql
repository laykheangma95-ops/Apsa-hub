-- =============================================================================
-- APSA — LEGACY PAYMENT INVENTORY FOR MIGRATION 068  (read-only, owner-run)
--
-- Target migration : supabase/migrations/068_payment_lifecycle_guard.sql
--                    (number PROVISIONAL; draft pending the owner's policy)
--
-- RUN ONLY against the confirmed STAGING project, as role postgres, BEFORE 068
-- is applied there. It is not a gate by itself: its result is reviewed with
-- the owner (docs/proposals/PAYMENT_LIFECYCLE_POLICY.md §6) before any
-- decision to apply 068.
--
-- WHAT IT DOES
--   One READ ONLY, REPEATABLE READ transaction with bounded timeouts, a single
--   SELECT, then ROLLBACK. It writes nothing, creates nothing (no temp tables)
--   and calls no payment function.
--
-- WHAT IT RETURNS — aggregates only:
--   check_id | category | currency | organizations | orders | payments |
--   amount_minor | meaning
--   Counts, and amounts summed per currency in integer minor units. It returns
--   no order, payment, customer, organization or member identifier, no
--   reference, note, name or phone — nothing that identifies a customer or a
--   sale. A category with nothing to report returns one row with zero counts,
--   so an absent row is never mistaken for "none".
--
-- HOW TO RUN
--   psql -X -q -v ON_ERROR_STOP=1 --csv -f scripts/sql/apsa_068_payment_legacy_inventory.sql \
--        -o <outside-repo>/inventory-068.csv
--   Supply the connection through the environment (PGHOST, PGUSER, a service
--   file or .pgpass), never on the command line. The run is valid only with
--   exit status 0 and a 99.01 row. Supabase SQL Editor's "Success" is not a
--   result: it may show only the final ROLLBACK.
--
-- DEFINITIONS — the same as migration 068:
--   received  order_payment_totals.received_minor (principal of paid /
--             refunded payments; only already-refunded amounts of reversed /
--             failed ones)
--   pending   principal of payments with status 'pending' (COD and
--             duplicate_suspected included)
--   claimed   received + pending
-- =============================================================================

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

WITH
pay AS (
  SELECT p.id, p.organization_id, p.order_id, p.status::text AS status, p.amount_minor,
    o.lifecycle_status::text AS lifecycle, o.currency, o.total_minor,
    COALESCE((SELECT SUM(e.amount_minor) FROM public.payment_events e
      WHERE e.payment_id = p.id AND e.organization_id = p.organization_id
        AND e.event_type = 'refund'), 0) AS refunded
  FROM public.payments p
  JOIN public.orders o ON o.id = p.order_id AND o.organization_id = p.organization_id
),
ord AS (
  SELECT t.order_id, t.organization_id, t.currency, t.total_minor, t.received_minor,
    t.net_minor, o.lifecycle_status::text AS lifecycle,
    COALESCE((SELECT SUM(p.amount_minor) FROM public.payments p
      WHERE p.order_id = t.order_id AND p.organization_id = t.organization_id
        AND p.status = 'pending'), 0) AS pending_minor
  FROM public.order_payment_totals t
  JOIN public.orders o ON o.id = t.order_id AND o.organization_id = t.organization_id
),
-- 068's verify rule, per claim:
--   pending → paid    confirmed; received + principal > total (or a draft) creates an excess
--   failed → pending  refused when received + other pending + principal − refunded > total
judged AS (
  SELECT pa.*, od.received_minor,
    od.pending_minor - CASE WHEN pa.status = 'pending' THEN pa.amount_minor ELSE 0 END
      AS other_pending
  FROM pay pa JOIN ord od ON od.order_id = pa.order_id AND od.organization_id = pa.organization_id
  WHERE pa.status IN ('pending', 'failed')
),
findings (check_id, category, currency, organizations, orders, payments, amount_minor, meaning) AS (
  -- 1. Pending claims on terminal orders
  SELECT '01.01', 'pending_claim_on_cancelled_order', currency,
    COUNT(DISTINCT organization_id), COUNT(DISTINCT order_id), COUNT(*), SUM(amount_minor),
    'Recorded, never confirmed or rejected, on a cancelled order. 068 still lets it be confirmed (to refund) or rejected/reversed.'
  FROM pay WHERE status = 'pending' AND lifecycle = 'cancelled' GROUP BY currency
  UNION ALL
  SELECT '01.02', 'pending_claim_on_completed_order', currency,
    COUNT(DISTINCT organization_id), COUNT(DISTINCT order_id), COUNT(*), SUM(amount_minor),
    'Recorded, never confirmed or rejected, on an already-completed (paid) order.'
  FROM pay WHERE status = 'pending' AND lifecycle = 'completed' GROUP BY currency
  UNION ALL
  SELECT '01.03', 'settled_net_on_cancelled_order', currency,
    COUNT(DISTINCT organization_id), COUNT(*), NULL::bigint, SUM(net_minor),
    'Cancelled orders still holding received money (net > 0); amount = net held. Needs a refund decision (left open by migration 063).'
  FROM ord WHERE lifecycle = 'cancelled' AND net_minor > 0 GROUP BY currency
  -- 2. Amounts above order totals
  UNION ALL
  SELECT '02.01', 'settled_above_total', currency,
    COUNT(DISTINCT organization_id), COUNT(*), NULL::bigint, SUM(received_minor - total_minor),
    'Orders whose received amount exceeds the total; amount = sum of the excess.'
  FROM ord WHERE received_minor > total_minor GROUP BY currency
  UNION ALL
  SELECT '02.02', 'claimed_above_total', currency,
    COUNT(DISTINCT organization_id), COUNT(*), NULL::bigint,
    SUM(received_minor + pending_minor - total_minor),
    'Orders whose received + pending claims exceed the total; amount = sum of the excess. 068 refuses any new claim on them.'
  FROM ord WHERE received_minor + pending_minor > total_minor GROUP BY currency
  UNION ALL
  SELECT '02.03', 'net_above_total_reconciliation_overpaid', currency,
    COUNT(DISTINCT organization_id), COUNT(*), NULL::bigint, SUM(net_minor - total_minor),
    'Orders the reconciliation screen already flags overpaid (net > total); for comparison with 02.01.'
  FROM ord WHERE net_minor > total_minor GROUP BY currency
  -- 3. Draft orders with payment claims
  UNION ALL
  SELECT '03.0' || CASE status WHEN 'pending' THEN '1' WHEN 'paid' THEN '2' ELSE '3' END,
    'draft_order_payment_' || status, currency,
    COUNT(DISTINCT organization_id), COUNT(DISTINCT order_id), COUNT(*), SUM(amount_minor),
    'Payments on an order that was never confirmed, by payment status.'
  FROM pay WHERE lifecycle = 'draft' AND status IN ('pending', 'paid', 'refunded')
  GROUP BY status, currency
  -- 4. Claims 068 would refuse to confirm (or to reinstate)
  UNION ALL
  SELECT '04.01', 'pending_claim_confirmation_creates_excess', currency,
    COUNT(DISTINCT organization_id), COUNT(DISTINCT order_id), COUNT(*), SUM(amount_minor),
    'Pending claims whose confirmation would take received above the total (or that sit on a draft). 068 still confirms them, stamps the excess on the confirmation event and leaves the order flagged overpaid until the excess is rejected (mismatch/reverse) or refunded.'
  FROM judged
  WHERE status = 'pending' AND (lifecycle = 'draft' OR received_minor + amount_minor > total_minor)
  GROUP BY currency
  UNION ALL
  SELECT '04.02', 'rejected_claim_068_refuses_to_reinstate', currency,
    COUNT(DISTINCT organization_id), COUNT(DISTINCT order_id), COUNT(*), SUM(amount_minor),
    'Rejected (mismatch / failed) claims that 068 refuses to move back to pending.'
  FROM judged
  WHERE status = 'failed'
    AND (lifecycle = 'draft'
      OR received_minor + other_pending - refunded + amount_minor > total_minor)
  GROUP BY currency
  -- 9. Context
  UNION ALL
  SELECT '09.01', 'context_payments_by_currency', currency,
    COUNT(DISTINCT organization_id), COUNT(DISTINCT order_id), COUNT(*), SUM(amount_minor),
    'All payments, any status (context for the rows above).'
  FROM pay GROUP BY currency
),
expected (check_id, category) AS (
  VALUES ('01.01', 'pending_claim_on_cancelled_order'),
         ('01.02', 'pending_claim_on_completed_order'),
         ('01.03', 'settled_net_on_cancelled_order'),
         ('02.01', 'settled_above_total'),
         ('02.02', 'claimed_above_total'),
         ('02.03', 'net_above_total_reconciliation_overpaid'),
         ('03.01', 'draft_order_payment_pending'),
         ('03.02', 'draft_order_payment_paid'),
         ('03.03', 'draft_order_payment_refunded'),
         ('04.01', 'pending_claim_confirmation_creates_excess'),
         ('04.02', 'rejected_claim_068_refuses_to_reinstate'),
         ('09.01', 'context_payments_by_currency')
),
report AS (
  SELECT check_id, category, currency, organizations, orders, payments, amount_minor, meaning
  FROM findings
  UNION ALL
  -- An explicit zero row for every category with no finding.
  SELECT x.check_id, x.category, NULL, 0, 0, 0, 0, 'none'
  FROM expected x WHERE NOT EXISTS (SELECT 1 FROM findings f WHERE f.check_id = x.check_id)
  UNION ALL
  SELECT '99.01', 'summary', NULL,
    NULL, NULL, NULL,
    (SELECT COUNT(*) FROM findings WHERE check_id BETWEEN '01' AND '05'),
    CASE WHEN to_regprocedure('public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)') IS NULL
      THEN 'STOP: migration 062 is not applied; 068 cannot be applied.'
    WHEN (SELECT prosrc FROM pg_proc WHERE oid =
        to_regprocedure('public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)'))
        LIKE '%order_not_payable%'
      THEN 'NOTE: 068 already appears applied; this inventory then describes residual legacy data.'
    WHEN (SELECT COUNT(*) FROM findings WHERE check_id BETWEEN '01' AND '05') = 0
      THEN 'CLEAN: no legacy state that 068 changes the handling of.'
    ELSE 'REVIEW: legacy states present; amount_minor here = number of non-empty finding rows. Review each with the owner before applying 068.'
    END
)
SELECT * FROM report ORDER BY check_id, currency NULLS FIRST;

ROLLBACK;
