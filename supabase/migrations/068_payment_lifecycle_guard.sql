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
--   8. A real bank / KHQR transfer above a STILL-POSITIVE outstanding amount
--      is recorded at its true amount only through the manager-level "record
--      with excess" action below, and the excess is returned through the
--      existing refund (pilot policy, draft). A transfer received when nothing
--      is outstanding is an unallocated receipt, outside this feature. Cash
--      and COD excess is change given in hand and never recorded.
--   9. A transfer reference recorded with excess is exclusive per
--      organization and method (canonical form; reversed or rejected payments
--      release it) — see "Transfer reference" below.
--
-- Forward-only. Additive only: one payment_event_type value
-- ('excess_returned'), one permission (payments.record_excess → OWNER,
-- MANAGER), one column (payments.excess_recorded, default false, immutable),
-- two indexes over it / the canonical reference, and new functions
-- (payment_reference_canonical_v1, payment_reference_held_v1,
-- payment_excess_state_v1, record_payment_with_excess_v1,
-- return_payment_excess_v1, reinstate_excess_payment_v1,
-- list_excess_to_return_v1; EXECUTE for service_role only where callable).
-- record_payment_v2 and verify_payment_v1 keep their signatures, owners and
-- grants (CREATE OR REPLACE). No existing row is changed: every existing
-- payment gets excess_recorded = false, so no index can meet a conflict.
--
-- Rollback (if 068 must be withdrawn before any excess payment exists):
-- re-apply 062's record_payment_v2 and 040's verify_payment_v1, drop the
-- functions, the two indexes, the trigger and the column, and delete the
-- payments.record_excess permission rows. The enum value cannot be dropped
-- and is harmless unused. After an excess payment exists, withdraw forward
-- only (its created event and audit rows are append-only history).

