-- Migration: 068_payment_lifecycle_guard   *** PROVISIONAL NUMBER ***
--
-- The number is a placeholder chosen not to collide with any migration open at
-- the time of writing: PR #137 adds 065_order_preparation_queue, PR #139 adds
-- the same 065 plus 066_pack_order_round_guard, and PR #136 still carries a
-- competing 065_order_parcel_workflow that must be renumbered (likely to 067).
-- Renumber this file once that sequence is settled on main. Its content does
-- not depend on 065–067: it re-declares only two payment functions from
-- 040 / 062.
--
-- *** DRAFT — REQUIRES THE PROJECT OWNER'S PRODUCT DECISION ***
-- No product document establishes whether a draft order may take a deposit or
-- whether an order may be overpaid (see "Owner decisions" below). This
-- migration implements the CONSERVATIVE assumption — refuse both — so that the
-- owner can accept, relax or reject it. It is not applied anywhere hosted.
--
-- ── The defect (reproduced against 001–064 on PostgreSQL 16) ────────────────
-- record_payment_v2 (062) locks the order row, but never reads the order's
-- lifecycle or its outstanding balance, and verify_payment_v1 (040) settles any
-- recorded claim. A member holding payments.record + payments.manual_confirm
-- could therefore, on a 100.00 order:
--   * draft      record and verify 100.00 → payment_status 'paid' on an order
--                that is "not a sale yet" (023);
--   * cancelled  record and verify 100.00 → a cancelled order reported 'paid';
--                a Record Payment queued behind the cancellation on the order
--                lock also succeeded after the cancellation committed;
--   * completed  record and verify a further 50.00 → received 150.00;
--   * confirmed  record and verify 250.00 → received 250.00.
-- The order-detail screen hides Record Payment on draft / cancelled orders and
-- says the rule is "re-checked server-side"; it was not, at any layer.
--
-- ── The rule (evaluated under the order row lock) ───────────────────────────
-- "Claimed" = valid received (order_payment_totals.received_minor: the
-- principal of paid / refunded payments, and only already-refunded amounts of
-- reversed / failed ones) + the principal of every PENDING payment (recorded,
-- not yet confirmed or rejected — COD and duplicate_suspected included).
--
-- record_payment_v2, for a NEW payment (an identical-key replay is answered
-- first, exactly as before, so a legitimate retry never trips this rule):
--   lifecycle <> 'confirmed'            → {status: 'order_not_payable', lifecycle}
--   claimed + amount > total_minor      → {status: 'exceeds_outstanding',
--                                          outstanding_minor, currency}
--   Nothing is written in either case: no payment, event, history or audit.
--
-- verify_payment_v1 — confirmation never strands money that arrived:
--   pending → paid (staff_confirmed / manager_verified / bank_verified) is NOT
--     refused, whatever the lifecycle or balance. After the record rule, a
--     pending claim always fits the total, so a confirmation can only exceed
--     it for a claim recorded before 068 — and refund_payment_v2 refunds only
--     a confirmed payment, so refusing it would leave money that really
--     arrived unrefundable (main allowed it; policy P5 keeps the same path open
--     after a cancellation). When the confirmation takes received above the
--     total, the excess is stamped on that confirmation's immutable payment
--     event (metadata.order_excess_minor, order_total_minor); the existing
--     reconciliation `overpaid` flag then shows it until it is refunded.
--   failed → pending (mismatch → unverified) reinstates a claim, so it is a
--     new claim and follows the record rule: refused when the claim afterwards
--     would exceed the total → {status: 'claim_exceeds_total', outstanding_minor}.
--   Transitions that lower or keep the claim are never refused.
--
-- Reversals, refunds and corrections only lower or keep the claim and are
-- unchanged. Deliveries' cod_amount_minor is operational, not a claim, and is
-- not read.
--
-- ── Locking ─────────────────────────────────────────────────────────────────
-- Both functions already take the order row lock (FOR UPDATE) before anything
-- else; every payment writer does (040: "Order BEFORE Payment"), and so does
-- every lifecycle writer (transition_order_status_v1, 026 → 063). The
-- lifecycle is read from the locked row itself; the claim is read in a later
-- statement, which in READ COMMITTED takes a fresh snapshot after the lock is
-- held — so a cancellation, completion or concurrent payment that committed
-- while this call waited is seen. No new lock, no new lock order.
--
-- ── Owner decisions this draft takes conservatively ─────────────────────────
--   1. Draft deposits: refused. (Allowing them means a deposit on an order
--      that may never be confirmed; discard would then need a refund path.)
--   2. Overpayment: refused at recording. The cashier returns change in hand
--      and records the order amount. (DATA_MODEL.md refund_status "includes
--      overpayments", so overpayment was anticipated as a state, not
--      established as a recording policy.)
--   3. Refunds do not reopen the outstanding balance (received_minor keeps a
--      refunded principal, per DATA_MODEL.md "refunds do not undo the fact
--      that money was received"). A re-collection after a refund is refused.
--   4. A pending claim (COD included) occupies the balance until it is
--      confirmed, rejected (mismatch) or reversed.
--   5. Payment on a completed order: refused (it is already paid).
--   6. Cancelled orders: no new payment; earlier claims stay confirmable so
--      that they can be refunded.
--   7. Legacy claims (recorded before 068) stay confirmable even on a draft or
--      above the total, so that money that arrived can be refunded; the excess
--      is stamped and flagged, never silently absorbed.
--   8. A real bank / KHQR overpayment is recorded at its true amount only
--      through the manager-level "record with excess" action below, and the
--      excess is returned through the existing refund (pilot policy, draft).
--
-- Forward-only. No table, column, index or policy change. Additive only: one
-- payment_event_type value ('excess_returned'), one permission
-- (payments.record_excess → OWNER, MANAGER) and two new entry points
-- (record_payment_with_excess_v1, return_payment_excess_v1; EXECUTE for
-- service_role only). record_payment_v2 and verify_payment_v1 keep their
-- signatures, owners and grants (CREATE OR REPLACE).

-- ── Precondition ─────────────────────────────────────────────────────────────
-- 068 re-declares 062's record_payment_v2. Applied without 062, CREATE OR
-- REPLACE would instead CREATE it — publishing a recording entry point ahead of
-- 062's replay identity and authority checks. Abort instead (nothing applied).
DO $$
BEGIN
  IF to_regprocedure('public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)') IS NULL
     OR to_regprocedure('public.payment_replay_matches_v1(uuid,uuid,uuid,uuid,text,bigint,text,text)') IS NULL
     OR to_regprocedure('public.verify_payment_before_order_v1(uuid,uuid,uuid,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '068_payment_lifecycle_guard requires migrations 040 and 062 to be applied first';
  END IF;
END $$;

-- ── record_payment_v2 (062's body + the 068 guard) ───────────────────────────

CREATE OR REPLACE FUNCTION public.record_payment_v2(
  p_organization_id uuid, p_order_id uuid, p_recorded_by uuid,
  p_method text, p_amount_minor bigint, p_reference text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  result jsonb;
  v_key text := NULLIF(trim(p_idempotency_key), '');
  v_existing public.payments%ROWTYPE;
  v_order record;
  v_claimed bigint;
BEGIN
  -- 068: the lifecycle and total are read from the locked row itself.
  SELECT id, lifecycle_status, total_minor, currency INTO v_order FROM public.orders
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

  -- 068: a NEW claim needs a confirmed order with enough outstanding balance.
  -- An invalid amount or method is left to the recording body to report.
  IF p_amount_minor > 0 AND p_method IN ('cash', 'khqr', 'bank_transfer', 'cod') THEN
    IF v_order.lifecycle_status <> 'confirmed' THEN
      RETURN jsonb_build_object('status', 'order_not_payable',
        'lifecycle', v_order.lifecycle_status::text);
    END IF;
    SELECT t.received_minor + COALESCE((SELECT SUM(p.amount_minor) FROM public.payments p
        WHERE p.organization_id = p_organization_id AND p.order_id = p_order_id
          AND p.status = 'pending'), 0)
      INTO v_claimed
      FROM public.order_payment_totals t
     WHERE t.order_id = p_order_id AND t.organization_id = p_organization_id;
    IF v_claimed + p_amount_minor > v_order.total_minor THEN
      RETURN jsonb_build_object('status', 'exceeds_outstanding',
        'outstanding_minor', GREATEST(v_order.total_minor - v_claimed, 0),
        'currency', v_order.currency);
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

-- ── verify_payment_v1 (040's wrapper + the 068 guard) ────────────────────────

CREATE OR REPLACE FUNCTION public.verify_payment_v1(
  p_organization_id uuid, p_payment_id uuid, p_actor uuid,
  p_expected_from text, p_to text, p_reason text DEFAULT NULL, p_metadata jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  target uuid;
  result jsonb;
  v_payment record;
  v_total bigint;
  v_received bigint;
  v_held bigint;
  v_claimed bigint;
BEGIN
  target := public.lock_payment_order(p_organization_id,p_payment_id);
  IF target IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF NOT COALESCE(CASE p_expected_from
    WHEN 'unverified' THEN p_to IN ('staff_confirmed','bank_verified','mismatch')
    WHEN 'staff_confirmed' THEN p_to IN ('manager_verified','bank_verified','mismatch')
    WHEN 'manager_verified' THEN p_to IN ('bank_verified','mismatch')
    WHEN 'bank_verified' THEN p_to = 'mismatch'
    WHEN 'mismatch' THEN p_to = 'unverified'
    WHEN 'duplicate_suspected' THEN p_to IN ('unverified','staff_confirmed','manager_verified','mismatch')
    ELSE false END, false)
  THEN RETURN jsonb_build_object('status','invalid_transition'); END IF;

  -- 068. The order row is locked (lock_payment_order); the stale / terminal
  -- checks stay with the body, so only a payment still in the expected state
  -- is judged here.
  SELECT id, status, verification_state, amount_minor INTO v_payment FROM public.payments
    WHERE id = p_payment_id AND organization_id = p_organization_id;
  IF v_payment.verification_state::text = p_expected_from AND (
       (v_payment.status = 'pending' AND p_to IN ('staff_confirmed','manager_verified','bank_verified'))
    OR (v_payment.status = 'failed' AND p_to = 'unverified')) THEN
    SELECT total_minor INTO v_total FROM public.orders
      WHERE id = target AND organization_id = p_organization_id;
    SELECT received_minor INTO v_received FROM public.order_payment_totals
      WHERE order_id = target AND organization_id = p_organization_id;
    IF v_payment.status = 'failed' THEN
      -- Reinstating a rejected claim is a new claim: the record rule. What it
      -- contributes while failed is its refunded amount (order_payment_totals).
      SELECT COALESCE(SUM(e.amount_minor), 0) INTO v_held FROM public.payment_events e
        WHERE e.payment_id = p_payment_id AND e.organization_id = p_organization_id
          AND e.event_type = 'refund';
      SELECT v_received - v_held + COALESCE(SUM(p.amount_minor), 0) INTO v_claimed
        FROM public.payments p
       WHERE p.organization_id = p_organization_id AND p.order_id = target
         AND p.status = 'pending' AND p.id <> p_payment_id;
      IF v_claimed + v_payment.amount_minor > v_total THEN
        RETURN jsonb_build_object('status', 'claim_exceeds_total',
          'outstanding_minor', GREATEST(v_total - v_claimed, 0));
      END IF;
    ELSIF v_received + v_payment.amount_minor > v_total THEN
      -- Settling a claim recorded before 068 above the total: allowed, and the
      -- excess it creates is written into its own immutable event.
      p_metadata := COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'order_excess_minor', v_received + v_payment.amount_minor - GREATEST(v_received, v_total),
        'order_total_minor', v_total);
    END IF;
  END IF;

  result := public.verify_payment_before_order_v1(p_organization_id,p_payment_id,p_actor,
    p_expected_from,p_to,p_reason,p_metadata);
  IF result->>'status' = 'success' THEN
    PERFORM public.sync_order_payment_state(p_organization_id,target,p_actor,
      COALESCE(p_reason,'Payment verification'));
  END IF;
  RETURN result;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- RECORD WITH EXCESS — a real bank / KHQR transfer above the outstanding amount
-- *** DRAFT — pilot policy proposed by the owner, not yet approved ***
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Ordinary recording (record_payment_v2 above) still refuses any amount above
-- the unclaimed total, so an accidental overpayment is never a cashier action.
-- When a customer really transferred more, a member holding the manager-level
-- payments.record_excess grant records the FULL amount received, and the
-- excess is returned through the existing audited refund (refund_payment_v2).
--
-- record_payment_with_excess_v1
--   * khqr / bank_transfer only (cash change is given in hand; COD is
--     collected against a known amount) → otherwise 'method_not_allowed';
--   * required: the transfer reference, a reason, an idempotency key, and
--     p_expected_outstanding_minor — the outstanding amount the member was
--     shown. A different outstanding amount (another payment, a rejection or
--     a reversal committed meanwhile) is 'stale': nothing is written, so a
--     stale screen can never record a different excess than it showed;
--   * amount ≤ outstanding → 'no_excess' (use ordinary recording);
--   * the reference is a traceability key the member typed, NOT proof that a
--     transfer happened: the payment starts pending / unverified (or
--     duplicate_suspected when the reference matches another active payment,
--     the 035 rule) exactly like any other claim, and only verification
--     settles it;
--   * under the order row lock (the lock ordinary recording takes first), then
--     the same reference advisory lock as ordinary recording;
--   * one created event carries the excess facts — excess_minor,
--     expected_outstanding_minor, order_total_minor — beside 062's request
--     digest (the reason is the payment note, so it is part of the digest);
--   * the mandatory audit row payments.record_excess commits in the same
--     transaction (an audit failure rolls everything back);
--   * a key replays only the original member's original request (062's rule),
--     and only for a payment recorded with excess; anything else under it is
--     'idempotency_conflict'.
--
-- return_payment_excess_v1 — returning the excess IS a refund: it calls
--   refund_payment_v2 (payments.refund, its key, acknowledgement, expected
--   total, mandatory audit and ledger semantics all unchanged). Before it, under
--   the same locks in the same order (refund key advisory lock → order →
--   payment), it bounds the amount by
--     LEAST(recorded excess − excess already returned, net − order total)
--   so it can never return part of the sale itself ('exceeds_returnable_excess').
--   After it, an 'excess_returned' event (amount, refund_event_id) and the
--   audit row payments.return_excess are written in the same transaction. That
--   event is the only evidence for the "excess returned" label: a refund made
--   through the ordinary refund operation is never labelled, even when it
--   happens to equal the excess. The order's refund_status keeps its meaning
--   (money was returned → 'partial').

ALTER TYPE public.payment_event_type ADD VALUE IF NOT EXISTS 'excess_returned';

INSERT INTO public.permissions (key, description, risk_level) VALUES
  ('payments.record_excess',
   'Record a bank transfer or KHQR payment above the order''s outstanding amount; the excess must be refunded',
   'critical')
ON CONFLICT (key) DO NOTHING;

-- Manager-level: Owner and Manager (the tier of payments.verify). Returning the
-- excess needs payments.refund, which stays Owner-only (migration 036).
DO $$
DECLARE
  v_perm uuid;
  v_role uuid;
BEGIN
  SELECT id INTO v_perm FROM public.permissions WHERE key = 'payments.record_excess';
  FOR v_role IN SELECT id FROM public.roles
     WHERE organization_id IS NULL AND system_role IN ('OWNER', 'MANAGER') LOOP
    INSERT INTO public.role_permissions (role_id, permission_id) VALUES (v_role, v_perm)
      ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE FUNCTION public.record_payment_with_excess_v1(
  p_organization_id uuid,
  p_order_id uuid,
  p_recorded_by uuid,
  p_method text,
  p_amount_minor bigint,
  p_reference text,
  p_idempotency_key text,
  p_reason text,
  p_expected_outstanding_minor bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_reference text := NULLIF(trim(p_reference), '');
  v_reason text := NULLIF(trim(p_reason), '');
  v_key text := NULLIF(trim(p_idempotency_key), '');
  v_order record;
  v_existing public.payments%ROWTYPE;
  v_created public.payment_events%ROWTYPE;
  v_claimed bigint;
  v_outstanding bigint;
  v_excess bigint;
  v_duplicate boolean;
  v_state public.payment_verification_state;
  v_payment_id uuid;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'record_payment_with_excess_v1: organization_id is required';
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('khqr', 'bank_transfer') THEN
    RETURN jsonb_build_object('status', 'method_not_allowed');
  END IF;
  IF v_reference IS NULL THEN RETURN jsonb_build_object('status', 'reference_required'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('status', 'reason_required'); END IF;
  IF v_key IS NULL THEN RETURN jsonb_build_object('status', 'idempotency_key_required'); END IF;
  IF p_expected_outstanding_minor IS NULL OR p_expected_outstanding_minor < 0 THEN
    RETURN jsonb_build_object('status', 'expected_outstanding_required');
  END IF;

  SELECT id, lifecycle_status, total_minor, currency INTO v_order FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  SELECT * INTO v_existing FROM public.payments
    WHERE organization_id = p_organization_id AND idempotency_key = v_key;
  IF FOUND THEN
    SELECT * INTO v_created FROM public.payment_events
      WHERE payment_id = v_existing.id AND event_type = 'created';
    IF NOT COALESCE(v_created.metadata ? 'excess_minor', false)
       OR NOT public.payment_replay_matches_v1(v_existing.id, p_organization_id, p_order_id,
         p_recorded_by, p_method, p_amount_minor, v_reference, v_reason) THEN
      RETURN jsonb_build_object('status', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('status', 'success', 'payment_id', v_existing.id, 'replayed', true,
      'duplicate_suspected', v_existing.verification_state = 'duplicate_suspected',
      'excess_minor', (v_created.metadata ->> 'excess_minor')::bigint,
      'currency', v_existing.currency);
  END IF;

  IF v_order.lifecycle_status <> 'confirmed' THEN
    RETURN jsonb_build_object('status', 'order_not_payable',
      'lifecycle', v_order.lifecycle_status::text);
  END IF;

  -- The same claim as record_payment_v2, read after the lock.
  SELECT t.received_minor + COALESCE((SELECT SUM(p.amount_minor) FROM public.payments p
      WHERE p.organization_id = p_organization_id AND p.order_id = p_order_id
        AND p.status = 'pending'), 0)
    INTO v_claimed
    FROM public.order_payment_totals t
   WHERE t.order_id = p_order_id AND t.organization_id = p_organization_id;
  v_outstanding := GREATEST(v_order.total_minor - v_claimed, 0);
  IF p_expected_outstanding_minor <> v_outstanding THEN
    RETURN jsonb_build_object('status', 'stale', 'outstanding_minor', v_outstanding,
      'currency', v_order.currency);
  END IF;
  IF p_amount_minor <= v_outstanding THEN
    RETURN jsonb_build_object('status', 'no_excess', 'outstanding_minor', v_outstanding,
      'currency', v_order.currency);
  END IF;
  v_excess := p_amount_minor - v_outstanding;

  -- The reference rule of 035 / 043 / 062's recording body: same lock key, same
  -- check. A matching active reference is suspicious, never a refusal.
  PERFORM pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_reference));
  SELECT EXISTS (SELECT 1 FROM public.payments
    WHERE organization_id = p_organization_id AND reference = v_reference
      AND status <> 'reversed') INTO v_duplicate;
  v_state := CASE WHEN v_duplicate THEN 'duplicate_suspected' ELSE 'unverified' END;

  INSERT INTO public.payments (
    organization_id, order_id, method, currency, amount_minor,
    status, verification_state, reference, idempotency_key, note, recorded_by
  ) VALUES (
    p_organization_id, p_order_id, p_method::public.payment_method, v_order.currency,
    p_amount_minor, 'pending', v_state, v_reference, v_key, v_reason, p_recorded_by
  )
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_payment_id;
  IF v_payment_id IS NULL THEN
    -- A concurrent request with this key, naming another order (whose lock
    -- this call does not hold), committed first. Never this request's replay.
    RETURN jsonb_build_object('status', 'idempotency_conflict');
  END IF;

  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, amount_minor, currency,
    to_verification, actor_user_id, reason, metadata
  ) VALUES (
    p_organization_id, v_payment_id, 'created', p_amount_minor, v_order.currency,
    v_state, p_recorded_by, v_reason,
    jsonb_build_object(
      'request_reference_digest', public.payment_request_digest_v1(
        p_organization_id, p_order_id, p_recorded_by, p_method, p_amount_minor,
        v_reference, v_reason),
      'request_digest_version', 1,
      'excess_minor', v_excess,
      'expected_outstanding_minor', v_outstanding,
      'order_total_minor', v_order.total_minor)
  );

  IF v_duplicate THEN
    INSERT INTO public.payment_events (
      organization_id, payment_id, event_type, actor_user_id, reason, metadata
    ) VALUES (
      p_organization_id, v_payment_id, 'duplicate_flagged', p_recorded_by,
      'Reference matches another active payment in this organization',
      jsonb_build_object('kind', 'reference', 'reference', v_reference)
    );
  END IF;

  PERFORM public.sync_order_payment_state(p_organization_id, p_order_id, p_recorded_by,
    'Payment recorded with excess');

  BEGIN
    INSERT INTO public.audit_logs(
      organization_id, actor_user_id, action, resource_type, resource_id, after_json, reason
    ) VALUES (
      p_organization_id, p_recorded_by, 'payments.record_excess', 'payments', v_payment_id::text,
      jsonb_build_object(
        'order_id', p_order_id, 'method', p_method, 'amount_minor', p_amount_minor,
        'currency', v_order.currency, 'excess_minor', v_excess,
        'expected_outstanding_minor', v_outstanding, 'duplicate_suspected', v_duplicate),
      v_reason
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
  END;

  RETURN jsonb_build_object('status', 'success', 'payment_id', v_payment_id, 'replayed', false,
    'duplicate_suspected', v_duplicate, 'excess_minor', v_excess, 'currency', v_order.currency);
END;
$$;

CREATE FUNCTION public.return_payment_excess_v1(
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
  v_target uuid;
  v_payment public.payments%ROWTYPE;
  v_refund public.payment_events%ROWTYPE;
  v_excess bigint;
  v_returned bigint;
  v_net bigint;
  v_total bigint;
  v_returnable bigint;
  v_result jsonb;
BEGIN
  IF v_key IS NULL THEN RETURN jsonb_build_object('status', 'idempotency_key_required'); END IF;

  -- refund_payment_v2's own lock order: the refund key, then order, then payment.
  PERFORM pg_advisory_xact_lock(
    hashtext('apsa:payment-refund:' || p_organization_id::text || ':' || v_key));
  v_target := public.lock_payment_order(p_organization_id, p_payment_id);
  IF v_target IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;

  -- A used key replays only an excess return; refund_payment_v2 then applies its
  -- own replay rule (same member, payment, amount and reason).
  SELECT * INTO v_refund FROM public.payment_events
   WHERE organization_id = p_organization_id AND event_type = 'refund' AND idempotency_key = v_key
   ORDER BY created_at, id LIMIT 1;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.payment_events
        WHERE payment_id = v_refund.payment_id AND event_type = 'excess_returned'
          AND metadata ->> 'refund_event_id' = v_refund.id::text) THEN
      RETURN jsonb_build_object('status', 'idempotency_conflict');
    END IF;
    RETURN public.refund_payment_v2(p_organization_id, p_payment_id, p_actor, p_amount_minor,
      p_reason, v_key, p_expected_refunded_minor, p_acknowledged_refund_ids);
  END IF;

  SELECT (metadata ->> 'excess_minor')::bigint INTO v_excess FROM public.payment_events
   WHERE payment_id = p_payment_id AND event_type = 'created';
  IF v_excess IS NULL THEN RETURN jsonb_build_object('status', 'no_recorded_excess'); END IF;
  IF v_payment.status NOT IN ('paid', 'refunded') THEN
    RETURN jsonb_build_object('status', 'invalid_state', 'current', v_payment.status::text);
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_returned FROM public.payment_events
   WHERE payment_id = p_payment_id AND event_type = 'excess_returned';
  SELECT net_minor, total_minor INTO v_net, v_total FROM public.order_payment_totals
   WHERE order_id = v_target AND organization_id = p_organization_id;
  v_returnable := GREATEST(LEAST(v_excess - v_returned, v_net - v_total), 0);
  IF p_amount_minor > v_returnable THEN
    RETURN jsonb_build_object('status', 'exceeds_returnable_excess',
      'returnable_excess_minor', v_returnable, 'currency', v_payment.currency);
  END IF;

  v_result := public.refund_payment_v2(p_organization_id, p_payment_id, p_actor, p_amount_minor,
    p_reason, v_key, p_expected_refunded_minor, p_acknowledged_refund_ids);
  IF v_result ->> 'status' <> 'success' OR COALESCE((v_result ->> 'replayed')::boolean, false) THEN
    RETURN v_result;
  END IF;

  SELECT * INTO STRICT v_refund FROM public.payment_events
   WHERE organization_id = p_organization_id AND payment_id = p_payment_id
     AND event_type = 'refund' AND idempotency_key = v_key;
  INSERT INTO public.payment_events (
    organization_id, payment_id, event_type, amount_minor, currency, actor_user_id, reason, metadata
  ) VALUES (
    p_organization_id, p_payment_id, 'excess_returned', p_amount_minor, v_payment.currency,
    p_actor, p_reason,
    jsonb_build_object('refund_event_id', v_refund.id, 'recorded_excess_minor', v_excess,
      'excess_returned_total_minor', v_returned + p_amount_minor)
  );
  BEGIN
    INSERT INTO public.audit_logs(
      organization_id, actor_user_id, action, resource_type, resource_id, after_json, reason
    ) VALUES (
      p_organization_id, p_actor, 'payments.return_excess', 'payments', p_payment_id::text,
      jsonb_build_object('refund_event_id', v_refund.id, 'amount_minor', p_amount_minor,
        'currency', v_payment.currency, 'recorded_excess_minor', v_excess,
        'excess_returned_total_minor', v_returned + p_amount_minor),
      p_reason
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
  END;

  RETURN v_result || jsonb_build_object('excess_returned', true,
    'refund_event_id', v_refund.id,
    'returnable_excess_minor', v_returnable - p_amount_minor);
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_with_excess_v1(uuid,uuid,uuid,text,bigint,text,text,text,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.return_payment_excess_v1(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_payment_with_excess_v1(uuid,uuid,uuid,text,bigint,text,text,text,bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.return_payment_excess_v1(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])
  TO service_role;

-- CREATE OR REPLACE keeps each function's owner and ACL; restated so this file
-- is self-describing and the migration safety check sees the REVOKE.
REVOKE ALL ON FUNCTION public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_payment_v1(uuid,uuid,uuid,text,text,text,jsonb)
  TO service_role;
