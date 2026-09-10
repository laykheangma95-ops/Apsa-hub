# APSA — Payment Domain

**Status:** Domain foundation AND transactional Order integration built.
Migrations written, NOT applied to the hosted Supabase project. No UI. No live
bank/API integration.

**Source of truth:** `DATA_MODEL.md` §50–53 (Payment, PaymentAttempt, PaymentProviderEvent,
Refund), `MVP_ROADMAP.md` §14 (Phase 8 — Payment Records), `PERMISSIONS_MATRIX.md` §17
(Payments), `SECURITY.md` §§41–44 (Payment Security, Payment Overrides, Refunds),
`ARCHITECTURE.md` (money rules).

---

## 1. Relationship to `orders.payment_status`

`orders.payment_status` (migration 023) is a coarse axis — `unpaid` / `pending` /
`paid` / `failed`, nothing finer — created for a phase that deliberately had no
payments table at all. The Payment Domain's foundation phase (migrations 034–036)
kept it completely untouched on purpose, and documented the integration as
explicitly deferred future work. **That phase is this document's history now, not
its current state**: migration 039 wires this Payment domain in as the axis's SOLE
authoritative driver, exactly the way the foundation phase said it would have to be
— "wired the same way migration 026 wired Inventory into Order: as one atomic
RPC-level change... never as two sequential service calls that could crash between
them."

Concretely:

- `src/server/payments/service.ts` and `repository.ts` are **still** completely
  unmodified by the integration — no import of `@/server/orders`, no call to
  `transitionPaymentStatus`/`transitionOrderPaymentFn`, enforced by the same
  structural tests as before (§9) plus a duplicate assertion in
  `src/tests/payment-order-integration.test.ts`. The bridge is **SQL calling SQL**:
  `record_payment_v1` / `verify_payment_v1` / `reverse_payment_v1` /
  `refund_payment_v1` each call a new function, `sync_order_payment_status_v1`
  (migration 039), inside their own transaction — never a second, separate
  TypeScript call that could crash between the two writes.
- `sync_order_payment_status_v1` recomputes `orders.payment_status` from the
  **net settled amount** — settled payment amounts minus refunds and reversals,
  compared against the order's own total — and applies it via the existing
  `transition_order_status_v1` (migration 026), never by writing the column
  directly. See §1a below for the exact rule.
- The Order domain's own generic mutator, `transitionPaymentStatus()`
  (`src/server/orders/service.ts`), is **closed**: it now unconditionally refuses
  every call (still 403 for a caller lacking `payments.confirm`, then 409 for one
  who has it), pointing at this domain. Before migration 039 this function was a
  second, independent way to write `orders.payment_status` with **no payment
  record required at all** — exactly the failure mode ("Order paid but no
  authoritative Payment exists") the integration exists to close. POS,
  Conversation and Delivery never called it in the first place (their own
  structural tests already proved that) and are unaffected.

### 1a. The settlement rule: an amount, not a flag

`orders.payment_status` has no `partially_paid`/`overpaid` state of its own — it
stays coarse by design (task brief: "Order payment axis: unpaid, pending, paid,
failed"). **Coarse does not mean approximate.** Whether an order is paid is an
AMOUNT question, so it is answered by comparing money that actually settled
against the order's own authoritative total (`orders.total_minor`, itself
DB-constrained to equal subtotal − discount + delivery, migration 023):

```
NET SETTLED = settled payment amounts − refunds − reversals

net > 0 AND net >= orders.total_minor  ->  'paid'     (exactly settled, or overpaid)
net > 0 AND net <  orders.total_minor  ->  'pending'  (PARTIAL — never 'paid')
net = 0 AND a pending payment exists    ->  'pending'
net = 0 AND only failed payments exist  ->  'failed'
otherwise                                ->  'unpaid'
```

What each payment status contributes to NET SETTLED:

| Payment `status` | Contributes |
|---|---|
| `paid` | its amount, **minus** whatever has since been refunded |
| `refunded` | same arithmetic — exactly 0 by construction |
| `pending` | 0 — a claim, not money (unverified records, evidence-backed records and unsettled COD all sit here) |
| `failed` | 0 — the claim was found not to hold up |
| `reversed` | 0 — the entire claim was voided, its refunds included |

The `net > 0` guard matters for a zero-total order: without it an order with no
payments at all would satisfy `0 >= 0` and be reported paid.

> **This rule replaced a financial-integrity bug.** The first draft of this
> integration derived the order's status from the EXISTENCE of a settled payment
> row ("any payment is paid → order is paid"). Under that rule a **$10** settled
> payment against a **$100** order marked the order fully paid, and a $20 partial
> refund of a fully-paid $100 order did not un-pay it. Settlement is an amount, so
> the rule sums amounts.

**Partial refunds resynchronize the order.** `refund_payment_v1` calls the sync on
**every** refund, not only a full one: $100 order, $100 paid, $20 refunded leaves
$80 net settled, so the order stops being `paid`. `payments.amount_minor` is still
never mutated — the refunded total is derived by summing the payment's append-only
`refund` events, so the original claim stays visible (DATA_MODEL.md §53).

**Currency safety.** Only payments in the ORDER's currency are summed; two
currencies are never added and no exchange rate is invented (ARCHITECTURE.md).
Everything is BIGINT integer minor units — no NUMERIC, no float, no rounding, and
`settlement.ts` rejects a non-integer outright rather than rounding it into a
comparison.

**Overpayment (net > total)** keeps the coarse axis at `paid` — the order genuinely
is covered — and adds **no** new `order_payment_status` enum value. The excess is
preserved, not discarded, in four places:

1. `sync_order_payment_status_v1`'s return envelope (`over_settled_minor`,
   `settlement_state`, `needs_review`), returned on the no-change path too, so an
   overpayment found on an already-`paid` order still surfaces;
