-- Migration: 035_payment_rpc
-- Purpose: Atomic, server-authoritative Payment write path.
-- Functions: record_payment_v1, attach_payment_evidence_v1, verify_payment_v1,
--            reverse_payment_v1, refund_payment_v1, correct_payment_v1
--
-- SECURITY MODEL — identical posture to migrations 024/027
--   Every function takes p_organization_id, which is safe ONLY because
--   EXECUTE is revoked from PUBLIC, anon and authenticated below. The sole
--   caller is src/server/payments/service.ts using the service role, and
--   organization_id always comes from a verified DB membership, never from a
--   client request body. SET search_path = public, auth on every function
--   prevents search_path injection against a SECURITY DEFINER routine.
--
-- ERROR CONVENTION
--   Expected business outcomes RETURN a JSONB {status: '...'} the application
--   maps to a domain-safe error. Impossible states RAISE, because they mean a
--   bug or an attack and must not be swallowed.
--
-- WHERE THE STATE MACHINE LIVES
--   The verification transition TABLE (which state may follow which) is
--   authoritative in TypeScript: src/server/payments/state-machine.ts —
--   pure, exhaustively tested, shared by every future caller. Exactly the
--   same division of labour as transition_order_status_v1 (migration 024):
--   these functions enforce what only the database can guarantee —
--   atomicity, tenant scope, optimistic concurrency and terminal-state
--   freezes — regardless of which server code calls them.

-- ── record_payment_v1 ─────────────────────────────────────────────────────────
--
-- Creates a payment record. This is the "Confirm payment received" / "record
-- a payment" primitive — it does NOT by itself mean the money is verified at
-- any particular trust level; it starts at verification_state = 'unverified'
-- (or 'duplicate_suspected' — see below) and status = 'pending'. Moving to
-- 'paid' happens through verify_payment_v1, driven by a human or a future
-- bank adapter.
--
-- IDEMPOTENCY: p_idempotency_key, when supplied, makes a retried call
-- (double-click, network retry, replayed request) return the SAME payment
-- rather than creating a second one. Enforced by uniq_payments_idempotency
-- (migration 034) via ON CONFLICT — safe under concurrent identical calls,
-- not just sequential ones.
--
-- DUPLICATE REFERENCE: a reference collision with another active (non-
-- reversed) payment in the same organization is suspicious, not impossible.
-- The payment is still recorded, but starts flagged duplicate_suspected
-- rather than unverified, and a 'duplicate_flagged' event explains why.

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
    SELECT EXISTS (
      SELECT 1 FROM public.payments
      WHERE organization_id = p_organization_id
        AND reference = v_reference
        AND status <> 'reversed'
    ) INTO v_duplicate;
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
      'Reference matches another active payment in this organization',
      jsonb_build_object('reference', v_reference)
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'success', 'payment_id', v_payment_id,
    'duplicate_suspected', v_duplicate, 'replayed', false
  );
END;
$$;

-- ── attach_payment_evidence_v1 ────────────────────────────────────────────────
--
-- Supporting data only. Deliberately never touches payments.status or
-- payments.verification_state — see migration 034's header and SECURITY.md
-- §41 ("Never determine actual payment success based only on: screenshot").

CREATE OR REPLACE FUNCTION public.attach_payment_evidence_v1(
  p_organization_id        UUID,
  p_payment_id             UUID,
  p_uploaded_by            UUID,
  p_evidence_type          TEXT,
  p_storage_ref            TEXT,
  p_extracted_amount_minor BIGINT DEFAULT NULL,
  p_extracted_reference    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_evidence_id UUID;
BEGIN
  IF p_evidence_type NOT IN ('screenshot', 'qr_scan', 'receipt', 'other') THEN
    RETURN jsonb_build_object('status', 'invalid_evidence_type');
  END IF;

  IF p_storage_ref IS NULL OR length(trim(p_storage_ref)) = 0 THEN
    RETURN jsonb_build_object('status', 'invalid_storage_ref');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE id = p_payment_id AND organization_id = p_organization_id
  ) THEN
    RETURN jsonb_build_object('status', 'payment_not_found');
  END IF;

  IF p_extracted_amount_minor IS NOT NULL AND p_extracted_amount_minor < 0 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;

  INSERT INTO public.payment_evidence (
    organization_id, payment_id, evidence_type, storage_ref,
    extracted_amount_minor, extracted_reference, uploaded_by
  ) VALUES (
    p_organization_id, p_payment_id, p_evidence_type::public.payment_evidence_type,
    trim(p_storage_ref), p_extracted_amount_minor, NULLIF(trim(p_extracted_reference), ''), p_uploaded_by
  )
  RETURNING id INTO v_evidence_id;

  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, actor_user_id, metadata
  ) VALUES (
    p_organization_id, p_payment_id, 'evidence_attached', p_uploaded_by,
    jsonb_build_object('evidence_id', v_evidence_id, 'evidence_type', p_evidence_type)
  );

  RETURN jsonb_build_object('status', 'success', 'evidence_id', v_evidence_id);
