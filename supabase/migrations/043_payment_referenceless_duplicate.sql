-- Migration: 043_payment_referenceless_duplicate
-- Purpose: Extend duplicate-payment suspicion to reference-less Payments.
-- Function changed: public.record_payment_before_order_v1(...) — the function
--   migration 040 renamed record_payment_v1 to. The public wrapper
--   record_payment_v1 (also migration 040) is NOT touched by this migration:
--   its Order row locking (`FOR UPDATE`) and idempotency-conflict validation
--   stay exactly as they are.
--
-- PROVEN DEFECT (launch-blocking financial integrity)
--   Order total = 10000. Merchant taps "Record cash 10000" — the client sends
--   idempotency key A. The server call succeeds, but the HTTP response never
--   reaches the client (dropped connection, backgrounded app, timeout). The
--   merchant sees no confirmation, closes the sheet, reopens it and retries —
--   this second attempt gets a NEW idempotency key B, because it is, from the
--   client's perspective, a different user action.
--
--   Before this migration, record_payment_before_order_v1 only ever treats a
--   payment as suspicious when it carries a non-null `reference` that
--   collides with another active payment (migration 035). A reference-less
--   cash payment has no such signal, so key A and key B both insert ordinary
--   'unverified' rows. If a reconciler later verifies both — each looks like
--   an independent, unremarkable cash payment — order_payment_totals sums
--   both principals and received_minor becomes 20000 against a 10000 Order.
--   That is invented money: a proven, launch-blocking P1.
--
-- WHY THIS CANNOT BE A CLIENT-ONLY FIX
--   The client cannot distinguish "my first request actually succeeded, I
--   just never heard back" from "my first request never reached the server"
--   — that is exactly what idempotency keys exist to paper over, and exactly
--   why they cannot paper over a *retry with a new key*. Only the server,
--   which can see the first row that already committed, can raise this as a
--   reviewable signal. And it must not guess reject/accept on the client's
--   behalf: rejecting a legitimate second cash payment (a real split payment
--   of the same amount) would silently lose a real sale; silently coalescing
--   the two rows would silently lose a real duplicate. Suspicion — recorded,
--   reviewable, never auto-resolved — is the only safe default.
--
-- WHAT THIS MIGRATION DOES NOT CHANGE
--   The existing reference-based duplicate check (migration 035) — its
--   advisory lock, its EXISTS predicate, its 'duplicate_flagged' event — is
--   untouched. When p_reference IS NOT NULL, this function behaves exactly as
--   it did before this migration. This migration only adds a second branch
--   for the case the reference-based check cannot cover: p_reference IS NULL.
--
-- REFERENCE-LESS DUPLICATE SUSPICION
--   A new reference-less Payment is flagged 'duplicate_suspected' (not
--   rejected, not silently merged, and the earlier Payment is never touched)
--   when an existing Payment in the SAME organization, order, method and
--   amount already exists with reference IS NULL, status <> 'reversed', and
--   created within the last 10 minutes. The Payment is inserted either way —
--   this is reconciliation input, not a gate.
--
--   10 MINUTES: no canonical duplicate-suspicion window exists elsewhere in
--   this repository as of migration 042. A lost-response retry is a human
--   noticing a stuck UI and tapping again — that happens within seconds to a
--   couple of minutes, not hours. A legitimate later same-amount cash payment
--   (e.g. a customer paying the same 10000 again for an unrelated reason
--   hours later) must not carry a stale suspicion flag forever, so the window
--   is short and bounded rather than "ever".
--
-- CONCURRENCY
--   Two genuinely concurrent reference-less requests with the SAME
--   organization/order/method/amount (e.g. the lost-response retry racing a
--   slow-arriving duplicate tap) must not both observe "no duplicate exists"
--   before either commits. A transaction-scoped advisory lock keyed on
--   (organization_id, order_id, method, amount_minor) — released
--   automatically at COMMIT/ROLLBACK — forces the second call to wait for the
--   first to commit, mirroring the reference-based lock immediately above it
--   and migration 035's own precedent (itself following migration 009's
--   per-founder lock pattern).
--
-- IDEMPOTENCY IS UNCHANGED AND UNRELATED
--   The SAME idempotency key replay still short-circuits via the existing
--   ON CONFLICT ... DO NOTHING / re-select path below — it never reaches
--   either duplicate-suspicion branch a second time for the same logical
--   request. Reference-less duplicate suspicion is about two DIFFERENT
--   idempotency keys producing suspiciously identical Payments, which
--   idempotency alone cannot and must not try to catch.

CREATE OR REPLACE FUNCTION public.record_payment_before_order_v1(
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
  v_duplicate_kind  TEXT;
  v_initial_state   public.payment_verification_state;
  v_lock_key        BIGINT;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'record_payment_before_order_v1: organization_id is required';
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
    -- Unchanged since migration 035 — see that migration's header for the
    -- concurrency rationale this reference-less branch mirrors below.
    v_lock_key := hashtext(p_organization_id::TEXT || ':' || v_reference);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT EXISTS (
      SELECT 1 FROM public.payments
      WHERE organization_id = p_organization_id
        AND reference = v_reference
        AND status <> 'reversed'
    ) INTO v_duplicate;
    IF v_duplicate THEN v_duplicate_kind := 'reference'; END IF;
  ELSE
    -- REFERENCELESS_DUPLICATE_CHECK_START
    -- New in migration 043. Same lock-then-check shape as the reference
    -- branch above, keyed on the authoritative reference-less identity
    -- instead: organization, order, method and amount.
    v_lock_key := hashtext(
      p_organization_id::TEXT || ':' || p_order_id::TEXT || ':' || p_method || ':' || p_amount_minor::TEXT
    );
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT EXISTS (
      SELECT 1 FROM public.payments
      WHERE organization_id = p_organization_id
        AND order_id = p_order_id
        AND method = p_method::public.payment_method
        AND amount_minor = p_amount_minor
        AND reference IS NULL
        AND status <> 'reversed'
        AND created_at > now() - interval '10 minutes'
    ) INTO v_duplicate;
    IF v_duplicate THEN v_duplicate_kind := 'referenceless'; END IF;
    -- REFERENCELESS_DUPLICATE_CHECK_END
  END IF;

  v_initial_state := CASE WHEN v_duplicate THEN 'duplicate_suspected' ELSE 'unverified' END;

  -- ON CONFLICT targets the partial unique index from migration 034. Rows
  -- with a NULL idempotency_key are never in that index, so this clause is a
  -- no-op for them and always proceeds to a normal insert.
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
      CASE v_duplicate_kind
        WHEN 'reference' THEN 'Reference matches another active payment in this organization'
        ELSE 'Same organization/order/method/amount matches another active reference-less payment within the duplicate suspicion window'
      END,
      CASE v_duplicate_kind
        WHEN 'reference' THEN jsonb_build_object('kind', 'reference', 'reference', v_reference)
        ELSE jsonb_build_object(
          'kind', 'referenceless', 'method', p_method,
          'amount_minor', p_amount_minor, 'window_minutes', 10
        )
      END
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'success', 'payment_id', v_payment_id,
    'duplicate_suspected', v_duplicate, 'replayed', false
  );
END;
$$;

-- CREATE OR REPLACE preserves the ACL of an existing function, but this
-- REVOKE is restated explicitly (matching migration 040's own grant) so
-- scripts/check-migration-safety.ts's SECURITY DEFINER check finds it in
-- this file too, and so intent is never implicit: this function is never
-- directly callable by anything except record_payment_v1's internal call.
REVOKE ALL ON FUNCTION public.record_payment_before_order_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