-- ── Precondition ─────────────────────────────────────────────────────────────
-- 068 re-declares 062's record_payment_v2. Applied without 062, CREATE OR
-- REPLACE would instead CREATE it — publishing a recording entry point ahead of
-- 062's replay identity and authority checks. Abort instead (nothing applied).
DO $$
BEGIN
  IF to_regprocedure('public.record_payment_v2(uuid,uuid,uuid,text,bigint,text,text,text)') IS NULL
     OR to_regprocedure('public.payment_replay_matches_v1(uuid,uuid,uuid,uuid,text,bigint,text,text)') IS NULL
     OR to_regprocedure('public.verify_payment_before_order_v1(uuid,uuid,uuid,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.refund_payment_v2(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])') IS NULL
     OR to_regclass('public.order_payment_totals') IS NULL THEN
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
  v_canonical text;
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

    -- 068: a transfer reference held by a payment recorded WITH EXCESS is
    -- exclusive (see payment_reference_canonical_v1 below): an ordinary claim
    -- under the same canonical reference and method would count that one
    -- transfer twice. Ordinary references among themselves keep the 035 rule
    -- (flagged duplicate_suspected, never refused). Lock order: order →
    -- canonical reference → the body's 035 reference lock.
    v_canonical := public.payment_reference_canonical_v1(p_reference);
    IF v_canonical IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(68068, hashtext(p_organization_id::text || ':' || p_method || ':' || v_canonical));
      IF public.payment_reference_held_v1(p_organization_id, p_method, v_canonical, NULL, true) THEN
        RETURN jsonb_build_object('status', 'duplicate_transfer_reference');
      END IF;
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
  v_canonical text;
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
  SELECT id, status, verification_state, amount_minor, method, reference, excess_recorded
    INTO v_payment FROM public.payments
    WHERE id = p_payment_id AND organization_id = p_organization_id;
  IF v_payment.verification_state::text = p_expected_from
     AND v_payment.status = 'failed' AND p_to = 'unverified' THEN
    -- A payment recorded WITH EXCESS is reinstated only through
    -- reinstate_excess_payment_v1, which rechecks its excess and reference.
    IF v_payment.excess_recorded THEN
      RETURN jsonb_build_object('status', 'excess_reinstatement_required');
    END IF;
    -- A rejected claim releases its reference (the release rule below); taking
    -- it back must not collide with a payment recorded with excess under it.
    v_canonical := public.payment_reference_canonical_v1(v_payment.reference);
    IF v_canonical IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(68068, hashtext(p_organization_id::text || ':' || v_payment.method::text || ':' || v_canonical));
      IF public.payment_reference_held_v1(p_organization_id, v_payment.method::text, v_canonical,
          p_payment_id, true) THEN
        RETURN jsonb_build_object('status', 'duplicate_transfer_reference');
      END IF;
    END IF;
  END IF;
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
-- RECORD WITH EXCESS — a real bank / KHQR transfer above a still-positive
-- outstanding amount   *** DRAFT — pilot policy proposed by the owner ***
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Ordinary recording (record_payment_v2 above) still refuses any amount above
-- the unclaimed total, so an accidental overpayment is never a cashier action.
-- When a customer really transferred more than the order still owes, a member
-- holding the manager-level payments.record_excess grant records the FULL
-- amount received, and the excess is returned through the existing audited
-- refund (refund_payment_v2). Cash and COD never come here: their excess is
-- change given in hand, and only the amount kept is recorded.
--
-- ── Scope (pilot) ───────────────────────────────────────────────────────────
-- The workflow handles a transfer that EXCEEDS A STILL-POSITIVE balance. When
-- the authoritative outstanding amount is zero (or below zero, legacy state),
-- the money is an unallocated receipt — outside this feature — and the call is
-- refused 'nothing_outstanding'. It is never attached to the paid order.
--
-- ── Transfer reference (staff evidence, never proof) ────────────────────────
-- The reference is what the member typed from the bank / KHQR notification. It
-- is a traceability key, NOT a verification: the payment starts pending and
-- settles only when a member confirms it.
--
-- Canonical form — payment_reference_canonical_v1(reference):
--   * every whitespace character removed (Unicode spaces, tabs, line breaks,
--     NBSP, zero-width space / joiner, BOM), leading, trailing and internal;
--   * lower-cased (lower(), the database's case-folding);
--   * an empty result is NULL — 'reference_required'.
--   So 'TRF-P1', 'trf-p1 ', 'TRF - P1' and 'T R F-P1' are one reference.
--   Trade-off: two genuinely different identifiers that differ ONLY in case or
--   whitespace collapse into one. Bank and KHQR transaction ids are
--   case-insensitive digit/letter strings in practice; a false collision
--   refuses a recording (visible, recoverable by the member), whereas a missed
--   collision counts one transfer twice. Nothing provider-specific is done:
--   punctuation, leading zeros and prefixes are kept.
--
-- An exclusive reference — scope: (organization, method, canonical reference).
--   Held by a payment in status pending, paid or refunded (a refunded transfer
--   still happened). Released by:
--     reversed — the record was wrong (final);
--     failed   — the claim was rejected (verification mismatch): it is no
--                longer a claim. Taking it back (failed → pending) rechecks
--                the reference under the same lock, so a released reference
--                can never be held twice.
--   record_payment_with_excess_v1 refuses a reference held by ANY payment
--   ('duplicate_transfer_reference'); record_payment_v2 refuses one held by a
--   payment recorded with excess. Race safety: every writer takes the
--   canonical-reference advisory lock (key space 68068) after the order lock
--   and rechecks after the wait; a partial unique index over payments recorded
--   with excess is the database's own backstop (excess vs excess, including a
--   reference changed later by correct_payment_v2).
--   Not covered: an ORDINARY payment's reference later corrected (owner-only,
--   audited correct_payment_v2) into one held by an ordinary payment — the 035
--   rule, unchanged.
--
-- ── record_payment_with_excess_v1 ───────────────────────────────────────────
--   * khqr / bank_transfer only → otherwise 'method_not_allowed';
--   * required: reference (canonical non-empty), reason, idempotency key and
--     p_expected_outstanding_minor — the outstanding amount the member was
--     shown;
--   * under the order row lock: a key already used replays only the original
--     member's original request (062's rule), and only for a payment recorded
--     with excess — anything else is 'idempotency_conflict'. Replay comes first,
--     so a retry after a later cancellation or payment still replays;
--   * order not confirmed → 'order_not_payable';
--   * authoritative outstanding ≤ 0 → 'nothing_outstanding';
--   * a different outstanding than the member was shown → 'stale';
--   * amount ≤ outstanding → 'no_excess' (use ordinary recording);
--   * reference held → 'duplicate_transfer_reference';
--   * every refusal writes nothing. On success: one payment (excess_recorded),
--     one created event carrying excess_minor / expected_outstanding_minor /
--     order_total_minor beside 062's digest, the derived order state, and the
--     mandatory audit row payments.record_excess — one transaction.
--
-- ── payment_excess_state_v1 — the one returnable-excess rule ────────────────
--   returnable = 0 unless the payment is confirmed (paid / refunded); else
--   GREATEST(LEAST(recorded excess − linked excess returns,
--                  order net received − order total), 0).
--   Used by return_payment_excess_v1 (under its locks), by the payment detail
--   and by list_excess_to_return_v1, so the screen and the refusal agree.
--
-- ── return_payment_excess_v1 ────────────────────────────────────────────────
--   Returning the excess IS a refund: refund_payment_v2 (payments.refund, its
--   key, acknowledgement, expected total, mandatory audit, ledger semantics —
--   unchanged), bounded by payment_excess_state_v1 under the same locks in the
--   same order (refund key → order → payment). After it, an 'excess_returned'
--   event (amount, refund_event_id) and the audit row payments.return_excess,
--   same transaction. That event is the only evidence for the "excess
--   returned" label. The order's refund_status keeps its ledger meaning (money
--   was returned → 'partial', also after returning only an excess).
--
-- ── reinstate_excess_payment_v1 — recovering a mistaken rejection ───────────
--   A payment recorded with excess that was rejected (mismatch) by mistake is
--   taken back to pending on the SAME payment row (no second row, the original
--   created event untouched) only when, under the order lock: the order is
--   confirmed; the outstanding amount the other claims leave is still positive
--   and exactly the one it was recorded against (its excess unchanged —
--   otherwise 'excess_changed': reverse is not available for a rejected claim,
--   so the member records the transfer again with excess, the rejection having
--   released the reference); and its reference is not held by another payment.
--   It writes the verification event (mismatch → unverified, metadata
--   excess_reinstated) and the audit row payments.reinstate_excess. The
--   ordinary verify_payment_v1 refuses this transition for such a payment
--   ('excess_reinstatement_required').
--
-- ── list_excess_to_return_v1 — the Payments "Excess to return" view ─────────
--   One statement (one snapshot): exact total + one page, newest first, ties
--   broken by kind, order id and payment id. Rows:
--     returnable            confirmed payment recorded with excess, returnable > 0
--     awaiting_confirmation pending payment recorded with excess (its recorded
--                           excess; nothing can be returned before confirmation)
--     legacy_overpaid       order with net received > total and no payment
--                           recorded with excess (legacy / pre-068 claims);
--                           returned through the ordinary refund
--   One row per payment (returnable / awaiting) or per order (legacy) — never
--   multiplied by events or refunds.

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