2. the `order_status_history.reason` text stamped at the moment it happened;
3. **`public.order_payment_settlement`** (migration 039) — a live view giving every
   order its total, net settled, outstanding, over-settled and
   `settlement_state` (`unsettled`/`partial`/`settled`/`overpaid`). Never a cache:
   derived from `payments` + their append-only refund events + the order total, so
   it cannot drift or need backfilling (same philosophy as `inventory_stock` and
   `payment_reconciliation_summary`);
4. `reconciliation.ts#getOrderSettlement` / `#getOrderSettlementIssues` (gated on
   `payments.read` / `payments.reconcile`), exposed through
   `getOrderSettlementFn` / `getOrderSettlementIssuesFn`.

Only `overpaid` is flagged `needsReview` — more money arrived than was ever owed,
which no legitimate workflow produces on its own. A *partially* settled order is an
ordinary Cambodian deposit/instalment state and is listed for follow-up, never
flagged as an anomaly.

**The rule is specified once, in TypeScript.** `src/server/payments/settlement.ts`
is the pure, exhaustively tested statement of it — the same division of labour
`state-machine.ts` already has with `verify_payment_v1`. The SQL function is how
the rule is applied *atomically*; that module is what the rule *is*. Structural
tests assert the two agree.

`PAYMENT_TRANSITIONS.paid` (`src/server/orders/state-machine.ts`) gained exits to
`pending`/`failed`/`unpaid` to describe this — reachable only through the
settlement recompute above, never through `transitionPaymentStatus()`.

---

## 2. Architecture

```
src/server/payments/
  types.ts            raw DB row types, RPC result envelopes, input types
  state-machine.ts     pure verification-state transition table (no DB, no I/O)
  repository.ts        RPC wrappers + org-scoped reads (supabaseAdmin only)
  service.ts            permission checks, validation, audit, domain mapping
  integrations.ts       bank/API verification adapter CONTRACT (no live adapter)
  reconciliation.ts     aggregate reads over payment_reconciliation_summary

src/api/payments.ts     browser-safe TanStack Start server functions
```

Same layered shape as the Order and Delivery domains: UI → `src/api/*` → domain
service → repository (RPC-only writes) → PostgreSQL. No route or component imports
`src/server/payments/*` directly — every mutation and read goes through
`src/api/payments.ts`, which dynamically imports server-only modules inside handler
bodies (never a static top-level import), exactly like `src/api/orders.ts`.

