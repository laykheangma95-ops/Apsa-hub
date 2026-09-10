-- Migration: 039_payment_order_integration
-- Purpose: Make the Payment Domain (migrations 034–036) the SOLE authoritative
--          driver of orders.payment_status, atomically — the same pattern
--          migration 026 used to wire Inventory into Order.
-- Function: sync_order_payment_status_v1 (NEW). Called from inside
--           record_payment_v1, verify_payment_v1, reverse_payment_v1 and
--           refund_payment_v1 (all CREATE OR REPLACE — signatures unchanged,
--           so no TypeScript caller changes). correct_payment_v1 and
--           attach_payment_evidence_v1 are untouched: neither one ever moves
--           `status`, so neither has an Order consequence (SECURITY.md §41 —
--           evidence is never financial authority).
--
-- This migration adds ONE new function and replaces the bodies of four
-- existing ones. It adds no table, no column and no enum value.
--
-- ── WHY THIS WAS DELIBERATELY DEFERRED UNTIL NOW ─────────────────────────────
--
-- supabase/PAYMENTS.md §1 (written with migrations 034–036) already commits to
-- this exact design: "Making this Payment domain the authoritative driver of
-- orders.payment_status is explicitly the next phase's work, and it must be
-- wired the same way migration 026 wired Inventory into Order: as one atomic
-- RPC-level change inside transition_order_status_v1, never as two sequential
-- service calls that could crash between them." This migration is that phase.
--
-- ── WHY THE INTEGRATION LIVES IN SQL, NOT IN src/server/payments/service.ts ──
--
-- supabase-js has no client-side transaction. If a TypeScript service method
-- called `verifyPayment()` and then separately called
-- `transitionPaymentStatus()` on the Order domain, a crash between the two
-- calls would leave exactly the failure mode this phase exists to prevent:
-- "Payment recorded but Order unpaid" or "Order paid but no authoritative
-- Payment exists" (task brief). Because both the payment write and the order
-- write happen inside ONE plpgsql function body, they commit or roll back
-- together — there is no window where one exists without the other.
--
-- This is also why src/server/payments/service.ts and repository.ts remain
-- completely unmodified by this migration and still contain no import of
-- @/server/orders and no call to transitionPaymentStatus()/
-- transitionOrderPaymentFn() — the existing structural test asserting that
-- (src/tests/payment-domain.test.ts, "Test 25") stays true. The bridge is a
-- database function calling another database function, not a TypeScript
-- service calling another TypeScript service.
--
-- ── THE SETTLEMENT RULE: AN AMOUNT, NOT A FLAG ───────────────────────────────
--
-- orders.payment_status (migration 023) is deliberately COARSE — only
-- unpaid/pending/paid/failed, no 'partially_paid' or 'overpaid' state of its
-- own. Coarse does NOT mean approximate: whether an order is paid is an
-- AMOUNT question, answered by comparing money that actually settled against
-- the order's own authoritative total.
--
--   NET SETTLED = settled payment amounts - refunds - reversals
--
-- computed in integer minor units over ALL of that order's payments, in the
-- order's own currency, recomputed fresh on every payment mutation — never a
-- value copied from "the payment that just changed":
--
--   net > 0 AND net >= orders.total_minor  -> 'paid'    (exact, or overpaid)
--   net > 0 AND net <  orders.total_minor  -> 'pending' (PARTIAL — never paid)
--   net = 0 AND a pending payment exists    -> 'pending'
--   net = 0 AND only failed payments exist  -> 'failed'
--   otherwise                                -> 'unpaid'
--
-- What counts toward NET SETTLED:
--   status 'paid'      counts, MINUS whatever has since been refunded
--   status 'refunded'  same arithmetic, which is exactly 0 by construction
--   status 'pending'   counts 0 — a claim, not money. This is what keeps an
--                      unverified record, a screenshot-backed record and an
--                      unsettled COD collection out of the settled total
--                      (SECURITY.md §41 — evidence is never authority)
--   status 'failed'    counts 0 — the claim was found not to hold up
--   status 'reversed'  counts 0 — the entire claim was voided
--
-- The `net > 0` guard matters for a zero-total order: without it an order
-- with no payments at all would satisfy `0 >= 0` and be reported paid.
--
-- WHY THIS IS NOT "ANY PAYMENT IS PAID -> ORDER IS PAID"
--   An earlier draft of this migration derived the order's status from the
--   EXISTENCE of a settled payment row. That is a financial-integrity bug: a
--   $10 settled payment against a $100 order would have marked the order
--   fully paid, and a $20 partial refund of a fully-paid $100 order would not
--   have un-paid it. Settlement is an amount, so this function sums amounts.
--
-- CURRENCY SAFETY
--   Only payments denominated in the ORDER's currency are summed. Two
--   currencies are never added together and no exchange rate is ever invented
--   (ARCHITECTURE.md). record_payment_v1 copies the order's currency onto
--   every payment it creates, so a mismatch cannot occur through the only
--   write path that exists — filtering here makes that structural rather than
--   assumed. Every value is BIGINT: integer minor units, integer comparisons,
--   no NUMERIC, no float, no rounding anywhere in this file.
--
-- OVERPAYMENT (net > total)
--   The coarse axis stays 'paid' — the order genuinely is covered — and this
--   migration deliberately adds NO new order_payment_status enum value. The
--   excess is preserved, not discarded, in three places: this function's
--   return envelope (over_settled_minor / settlement_state / needs_review),
--   the order_status_history.reason text it writes at the moment it happens,
--   and the order_payment_settlement view below, which is a LIVE derivation
--   over immutable data (payments + payment_events + the order total) and so
--   can never go stale or be lost — the same "never a cache" philosophy as
--   inventory_stock (021) and payment_reconciliation_summary (034).
--
-- Refund/reversal history is likewise never lost: the detailed truth — which
-- payment, how much, refunded when, by whom, why — remains fully visible in
-- payments/payment_events. This function only ever writes the coarse summary
-- the Order axis was designed to hold.
--
-- THE RULE IS SPECIFIED ONCE, IN TYPESCRIPT
--   src/server/payments/settlement.ts is the pure, exhaustively tested
--   statement of this same rule — exactly the division of labour
--   state-machine.ts already has with verify_payment_v1. This function is how
--   the rule gets applied ATOMICALLY; that module is what the rule IS.
--   Structural tests assert the two agree.
--
-- ── WHY 'paid' NEEDED NEW EXIT EDGES ──────────────────────────────────────────
--
-- src/server/orders/state-machine.ts previously modelled 'paid' as terminal
-- ("`paid` is terminal only because refunds do not exist yet... it gains
-- exits to `refunded`/`partially_refunded`" once they did). Since the Order
-- axis stays coarse rather than gaining those states, the exits are instead
-- to pending/failed/unpaid, added by this phase to PAYMENT_TRANSITIONS
-- (src/server/orders/state-machine.ts) so the TypeScript description of the
-- axis matches what this migration can now legitimately produce. Note that
-- transition_order_status_v1 (migration 026) itself never enforced that
-- transition table — it only checks optimistic concurrency
-- (p_expected_from) and the terminal-LIFECYCLE freeze — so no SQL change to
-- that function was needed to allow the new edges; only the TypeScript
-- description and the tests asserting it needed updating.
--
-- ── WHO MAY REACH orders.payment_status NOW ──────────────────────────────────
--
-- Exactly one path exists after this migration: record_payment_v1 /
-- verify_payment_v1 / reverse_payment_v1 / refund_payment_v1, called only by
-- src/server/payments/service.ts using the service role, gated by the
-- `payments.*` permissions (migration 036). The Order domain's own
-- src/server/orders/service.ts#transitionPaymentStatus — previously a second,
-- independent way to move this same column, gated only by `payments.confirm`,
-- with no payment record required at all — is closed by this phase (see the
-- companion TypeScript change): it now unconditionally refuses, regardless of
-- target, with a message pointing at the Payment Domain. That closes exactly
-- the gap the task brief's "PAYMENT ↔ ORDER AUTHORITY" section describes:
-- "Order.paymentStatus must never be changed directly by... generic Order
-- update. Only Payment Domain may produce financial state changes." POS,
-- Conversation and Delivery never called that function in the first place
-- (see their own structural tests) and remain unaffected.
--
-- ── ATOMICITY & LOCKING ───────────────────────────────────────────────────────
--
-- sync_order_payment_status_v1 takes `SELECT ... FOR UPDATE` on the order row
-- itself before deciding anything, so two concurrent payment mutations
-- against the same order serialize on this function exactly as two
-- concurrent order confirmations serialize inside transition_order_status_v1.
-- It then calls transition_order_status_v1 (which takes the SAME row lock
-- again) — safe: a Postgres transaction never blocks on a row lock it
-- already holds. Because this function itself is invoked from inside
-- record/verify/reverse/refund_payment_v1's own transaction, the payments
-- write, the payment_events write, and the orders write are one atomic unit
-- — there is no "record the payment, then separately sync the order" window.
--
-- ── TENANT ISOLATION ─────────────────────────────────────────────────────────
--
-- p_organization_id is threaded through from the same verified-membership
-- value every calling RPC already receives (never from a client). The order
-- lookup is WHERE id = p_order_id AND organization_id = p_organization_id, so
-- a payment somehow associated with a foreign order (already prevented by
-- record_payment_v1's own order lookup) could never cause this function to
-- touch another tenant's order even if it were reachable. The aggregate
-- EXISTS queries below are likewise organization_id-scoped.
--
-- ── ERROR CONVENTION ──────────────────────────────────────────────────────────
--
-- This is a CONSEQUENCE, not the caller's primary outcome. It never RAISEs
-- for an ordinary business outcome — a 'terminal' result from
-- transition_order_status_v1 (order lifecycle cancelled/completed) or a
-- theoretically-unreachable 'order_not_found' are both swallowed as no-ops
-- so that a payment record/verify/reverse/refund never fails because of what
-- it implies for the order's coarse status display.

CREATE OR REPLACE FUNCTION public.sync_order_payment_status_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_actor           UUID,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order        RECORD;
  v_net_settled  BIGINT  := 0;
  v_has_pending  BOOLEAN := false;
  v_has_failed   BOOLEAN := false;
  v_outstanding  BIGINT;
  v_over_settled BIGINT;
  v_state        TEXT;
  v_target       public.order_payment_status;
  v_reason       TEXT;
  v_facts        JSONB;
  v_result       JSONB;
BEGIN
  -- The lock comes FIRST, before the settlement aggregate below, and that
  -- ordering is load-bearing under concurrency. Two payment mutations against
  -- the same order serialize here; because the aggregate is a SEPARATE
  -- statement executed only after this lock is granted, READ COMMITTED gives
  -- it a fresh snapshot that already includes whatever the transaction we
  -- waited for committed. Aggregating before locking would let two concurrent
  -- settlements each miss the other's payment and both write a stale total.
  SELECT lifecycle_status, payment_status, total_minor, currency INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Unreachable in practice: every caller already proved the order exists
    -- for this org before recording/verifying/reversing/refunding a payment
    -- against it. A no-op rather than a RAISE, so this consequence can never
    -- fail the payment mutation that triggered it.
    RETURN jsonb_build_object('status', 'order_not_found');
  END IF;

  -- NET SETTLED = settled amounts - refunds - reversals, in ONE scan, in
  -- integer minor units, in the order's own currency only. See this
  -- migration's header for what each payment status contributes and why.
  SELECT
    COALESCE(SUM(
      CASE
        WHEN p.status IN ('paid', 'refunded')
          THEN GREATEST(p.amount_minor - COALESCE(r.refunded_minor, 0), 0)
        ELSE 0
      END
    ), 0),
    COALESCE(bool_or(p.status = 'pending'), false),
    COALESCE(bool_or(p.status = 'failed'), false)
  INTO v_net_settled, v_has_pending, v_has_failed
  FROM public.payments p
  LEFT JOIN LATERAL (
    -- Refunds are DERIVED by summing this payment's own append-only 'refund'
    -- events (migration 035 / DATA_MODEL.md §53) — payments.amount_minor is
    -- never mutated, so the original claim stays visible after any refund.
    SELECT SUM(e.amount_minor) AS refunded_minor
    FROM public.payment_events e
    WHERE e.payment_id = p.id
      AND e.organization_id = p.organization_id
      AND e.event_type = 'refund'
  ) r ON true
  WHERE p.order_id = p_order_id
    AND p.organization_id = p_organization_id
    AND p.currency = v_order.currency;

  v_outstanding  := GREATEST(v_order.total_minor - v_net_settled, 0);
  v_over_settled := GREATEST(v_net_settled - v_order.total_minor, 0);

  v_state := CASE
    WHEN v_net_settled = 0                   THEN 'unsettled'
    WHEN v_net_settled < v_order.total_minor THEN 'partial'
    WHEN v_net_settled = v_order.total_minor THEN 'settled'
    ELSE                                          'overpaid'
  END;

  IF v_net_settled > 0 AND v_net_settled >= v_order.total_minor THEN
    v_target := 'paid';
  ELSIF v_net_settled > 0 OR v_has_pending THEN
    -- PARTIALLY settled money and an in-flight claim both land here. The
    -- coarse axis has no 'partially_paid' value; what matters financially is
    -- that neither is 'paid'.
    v_target := 'pending';
  ELSIF v_has_failed THEN
    v_target := 'failed';
  ELSE
    v_target := 'unpaid';
  END IF;

  -- Returned on every path, changed or not, so an overpayment discovered on
  -- an order that was ALREADY 'paid' still reaches the caller rather than
  -- being swallowed by a no-op. The same facts are independently derivable at
  -- any later time from public.order_payment_settlement below.
  v_facts := jsonb_build_object(
    'currency',           v_order.currency,
    'order_total_minor',  v_order.total_minor,
    'net_settled_minor',  v_net_settled,
    'outstanding_minor',  v_outstanding,
    'over_settled_minor', v_over_settled,
    'settlement_state',   v_state,
    'needs_review',       v_state = 'overpaid'
  );

  IF v_order.payment_status = v_target THEN
    RETURN jsonb_build_object('status', 'no_change', 'current', v_order.payment_status::TEXT)
           || v_facts;
  END IF;

  -- The settlement figures are stamped into the immutable history row itself,
  -- so "why did this order become paid / stop being paid" is answerable from
  -- order_status_history alone, at the moment it happened.
  v_reason := COALESCE(NULLIF(trim(p_reason), ''), 'Payment settlement recomputed')
    || format(' [settled %s of %s %s; %s]',
              v_net_settled, v_order.total_minor, v_order.currency, v_state);

  -- transition_order_status_v1 reused exactly as-is. v_order.payment_status is
  -- safe to pass as p_expected_from because this function already holds the
  -- order row's lock for the rest of the transaction — nothing else could have
  -- changed it since. Its own terminal-lifecycle freeze (cancelled/completed)
  -- applies here as on every other axis: the order's displayed payment status
  -- stays frozen once the order itself is done, and this call simply returns
  -- 'terminal' rather than raising.
  v_result := public.transition_order_status_v1(
    p_organization_id, p_order_id, 'payment',
    v_order.payment_status::TEXT, v_target::TEXT,
    p_actor, v_reason
  );

  RETURN v_result || v_facts;
END;
$$;

COMMENT ON FUNCTION public.sync_order_payment_status_v1(UUID, UUID, UUID, TEXT) IS
  'Recomputes orders.payment_status from NET SETTLED AMOUNT (settled payment amounts minus refunds and reversals, integer minor units, order currency only) compared against orders.total_minor, and applies it via transition_order_status_v1, atomically. Partial settlement is never ''paid''. Overpayment stays coarse-''paid'' and is preserved in the return envelope, the history reason and public.order_payment_settlement. Called only from inside record_payment_v1/verify_payment_v1/reverse_payment_v1/refund_payment_v1 — never from TypeScript, and not independently reachable by any client.';

REVOKE EXECUTE ON FUNCTION public.sync_order_payment_status_v1(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_order_payment_status_v1(UUID, UUID, UUID, TEXT)
  TO service_role;

-- ── order_payment_settlement: live derived settlement truth ──────────────────
--
-- Where the finer-than-coarse facts live: how much of each order has actually
-- settled, what is still outstanding, and — critically — how much MORE than
-- the order total has arrived. The coarse orders.payment_status cannot express
-- 'partial' or 'overpaid' (and this migration deliberately does not add enum
-- values to it), so those states are preserved here instead of being lost.
--
-- Never a cache, never a maintained balance: recomputed from the same
-- immutable sources the sync function uses (payments + their append-only
-- refund events + the order's own DB-constrained total), so it cannot drift
-- from reality or need backfilling — the same philosophy as inventory_stock
-- (migration 021) and payment_reconciliation_summary (migration 034).
--
-- security_invoker = true: the view enforces the RLS of orders and payments
-- for whichever role queries it, which is "nobody but service_role" — the
-- same posture as its base tables. The REVOKE below is the second gate.

CREATE OR REPLACE VIEW public.order_payment_settlement
WITH (security_invoker = true) AS
SELECT
  o.id                AS order_id,
  o.organization_id,
  o.currency,
  o.total_minor       AS order_total_minor,
  s.net_settled_minor,
  GREATEST(o.total_minor - s.net_settled_minor, 0)::BIGINT AS outstanding_minor,
  GREATEST(s.net_settled_minor - o.total_minor, 0)::BIGINT AS over_settled_minor,
  s.has_pending_payment,
  s.has_failed_payment,
  CASE
    WHEN s.net_settled_minor = 0              THEN 'unsettled'
    WHEN s.net_settled_minor < o.total_minor  THEN 'partial'
    WHEN s.net_settled_minor = o.total_minor  THEN 'settled'
    ELSE                                           'overpaid'
  END                 AS settlement_state,
  o.payment_status    AS order_payment_status
FROM public.orders o
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(
      CASE
        WHEN p.status IN ('paid', 'refunded')
          THEN GREATEST(p.amount_minor - COALESCE(r.refunded_minor, 0), 0)
        ELSE 0
      END
    ), 0)::BIGINT                                  AS net_settled_minor,
    COALESCE(bool_or(p.status = 'pending'), false) AS has_pending_payment,
    COALESCE(bool_or(p.status = 'failed'), false)  AS has_failed_payment
  FROM public.payments p
  LEFT JOIN LATERAL (
    SELECT SUM(e.amount_minor) AS refunded_minor
    FROM public.payment_events e
    WHERE e.payment_id = p.id
      AND e.organization_id = p.organization_id
      AND e.event_type = 'refund'
  ) r ON true
  WHERE p.order_id = o.id
    AND p.organization_id = o.organization_id
    AND p.currency = o.currency
) s;

COMMENT ON VIEW public.order_payment_settlement IS
  'Live per-order settlement truth: order total, net settled (settled amounts minus refunds/reversals, order currency only), outstanding, over-settled, and settlement_state (unsettled/partial/settled/overpaid). Not a cache — always recomputed. This is where partial and overpaid settlement are preserved, since orders.payment_status is deliberately coarse. See src/server/payments/settlement.ts for the same rule stated in TypeScript.';

REVOKE ALL ON public.order_payment_settlement FROM anon, authenticated;

-- ── record_payment_v1 (CREATE OR REPLACE — adds the ORDER CONSEQUENCE only) ──
--
-- A newly recorded payment always starts status='pending' (migration 035's
-- header: never 'paid' at creation), so this can only ever move the order
-- from unpaid/failed to pending, or leave it exactly where it already is.

CREATE OR REPLACE FUNCTION public.record_payment_v1(
  p_organization_id UUID,
  p_order_id        UUID,
  p_recorded_by     UUID,
  p_method          TEXT,
  p_amount_minor    BIGINT,
  p_reference       TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_note            TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_order           RECORD;
  v_payment_id      UUID;
  v_reference       TEXT := NULLIF(trim(p_reference), '');
  v_idempotency_key TEXT := NULLIF(trim(p_idempotency_key), '');
  v_duplicate       BOOLEAN := false;
  v_initial_state   public.payment_verification_state;
  v_lock_key        BIGINT;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'record_payment_v1: organization_id is required';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;

  IF p_method NOT IN ('cash', 'khqr', 'bank_transfer', 'cod') THEN
    RETURN jsonb_build_object('status', 'invalid_method');
  END IF;

  SELECT id, currency INTO v_order
  FROM public.orders
  WHERE id = p_order_id AND organization_id = p_organization_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'order_not_found');
  END IF;

  IF v_reference IS NOT NULL THEN
    v_lock_key := hashtext(p_organization_id::TEXT || ':' || v_reference);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT EXISTS (
      SELECT 1 FROM public.payments
      WHERE organization_id = p_organization_id
        AND reference = v_reference
        AND status <> 'reversed'
    ) INTO v_duplicate;
  END IF;

  v_initial_state := CASE WHEN v_duplicate THEN 'duplicate_suspected' ELSE 'unverified' END;

  INSERT INTO public.payments (
    organization_id, order_id, method, currency, amount_minor,
    status, verification_state, reference, idempotency_key, note, recorded_by
  ) VALUES (
    p_organization_id, p_order_id, p_method::public.payment_method, v_order.currency, p_amount_minor,
    'pending', v_initial_state, v_reference, v_idempotency_key, NULLIF(trim(p_note), ''), p_recorded_by
  )
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_payment_id;

  IF v_payment_id IS NULL THEN
    -- A concurrent call with the same idempotency key won the race. Return
    -- its result rather than creating a second financial record.
    SELECT id INTO v_payment_id
    FROM public.payments
    WHERE organization_id = p_organization_id AND idempotency_key = v_idempotency_key;

    -- ORDER CONSEQUENCE (replay path): nothing new was recorded by THIS
    -- call, but the aggregate is recomputed anyway — a no-op in the normal
    -- case, and safe/idempotent if something else changed the order's
    -- payment axis out of band since the winning call.
    PERFORM public.sync_order_payment_status_v1(
      p_organization_id, p_order_id, p_recorded_by, 'Payment recorded (replayed)'
    );

    RETURN jsonb_build_object(
      'status', 'success', 'payment_id', v_payment_id, 'replayed', true, 'duplicate_suspected', false
    );
  END IF;

  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, amount_minor, currency,
    to_verification, actor_user_id, reason
  ) VALUES (
    p_organization_id, v_payment_id, 'created', p_amount_minor, v_order.currency,
    v_initial_state, p_recorded_by, p_note
  );

  IF v_duplicate THEN
    INSERT INTO public.payment_events (
      organization_id, payment_id, event_type, actor_user_id, reason, metadata
    ) VALUES (
      p_organization_id, v_payment_id, 'duplicate_flagged', p_recorded_by,
      'Reference matches another active payment in this organization',
      jsonb_build_object('reference', v_reference)
    );
  END IF;

  -- ORDER CONSEQUENCE. A newly recorded payment is always 'pending', so it
  -- adds NOTHING to net settled — it can only move an unpaid/failed order to
  -- 'pending'. See sync_order_payment_status_v1 for the settlement rule.
  PERFORM public.sync_order_payment_status_v1(
    p_organization_id, p_order_id, p_recorded_by, 'Payment recorded'
  );

  RETURN jsonb_build_object(
    'status', 'success', 'payment_id', v_payment_id,
    'duplicate_suspected', v_duplicate, 'replayed', false
  );
END;
$$;

-- ── verify_payment_v1 (CREATE OR REPLACE — adds the ORDER CONSEQUENCE only) ──
--
-- The ONLY code path (with reverse/refund below) that can move
-- orders.payment_status to 'paid' anywhere in APSA — and only ever by moving
-- this payment's own status to 'paid' and letting the settlement rule in
-- sync_order_payment_status_v1 decide whether the resulting NET SETTLED
-- amount actually covers the order total. It never writes 'paid' directly,
-- and verifying a payment that covers only part of the order does NOT make
-- the order paid.

CREATE OR REPLACE FUNCTION public.verify_payment_v1(
  p_organization_id UUID,
  p_payment_id      UUID,
  p_actor           UUID,
  p_expected_from   TEXT,
  p_to              TEXT,
  p_reason          TEXT DEFAULT NULL,
  p_metadata        JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_payment    RECORD;
  v_new_status public.payment_status;
  v_event_type public.payment_event_type;
BEGIN
  SELECT id, order_id, status, verification_state INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_payment.verification_state::TEXT <> p_expected_from THEN
    RETURN jsonb_build_object('status', 'stale', 'current', v_payment.verification_state::TEXT);
  END IF;

  IF v_payment.status IN ('reversed', 'refunded') THEN
    RETURN jsonb_build_object('status', 'terminal', 'current', v_payment.status::TEXT);
  END IF;

  v_new_status := CASE p_to
    WHEN 'staff_confirmed'   THEN 'paid'
    WHEN 'manager_verified'  THEN 'paid'
    WHEN 'bank_verified'     THEN 'paid'
    WHEN 'mismatch'          THEN 'failed'
    WHEN 'unverified'        THEN 'pending'
    ELSE NULL
  END;

  IF v_new_status IS NULL THEN
    RAISE EXCEPTION 'verify_payment_v1: unknown target verification state %', p_to;
  END IF;

  v_event_type := CASE p_to
    WHEN 'staff_confirmed'  THEN 'staff_confirmed'
    WHEN 'manager_verified' THEN 'manager_verified'
    WHEN 'bank_verified'    THEN 'bank_verified'
    WHEN 'mismatch'         THEN 'verification_failed'
    ELSE 'correction'
  END;

  UPDATE public.payments
  SET status = v_new_status, verification_state = p_to::public.payment_verification_state
  WHERE id = p_payment_id;

  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, from_verification, to_verification,
    actor_user_id, reason, metadata
  ) VALUES (
    p_organization_id, p_payment_id, v_event_type,
    p_expected_from::public.payment_verification_state, p_to::public.payment_verification_state,
    p_actor, p_reason, p_metadata
  );

  -- ORDER CONSEQUENCE. This payment's money now counts toward (or, on a
  -- 'mismatch', stops counting toward) NET SETTLED; whether that makes the
  -- order 'paid' depends entirely on whether the net total covers
  -- orders.total_minor. Verifying a deposit that covers half the order leaves
  -- the order 'pending', and a mismatch on one payment cannot un-pay an order
  -- that other payments still fully cover — see that function's rule.
  PERFORM public.sync_order_payment_status_v1(
    p_organization_id, v_payment.order_id, p_actor,
    format('Payment %s verification: %s -> %s', p_payment_id, p_expected_from, p_to)
  );

  RETURN jsonb_build_object(
    'status', 'success', 'from', p_expected_from, 'to', p_to, 'payment_status', v_new_status::TEXT
  );
