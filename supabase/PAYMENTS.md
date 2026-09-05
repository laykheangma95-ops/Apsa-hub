# APSA — Payment Domain

**Status:** Foundation built. Migrations written, NOT applied to the hosted Supabase
project. No UI. No live bank/API integration.

**Source of truth:** `DATA_MODEL.md` §50–53 (Payment, PaymentAttempt, PaymentProviderEvent,
Refund), `MVP_ROADMAP.md` §14 (Phase 8 — Payment Records), `PERMISSIONS_MATRIX.md` §17
(Payments), `SECURITY.md` §§41–44 (Payment Security, Payment Overrides, Refunds),
`ARCHITECTURE.md` (money rules).

---

## 1. Why this domain is separate from `orders.payment_status`

`orders.payment_status` (migration 023) is a coarse, manually-driven axis — "has the
money arrived" — created for a phase that deliberately had no payments table at all.
It is **untouched by this phase**. Nothing in `src/server/payments/*` or migrations
034–036 writes to the `orders` table, imports `@/server/orders`, or calls
`transitionPaymentStatus`/`transitionOrderPaymentFn`. That boundary is enforced by
structural tests (see §9) as well as by the fact that the Payment repository's only
touch on `orders` is a read-only existence/currency lookup.

Making this Payment domain the authoritative driver of `orders.payment_status` is
**explicitly the next phase's work**, and it must be wired the same way migration 026
wired Inventory into Order: as one atomic RPC-level change inside
`transition_order_status_v1`, never as two sequential service calls that could crash
between them. This foundation phase stops short of that integration on purpose — see
the task brief's "Payment / Order separation" section.

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

---

## 4. COD rules

Cash-on-delivery does **not** mean paid. `deliveries.cod_amount_minor` (migration 027)
is an operational collection reference only — migration 027 makes no reference to the
`payments` table at all (verified by a structural test), and no Delivery status
transition (`pending/preparing/ready/in_transit/delivered/failed/cancelled`) ever calls
into the Payment domain. COD settlement happens later, exclusively through
`recordPayment({ method: "cod" })`, which requires its own permission
(`payments.mark_cod`) distinct from counter payments (`payments.record`).

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
the Product domain uses for cost fields.

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

---

## 8. Reversal / correction / refund rules

Nothing is ever deleted or destructively rewritten:

- **Reversal** (`reverse_payment_v1`): requires a reason; moves `status` to the
  terminal `reversed`; appends a `reversal` event. Allowed only from `pending`/`paid`.
- **Refund** (`refund_payment_v1`): refunded amount is **derived** by summing prior
  `refund` events for the payment — `payments.amount_minor` is never mutated
  (`DATA_MODEL.md` §53). Supports partial refunds; `status` moves to `refunded` only
  once the cumulative refunded total equals the original amount.
- **Correction** (`correct_payment_v1`): narrow by design — may only update
  `reference`/`note` (never amount/method/currency, since a wrong amount is a
  reversal-and-re-record situation, not a paperwork fix). Requires
  `payments.override_status` (Owner only) and always appends a `correction` event
  carrying the before/after values.

`payment_events` is append-only **at the database level**: `BEFORE UPDATE` and
`BEFORE DELETE` triggers (`block_payment_event_mutation`) raise unconditionally for
every role, including `service_role` — this is not merely an RLS policy that a
service-role bypass could defeat.

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
  superseded going forward by `payments.override_status`.

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

Numbered 034–036 because the repository's `main` branch had already advanced to
migration 033 by the time this phase started (the task brief's original 028–029
placeholder range no longer applied — see the task brief's own numbering note).
Additive only; no existing migration file was modified.

---

## 14. Hosted Supabase migration status

**NOT APPLIED.** Migrations 034–036 exist only in this repository. Per this phase's
constraints, no hosted Supabase migration was run. The project owner must apply
034–036 (in order, after 001–033) to the live APSA Supabase project before any
production traffic reaches this domain, then run
`supabase gen types typescript` to regenerate `src/lib/supabase/types.ts` and remove
the `as any` casts in `src/server/payments/repository.ts` (same activation step every
prior domain — Customer, Product, Order, Delivery — has documented in
`APSA_BUILD_STATUS.md`).

---

## 15. Smoke-test checklist (once migrations are applied to a live project)

1. `record_payment_v1` — record a cash payment against a real order; confirm a
   `payments` row appears with `status='pending'`, `verification_state='unverified'`,
   and a `created` row in `payment_events`.
2. Re-run the exact same `recordPayment` call with the same `idempotencyKey` — confirm
   no second row is created and the same `payment_id` is returned.
3. `attachEvidence` — attach a screenshot to the payment; confirm `payments.status`
   and `verification_state` are unchanged.
4. `verifyPayment(..., 'staff_confirmed')` — confirm `status` becomes `paid` and an
   immutable `staff_confirmed` event is recorded with the acting user id.
5. Attempt a direct `UPDATE`/`DELETE` on a `payment_events` row via the SQL editor as
   `service_role` — confirm it is rejected by `block_payment_event_mutation`.
6. `refundPayment` for a partial amount, then again for the remainder — confirm
   `status` stays `paid` after the first call and becomes `refunded` only after the
   second, with two separate `refund` events.
7. Attempt any of the six RPCs as the `anon` or `authenticated` role directly against
   PostgREST — confirm `permission denied for function ...`.
8. Confirm `orders.payment_status` on the same order is completely unaffected by every
   step above.