The Order integration (migration 039, §1/§1a) adds no new TypeScript module —
`sync_order_payment_status_v1` lives entirely in Postgres and is called only from
inside the four RPCs above, never from `src/server/payments/*`.

---

## 3. State model

Two independent axes, mirroring Order's lifecycle/payment/fulfillment split:

| Axis | Values | Meaning |
|---|---|---|
| `status` | `pending → paid → (reversed \| refunded)`, or `failed` | Settlement outcome of this payment record |
| `verification_state` | `unverified → staff_confirmed → manager_verified → bank_verified`, plus `mismatch`, `duplicate_suspected` | How much the claim "this money arrived" can be trusted, and by whom |

A payment is displayed as the combination: **"Paid · Staff confirmed"**, **"Paid ·
Manager verified"**, **"Paid · Bank verified"**, **"Pending · Needs review"**.

`status` is never set independently — it is the **derived consequence** of a
verification transition (`resultingPaymentStatus` in `state-machine.ts`), applied
atomically by `verify_payment_v1`:

| Target verification state | Resulting status |
|---|---|
| `staff_confirmed`, `manager_verified`, `bank_verified` | `paid` |
| `mismatch` | `failed` |
| `unverified`, `duplicate_suspected` | `pending` |

Reversal and refund are the only two ways `status` moves outside this mapping
(`reverse_payment_v1` → `reversed`, `refund_payment_v1` → `refunded` once fully
refunded), and both are separate, narrowly-scoped RPCs.

### Verification transition table

```
unverified            → staff_confirmed | bank_verified | mismatch
staff_confirmed       → manager_verified | bank_verified | mismatch
manager_verified      → bank_verified | mismatch
bank_verified         → mismatch
mismatch              → unverified
duplicate_suspected   → unverified | staff_confirmed | manager_verified | mismatch
```

`unverified → bank_verified` exists directly because an API-confirmed bank payment
can arrive with no manual step at all — the core product principle: *"APSA must
support payments with or without bank API."*

Since migration 039, every one of these transitions also recomputes
`orders.payment_status` in the same transaction (§1a). `staff_confirmed` /
`manager_verified` / `bank_verified` are the only targets that can move money
into the settled total at all — but they make the ORDER `paid` only if the
resulting net settled amount actually covers the order total: verifying a
deposit that covers half the order leaves the order `pending`. `mismatch`
removes that payment's money from the total again, which downgrades the order
only if the remaining payments no longer cover it.

---

## 4. COD rules

Cash-on-delivery does **not** mean paid. `deliveries.cod_amount_minor` (migration 027)
is an operational collection reference only — migration 027 makes no reference to the
`payments` table at all (verified by a structural test), and no Delivery status
transition (`pending/preparing/ready/in_transit/delivered/failed/cancelled`) ever calls
into the Payment domain, and migration 039 adds nothing there either — Delivery only
ever writes `orders.fulfillment_status`. COD settlement happens later, exclusively
through `recordPayment({ method: "cod" })`, which requires its own permission
(`payments.mark_cod`) distinct from counter payments (`payments.record`).

Recording a COD payment is **not itself settlement**: `record_payment_v1` always
inserts `status = 'pending'` regardless of method (§1a moves the order to `pending`,
not `paid`, at this point). Only a subsequent `verifyPayment(..., 'staff_confirmed')`
— someone actually confirming the cash was collected — moves the payment, and
therefore the order, to `paid`.

---

## 5. Evidence handling

Screenshots, QR scans and receipts are supporting data, never financial authority.
`attach_payment_evidence_v1` writes only to `payment_evidence` and appends an
`evidence_attached` event — it is structurally incapable of touching
`payments.status` or `payments.verification_state` (no `UPDATE public.payments`
exists in that function; a test asserts this directly against the SQL). `storage_ref`
is an opaque pointer into wherever APSA stores uploaded files, never a binary blob in
the database. `extracted_amount_minor` / `extracted_reference` / `extracted_at` are
schema-ready for a future OCR/extraction pass; nothing writes non-null values there
yet except what the uploader explicitly supplies.

