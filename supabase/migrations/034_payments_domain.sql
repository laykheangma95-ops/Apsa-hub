-- Migration: 034_payments_domain
-- Purpose: Production Payment domain foundation — authoritative financial
--          truth, separate from (and never driven by) the Order domain.
-- Tables: payments, payment_events, payment_evidence
-- View:   payment_reconciliation_summary (derived aggregate, never a cache)
-- Classification: tenant-private (scoped to organization_id)
--
-- SOURCE OF TRUTH
--   DATA_MODEL.md §50 (Payment), §51 (PaymentAttempt), §52 (PaymentProviderEvent),
--   §53 (Refund); MVP_ROADMAP.md §14 (Phase 8 — Payment Records);
--   PERMISSIONS_MATRIX.md §17 (Payments); SECURITY.md §§41-44 (Payment
--   Security, Payment Overrides, Refunds); ARCHITECTURE.md (money rules).
--
-- WHY A DOMAIN SEPARATE FROM orders.payment_status
--   orders.payment_status (migration 023) is a coarse, manually-driven axis —
--   "has the money arrived" — and stays exactly as it is in this phase. This
--   migration does NOT touch it, does NOT add a trigger from payments onto
--   orders, and no function here ever writes to the orders table. That
--   integration ("Payment Domain becomes the sole authority over Order
--   payment state") is explicitly the NEXT phase. This phase's job is the
--   authoritative Payment record itself: who paid what, by which method, with
--   what evidence, confirmed by whom, and at what trust level — all of it
--   append-only where it matters, all of it re-examinable without deleting or
--   silently rewriting anything.
--
-- TWO AXES, LIKE ORDERS BEFORE IT
--   status              — pending | paid | failed | reversed | refunded
--                          (the settlement outcome of this payment record)
--   verification_state  — unverified | staff_confirmed | manager_verified |
--                          bank_verified | mismatch | duplicate_suspected
--                          (how much the claim "this money arrived" can be
--                          trusted, and by what authority)
--   A payment can be "Paid · Staff confirmed", "Paid · Manager verified",
--   "Paid · Bank verified" or "Pending · Needs review" — these are
--   independent facts, exactly as MVP_ROADMAP.md's payment brief and this
--   phase's product spec require.
--
-- SCREENSHOT / EVIDENCE INVARIANT (SECURITY.md §41, MVP_ROADMAP.md §14)
--   payment_evidence is supporting data, never financial authority. No
--   function in this migration or the next (035_payment_rpc.sql) ever lets an
--   evidence attachment move payments.status or verification_state. Only a
--   human (staff/manager) or a future verified bank adapter can do that, via
--   verify_payment_v1.
--
-- IMMUTABLE FINANCIAL HISTORY
--   payment_events is the append-only ledger of everything that happened to a
--   payment. A hard DB trigger (not just RLS, not just application
--   discipline) blocks UPDATE and DELETE on it outright — even a service-role
--   write cannot rewrite history here. Corrections, reversals and refunds are
--   new rows, never edits to old ones (DATA_MODEL.md §53: "Refund should not
--   be represented by simply changing payment amount").
--
-- IDEMPOTENCY AND DUPLICATE REFERENCES ARE DIFFERENT PROBLEMS
--   idempotency_key: a hard, DB-enforced uniqueness constraint. The SAME
--   client action retried (double-click, network retry, replayed webhook)
--   must produce the SAME payment record, never a second one. See
--   uniq_payments_idempotency below and record_payment_v1 (migration 035).
--
--   reference (bank/KHQR transaction reference): NOT hard-unique. Two
--   legitimate payments can share a reference by accident (a resent
--   screenshot, a merchant re-quoting a KHQR code) and a hard constraint
--   would reject a real sale. Instead, a collision is SUSPICIOUS, not
--   impossible: the new payment is still recorded, but starts life with
--   verification_state = 'duplicate_suspected' rather than 'unverified',
--   putting it in the reconciliation "needs review" bucket instead of being
--   silently accepted or silently rejected.
--
-- TENANT ISOLATION
--   organization_id is NOT NULL everywhere and always server-supplied.
--   Cross-tenant integrity triggers re-verify every FK's organization_id
--   against the row's own, exactly as migrations 023/027 do for
--   orders/deliveries — so a cross-tenant link is impossible even through a
--   service-role write.
--
-- MONEY
--   Every monetary column is an INTEGER minor unit. Currency is explicit and
--   is always the ORDER's currency (checked in record_payment_v1), never a
--   caller's claim.

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE public.payment_method AS ENUM (
  'cash',
  'khqr',
  'bank_transfer',
  'cod'
);

-- Settlement outcome of the payment record itself.
CREATE TYPE public.payment_status AS ENUM (
  'pending',
  'paid',
  'failed',
  'reversed',
  'refunded'
);

-- How much the claim "this money arrived" can currently be trusted, and by
-- what authority. Independent of `status` — see migration header.
CREATE TYPE public.payment_verification_state AS ENUM (
  'unverified',
  'staff_confirmed',
  'manager_verified',
  'bank_verified',
  'mismatch',
  'duplicate_suspected'
);

CREATE TYPE public.payment_evidence_type AS ENUM (
  'screenshot',
  'qr_scan',
  'receipt',
  'other'
);

-- Append-only ledger event kinds (payment_events.event_type).
CREATE TYPE public.payment_event_type AS ENUM (
  'created',
  'evidence_attached',
  'staff_confirmed',
  'manager_verified',
  'bank_verified',
  'verification_failed',
  'correction',
  'reversal',
  'refund',
  'duplicate_flagged'
);

-- ── payments ──────────────────────────────────────────────────────────────────

CREATE TABLE public.payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Financial history must not be silently detached from the sale it belongs
  -- to; orders are never hard-deleted anyway (see migration 023).
  order_id            UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,

  method              public.payment_method NOT NULL,

  -- Always the parent order's currency (enforced by record_payment_v1, not
  -- trusted from the caller) — one currency per order, exactly like line items.
  currency            TEXT NOT NULL CHECK (currency IN ('USD', 'KHR')),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),

  status              public.payment_status NOT NULL DEFAULT 'pending',
  verification_state  public.payment_verification_state NOT NULL DEFAULT 'unverified',

  -- Bank/KHQR transaction reference. Not hard-unique — see migration header.
  reference           TEXT,

  -- Retry-safety key for the manual-confirmation click / API call that
  -- created this record. Hard-unique per organization (see index below).
  idempotency_key     TEXT,

  note                TEXT,

  recorded_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payments IS
  'Authoritative payment record, separate from orders.payment_status. Two independent axes: status (settlement outcome) and verification_state (trust level). Never mutated by evidence attachment alone.';

