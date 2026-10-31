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
-- verify_payment_v1, for a transition that RAISES the order's claim:
--   pending → paid (staff_confirmed / manager_verified / bank_verified)
--     raises received; failed → pending (mismatch → unverified) reinstates a
--     claim. Refused when:
--       lifecycle = 'draft'             → order_not_payable
--       pending → paid: received afterwards would exceed total_minor
--       failed → pending: the claim afterwards would exceed total_minor
--                                       → exceeds_outstanding
--   Settling is measured against received money only, so two over-claims
--   recorded before 068 cannot block each other: the first to be confirmed
--   settles, the other is then refused.
--   With the record rule in place, a pending payment is already counted in the
--   claim, so pending → paid can only exceed the total for a claim recorded
--   before this migration. Transitions that lower or keep the claim (to
--   mismatch, paid → stronger verification) are never refused.
--   A CANCELLED order is deliberately not refused here: money recorded before
--   the cancellation must still be confirmable, because refund_payment_v2 only
--   refunds a 'paid' payment — refusing it would leave real money unrefundable.
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
--
-- Forward-only. No table, column, index, policy or grant changes; both
-- functions keep their signatures, owners and grants (CREATE OR REPLACE).

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
  v_order record;
  v_payment record;
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

  -- 068: a transition that raises the order's claim. The order row is locked
  -- (lock_payment_order); the stale / terminal checks stay with the body, so
  -- only a payment that is still in the expected state is judged here.
  SELECT id, status, verification_state, amount_minor INTO v_payment FROM public.payments
    WHERE id = p_payment_id AND organization_id = p_organization_id;
  IF v_payment.verification_state::text = p_expected_from AND (
       (v_payment.status = 'pending' AND p_to IN ('staff_confirmed','manager_verified','bank_verified'))
    OR (v_payment.status = 'failed' AND p_to = 'unverified')) THEN
    SELECT lifecycle_status, total_minor, currency INTO v_order FROM public.orders
      WHERE id = target AND organization_id = p_organization_id;
    IF v_order.lifecycle_status = 'draft' THEN
      RETURN jsonb_build_object('status', 'order_not_payable', 'lifecycle', 'draft');
    END IF;
    -- What this payment contributes now: nothing while pending, its refunded
    -- amount while failed (order_payment_totals).
    SELECT COALESCE(SUM(e.amount_minor), 0) INTO v_held FROM public.payment_events e
      WHERE e.payment_id = p_payment_id AND e.organization_id = p_organization_id
        AND e.event_type = 'refund';
    IF v_payment.status = 'pending' THEN v_held := 0; END IF;
    -- Settling (pending → paid) is measured against money already received,
    -- so two over-claims cannot block each other's confirmation; reinstating a
    -- rejected claim (failed → pending) against every claim, as recording is.
    SELECT t.received_minor + CASE WHEN v_payment.status = 'pending' THEN 0
        ELSE COALESCE((SELECT SUM(p.amount_minor) FROM public.payments p
          WHERE p.organization_id = p_organization_id AND p.order_id = target
            AND p.status = 'pending' AND p.id <> p_payment_id), 0) END
      INTO v_claimed
      FROM public.order_payment_totals t
     WHERE t.order_id = target AND t.organization_id = p_organization_id;
    IF v_claimed - v_held + v_payment.amount_minor > v_order.total_minor THEN
      RETURN jsonb_build_object('status', 'exceeds_outstanding',
        'outstanding_minor', GREATEST(v_order.total_minor - (v_claimed - v_held), 0),
        'currency', v_order.currency);
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