`reference` and evidence `storage_ref` are withheld (returned as `null`) from any
caller who lacks `payments.view_provider_reference` — the same withholding pattern
the Product domain uses for cost fields. This withholding also applies to
`payment_events[].metadata`: a `duplicate_flagged` event's metadata carries the raw
colliding reference and a `correction` event's metadata carries the before/after
reference values, so `mapEvent()` redacts any object key matching `/reference/i`
(recursively, at any nesting depth) whenever the caller lacks
`payments.view_provider_reference` — a name-pattern redaction rather than an allowlist
of today's known event shapes, so it also covers metadata a future bank-adapter
integration might add (e.g. `providerReference`, `conflictingReference`).

---

## 6. Idempotency

`idempotency_key` is a hard, DB-enforced uniqueness constraint
(`uniq_payments_idempotency`, partial index scoped per organization).
`record_payment_v1` inserts with
`ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`
and, on conflict, re-reads and returns the existing payment (`replayed: true`) instead
of creating a second row. This is safe under **concurrent** identical requests (double
click, network retry, replayed webhook), not just sequential ones — the uniqueness
guarantee lives in the index, not in application-level locking.

Verification, reversal and refund are all protected by row-level `FOR UPDATE` locks
plus optimistic-concurrency `expected_from` checks (verification) or direct state
checks (reversal/refund) — a concurrent conflicting call is surfaced as a domain-safe
`stale`/`invalid_state` result, never silently overwritten.

---

## 7. Duplicate reference behavior

A `reference` collision with another **active** (non-reversed) payment in the same
organization is **suspicious, not impossible**. `record_payment_v1` still creates the
payment, but starts it at `verification_state = 'duplicate_suspected'` instead of
`unverified`, and appends a `duplicate_flagged` event explaining why. There is no hard
uniqueness constraint on `reference` — a resent screenshot or a re-quoted KHQR code is
a normal occurrence, and rejecting it outright would block a legitimate sale. A flagged
duplicate is later resolved through `verify_payment_v1`
(`duplicate_suspected → unverified | staff_confirmed | manager_verified | mismatch`).

**Concurrency:** the duplicate-reference `EXISTS` check and the `INSERT` are two
separate statements — without serialization, two genuinely concurrent calls carrying
the same reference could each see "no duplicate" before either commits.
`record_payment_v1` takes a transaction-scoped advisory lock
(`pg_advisory_xact_lock(hashtext(organization_id || ':' || reference))`) immediately
before the check, so a second concurrent call for the same `(organization_id,
reference)` pair waits for the first to commit and then reliably observes its row —
same pattern as `create_organization_for_founder`'s per-founder lock (migration 009).
Skipped entirely when no reference is supplied.

---

## 8. Reversal / correction / refund rules

Nothing is ever deleted or destructively rewritten:

- **Reversal** (`reverse_payment_v1`): requires a reason; moves `status` to the
  terminal `reversed`; appends a `reversal` event. Allowed only from `pending`/`paid`.
  Since migration 039, recomputes `orders.payment_status` (§1a) in the same
  transaction: the reversed payment's whole amount (its own refunds included)
  stops counting toward net settled, so the order stays `paid` if the REMAINING
  payments still cover its total and drops if they no longer do. A reversal never
  downgrades an order that other payments still fully cover, and never leaves one
  marked paid whose money has gone.
- **Refund** (`refund_payment_v1`): refunded amount is **derived** by summing prior
  `refund` events for the payment — `payments.amount_minor` is never mutated
  (`DATA_MODEL.md` §53). Supports partial refunds; `status` moves to `refunded` only
  once the cumulative refunded total equals the original amount. Since migration
  039, recomputes `orders.payment_status` (§1a) on **every** refund, partial ones
  included — a $20 refund against a fully-paid $100 order leaves $80 net settled,
  so the order stops being `paid`. (Syncing only on a FULL refund was the
  partial-refund half of the financial-integrity bug §1a describes.)
- **Correction** (`correct_payment_v1`): narrow by design — may only update
  `reference`/`note` (never amount/method/currency, since a wrong amount is a
  reversal-and-re-record situation, not a paperwork fix). Requires
  `payments.override_status` (Owner only) and always appends a `correction` event
  carrying the before/after values. Untouched by migration 039 — a correction never
  moves `status`, so it has no Order consequence.