COMMENT ON COLUMN public.payments.reference IS
  'Bank/KHQR transaction reference as claimed by the merchant/customer. Deliberately NOT unique — a collision marks the payment duplicate_suspected instead of being rejected. See record_payment_v1.';

-- Idempotency: the SAME client action retried must return the SAME payment.
-- Partial index (WHERE idempotency_key IS NOT NULL) so payments with no
-- idempotency key never collide with each other.
CREATE UNIQUE INDEX uniq_payments_idempotency
  ON public.payments(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_payments_org_order
  ON public.payments(organization_id, order_id);

CREATE INDEX idx_payments_org_status
  ON public.payments(organization_id, status);

CREATE INDEX idx_payments_org_verification
  ON public.payments(organization_id, verification_state);

CREATE INDEX idx_payments_org_created
  ON public.payments(organization_id, created_at DESC);

-- Duplicate-reference lookup (record_payment_v1 checks this on every insert).
CREATE INDEX idx_payments_org_reference
  ON public.payments(organization_id, reference)
  WHERE reference IS NOT NULL;

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── payment_events ────────────────────────────────────────────────────────────
--
-- DATA_MODEL.md §53: "Refund should not be represented by simply changing
-- payment amount." Every reversal/refund/correction/verification step is a
-- new row here. Refunded totals are DERIVED by summing 'refund' events for a
-- payment (see refund_payment_v1) — never by mutating payments.amount_minor.
--
-- amount_minor on this table is used only by 'created' (the recorded amount)
-- and 'refund' (the amount of that specific refund) events; NULL otherwise.

CREATE TABLE public.payment_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payment_id         UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  event_type         public.payment_event_type NOT NULL,
  amount_minor       BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency           TEXT CHECK (currency IS NULL OR currency IN ('USD', 'KHR')),
  from_verification  public.payment_verification_state,
  to_verification    public.payment_verification_state,
  actor_user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason             TEXT,
  -- Bounded, non-sensitive context only (e.g. evidence id, duplicate
  -- reference). DATA_MODEL.md §52: never store a full sensitive payload here.
  metadata           JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_events IS
  'Append-only financial event ledger for a payment. UPDATE and DELETE are blocked by trigger for every role, including service_role — history is never rewritten, only extended.';

CREATE INDEX idx_payment_events_payment
  ON public.payment_events(payment_id, created_at DESC);

CREATE INDEX idx_payment_events_org
  ON public.payment_events(organization_id, created_at DESC);

CREATE INDEX idx_payment_events_org_type
  ON public.payment_events(organization_id, event_type);

-- ── payment_evidence ──────────────────────────────────────────────────────────
--
-- storage_ref is an opaque pointer into wherever APSA stores uploaded files —
-- never a binary blob in this table. extracted_* columns are schema-ready for
-- future OCR/amount-extraction (this phase does not implement extraction —
-- same pattern as orders.delivery_minor in migration 023: the column exists
-- so a later phase never needs a financial-table ALTER, but nothing writes a
-- non-null value here yet except what the uploader explicitly supplies).

CREATE TABLE public.payment_evidence (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payment_id              UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  evidence_type           public.payment_evidence_type NOT NULL,
  storage_ref             TEXT NOT NULL CHECK (length(trim(storage_ref)) > 0),
  extracted_amount_minor  BIGINT CHECK (extracted_amount_minor IS NULL OR extracted_amount_minor >= 0),
  extracted_reference     TEXT,
  extracted_at            TIMESTAMPTZ,
  uploaded_by             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_evidence IS
  'Supporting evidence only (screenshots, QR scans, receipts). Never financial authority — attaching evidence never changes payments.status or verification_state (SECURITY.md §41).';

CREATE INDEX idx_payment_evidence_payment
  ON public.payment_evidence(payment_id, created_at DESC);

CREATE INDEX idx_payment_evidence_org
  ON public.payment_evidence(organization_id, created_at DESC);

-- ── Cross-tenant integrity ────────────────────────────────────────────────────
-- Mirrors migrations 023/027: FKs prove existence, not tenancy. These
-- triggers close that gap even for service-role writes.

CREATE OR REPLACE FUNCTION public.check_payment_cross_tenant_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = NEW.order_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'payment order_id must belong to the same organization as the payment (cross_tenant_order)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_cross_tenant_refs_check
  BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_cross_tenant_refs();

CREATE OR REPLACE FUNCTION public.check_payment_event_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE id = NEW.payment_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'payment_event organization_id must match the parent payment organization_id (cross_tenant_payment)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_event_integrity_check
  BEFORE INSERT ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_event_integrity();

-- Append-only, for real: block UPDATE and DELETE for every role, including
-- service_role. RLS alone only stops JWT clients; this stops every writer,
-- because "never silently edit settled financial history" is this domain's
-- loudest invariant and must not depend on every future caller behaving.
CREATE OR REPLACE FUNCTION public.block_payment_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'payment_events is an append-only ledger — % is not permitted (row id: %)',
    TG_OP, COALESCE(OLD.id, NULL);
END;
$$;

CREATE TRIGGER payment_events_no_update
  BEFORE UPDATE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.block_payment_event_mutation();

CREATE TRIGGER payment_events_no_delete
  BEFORE DELETE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.block_payment_event_mutation();

CREATE OR REPLACE FUNCTION public.check_payment_evidence_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE id = NEW.payment_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'payment_evidence organization_id must match the parent payment organization_id (cross_tenant_payment)';
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE INSERT OR UPDATE (not INSERT-only): payment_evidence has no exposed
-- UPDATE path today, but extracted_amount_minor/extracted_reference/
-- extracted_at are explicitly schema-ready for a future OCR/extraction
-- writer (see the table's own comment above) — this trigger must already be
-- in place so that future writer cannot introduce a cross-tenant row via
-- UPDATE without a schema change being needed here.
CREATE TRIGGER payment_evidence_integrity_check
  BEFORE INSERT OR UPDATE ON public.payment_evidence
  FOR EACH ROW EXECUTE FUNCTION public.check_payment_evidence_integrity();

-- ── Row-Level Security ────────────────────────────────────────────────────────
--
-- Same posture as orders/deliveries (migrations 023/027): JWT clients get NO
-- access at all, not even SELECT. Every Payment operation goes through the
-- server domain (src/server/payments/service.ts) using the service role.
-- Payment rows carry financial history, evidence and staff accountability
-- data — precisely what a restricted custom role must not be able to read by
-- pointing a client directly at PostgREST (same rationale as migration 023's
-- long RLS comment).

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payments_select_blocked" ON public.payments FOR SELECT USING (false);
CREATE POLICY "payments_insert_blocked" ON public.payments FOR INSERT WITH CHECK (false);
CREATE POLICY "payments_update_blocked" ON public.payments FOR UPDATE USING (false);
CREATE POLICY "payments_no_delete"      ON public.payments FOR DELETE USING (false);

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_events_select_blocked" ON public.payment_events FOR SELECT USING (false);
CREATE POLICY "payment_events_insert_blocked" ON public.payment_events FOR INSERT WITH CHECK (false);
CREATE POLICY "payment_events_no_update"      ON public.payment_events FOR UPDATE USING (false);
CREATE POLICY "payment_events_no_delete"      ON public.payment_events FOR DELETE USING (false);

ALTER TABLE public.payment_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_evidence_select_blocked" ON public.payment_evidence FOR SELECT USING (false);
CREATE POLICY "payment_evidence_insert_blocked" ON public.payment_evidence FOR INSERT WITH CHECK (false);
CREATE POLICY "payment_evidence_update_blocked" ON public.payment_evidence FOR UPDATE USING (false);
CREATE POLICY "payment_evidence_no_delete"      ON public.payment_evidence FOR DELETE USING (false);

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.payments         FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.payment_events   FROM anon, authenticated;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.payment_evidence FROM anon, authenticated;

-- ── payment_reconciliation_summary: live derived aggregate ────────────────────
--
-- Same philosophy as inventory_stock (migration 021): never a maintained
-- balance/cache column, always recomputed from the ledger of truth (here,
-- the payments table's current state). security_invoker means the view
-- enforces payments' RLS for whichever role queries it — which is "nobody but
-- service_role", identical to the base table.

CREATE VIEW public.payment_reconciliation_summary
WITH (security_invoker = true) AS
SELECT
  organization_id,
  method,
  currency,
  status,
  verification_state,
  COUNT(*)::INTEGER      AS payment_count,
  SUM(amount_minor)::BIGINT AS amount_minor_total
FROM public.payments
GROUP BY organization_id, method, currency, status, verification_state;

COMMENT ON VIEW public.payment_reconciliation_summary IS
  'Live aggregate of payments, grouped for reconciliation reads (expected revenue, needs-review buckets, COD unsettled, etc.). Not a cache — always recomputed. See src/server/payments/reconciliation.ts.';

REVOKE ALL ON public.payment_reconciliation_summary FROM anon, authenticated;
