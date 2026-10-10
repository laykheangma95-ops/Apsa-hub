-- 062_financial_replay_refund_audit_atomicity.sql
--
-- Financial replay identity, durable refund idempotency, and mandatory-audit
-- atomicity for refunds, reversals and corrections (PR #121 independent
-- review: P2 #3, #4, #5).
--
-- Functions and grants only. No table, column, index, constraint, RLS policy
-- or data change; migrations 040, 043, 060 and 061 are untouched.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- P2 #3 — replay accepted another actor's operation.
--   record_payment_v1 (040) replayed an existing payment for ANY caller that
--   presented its idempotency key with the same order, amount and method: it
--   never compared who recorded it, and ignored the reference and the note.
--   refund_payment_v1 (040) replayed a refund for any caller with the same
--   amount and reason. A member whose request had been executed as someone
--   else (or who merely held another member's key) got the other member's
--   payment or refund back as their own authorized success — and the refund
--   path then wrote a mandatory audit row naming the WRONG member.
--
-- P2 #4 — a refund retried after a lost response refunded twice.
--   The refund key was optional and the Payment detail screen never sent one,
--   so "committed, response lost, tap again" was a second refund. Even with a
--   key, a key held only in browser memory is lost on a remount or reload.
--
-- P2 #5 — a financial mutation committed before its mandatory audit.
--   Refund, reversal and correction each called their RPC (one transaction)
--   and then inserted the mandatory audit row (another). An audit-store
--   failure left the money moved (or the reference rewritten) with no audit
--   row, and the merchant was told it was blocked; a reversal could never be
--   retried into an audited state (already reversed), and a correction retry
--   applied a second correction.
--
-- ── WHAT ───────────────────────────────────────────────────────────────────
--
-- record_payment_v1 (replaced, same signature and grants)
--   A key replays ONLY the original request of the original member: same
--   order, recorder, method, amount, and the reference and note as originally
--   recorded (a later correction does not move the original — its first
--   correction event carries the pre-correction values; the created event
--   carries the original note). Anything else is `idempotency_conflict` and
--   writes nothing. A replay writes nothing at all.
--
-- refund_payment_v2 (new; the server's only refund entry point)
--   * The idempotency key is REQUIRED. One key is one logical refund in the
--     organization: every request carrying it is serialized by a transaction
--     advisory lock before it is looked up, whichever payment it names.
--   * A key already used replays only for the same member, payment, amount
--     and reason (writes nothing); anything else is `idempotency_conflict`.
--   * The caller states the refunded total it last saw
--     (p_expected_refunded_minor). Under the order and payment locks, a
--     different current total is `stale` and writes nothing. This is an
--     ADDITIONAL safeguard: it refuses a retry that lost its key (remount,
--     reload) but still describes the payment as it was before the refund
--     already made. Durable idempotency is the key, stored in the ledger
--     (payment_events.idempotency_key, unique per payment since 040).
--   * The refund event, the payment status, the derived order state and the
--     mandatory `payments.refund` audit row commit in ONE transaction. If the
--     audit insert fails the whole call fails with `apsa_audit_unavailable`
--     and nothing commits.
--
-- reverse_payment_v2 / correct_payment_v2 (new; the server's only entry points)
--   The 040 / 035 bodies, unchanged, followed by the mandatory
--   `payments.reverse` / `payments.override` audit row — in ONE transaction.
--   An audit-store failure rolls the whole call back (`apsa_audit_unavailable`).
--
-- refund_payment_v1(…, text), reverse_payment_v1 and correct_payment_v1 are
-- RETIRED: EXECUTE is revoked from every role except their owner (the v2
-- functions call them as the owner). A post-condition below aborts this
-- migration if any role other than the owner can still run one of them, or
-- if the server role cannot run the replacements.
--
-- Why not "write the audit first" or "compensate after": an audit row for a
-- refund that then failed is a false record, and a compensating write after a
-- failed audit is a second financial event that can itself fail. One
-- transaction is the only boundary in which both commit or neither does.
--
-- Lock order is unchanged: advisory key lock, then Order, then Payment — the
-- same Order-before-Payment order as every 040 financial RPC. Only refund_
-- payment_v2 takes the key lock, always first, so no cycle is possible.

-- ── Original-request comparison for payment replay ─────────────────────────

CREATE FUNCTION public.payment_replay_matches_v1(
  p_payment_id uuid,
  p_order_id uuid,
  p_recorded_by uuid,
  p_method text,
  p_amount_minor bigint,
  p_reference text,
  p_note text
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, auth AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_before jsonb;
  v_original_reference text;
  v_original_note text;
BEGIN
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- The reference as RECORDED: a correction keeps the pre-correction values in
  -- its event; the earliest correction holds the original.
  SELECT e.metadata -> 'before' INTO v_before
    FROM public.payment_events e
   WHERE e.payment_id = p_payment_id AND e.event_type = 'correction'
   ORDER BY e.created_at, e.id
   LIMIT 1;
  v_original_reference := CASE WHEN v_before IS NULL THEN v_payment.reference
                               ELSE v_before ->> 'reference' END;

  -- The note as RECORDED: the immutable created event carries it.
  SELECT NULLIF(trim(e.reason), '') INTO v_original_note
    FROM public.payment_events e
   WHERE e.payment_id = p_payment_id AND e.event_type = 'created';

  RETURN v_payment.order_id = p_order_id
     AND v_payment.recorded_by IS NOT DISTINCT FROM p_recorded_by
     AND v_payment.method::text = p_method
     AND v_payment.amount_minor = p_amount_minor
     AND v_original_reference IS NOT DISTINCT FROM NULLIF(trim(p_reference), '')
     AND v_original_note IS NOT DISTINCT FROM NULLIF(trim(p_note), '');
END;
$$;

-- ── record_payment_v1: replay bound to the actor and the original request ──

CREATE OR REPLACE FUNCTION public.record_payment_v1(
  p_organization_id uuid, p_order_id uuid, p_recorded_by uuid,
  p_method text, p_amount_minor bigint, p_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  result jsonb;
  v_key text := NULLIF(trim(p_idempotency_key), '');
  v_existing public.payments%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payments
      WHERE organization_id = p_organization_id AND idempotency_key = v_key;
    IF FOUND THEN
      IF NOT public.payment_replay_matches_v1(v_existing.id, p_order_id, p_recorded_by,
          p_method, p_amount_minor, p_reference, p_note) THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict');
      END IF;
      -- The original member's own retry: the payment it already recorded.
      -- Nothing is written.
      RETURN jsonb_build_object('status', 'success', 'payment_id', v_existing.id,
        'replayed', true,
        'duplicate_suspected', v_existing.verification_state = 'duplicate_suspected');
    END IF;
  END IF;

  result := public.record_payment_before_order_v1(p_organization_id, p_order_id,
    p_recorded_by, p_method, p_amount_minor, p_reference, p_idempotency_key, p_note);

  IF result ->> 'status' = 'success' THEN
    IF COALESCE((result ->> 'replayed')::boolean, false) THEN
      -- A concurrent request with this key committed between the lookup above
      -- and the insert (one naming a different order, whose lock this call does
      -- not hold). Same rule: only the original request of the original member.
      IF NOT public.payment_replay_matches_v1((result ->> 'payment_id')::uuid, p_order_id,
          p_recorded_by, p_method, p_amount_minor, p_reference, p_note) THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict');
      END IF;
      RETURN result;
    END IF;
    PERFORM public.sync_order_payment_state(p_organization_id, p_order_id, p_recorded_by,
      'Payment recorded');
  END IF;
  RETURN result;
END;
$$;

-- ── refund_payment_v2 ──────────────────────────────────────────────────────

CREATE FUNCTION public.refund_payment_v2(
  p_organization_id uuid,
  p_payment_id uuid,
  p_actor uuid,
  p_amount_minor bigint,
  p_reason text,
  p_idempotency_key text,
  p_expected_refunded_minor bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_key text := NULLIF(trim(p_idempotency_key), '');
  v_target uuid;
  v_previous public.payment_events%ROWTYPE;
  v_refunded bigint;
  v_result jsonb;
BEGIN
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('status', 'idempotency_key_required');
  END IF;
  IF p_expected_refunded_minor IS NULL OR p_expected_refunded_minor < 0 THEN
    RETURN jsonb_build_object('status', 'expected_refunded_required');
  END IF;

  -- One key, one logical refund in this organization: every request carrying
  -- it waits here, whichever payment it names, before the key is looked up.
  PERFORM pg_advisory_xact_lock(
    hashtext('apsa:payment-refund:' || p_organization_id::text || ':' || v_key));

  v_target := public.lock_payment_order(p_organization_id, p_payment_id);
  IF v_target IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM 1 FROM public.payments WHERE id = p_payment_id FOR UPDATE;

  SELECT * INTO v_previous FROM public.payment_events
   WHERE organization_id = p_organization_id AND event_type = 'refund'
     AND idempotency_key = v_key
   ORDER BY created_at, id
   LIMIT 1;
  IF FOUND THEN
    IF v_previous.payment_id <> p_payment_id
       OR v_previous.actor_user_id IS DISTINCT FROM p_actor
       OR v_previous.amount_minor IS DISTINCT FROM p_amount_minor
       OR v_previous.reason IS DISTINCT FROM p_reason THEN
      RETURN jsonb_build_object('status', 'idempotency_conflict');
    END IF;
    -- The same member's retry of the same refund: its original result. The
    -- original committed its own audit row with it; nothing is written now.
    RETURN v_previous.metadata || jsonb_build_object('replayed', true);
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_refunded FROM public.payment_events
   WHERE payment_id = p_payment_id AND event_type = 'refund';
  IF v_refunded <> p_expected_refunded_minor THEN
    RETURN jsonb_build_object('status', 'stale', 'refunded_total', v_refunded);
  END IF;

  -- The ledger write (040's validated body: amount, reason, state, the
  -- remaining balance, the refund event under this key, payment status, the
  -- derived order state), then the mandatory audit row — one transaction.
  v_result := public.refund_payment_v1(p_organization_id, p_payment_id, p_actor,
    p_amount_minor, p_reason, v_key);

  IF v_result ->> 'status' = 'success' THEN
    BEGIN
      INSERT INTO public.audit_logs(
        organization_id, actor_user_id, action, resource_type, resource_id, after_json, reason
      ) VALUES (
        p_organization_id, p_actor, 'payments.refund', 'payments', p_payment_id::text,
        jsonb_build_object(
          'refunded_amount_minor', p_amount_minor,
          'refunded_total', v_result -> 'refunded_total',
          'fully_refunded', COALESCE(v_result -> 'fully_refunded', 'false'::jsonb),
          'replayed', false
        ),
        p_reason
      );
    EXCEPTION WHEN OTHERS THEN
      -- Re-raised, so the WHOLE call fails and the refund rolls back with it.
      RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
    END;
  END IF;
  RETURN v_result;
END;
$$;

-- ── reverse_payment_v2 / correct_payment_v2 ─────────────────────────────────

CREATE FUNCTION public.reverse_payment_v2(
  p_organization_id uuid,
  p_payment_id uuid,
  p_actor uuid,
  p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- 040's body: Order lock, then Payment; the reversal event, the payment
  -- status and the derived order state.
  v_result := public.reverse_payment_v1(p_organization_id, p_payment_id, p_actor, p_reason);
  IF v_result ->> 'status' = 'success' THEN
    BEGIN
      INSERT INTO public.audit_logs(
        organization_id, actor_user_id, action, resource_type, resource_id, reason
      ) VALUES (
        p_organization_id, p_actor, 'payments.reverse', 'payments', p_payment_id::text, p_reason
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
    END;
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.correct_payment_v2(
  p_organization_id uuid,
  p_payment_id uuid,
  p_actor uuid,
  p_reason text,
  p_new_reference text DEFAULT NULL,
  p_new_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_before record;
  v_result jsonb;
BEGIN
  -- The values being replaced, read under the lock 035's body then takes again.
  SELECT reference, note INTO v_before FROM public.payments
   WHERE id = p_payment_id AND organization_id = p_organization_id
   FOR UPDATE;
  v_result := public.correct_payment_v1(p_organization_id, p_payment_id, p_actor, p_reason,
    p_new_reference, p_new_note);
  IF v_result ->> 'status' = 'success' THEN
    BEGIN
      INSERT INTO public.audit_logs(
        organization_id, actor_user_id, action, resource_type, resource_id,
        before_json, after_json, reason
      ) VALUES (
        p_organization_id, p_actor, 'payments.override', 'payments', p_payment_id::text,
        jsonb_build_object('reference', v_before.reference, 'note', v_before.note),
        jsonb_strip_nulls(jsonb_build_object('reference', p_new_reference, 'note', p_new_note)),
        p_reason
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
    END;
  END IF;
  RETURN v_result;
END;
$$;

-- ── Privileges ─────────────────────────────────────────────────────────────
--
-- 061 left function EXECUTE alone, and functions default to PUBLIC EXECUTE —
-- plus whatever an environment's default privileges add (Supabase grants
-- EXECUTE on new functions to anon, authenticated and service_role). So every
-- function here states its grants explicitly, and any OTHER grantee found is
-- revoked dynamically: the retired and internal functions end up executable
-- by their owner alone; the server entry points by their owner and the
-- server role alone.

REVOKE ALL ON FUNCTION public.payment_replay_matches_v1(uuid,uuid,uuid,text,bigint,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_payment_v1(uuid,uuid,uuid,bigint,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reverse_payment_v1(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_payment_v1(uuid,uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_payment_v2(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.correct_payment_v2(uuid,uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_payment_v2(uuid,uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.correct_payment_v2(uuid,uuid,uuid,text,text,text)
  TO service_role;

DO $$
DECLARE
  v_fn regprocedure;
  v_keep_server boolean;
  v_grantee text;
BEGIN
  FOR v_fn, v_keep_server IN
    SELECT f::regprocedure, k FROM (VALUES
      ('public.payment_replay_matches_v1(uuid,uuid,uuid,text,bigint,text,text)', false),
      ('public.refund_payment_v1(uuid,uuid,uuid,bigint,text,text)', false),
      ('public.reverse_payment_v1(uuid,uuid,uuid,text)', false),
      ('public.correct_payment_v1(uuid,uuid,uuid,text,text,text)', false),
      ('public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)', true),
      ('public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint)', true),
      ('public.reverse_payment_v2(uuid,uuid,uuid,text)', true),
      ('public.correct_payment_v2(uuid,uuid,uuid,text,text,text)', true)
    ) AS t(f, k)
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT quote_ident(r.rolname)
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        JOIN pg_roles r ON r.oid = a.grantee
       WHERE p.oid = v_fn
         AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> p.proowner
         AND NOT (v_keep_server AND r.rolname = 'service_role')
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_fn, v_grantee);
    END LOOP;
  END LOOP;
END;
$$;

-- ── Post-conditions: abort unless the effective authority is exactly this ──

DO $$
DECLARE
  v_fn regprocedure;
  v_server boolean;
  v_extra text;
BEGIN
  FOR v_fn, v_server IN
    SELECT f::regprocedure, k FROM (VALUES
      ('public.payment_replay_matches_v1(uuid,uuid,uuid,text,bigint,text,text)', false),
      ('public.refund_payment_v1(uuid,uuid,uuid,bigint,text,text)', false),
      ('public.reverse_payment_v1(uuid,uuid,uuid,text)', false),
      ('public.correct_payment_v1(uuid,uuid,uuid,text,text,text)', false),
      ('public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)', true),
      ('public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint)', true),
      ('public.reverse_payment_v2(uuid,uuid,uuid,text)', true),
      ('public.correct_payment_v2(uuid,uuid,uuid,text,text,text)', true)
    ) AS t(f, k)
  LOOP
    -- Stored ACL (or the PUBLIC default when none is stored): no grantee but
    -- the owner — and the server role where it is meant to run the function.
    SELECT string_agg(DISTINCT coalesce(r.rolname, 'PUBLIC'), ', ') INTO v_extra
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.oid = v_fn
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND NOT (v_server AND r.rolname = 'service_role');
    IF v_extra IS NOT NULL THEN
      RAISE EXCEPTION '062: % is still executable by %', v_fn, v_extra;
    END IF;
    -- Effective authority, inheritance included.
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '062: % is executable by a browser role', v_fn;
    END IF;
    IF has_function_privilege('service_role', v_fn, 'EXECUTE') IS DISTINCT FROM v_server THEN
      RAISE EXCEPTION '062: % — service_role EXECUTE must be %', v_fn, v_server;
    END IF;
  END LOOP;
END;
$$;