`payment_events` is append-only **at the database level**: `BEFORE UPDATE` and
`BEFORE DELETE` triggers (`block_payment_event_mutation`) raise unconditionally for
every role, including `service_role` — this is not merely an RLS policy that a
service-role bypass could defeat.

The Order axis has no `refunded` state of its own (§1a) — after any refund or
reversal, `sync_order_payment_status_v1` recomputes the order from the net settled
amount that remains (still covering the total keeps it `paid`; a shortfall with
money still in play makes it `pending`; nothing left makes it `unpaid`).
"Recompute safely" means exactly this: never a blind downgrade, never a stale
`paid`, always a fresh amount-based recomputation over the order's current
payments.

---

## 9. Tenant isolation & permissions

- `organization_id` is never trusted from the client — every `src/api/payments.ts`
  handler resolves it from the caller's active DB membership, the same
  `resolveAuthContext()` pattern as `src/api/orders.ts`/`src/api/deliveries.ts`.
  `user_id` comes from the validated session cookie.
- All three tables (`payments`, `payment_events`, `payment_evidence`) have RLS
  enabled with every policy `USING (false)`/`WITH CHECK (false)` — JWT clients get
  **no** direct access at all, not even `SELECT`, plus a matching `REVOKE` on the
  table grants (defense in depth, same posture as `orders`/`deliveries`).
  All six RPCs (`record_payment_v1`, `attach_payment_evidence_v1`,
  `verify_payment_v1`, `reverse_payment_v1`, `refund_payment_v1`,
  `correct_payment_v1`) have `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated`
  and granted only to `service_role`.
- Cross-tenant integrity triggers re-verify every FK's `organization_id` against the
  row's own, so a cross-tenant link is impossible even through a service-role write.
- Permission vocabulary (migration 036, `PERMISSIONS_MATRIX.md` §17):

  | Permission | Owner | Manager | Cashier | Sales | Customer Service |
  |---|:---:|:---:|:---:|:---:|:---:|
  | `payments.read` | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
  | `payments.record` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
  | `payments.manual_confirm` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
  | `payments.mark_cod` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
  | `payments.verify` | ✅ | ✅ | ❌ | ❌ | ❌ |
  | `payments.refund` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
  | `payments.reverse` | ✅ | ❌ | ❌ | ❌ | ❌ |
  | `payments.override_status` | ✅* | ❌ | ❌ | ❌ | ❌ |
  | `payments.view_provider_reference` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
  | `payments.reconcile` | ✅ | ✅ | ❌ | ❌ | ❌ |

  ⚠️ = conditional, deliberately not granted outright yet (same convention as
  migrations 019/022/025/027). `payments.confirm`/`payments.override` (migration
  003) are pre-existing, unrelated keys — `payments.confirm` remains the Order
  domain's own payment-axis permission; `payments.override` is left in place but
  superseded going forward by `payments.override_status`. All nine keys in this
  table — including `payments.verify`, `payments.reverse` and `payments.reconcile`,
  which this phase introduces beyond the original matrix — are now recorded in
  `PERMISSIONS_MATRIX.md` §17 itself, not only here.

---

## 10. Error model

Every service function throws a plain `Error` with a `statusCode` property
(400/404/409) and a message safe to show to a caller — never a raw Postgres error.
RPC business-outcome envelopes (`{status: '...'}`) are mapped by dedicated
`*FailureToError` functions in `service.ts`. Genuinely impossible states (a coding
bug, not a business outcome) `RAISE EXCEPTION` in SQL and surface as a generic 500.

---

## 11. Bank/API verification hook

`src/server/payments/integrations.ts` defines `PaymentVerificationAdapter` — a
provider-agnostic contract (`verify(request) → PaymentVerificationOutcome`) and a
pure mapping (`outcomeToVerificationTarget`) from a normalized outcome to a
`verify_payment_v1` target state. The only adapter shipped in this phase,
`manualOnlyAdapter`, always reports `not_found` — there is no live bank/API
integration. A future adapter (ABA, Wing, Bakong/KHQR, or any other partner) plugs
into this same interface with no domain-layer or schema change required.

---

## 12. Reconciliation foundation

