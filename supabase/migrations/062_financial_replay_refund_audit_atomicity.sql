-- 062_financial_replay_refund_audit_atomicity.sql
--
-- Financial replay identity, durable refund intent, mandatory-audit atomicity
-- and the effective authority over every financial RPC (PR #121 independent
-- reviews: P2 #3, #4, #5, and the migration 062 re-review findings 1–4).
--
-- Functions, function grants and the CREATE privilege on schema public only.
-- No table, column, index, constraint, RLS policy or data change; migrations
-- 040, 043, 060 and 061 are not edited.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Replay accepted another actor's operation (P2 #3). record_payment_v1 (040)
--   replayed a payment for ANY caller holding its key; refund_payment_v1 (040)
--   replayed a refund for any caller with the same amount and reason.
--
-- The ORIGINAL recording request could not be identified (re-review #2). The
--   first repair inferred the original reference from the earliest correction
--   event; correction events can share a timestamp (one transaction) or carry
--   a timestamp older than their commit (a transaction that started earlier
--   but waited for the payment lock), so that order is ambiguous: the original
--   request's replay was refused while a changed reference was accepted.
--
-- A refund retried after a reload refunded twice (P2 #4, re-review #1). The
--   retry carried a new key (the old one lived in the closed page) and the
--   refreshed refunded total, so neither the key nor the total could tell it
--   from a new refund.
--
-- A financial mutation committed before its mandatory audit (P2 #5). The
--   refund, reversal and correction RPCs committed, then the service wrote the
--   mandatory audit row separately.
--
-- Legacy and overloaded financial functions stayed executable (re-review #3).
--   The first repair revoked three known signatures. Pre-authority bodies
--   (*_before_order_v1), internal helpers, other overloads of a retired name,
--   grants to PUBLIC, grants inherited through role memberships (SET-only
--   included), owners a browser or server role can become, and functions
--   planted in other schemas were never checked.
--
-- A release that reached the database before this migration kept the unsafe
--   recording replay (re-review #4): it called record_payment_v1, which still
--   had 040's rules there.
--
-- ── WHAT ───────────────────────────────────────────────────────────────────
--
-- payment_request_digest_v1 — a deterministic SHA-256 of one recording
--   request: organization, order, recorder, method, amount, and the reference
--   and note exactly as the payment row stores them (trimmed, empty = NULL).
--
-- record_payment_before_order_v1 (043's body, unchanged but for one thing)
--   stamps that digest on the payment's own 'created' event, as
--   metadata.request_reference_digest. payment_events is append-only for
--   every role (034), so the original request's identity is immutable: no
--   correction, however ordered, can change it. The key name contains
--   "reference", so the payments API withholds it from members without
--   payments.view_provider_reference, like every other reference value.
--
-- payment_replay_matches_v1 — a key replays only the original member's
--   original request: the payment's guarded identity (040's trigger: order,
--   method, amount), the append-only created event (recorder, amount), and the
--   stored digest. A payment recorded before this migration has no digest: its
--   original request cannot be proven, so a replay of it is REFUSED
--   (idempotency_conflict), never guessed from mutable columns or from the
--   order of correction events.
--
-- record_payment_v2 — the recording entry point of this release. A key
--   replays only the original request of the original member (nothing
--   written); anything else under it is idempotency_conflict. The application
--   calls ONLY this name, so a release that reaches a database without this
--   migration finds no such function and records nothing (it reports
--   schema_upgrade_required) instead of using 040's replay rules.
--   record_payment_v1 is kept, now delegating to record_payment_v2, so a
--   previous release running against this database records with the safe
--   rules too.
--
-- refund_payment_v2 — one logical refund:
--   * the idempotency key is REQUIRED; one key is one refund in the
--     organization (transaction advisory lock before the lookup); a used key
--     replays only for the same member, payment, amount and reason (nothing
--     written) — anything else is idempotency_conflict;
--   * p_acknowledged_refund_ids: every refund already on the payment must be
--     acknowledged by the request. An unacknowledged earlier refund is
--     confirmation_required (nothing written); an acknowledged id that is not
--     a refund of this payment is stale. A retry that lost its key — after a
--     reload, in another tab, on another device — cannot silently become a
--     second refund: the client must show the existing refund and get an
--     explicit confirmation first. A deliberate further refund stays possible.
--   * p_expected_refunded_minor: the refunded total the request was started
--     from; a different total is stale (an additional safeguard);
--   * the refund event, payment status, derived order state and the mandatory
--     payments.refund audit row commit in ONE transaction.
--
-- reverse_payment_v2 / correct_payment_v2 — 040's reversal and 035's
--   correction, then the mandatory payments.reverse / payments.override audit
--   row, in ONE transaction. An audit-store failure rolls the whole call back
--   (apsa_audit_unavailable).
--
-- AUTHORITY, by NAME (every overload, every schema), checked as EFFECTIVE
-- privilege (PUBLIC, direct, inherited, ownership, any membership edge):
--   entry points  record_payment_v1, record_payment_v2, verify_payment_v1,
--                 attach_payment_evidence_v1, refund_payment_v2,
--                 reverse_payment_v2, correct_payment_v2 — exactly one
--                 function per name (public), SECURITY DEFINER with a fixed
--                 search_path; EXECUTE for their owner and service_role only.
--   internals     refund_payment_v1, reverse_payment_v1, correct_payment_v1,
--                 the four *_before_order_v1 bodies, lock_payment_order,
--                 sync_order_payment_state, payment_replay_matches_v1,
--                 payment_request_digest_v1,
--                 transition_order_before_payment_authority_v1 — EXECUTE for
--                 their owner and the owners of the SECURITY DEFINER functions
--                 that call them, nobody else.
--   schema public no CREATE for PUBLIC, anon, authenticated or any role they
--                 can reach, so no overload can be planted afterwards.
-- The post-conditions at the end ABORT the migration (nothing applied) if any
-- role anon or authenticated can reach can execute a financial RPC, if any
-- role service_role can reach can execute an internal one, if a caller's owner
-- cannot execute what it calls, if an entry point has an overload, or if a
-- browser-reachable role can still create in schema public.
--
-- ── DEPLOYMENT ─────────────────────────────────────────────────────────────
--
-- Safe in either order (CORRECTIONS.md, CORRECTION-005):
--   migration first  the previous release keeps recording (record_payment_v1
--                    now has the safe rules) and refusing refunds, reversals
--                    and corrections (their v1 functions are closed) until
--                    the new release is deployed.
--   release first    the new release refuses recording, refunds, reversals
--                    and corrections (schema_upgrade_required, before any
--                    write) until this migration is applied; everything else
--                    keeps working.
-- Lock order is unchanged: advisory key lock, then Order, then Payment.

-- ── The original recording request, as an immutable digest ─────────────────

CREATE FUNCTION public.payment_request_digest_v1(
  p_organization_id uuid,
  p_order_id uuid,
  p_recorded_by uuid,
  p_method text,
  p_amount_minor bigint,
  p_reference text,
  p_note text
) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'v', 1,
    'organization_id', p_organization_id,
    'order_id', p_order_id,
    'recorded_by', p_recorded_by,
    'method', p_method,
    'amount_minor', p_amount_minor,
    'reference', NULLIF(trim(p_reference), ''),
    'note', NULLIF(trim(p_note), '')
  )::text, 'UTF8')), 'hex')
$$;

-- ── 043's recording body, stamping the digest on the created event ─────────

-- Migration 043's body, byte for byte, but for the created-event insert, which
-- now carries the request digest. Same signature, owner-only (below).
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

  -- Migration 062: the original request's immutable identity, stamped on the
  -- append-only created event (see payment_request_digest_v1).
  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, amount_minor, currency,
    to_verification, actor_user_id, reason, metadata
  ) VALUES (
    p_organization_id, v_payment_id, 'created', p_amount_minor, v_order.currency,
    v_initial_state, p_recorded_by, p_note,
    jsonb_build_object(
      'request_reference_digest', public.payment_request_digest_v1(
        p_organization_id, p_order_id, p_recorded_by, p_method, p_amount_minor,
        p_reference, p_note),
      'request_digest_version', 1)
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

-- ── Original-request comparison for payment replay ─────────────────────────

CREATE FUNCTION public.payment_replay_matches_v1(
  p_payment_id uuid,
  p_organization_id uuid,
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
  v_created public.payment_events%ROWTYPE;
BEGIN
  SELECT * INTO v_payment FROM public.payments
   WHERE id = p_payment_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_created FROM public.payment_events
   WHERE payment_id = p_payment_id AND event_type = 'created';
  IF NOT FOUND THEN RETURN false; END IF;

  -- Immutable facts only: the payment identity 040's trigger guards, and the
  -- append-only created event (the recorder and the amount it was created for).
  IF v_payment.order_id <> p_order_id
     OR v_payment.method::text <> p_method
     OR v_payment.amount_minor <> p_amount_minor
     OR v_created.actor_user_id IS DISTINCT FROM p_recorded_by
     OR v_created.amount_minor IS DISTINCT FROM p_amount_minor THEN
    RETURN false;
  END IF;

  -- The original request's digest, stamped when it was recorded. A payment
  -- recorded before migration 062 has none: its original request cannot be
  -- proven, so it is never replayed.
  IF v_created.metadata IS NULL OR NOT (v_created.metadata ? 'request_reference_digest') THEN
    RETURN false;
  END IF;
  RETURN v_created.metadata ->> 'request_reference_digest' = public.payment_request_digest_v1(
    p_organization_id, p_order_id, p_recorded_by, p_method, p_amount_minor, p_reference, p_note);
END;
$$;

-- ── record_payment_v2 — this release's recording entry point ───────────────

CREATE FUNCTION public.record_payment_v2(
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
      IF NOT public.payment_replay_matches_v1(v_existing.id, p_organization_id, p_order_id,
          p_recorded_by, p_method, p_amount_minor, p_reference, p_note) THEN
        RETURN jsonb_build_object('status', 'idempotency_conflict');
      END IF;
      -- The original member's own retry of the original request: the payment
      -- it already recorded. Nothing is written.
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
      IF NOT public.payment_replay_matches_v1((result ->> 'payment_id')::uuid, p_organization_id,
          p_order_id, p_recorded_by, p_method, p_amount_minor, p_reference, p_note) THEN
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

-- The previous release's recording entry point, kept (same signature and
-- grants) and now delegating to record_payment_v2, so that release records
-- with the same rules if this migration is applied before the new release.
CREATE OR REPLACE FUNCTION public.record_payment_v1(
  p_organization_id uuid, p_order_id uuid, p_recorded_by uuid,
  p_method text, p_amount_minor bigint, p_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  RETURN public.record_payment_v2(p_organization_id, p_order_id, p_recorded_by, p_method,
    p_amount_minor, p_reference, p_idempotency_key, p_note);
END;
$$;

-- ── refund_payment_v2 — one logical refund ─────────────────────────────────

CREATE FUNCTION public.refund_payment_v2(
  p_organization_id uuid,
  p_payment_id uuid,
  p_actor uuid,
  p_amount_minor bigint,
  p_reason text,
  p_idempotency_key text,
  p_expected_refunded_minor bigint,
  p_acknowledged_refund_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_key text := NULLIF(trim(p_idempotency_key), '');
  v_acknowledged uuid[] := COALESCE(p_acknowledged_refund_ids, '{}'::uuid[]);
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

  -- A new key. Every refund already on this payment must be acknowledged: a
  -- request that does not know about one is either a retry that lost its key
  -- or a decision made without seeing it — never silently a further refund.
  IF EXISTS (
    SELECT 1 FROM unnest(v_acknowledged) AS a(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.payment_events e
        WHERE e.id = a.id AND e.payment_id = p_payment_id AND e.event_type = 'refund')
  ) THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payment_events e
     WHERE e.payment_id = p_payment_id AND e.event_type = 'refund'
       AND e.id <> ALL (v_acknowledged)
  ) THEN
    RETURN jsonb_build_object('status', 'confirmation_required');
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

-- ── Authority: explicit statements first ───────────────────────────────────
--
-- Restated per function so intent is never implicit (and so
-- scripts/check-migration-safety.ts finds every SECURITY DEFINER revoke in
-- this file). The dynamic pass below then covers EVERY overload and grantee.

REVOKE ALL ON FUNCTION public.payment_request_digest_v1(uuid,uuid,uuid,text,bigint,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_replay_matches_v1(uuid,uuid,uuid,uuid,text,bigint,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_payment_before_order_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refund_payment_v1(uuid,uuid,uuid,bigint,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reverse_payment_v1(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_payment_v1(uuid,uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_payment_v2(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.correct_payment_v2(uuid,uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_payment_v2(uuid,uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.correct_payment_v2(uuid,uuid,uuid,text,text,text)
  TO service_role;

-- No browser role may create in schema public: an overload planted there
-- would be resolved by name like the real function.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- ── Authority: every overload, every grantee ───────────────────────────────

DO $$
DECLARE
  c_entry CONSTANT text[] := ARRAY[
    'record_payment_v1', 'record_payment_v2', 'verify_payment_v1', 'attach_payment_evidence_v1',
    'refund_payment_v2', 'reverse_payment_v2', 'correct_payment_v2'];
  c_internal CONSTANT text[] := ARRAY[
    'refund_payment_v1', 'reverse_payment_v1', 'correct_payment_v1',
    'record_payment_before_order_v1', 'verify_payment_before_order_v1',
    'reverse_payment_before_order_v1', 'refund_payment_before_order_v1',
    'lock_payment_order', 'sync_order_payment_state', 'payment_replay_matches_v1',
    'payment_request_digest_v1', 'transition_order_before_payment_authority_v1'];
  v_browser oid[];
  v_fn record;
  v_keep oid[];
  v_grantee record;
BEGIN
  -- Every role anon or authenticated is a member of, any depth, any edge.
  WITH RECURSIVE r(oid) AS (
    SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    UNION
    SELECT m.roleid FROM pg_auth_members m JOIN r ON m.member = r.oid
  ) SELECT array_agg(oid) INTO v_browser FROM r;

  -- CREATE on schema public held by any of them directly.
  FOR v_grantee IN
    SELECT DISTINCT a.grantee
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.nspname = 'public' AND a.privilege_type = 'CREATE'
       AND (a.grantee = 0 OR a.grantee = ANY (v_browser))
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %s',
      CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
  END LOOP;

  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure AS sig, p.proowner, p.proname
      FROM pg_proc p
     WHERE p.proname = ANY (c_entry || c_internal)
  LOOP
    IF v_fn.proname = ANY (c_entry) THEN
      v_keep := ARRAY[v_fn.proowner, 'service_role'::regrole::oid];
    ELSE
      -- The owner, and the owner of every SECURITY DEFINER function that calls it.
      SELECT COALESCE(array_agg(DISTINCT c.proowner), '{}'::oid[]) || v_fn.proowner INTO v_keep
        FROM pg_proc c
       WHERE c.prosecdef AND c.oid <> v_fn.oid
         AND position(v_fn.proname || '(' IN c.prosrc) > 0;
    END IF;
    FOR v_grantee IN
      SELECT DISTINCT a.grantee
        FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = v_fn.oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> ALL (v_keep)
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_fn.sig,
        CASE WHEN v_grantee.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_grantee.grantee)) END);
    END LOOP;
  END LOOP;
END;
$$;

-- ── Post-conditions: abort unless the effective authority is exactly this ──

DO $$
DECLARE
  c_entry CONSTANT text[] := ARRAY[
    'record_payment_v1', 'record_payment_v2', 'verify_payment_v1', 'attach_payment_evidence_v1',
    'refund_payment_v2', 'reverse_payment_v2', 'correct_payment_v2'];
  c_entry_sig CONSTANT text[] := ARRAY[
    'record_payment_v1(uuid,uuid,uuid,text,bigint,text,text,text)',
    'record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)',
    'verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)',
    'attach_payment_evidence_v1(uuid,uuid,uuid,text,text,bigint,text)',
    'refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])',
    'reverse_payment_v2(uuid,uuid,uuid,text)',
    'correct_payment_v2(uuid,uuid,uuid,text,text,text)'];
  c_internal CONSTANT text[] := ARRAY[
    'refund_payment_v1', 'reverse_payment_v1', 'correct_payment_v1',
    'record_payment_before_order_v1', 'verify_payment_before_order_v1',
    'reverse_payment_before_order_v1', 'refund_payment_before_order_v1',
    'lock_payment_order', 'sync_order_payment_state', 'payment_replay_matches_v1',
    'payment_request_digest_v1', 'transition_order_before_payment_authority_v1'];
  v_browser oid[];
  v_server oid[];
  v_problem text;
  v_expected oid;
  v_fn record;
  v_role oid;
  i int;
BEGIN
  WITH RECURSIVE r(oid) AS (
    SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
    UNION
    SELECT m.roleid FROM pg_auth_members m JOIN r ON m.member = r.oid
  ) SELECT array_agg(oid) INTO v_browser FROM r;
  WITH RECURSIVE r(oid) AS (
    SELECT oid FROM pg_roles WHERE rolname = 'service_role'
    UNION
    SELECT m.roleid FROM pg_auth_members m JOIN r ON m.member = r.oid
  ) SELECT array_agg(oid) INTO v_server FROM r;

  SELECT string_agg(rolname, ', ') INTO v_problem
    FROM pg_roles WHERE oid = ANY (v_browser || v_server) AND rolsuper;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '062: browser- or server-reachable role(s) % are superusers', v_problem;
  END IF;
  IF 'service_role'::regrole::oid = ANY (v_browser) THEN
    RAISE EXCEPTION '062: a browser role can become service_role';
  END IF;

  -- Entry points: exactly one function per name — the expected one, in public —
  -- SECURITY DEFINER with a fixed search_path, executable by service_role.
  FOR i IN 1 .. array_length(c_entry, 1) LOOP
    v_expected := to_regprocedure('public.' || c_entry_sig[i]);
    IF v_expected IS NULL THEN
      RAISE EXCEPTION '062: entry point public.% is missing', c_entry_sig[i];
    END IF;
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_problem
      FROM pg_proc p
     WHERE p.proname = c_entry[i] AND p.oid <> v_expected;
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION '062: unexpected financial entry-point overload(s): %', v_problem;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = v_expected AND p.prosecdef
         AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS s(cfg) WHERE s.cfg LIKE 'search_path=%')
    ) THEN
      RAISE EXCEPTION '062: entry point public.% is not SECURITY DEFINER with a fixed search_path', c_entry_sig[i];
    END IF;
    IF NOT has_function_privilege('service_role', v_expected, 'EXECUTE') THEN
      RAISE EXCEPTION '062: service_role cannot execute public.%', c_entry_sig[i];
    END IF;
  END LOOP;

  -- Every financial function, every overload, every schema.
  FOR v_fn IN
    SELECT p.oid, p.oid::regprocedure::text AS sig, p.proowner, p.proname,
           p.proname = ANY (c_internal) AS internal
      FROM pg_proc p
     WHERE p.proname = ANY (c_entry || c_internal)
  LOOP
    -- No browser-reachable role executes or owns it.
    FOREACH v_role IN ARRAY v_browser LOOP
      IF v_role = v_fn.proowner OR has_function_privilege(v_role, v_fn.oid, 'EXECUTE') THEN
        RAISE EXCEPTION '062: browser-reachable role % can execute %', pg_get_userbyid(v_role), v_fn.sig;
      END IF;
    END LOOP;
    -- The owner of an entry point is not a role the server can become.
    IF NOT v_fn.internal AND v_fn.proowner = ANY (v_server) THEN
      RAISE EXCEPTION '062: service_role can become the owner of %', v_fn.sig;
    END IF;
    IF v_fn.internal THEN
      -- No server-reachable role executes or owns an internal function.
      FOREACH v_role IN ARRAY v_server LOOP
        IF v_role = v_fn.proowner OR has_function_privilege(v_role, v_fn.oid, 'EXECUTE') THEN
          RAISE EXCEPTION '062: server-reachable role % can execute internal %', pg_get_userbyid(v_role), v_fn.sig;
        END IF;
      END LOOP;
      -- Every SECURITY DEFINER caller's owner can still execute it.
      SELECT string_agg(c.oid::regprocedure::text, ', ') INTO v_problem
        FROM pg_proc c
       WHERE c.prosecdef AND c.oid <> v_fn.oid
         AND position(v_fn.proname || '(' IN c.prosrc) > 0
         AND NOT has_function_privilege(c.proowner, v_fn.oid, 'EXECUTE');
      IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION '062: % can no longer execute %, which it calls', v_problem, v_fn.sig;
      END IF;
    END IF;
  END LOOP;

  -- Nobody a browser can become may create in schema public.
  FOREACH v_role IN ARRAY v_browser LOOP
    IF has_schema_privilege(v_role, 'public', 'CREATE') THEN
      RAISE EXCEPTION '062: browser-reachable role % can CREATE in schema public', pg_get_userbyid(v_role);
    END IF;
  END LOOP;
END;
$$;