-- ── Canonical transfer reference ────────────────────────────────────────────

CREATE FUNCTION public.payment_reference_canonical_v1(p_reference text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT NULLIF(lower(regexp_replace(p_reference,
    '[[:space:]\u0085  ᠎ -‍    ⁠　﻿]+',
    '', 'g')), '')
$$;
COMMENT ON FUNCTION public.payment_reference_canonical_v1(text) IS
  'Migration 068: the canonical transfer reference — all whitespace removed, lower-cased, empty → NULL. See the migration header for the trade-off.';

-- Which payment rows hold a recorded-with-excess reference: set once, at
-- recording, by record_payment_with_excess_v1, and immutable afterwards.
-- Existing rows are false (nothing was recorded with excess before 068), so
-- the column add and the partial unique index below never meet a conflict.
ALTER TABLE public.payments ADD COLUMN excess_recorded boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.payments.excess_recorded IS
  'Migration 068: recorded through record_payment_with_excess_v1. Immutable. The excess amount itself is on the payment''s created event (excess_minor).';

CREATE FUNCTION public.guard_payment_excess_recorded() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, auth AS $$
BEGIN
  IF NEW.excess_recorded IS DISTINCT FROM OLD.excess_recorded THEN
    RAISE EXCEPTION 'Payment excess_recorded is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_excess_recorded_immutable BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_excess_recorded();

CREATE INDEX idx_payments_org_method_reference_canonical
  ON public.payments (organization_id, method, public.payment_reference_canonical_v1(reference))
  WHERE reference IS NOT NULL;

-- The backstop: at most one payment recorded with excess holds a canonical
-- reference per organization and method while it is pending, paid or refunded.
CREATE UNIQUE INDEX uniq_payments_excess_reference_held
  ON public.payments (organization_id, method, public.payment_reference_canonical_v1(reference))
  WHERE excess_recorded AND status IN ('pending', 'paid', 'refunded');

-- Is this canonical reference held (pending / paid / refunded) by a payment of
-- this organization and method — optionally only by one recorded with excess,
-- optionally ignoring one payment? The caller holds the reference lock.
CREATE FUNCTION public.payment_reference_held_v1(
  p_organization_id uuid, p_method text, p_canonical text, p_except uuid, p_excess_only boolean
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, auth AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payments
     WHERE organization_id = p_organization_id
       AND method::text = p_method
       AND public.payment_reference_canonical_v1(reference) = p_canonical
       AND status IN ('pending', 'paid', 'refunded')
       AND (p_except IS NULL OR id <> p_except)
       AND (NOT p_excess_only OR excess_recorded))
$$;

-- ── The returnable-excess rule ──────────────────────────────────────────────

CREATE FUNCTION public.payment_excess_state_v1(p_organization_id uuid, p_payment_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_excess bigint;
  v_returned bigint;
  v_net bigint;
  v_total bigint;
  v_returnable bigint;
BEGIN
  SELECT * INTO v_payment FROM public.payments
   WHERE id = p_payment_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT (metadata ->> 'excess_minor')::bigint INTO v_excess FROM public.payment_events
   WHERE payment_id = p_payment_id AND organization_id = p_organization_id
     AND event_type = 'created';
  IF v_excess IS NULL THEN RETURN jsonb_build_object('status', 'no_recorded_excess'); END IF;
  SELECT COALESCE(SUM(amount_minor), 0) INTO v_returned FROM public.payment_events
   WHERE payment_id = p_payment_id AND organization_id = p_organization_id
     AND event_type = 'excess_returned';
  SELECT net_minor, total_minor INTO v_net, v_total FROM public.order_payment_totals
   WHERE order_id = v_payment.order_id AND organization_id = p_organization_id;
  v_returnable := CASE WHEN v_payment.status IN ('paid', 'refunded')
    THEN GREATEST(LEAST(v_excess - v_returned, v_net - v_total), 0) ELSE 0 END;
  RETURN jsonb_build_object('status', 'success',
    'payment_status', v_payment.status::text,
    'recorded_excess_minor', v_excess,
    'excess_returned_minor', v_returned,
    'returnable_excess_minor', v_returnable,
    'currency', v_payment.currency);
END;
$$;

-- ── record_payment_with_excess_v1 ───────────────────────────────────────────

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
  v_canonical text := public.payment_reference_canonical_v1(p_reference);
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
  v_constraint text;
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
  IF v_canonical IS NULL THEN RETURN jsonb_build_object('status', 'reference_required'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('status', 'reason_required'); END IF;
  IF v_key IS NULL THEN RETURN jsonb_build_object('status', 'idempotency_key_required'); END IF;
  IF p_expected_outstanding_minor IS NULL OR p_expected_outstanding_minor < 0 THEN
    RETURN jsonb_build_object('status', 'expected_outstanding_required');
  END IF;

  SELECT id, lifecycle_status, total_minor, currency INTO v_order FROM public.orders
    WHERE id = p_order_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;

  -- Replay first: the original member's retry of the original request.
  SELECT * INTO v_existing FROM public.payments
    WHERE organization_id = p_organization_id AND idempotency_key = v_key;
  IF FOUND THEN
    SELECT * INTO v_created FROM public.payment_events
      WHERE payment_id = v_existing.id AND event_type = 'created';
    IF NOT v_existing.excess_recorded
       OR NOT COALESCE(v_created.metadata ? 'excess_minor', false)
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

  -- The same claim as record_payment_v2, read after the lock (a fresh
  -- statement snapshot: what committed while this call waited is seen).
  SELECT t.received_minor + COALESCE((SELECT SUM(p.amount_minor) FROM public.payments p
      WHERE p.organization_id = p_organization_id AND p.order_id = p_order_id
        AND p.status = 'pending'), 0)
    INTO v_claimed
    FROM public.order_payment_totals t
   WHERE t.order_id = p_order_id AND t.organization_id = p_organization_id;
  v_outstanding := v_order.total_minor - v_claimed;
  IF v_outstanding <= 0 THEN
    -- Fully claimed (or over-claimed by legacy state): this money is an
    -- unallocated receipt, outside this workflow. Never attached to the order.
    RETURN jsonb_build_object('status', 'nothing_outstanding', 'outstanding_minor', 0,
      'currency', v_order.currency);
  END IF;
  IF p_expected_outstanding_minor <> v_outstanding THEN
    RETURN jsonb_build_object('status', 'stale', 'outstanding_minor', v_outstanding,
      'currency', v_order.currency);
  END IF;
  IF p_amount_minor <= v_outstanding THEN
    RETURN jsonb_build_object('status', 'no_excess', 'outstanding_minor', v_outstanding,
      'currency', v_order.currency);
  END IF;
  v_excess := p_amount_minor - v_outstanding;

  -- The exclusive canonical reference (order lock → reference lock → 035 lock).
  PERFORM pg_advisory_xact_lock(68068,
    hashtext(p_organization_id::text || ':' || p_method || ':' || v_canonical));
  IF public.payment_reference_held_v1(p_organization_id, p_method, v_canonical, NULL, false) THEN
    RETURN jsonb_build_object('status', 'duplicate_transfer_reference');
  END IF;

  -- 035's exact-reference rule, unchanged: the same text on a payment of
  -- ANOTHER method is suspicious (flagged), never a refusal.
  PERFORM pg_advisory_xact_lock(hashtext(p_organization_id::text || ':' || v_reference));
  SELECT EXISTS (SELECT 1 FROM public.payments
    WHERE organization_id = p_organization_id AND reference = v_reference
      AND status <> 'reversed') INTO v_duplicate;
  v_state := CASE WHEN v_duplicate THEN 'duplicate_suspected' ELSE 'unverified' END;

  BEGIN
    INSERT INTO public.payments (
      organization_id, order_id, method, currency, amount_minor,
      status, verification_state, reference, idempotency_key, note, recorded_by, excess_recorded
    ) VALUES (
      p_organization_id, p_order_id, p_method::public.payment_method, v_order.currency,
      p_amount_minor, 'pending', v_state, v_reference, v_key, v_reason, p_recorded_by, true
    )
    ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
    DO NOTHING
    RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'uniq_payments_excess_reference_held' THEN
      RETURN jsonb_build_object('status', 'duplicate_transfer_reference');
    END IF;
    RAISE;
  END;
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

-- ── return_payment_excess_v1 ────────────────────────────────────────────────

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
  v_state jsonb;
  v_returned bigint;
  v_returnable bigint;
  v_excess bigint;
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

  -- The one rule (payment_excess_state_v1), read under the locks.
  v_state := public.payment_excess_state_v1(p_organization_id, p_payment_id);
  IF v_state ->> 'status' = 'no_recorded_excess' THEN
    RETURN jsonb_build_object('status', 'no_recorded_excess');
  END IF;
  IF v_payment.status NOT IN ('paid', 'refunded') THEN
    RETURN jsonb_build_object('status', 'invalid_state', 'current', v_payment.status::text);
  END IF;
  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;
  v_excess := (v_state ->> 'recorded_excess_minor')::bigint;
  v_returned := (v_state ->> 'excess_returned_minor')::bigint;
  v_returnable := (v_state ->> 'returnable_excess_minor')::bigint;
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

-- ── reinstate_excess_payment_v1 ─────────────────────────────────────────────

CREATE FUNCTION public.reinstate_excess_payment_v1(
  p_organization_id uuid,
  p_payment_id uuid,
  p_actor uuid,
  p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_reason text := NULLIF(trim(p_reason), '');
  v_target uuid;
  v_payment public.payments%ROWTYPE;
  v_created public.payment_events%ROWTYPE;
  v_order record;
  v_received bigint;
  v_held bigint;
  v_claimed bigint;
  v_outstanding bigint;
  v_excess bigint;
  v_canonical text;
  v_constraint text;
  v_result jsonb;
BEGIN
  IF v_reason IS NULL THEN RETURN jsonb_build_object('status', 'reason_required'); END IF;

  -- Order BEFORE payment, then the canonical reference lock: the order of
  -- record_payment_v2 / record_payment_with_excess_v1 / verify_payment_v1.
  v_target := public.lock_payment_order(p_organization_id, p_payment_id);
  IF v_target IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  SELECT * INTO v_created FROM public.payment_events
   WHERE payment_id = p_payment_id AND event_type = 'created';
  IF NOT v_payment.excess_recorded OR NOT COALESCE(v_created.metadata ? 'excess_minor', false) THEN
    RETURN jsonb_build_object('status', 'no_recorded_excess');
  END IF;
  IF v_payment.status <> 'failed' OR v_payment.verification_state <> 'mismatch' THEN
    RETURN jsonb_build_object('status', 'invalid_state', 'current', v_payment.status::text);
  END IF;

  SELECT lifecycle_status, total_minor, currency INTO v_order FROM public.orders
   WHERE id = v_target AND organization_id = p_organization_id;
  IF v_order.lifecycle_status <> 'confirmed' THEN
    RETURN jsonb_build_object('status', 'order_not_payable',
      'lifecycle', v_order.lifecycle_status::text);
  END IF;

  -- What the other claims leave outstanding (verify_payment_v1's reinstatement
  -- arithmetic: this payment contributes only its refunded amount while failed).
  SELECT received_minor INTO v_received FROM public.order_payment_totals
   WHERE order_id = v_target AND organization_id = p_organization_id;
  SELECT COALESCE(SUM(e.amount_minor), 0) INTO v_held FROM public.payment_events e
   WHERE e.payment_id = p_payment_id AND e.organization_id = p_organization_id
     AND e.event_type = 'refund';
  SELECT v_received - v_held + COALESCE(SUM(p.amount_minor), 0) INTO v_claimed
    FROM public.payments p
   WHERE p.organization_id = p_organization_id AND p.order_id = v_target
     AND p.status = 'pending' AND p.id <> p_payment_id;
  v_outstanding := v_order.total_minor - v_claimed;
  v_excess := (v_created.metadata ->> 'excess_minor')::bigint;
  IF v_outstanding <= 0 THEN
    RETURN jsonb_build_object('status', 'nothing_outstanding', 'outstanding_minor', 0,
      'currency', v_order.currency);
  END IF;
  IF v_payment.amount_minor - v_outstanding <> v_excess THEN
    RETURN jsonb_build_object('status', 'excess_changed', 'outstanding_minor', v_outstanding,
      'recorded_excess_minor', v_excess, 'currency', v_order.currency);
  END IF;

  v_canonical := public.payment_reference_canonical_v1(v_payment.reference);
  PERFORM pg_advisory_xact_lock(68068,
    hashtext(p_organization_id::text || ':' || v_payment.method::text || ':' || v_canonical));
  IF public.payment_reference_held_v1(p_organization_id, v_payment.method::text, v_canonical,
      p_payment_id, false) THEN
    RETURN jsonb_build_object('status', 'duplicate_transfer_reference');
  END IF;

  BEGIN
    v_result := public.verify_payment_before_order_v1(p_organization_id, p_payment_id, p_actor,
      'mismatch', 'unverified', v_reason,
      jsonb_build_object('excess_reinstated', true, 'recorded_excess_minor', v_excess,
        'outstanding_minor', v_outstanding));
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'uniq_payments_excess_reference_held' THEN
      RETURN jsonb_build_object('status', 'duplicate_transfer_reference');
    END IF;
    RAISE;
  END;
  IF v_result ->> 'status' <> 'success' THEN RETURN v_result; END IF;

  PERFORM public.sync_order_payment_state(p_organization_id, v_target, p_actor,
    'Payment recorded with excess reinstated');

  BEGIN
    INSERT INTO public.audit_logs(
      organization_id, actor_user_id, action, resource_type, resource_id, after_json, reason
    ) VALUES (
      p_organization_id, p_actor, 'payments.reinstate_excess', 'payments', p_payment_id::text,
      jsonb_build_object('order_id', v_target, 'amount_minor', v_payment.amount_minor,
        'currency', v_order.currency, 'recorded_excess_minor', v_excess,
        'outstanding_minor', v_outstanding),
      v_reason
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'apsa_audit_unavailable' USING DETAIL = SQLERRM;
  END;

  RETURN v_result || jsonb_build_object('reinstated', true, 'excess_minor', v_excess);
END;
$$;

-- ── list_excess_to_return_v1 ────────────────────────────────────────────────

CREATE FUNCTION public.list_excess_to_return_v1(
  p_organization_id uuid,
  p_limit integer,
  p_offset integer
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'list_excess_to_return_v1: organization_id is required';
  END IF;

  WITH recorded AS (
    SELECT p.id AS payment_id, p.order_id, p.created_at, p.method::text AS method,
      p.amount_minor, p.currency, p.status::text AS payment_status,
      public.payment_excess_state_v1(p.organization_id, p.id) AS st
    FROM public.payments p
    WHERE p.organization_id = p_organization_id AND p.excess_recorded
      AND p.status IN ('pending', 'paid', 'refunded')
  ),
  items AS (
    SELECT CASE WHEN r.payment_status = 'pending' THEN 'awaiting_confirmation' ELSE 'returnable' END
        AS kind,
      r.payment_id, r.order_id, r.created_at AS occurred_at, r.method, r.amount_minor, r.currency,
      r.payment_status,
      CASE WHEN r.payment_status = 'pending' THEN (r.st ->> 'recorded_excess_minor')::bigint
        ELSE (r.st ->> 'returnable_excess_minor')::bigint END AS excess_minor
    FROM recorded r
    WHERE r.payment_status = 'pending' OR (r.st ->> 'returnable_excess_minor')::bigint > 0
    UNION ALL
    SELECT 'legacy_overpaid', NULL::uuid, t.order_id, o.created_at, NULL::text, NULL::bigint,
      t.currency, NULL::text, t.net_minor - t.total_minor
    FROM public.order_payment_totals t
    JOIN public.orders o ON o.id = t.order_id AND o.organization_id = t.organization_id
    WHERE t.organization_id = p_organization_id
      AND t.order_id IN (SELECT DISTINCT q.order_id FROM public.payments q
                          WHERE q.organization_id = p_organization_id)
      AND t.net_minor > t.total_minor
      AND NOT EXISTS (SELECT 1 FROM public.payments x
        WHERE x.organization_id = p_organization_id AND x.order_id = t.order_id
          AND x.excess_recorded AND x.status IN ('pending', 'paid', 'refunded'))
  ),
  page AS (
    SELECT i.*, o.order_number, o.lifecycle_status::text AS order_lifecycle, o.total_minor,
      c.display_name AS customer_name
    FROM items i
    JOIN public.orders o ON o.id = i.order_id AND o.organization_id = p_organization_id
    LEFT JOIN public.customers c ON c.id = o.customer_id AND c.organization_id = p_organization_id
    ORDER BY i.occurred_at DESC, i.kind, i.order_id, i.payment_id NULLS FIRST
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'status', 'success',
    'total', (SELECT count(*) FROM items),
    'limit', v_limit,
    'offset', v_offset,
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(pg) ORDER BY pg.occurred_at DESC, pg.kind,
        pg.order_id, pg.payment_id NULLS FIRST) FROM page pg), '[]'::jsonb))
    INTO v_result;
  RETURN v_result;
END;
$$;

-- ── Grants: owner postgres (the migration role), EXECUTE for service_role only ─

REVOKE ALL ON FUNCTION public.payment_reference_canonical_v1(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_reference_canonical_v1(text) TO service_role;
REVOKE ALL ON FUNCTION public.guard_payment_excess_recorded()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_reference_held_v1(uuid,text,text,uuid,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.payment_excess_state_v1(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_payment_with_excess_v1(uuid,uuid,uuid,text,bigint,text,text,text,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.return_payment_excess_v1(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reinstate_excess_payment_v1(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_excess_to_return_v1(uuid,integer,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.payment_excess_state_v1(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_payment_with_excess_v1(uuid,uuid,uuid,text,bigint,text,text,text,bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.return_payment_excess_v1(uuid,uuid,uuid,bigint,text,text,bigint,uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reinstate_excess_payment_v1(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_excess_to_return_v1(uuid,integer,integer) TO service_role;

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