`src/server/payments/reconciliation.ts#getReconciliationSummary(ctx)` (gated on
`payments.reconcile`) aggregates `payment_reconciliation_summary` — a live,
non-cached SQL view over `payments`, grouped by
`(organization_id, method, currency, status, verification_state)` — into per-currency
buckets: expected revenue, paid, pending, failed, reversed, refunded, bank-verified,
manager-verified, staff-confirmed-only, COD-unsettled, needs-review (mismatch +
duplicate-suspected + pending-and-unverified), duplicate-suspected, and mismatch.
Two currencies are never summed together (no implicit exchange rate).

**Bucket definitions, stated precisely (each is also documented inline on
`ReconciliationSummary` in the source):**

- **`expectedRevenue`** = `status IN ('pending', 'paid', 'refunded')`. Excludes
  `reversed` (voided before/instead of settling — never became revenue) and `failed`
  (the status a `mismatch` verification always produces — the claim was found not to
  hold up, so it never became real money either). **Includes `refunded`, gross**: a
  refunded payment genuinely arrived and settled as `paid` before later being returned,
  so excluding it would erase that the sale happened. `refunded` is reported as its own
  bucket precisely so a consumer can compute `expectedRevenue - refunded` for a NET
  figure — do not add `refunded` into `expectedRevenue` a second time.
- **`bankVerified` / `managerVerified` / `staffConfirmedOnly`** = the matching
  `verification_state`, but **only while `status = 'paid'`**. `reverse_payment_v1` and
  `refund_payment_v1` never touch `verification_state` (migration 035), so a reversed or
  refunded payment can still carry e.g. `verification_state = 'bank_verified'` from
  before it was voided/returned — these trust-tier buckets deliberately exclude that
  money because it is no longer a live balance.
- **`needsReview` / `duplicateSuspected` / `mismatch`** = the matching
  `verification_state`, excluding any payment already `reversed` or `refunded` — voiding
  or refunding a payment already resolved whatever needed reviewing about it.

**No dashboard UI exists yet.** This is backend capability only, using neutral
labels ("needs review") rather than accusatory ones, per `SECURITY.md`'s guidance
against labeling staff actions as theft/fraud.

---

## 13. Migration rollout order

| # | File | Purpose |
|---|------|---------|
| 34 | `034_payments_domain.sql` | Enums, `payments`/`payment_events`/`payment_evidence` tables, cross-tenant triggers, append-only trigger on `payment_events`, RLS, `payment_reconciliation_summary` view |
| 35 | `035_payment_rpc.sql` | `record_payment_v1`, `attach_payment_evidence_v1`, `verify_payment_v1`, `reverse_payment_v1`, `refund_payment_v1`, `correct_payment_v1`, privilege grants |
| 36 | `036_payment_permissions.sql` | Seeds the finer-grained `payments.*` permission keys and role grants |
| 39 | `039_payment_order_integration.sql` | Adds `sync_order_payment_status_v1` (net-settlement rule, §1a) and the `order_payment_settlement` view; `CREATE OR REPLACE`s `record_payment_v1`/`verify_payment_v1`/`reverse_payment_v1`/`refund_payment_v1` (same signatures) to call it. No table/column/enum change. |

Numbered 034–036 (and, for the integration, 039) because the repository's `main`
branch had already advanced past the task brief's original 028–029 placeholder
range by the time each phase started (037–038 belong to Conversation ingestion
work) — see each migration's own numbering note. Additive only; no existing
migration file's contents were modified by any of these.

---

## 14. Hosted Supabase migration status

**NOT APPLIED.** Migrations 034–036 and 039 exist only in this repository. Per this
phase's constraints, no hosted Supabase migration was run. The project owner must
apply 034–036 then 039 (in order, after 001–038) to the live APSA Supabase project
before any production traffic reaches this domain, then run
`supabase gen types typescript` to regenerate `src/lib/supabase/types.ts` and remove
the `as any` casts in `src/server/payments/repository.ts` (same activation step every
prior domain — Customer, Product, Order, Delivery — has documented in
`APSA_BUILD_STATUS.md`). Migration 039 depends only on 023/026 (Order + its Inventory
integration) and 034–036 already being applied; it adds no new dependency.