END;
$$;

-- ── verify_payment_v1 ─────────────────────────────────────────────────────────
--
-- Moves verification_state and, as its trusted consequence, status. The
-- allowed-transition TABLE lives in TypeScript (state-machine.ts) and is
-- checked by the service before this is called — exactly like
-- transition_order_status_v1, this function enforces only what the database
-- alone can guarantee: atomicity, optimistic concurrency (p_expected_from)
-- and the terminal freeze once a payment is reversed or refunded.

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
  SELECT id, status, verification_state INTO v_payment
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

  RETURN jsonb_build_object(
    'status', 'success', 'from', p_expected_from, 'to', p_to, 'payment_status', v_new_status::TEXT
  );
END;
$$;

-- ── reverse_payment_v1 ────────────────────────────────────────────────────────
--
-- Reversal never deletes or rewrites the original payment — it appends an
-- event and moves status to the terminal 'reversed' state. Allowed from
-- 'pending' or 'paid' only: a reversal undoes a claimed/settled payment, not
-- one that already failed, was already reversed, or was refunded (refund is
-- the correct tool once money has actually moved back).

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

  SELECT id, status INTO v_payment
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

  RETURN jsonb_build_object('status', 'success');
END;
$$;

-- ── refund_payment_v1 ─────────────────────────────────────────────────────────
--
-- Refunded amount is DERIVED by summing prior 'refund' events for this
-- payment — payments.amount_minor is never mutated (DATA_MODEL.md §53).
-- Supports partial refunds: status only moves to 'refunded' once the
-- cumulative refunded total equals the original amount; a partial refund
-- leaves status at 'paid' with the refund history visible in payment_events.

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

  SELECT id, status, amount_minor INTO v_payment
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

  RETURN jsonb_build_object(
    'status', 'success',
    'refunded_total', v_new_total,
    'fully_refunded', v_new_total = v_payment.amount_minor
  );
END;
$$;

-- ── correct_payment_v1 ────────────────────────────────────────────────────────
--
-- Correction is narrow by design: it may only update `reference` and `note`
-- — annotative fields, never amount/method/currency (a wrong amount is a
-- reversal-and-re-record situation, not a "correction", because the original
-- financial claim itself was wrong, not just its paperwork). Every correction
-- appends an event carrying the before/after values, so the original claim
-- remains visible even after being corrected.

CREATE OR REPLACE FUNCTION public.correct_payment_v1(
  p_organization_id UUID,
  p_payment_id      UUID,
  p_actor           UUID,
  p_reason          TEXT,
  p_new_reference   TEXT DEFAULT NULL,
  p_new_note        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_payment     RECORD;
  v_ref_clean   TEXT := NULLIF(trim(p_new_reference), '');
  v_note_clean  TEXT := NULLIF(trim(p_new_note), '');
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('status', 'reason_required');
  END IF;

  IF v_ref_clean IS NULL AND v_note_clean IS NULL THEN
    RETURN jsonb_build_object('status', 'no_changes');
  END IF;

  SELECT id, reference, note INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id AND organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  UPDATE public.payments
  SET
    reference = COALESCE(v_ref_clean, reference),
    note      = COALESCE(v_note_clean, note)
  WHERE id = p_payment_id;

  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, actor_user_id, reason, metadata
  ) VALUES (
    p_organization_id, p_payment_id, 'correction', p_actor, p_reason,
    jsonb_build_object(
      'before', jsonb_build_object('reference', v_payment.reference, 'note', v_payment.note),
      'after',  jsonb_build_object(
        'reference', COALESCE(v_ref_clean, v_payment.reference),
        'note',      COALESCE(v_note_clean, v_payment.note)
      )
    )
  );

  RETURN jsonb_build_object('status', 'success');
END;
$$;

-- ── Privileges ────────────────────────────────────────────────────────────────
--
-- Same posture as migrations 024/027: revoke from PUBLIC (which would
-- otherwise implicitly cover service_role too — see migration 024's own
-- correction note), then grant explicitly to service_role only. anon and
-- authenticated stay revoked because these functions accept
-- p_organization_id — EXECUTE for a JWT client would be a direct
-- cross-tenant write primitive.

REVOKE EXECUTE ON FUNCTION public.record_payment_v1(UUID, UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.attach_payment_evidence_v1(UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_payment_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_payment_v1(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_payment_v1(UUID, UUID, UUID, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.correct_payment_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_payment_v1(UUID, UUID, UUID, TEXT, BIGINT, TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_payment_evidence_v1(UUID, UUID, UUID, TEXT, TEXT, BIGINT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_payment_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_payment_v1(UUID, UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_payment_v1(UUID, UUID, UUID, BIGINT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.correct_payment_v1(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;