END;
$$;

-- ── reverse_payment_v1 (CREATE OR REPLACE — adds the ORDER CONSEQUENCE only) ─

CREATE OR REPLACE FUNCTION public.reverse_payment_v1(
  p_organization_id UUID,
  p_payment_id      UUID,
  p_actor           UUID,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_payment RECORD;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('status', 'reason_required');
  END IF;

  SELECT id, order_id, status INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_payment.status NOT IN ('pending', 'paid') THEN
    RETURN jsonb_build_object('status', 'invalid_state', 'current', v_payment.status::TEXT);
  END IF;

  UPDATE public.payments SET status = 'reversed' WHERE id = p_payment_id;

  INSERT INTO public.payment_events (organization_id, payment_id, event_type, actor_user_id, reason)
  VALUES (p_organization_id, p_payment_id, 'reversal', p_actor, p_reason);

  -- ORDER CONSEQUENCE. A reversal voids this claim entirely — its amount, and
  -- any refunds already taken out of it, stop counting toward NET SETTLED. If
  -- the order's REMAINING payments still cover its total the order correctly
  -- stays 'paid'; if they no longer do, it drops to 'pending'/'unpaid'. A
  -- reversal never downgrades an order that other payments still fully cover,
  -- and never leaves one marked paid whose money has gone.
  PERFORM public.sync_order_payment_status_v1(
    p_organization_id, v_payment.order_id, p_actor,
    format('Payment %s reversed: %s', p_payment_id, p_reason)
  );

  RETURN jsonb_build_object('status', 'success');
END;
$$;

-- ── refund_payment_v1 (CREATE OR REPLACE — adds the ORDER CONSEQUENCE only) ──
--
-- EVERY refund resyncs the order, partial ones included. Because settlement
-- is an AMOUNT (see this migration's header), a partial refund genuinely
-- changes it: $100 order, $100 paid, $20 refunded leaves $80 net settled, so
-- the order MUST stop being 'paid'. An earlier draft synced only on a FULL
-- refund — correct under the old existence-based rule, wrong under this one,
-- and the exact case that would have silently left an order marked paid while
-- $20 of its money had gone back to the customer.
--
-- payments.amount_minor is still never mutated: the refunded total is derived
-- by summing this payment's append-only 'refund' events, so the original
-- claim remains visible in full (DATA_MODEL.md §53).

CREATE OR REPLACE FUNCTION public.refund_payment_v1(
  p_organization_id UUID,
  p_payment_id      UUID,
  p_actor           UUID,
  p_amount_minor    BIGINT,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_payment         RECORD;
  v_refunded_so_far BIGINT;
  v_new_total       BIGINT;
BEGIN
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('status', 'reason_required');
  END IF;

  SELECT id, order_id, status, amount_minor INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_payment.status NOT IN ('paid', 'refunded') THEN
    RETURN jsonb_build_object('status', 'invalid_state', 'current', v_payment.status::TEXT);
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_refunded_so_far
  FROM public.payment_events
  WHERE payment_id = p_payment_id AND event_type = 'refund';

  v_new_total := v_refunded_so_far + p_amount_minor;

  IF v_new_total > v_payment.amount_minor THEN
    RETURN jsonb_build_object(
      'status', 'invalid_amount', 'reason', 'exceeds_paid_amount',
      'already_refunded', v_refunded_so_far, 'payment_amount', v_payment.amount_minor
    );
  END IF;

  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, amount_minor, actor_user_id, reason
  ) VALUES (
    p_organization_id, p_payment_id, 'refund', p_amount_minor, p_actor, p_reason
  );

  IF v_new_total = v_payment.amount_minor THEN
    UPDATE public.payments SET status = 'refunded' WHERE id = p_payment_id;
  END IF;

  -- ORDER CONSEQUENCE — on EVERY refund, partial or full, and only after the
  -- refund event (and any resulting status change) is already written above,
  -- so the recompute sees this refund. See the header note on this function.
  PERFORM public.sync_order_payment_status_v1(
    p_organization_id, v_payment.order_id, p_actor,
    format('Payment %s refunded %s of %s: %s',
           p_payment_id, p_amount_minor, v_payment.amount_minor, p_reason)
  );

  RETURN jsonb_build_object(
    'status', 'success',
    'refunded_total', v_new_total,
    'fully_refunded', v_new_total = v_payment.amount_minor
  );
END;
$$;

-- ── Privileges (restated, not merely relied upon from CREATE OR REPLACE) ─────
--
-- CREATE OR REPLACE preserves each function's existing ACL, but restating it
-- here means the end state of this migration is readable on its own and
-- cannot drift if any of these functions is ever recreated rather than
-- replaced — same reasoning as migration 026's closing note. anon and
-- authenticated MUST NOT hold EXECUTE on any of these: every one of them
-- takes p_organization_id and now moves order state as well as payment
-- state, so EXECUTE for a JWT client would be a direct cross-tenant
-- financial-write primitive. This migration grants NOTHING new to anon or
-- authenticated anywhere.

REVOKE EXECUTE ON FUNCTION public.record_payment_v1(UUID, UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_payment_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_payment_v1(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_payment_v1(UUID, UUID, UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_payment_v1(UUID, UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_payment_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_payment_v1(UUID, UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_payment_v1(UUID, UUID, UUID, BIGINT, TEXT)
  TO service_role;