---

## 15. Smoke-test checklist (once migrations are applied to a live project)

1. `record_payment_v1` — record a cash payment against a real order (starting
   `orders.payment_status = 'unpaid'`); confirm a `payments` row appears with
   `status='pending'`, `verification_state='unverified'`, a `created` row in
   `payment_events`, AND that the order's `payment_status` moved to `'pending'`
   with a new `order_status_history` row (`axis='payment'`).
2. Re-run the exact same `recordPayment` call with the same `idempotencyKey` — confirm
   no second `payments` row is created, the same `payment_id` is returned, and the
   order's `payment_status` is unaffected (still `'pending'`, no duplicate history row).
3. `attachEvidence` — attach a screenshot to the payment; confirm `payments.status`,
   `verification_state`, AND `orders.payment_status` are all unchanged.
4. **PARTIAL SETTLEMENT — the case this checklist exists for.** On a $100 order,
   record and `verifyPayment(..., 'staff_confirmed')` a **$10** payment. Confirm the
   payment's `status` becomes `paid` and its `staff_confirmed` event is recorded —
   but `orders.payment_status` is `'pending'`, **NOT** `'paid'`. Then check
   `SELECT * FROM order_payment_settlement WHERE order_id = ...`:
   `net_settled_minor = 1000`, `outstanding_minor = 9000`,
   `settlement_state = 'partial'`.
5. Settle the remaining $90 (a second payment, verified). Confirm net settled now
   equals the order total, `settlement_state = 'settled'`, and only NOW does
   `orders.payment_status` become `'paid'` — with an `order_status_history` row
   (`axis='payment'`, `to='paid'`) whose `reason` carries the settlement figures.
6. Attempt a direct `UPDATE`/`DELETE` on a `payment_events` row via the SQL editor as
   `service_role` — confirm it is rejected by `block_payment_event_mutation`.
7. **PARTIAL REFUND.** `refundPayment` $20 against that fully-settled $100 order.
   Confirm the payment's own `status` stays `paid` (it is only partially refunded),
   `payments.amount_minor` is unchanged, a `refund` event exists — and
   `orders.payment_status` has dropped OUT of `'paid'` to `'pending'`, with
   `net_settled_minor = 8000` and `settlement_state = 'partial'`. Then refund the
   remaining $80: the payment becomes `'refunded'`, the order `'unpaid'`,
   `settlement_state = 'unsettled'`, and both `refund` events remain.
8. **OVERPAYMENT.** On a fresh $100 order, settle $110 (e.g. two verified payments).
   Confirm `orders.payment_status` is `'paid'` (the order IS covered), no new enum
   value appeared on that column, and `order_payment_settlement` reports
   `settlement_state = 'overpaid'` with `over_settled_minor = 1000`.
   `getOrderSettlementIssues` must list that order under `overpaid` with
   `needsReview: true`.
9. Attempt any of the six RPCs (or `sync_order_payment_status_v1` directly) as the
   `anon` or `authenticated` role directly against PostgREST — confirm
   `permission denied for function ...` for every one of them. Do the same for
   `SELECT * FROM order_payment_settlement`.
10. On a fully-settled order, record a SECOND payment and let its verification fail
    (`mismatch`) — confirm the order STAYS `'paid'`: the failed attempt never
    counted toward net settled, so removing it changes nothing (§1a).
11. Reverse the payment that fully settled an order (no other active payment on it)
    — confirm `orders.payment_status` recomputes to `'unpaid'`, `net_settled_minor`
    returns to 0, and the original `payments` row (now `status='reversed'`) and its
    full event history remain visible and unmodified.
12. Confirm a COD payment (`method: 'cod'`) leaves the order at `'pending'`, not
    `'paid'`, until a subsequent `verifyPayment` call — Delivery's own status
    transitions (`create_delivery_v1`/`transition_delivery_status_v1`, migration 027)
    must never move `orders.payment_status` regardless of how far the delivery
    progresses.
13. **Cross-tenant.** As Org A, call `getOrderSettlement` with an Org B order id —
    confirm `null` (indistinguishable from a nonexistent order), and that Org B's
    payments never appear in any Org A settlement figure.
