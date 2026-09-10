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
-- ── THE AGGREGATE RULE ────────────────────────────────────────────────────────
--
-- orders.payment_status (migration 023) is deliberately COARSE — only
-- unpaid/pending/paid/failed, no 'refunded' or 'partially_paid' state of its
-- own (task brief: "Order payment axis" lists exactly these four). An order
-- may have more than one payment row over its life (a failed attempt then a
-- successful one; a cash payment later fully refunded and re-collected by
-- bank transfer), so the coarse status is a DETERMINISTIC AGGREGATE over all
-- of that order's payments, recomputed fresh on every payment mutation —
-- never a value copied from "the payment that just changed":
--
--   ANY payment status = 'paid'    -> order payment_status = 'paid'
--   else ANY payment status = 'pending'  -> order payment_status = 'pending'
--   else ANY payment status = 'failed'   -> order payment_status = 'failed'
--   else (no payments, or all reversed/refunded with nothing else active)
--                                   -> order payment_status = 'unpaid'
--
-- 'paid' wins over everything else unconditionally. This is what makes the
-- "PAID RULE" (task brief) hold even with multiple payment attempts: once ANY
-- payment for this order has been staff/manager/bank-verified, an unrelated
-- second attempt failing, or being reversed, can never silently downgrade the
-- order — only a full reversal/refund of the PAID payment itself (which
-- removes it from the 'paid' bucket) can move the order off 'paid', and even
-- then only down to whatever the remaining payments still support.
--
-- Refund/reversal history is never lost by this collapse to 'unpaid': the
-- detailed truth — which payment, how much, refunded when, by whom, why —
-- remains fully visible in payments/payment_events and the reconciliation
-- view (PAYMENTS.md §12). This function only ever writes the coarse summary
-- the Order axis was designed to hold.
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
  v_order  RECORD;
  v_target public.order_payment_status;
BEGIN
  SELECT lifecycle_status, payment_status INTO v_order
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

  IF EXISTS (
    SELECT 1 FROM public.payments
    WHERE order_id = p_order_id AND organization_id = p_organization_id AND status = 'paid'
  ) THEN
    v_target := 'paid';
  ELSIF EXISTS (
    SELECT 1 FROM public.payments
    WHERE order_id = p_order_id AND organization_id = p_organization_id AND status = 'pending'
  ) THEN
    v_target := 'pending';
  ELSIF EXISTS (
    SELECT 1 FROM public.payments
    WHERE order_id = p_order_id AND organization_id = p_organization_id AND status = 'failed'
  ) THEN
    v_target := 'failed';
  ELSE
    -- No active claim remains: either no payment was ever recorded, or every
    -- payment for this order is now reversed/refunded with nothing else
    -- pending/paid/failed. The coarse axis has no 'refunded' state of its
    -- own, so the correct coarse signal is "no money currently stands
    -- settled" — the detailed history stays fully visible in
    -- payments/payment_events regardless.
    v_target := 'unpaid';
  END IF;

  IF v_order.payment_status = v_target THEN
    RETURN jsonb_build_object('status', 'no_change', 'current', v_order.payment_status::TEXT);
  END IF;

  -- Reused exactly as-is. v_order.payment_status is safe to pass as
  -- p_expected_from because this function already holds the order row's
  -- lock (FOR UPDATE above) for the rest of the transaction — nothing else
  -- could have changed it since. transition_order_status_v1's own
  -- terminal-lifecycle freeze (cancelled/completed) applies here exactly as
  -- it does to every other axis: the order's displayed payment status stays
  -- frozen once the order itself is done, and this call simply returns
  -- 'terminal' rather than raising.
  RETURN public.transition_order_status_v1(
    p_organization_id, p_order_id, 'payment',
    v_order.payment_status::TEXT, v_target::TEXT,
    p_actor, p_reason
  );
END;
$$;

COMMENT ON FUNCTION public.sync_order_payment_status_v1(UUID, UUID, UUID, TEXT) IS
  'Recomputes orders.payment_status from the authoritative aggregate of this order''s payments (paid > pending > failed > unpaid) and applies it via transition_order_status_v1, atomically. Called only from inside record_payment_v1/verify_payment_v1/reverse_payment_v1/refund_payment_v1 — never from TypeScript, and not independently reachable by any client.';

REVOKE EXECUTE ON FUNCTION public.sync_order_payment_status_v1(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_order_payment_status_v1(UUID, UUID, UUID, TEXT)
  TO service_role;

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

  -- ORDER CONSEQUENCE. See sync_order_payment_status_v1 for the full
  -- aggregate rule (paid > pending > failed > unpaid).
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
-- orders.payment_status to 'paid' anywhere in APSA — via the aggregate rule
-- in sync_order_payment_status_v1, never by writing 'paid' directly.

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

  -- ORDER CONSEQUENCE. sync_order_payment_status_v1 always resolves to
  -- 'paid' the moment ANY payment for this order carries status='paid',
  -- regardless of how many other attempts exist. A 'mismatch' (->'failed')
  -- verification only moves the order DOWN when no other payment for it is
  -- still 'paid' — see that function's aggregate rule.
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

  -- ORDER CONSEQUENCE. Recomputes the order's coarse payment axis now that
  -- this claim no longer counts. If another payment for the order is still
  -- 'paid', the order correctly stays 'paid' — a reversal never downgrades
  -- an order that a DIFFERENT payment already settled.
  PERFORM public.sync_order_payment_status_v1(
    p_organization_id, v_payment.order_id, p_actor,
    format('Payment %s reversed: %s', p_payment_id, p_reason)
  );

  RETURN jsonb_build_object('status', 'success');
END;
$$;

-- ── refund_payment_v1 (CREATE OR REPLACE — adds the ORDER CONSEQUENCE only) ──
--
-- Only a FULLY refunded payment can change the order's coarse axis. A
-- partial refund leaves this payment's own status at 'paid', so the
-- aggregate still finds it and the order correctly stays 'paid' — refund
-- amounts are never tracked on the order itself; they remain fully visible
-- in payment_events and the reconciliation view (PAYMENTS.md §12).

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

    -- ORDER CONSEQUENCE — only on a FULL refund. See header note above.
    PERFORM public.sync_order_payment_status_v1(
      p_organization_id, v_payment.order_id, p_actor,
      format('Payment %s fully refunded: %s', p_payment_id, p_reason)
    );
  END IF;

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
