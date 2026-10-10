# APSA — CORRECTIONS & AMENDMENTS LOG

**Document:** `CORRECTIONS.md`  
**Project:** APSA  
**Status:** Active — source of truth for overrides, clarifications, and corrections to all other APSA documents  
**Audience:** Claude Code, Lovable, Codex, all engineers, all AI agents working on this project  
**Rule:** When this file contradicts any other APSA document, **this file wins.**

---

# 1. PURPOSE

This document exists to prevent a common failure in AI-assisted development:

> An AI agent reads an outdated instruction in one document, implements it, and breaks something that was already corrected in a later conversation.

CORRECTIONS.md is the amendment log for all APSA source-of-truth documents.

When a decision changes, when a document contains an error, or when a clarification supersedes earlier guidance — it is recorded here first.

Every agent, engineer, or tool working on APSA **must read this file before acting on any other document.**

---

# 2. HOW TO READ THIS FILE

Each correction entry contains:

- **Date** — when the correction was made
- **Affects** — which document(s) the correction applies to
- **Section** — the section or topic being corrected
- **Original** — what the document previously said (or implied)
- **Correction** — what is now true
- **Reason** — why the correction was made

Corrections are listed newest first.

---

# 3. ACTIVE CORRECTIONS

---

### CORRECTION-005

**Date:** 2026-10-11
**Affects:** supabase/migrations/062_financial_replay_refund_audit_atomicity.sql (new: `record_payment_v1` replaced, `refund_payment_v2`, `reverse_payment_v2`, `correct_payment_v2`, `payment_replay_matches_v1`; `refund_payment_v1` / `reverse_payment_v1` / `correct_payment_v1` retired), DATA_MODEL.md §53 (the "Recording retry keys…" and "Payment history is protected…" paragraphs — superseded here, not edited), src/server/auth/audit.ts and src/server/auth/audit-unavailable.ts, src/server/payments/repository.ts and service.ts (`refundPayment`, `reversePayment`, `correctPayment`), src/api/payments.ts (`refundPaymentFn`), src/lib/api/index.ts (`refundRealPayment`), src/lib/payments.ts (`refundedMinorOf`), src/routes/app.payments.$id.tsx (refund); proofs: src/tests/financial-mutation-integrity.runtime.ts, src/tests/payment-action-principal-mounted.runtime.ts, src/tests/financial-replay-audit-contract.test.ts
**Section:** Payments — durable replay identity, refund idempotency, mandatory-audit atomicity
**Original:** DATA_MODEL.md §53: a payment-recording retry key replayed the existing payment for any caller presenting it with the same order, amount and method; "Refund APIs accept an optional idempotency key scoped to the Payment … Legacy callers without a key retain non-idempotent refund behavior"; "The separate mandatory audit write is required on replay too, so a failed earlier audit can be repaired. Replay audit records carry an explicit flag". The refund, reversal and correction RPCs committed first and the mandatory audit row was a second, separate write.
**Correction:** Project owner decision (PR #121 independent review P2 #3, #4, #5; migration 062 approved 2026-10-10):
- **Payment-recording replay** belongs to one actor, tenant and request. A key replays only the original member's original request — same order, recorder, method, amount, and the reference and note *as originally recorded* (a later correction does not change what the original request was). Anything else under that key is `idempotency_conflict` (409) and writes nothing; a replay writes nothing either. The key stays organization-scoped.
- **Refund idempotency is durable and required.** `refundPaymentFn` requires an idempotency key and the refunded total the refund was started from; a request without either (a browser bundle from before this rule) is refused before anything runs. One key is one logical refund in the organization: every request carrying it is serialized (transaction advisory lock), it replays only for the same member, payment, amount and reason (nothing written), and anything else — including the same key on another payment — is `idempotency_conflict`. The key is stored in the refund's own ledger event. The refunded-total precondition is an additional safeguard, not the idempotency: a different current total is `refund_stale` (409, nothing written), which refuses a retry that lost its key but still describes the payment as it was before the refund already made. Payment detail holds one key per logical refund in its page-lifetime, member + organization scoped holder, retired only when the server accepts the refund.
- **Mandatory financial audits are atomic with their mutation.** Refund, reversal and correction write their mandatory audit row (`payments.refund`, `payments.reverse`, `payments.override`) inside the same database transaction as the financial change (`refund_payment_v2`, `reverse_payment_v2`, `correct_payment_v2`); if the audit insert fails the whole call rolls back and the caller gets 503 `audit_unavailable`. The audit's organization and actor are the server's own (the RPC's `p_organization_id` / `p_actor`, from `ctx`). A replay writes no audit row: the original committed its own. The "replay repairs a failed earlier audit" design is withdrawn — there is no longer a committed refund without its audit row to repair.
- `refund_payment_v1(…, text)`, `reverse_payment_v1` and `correct_payment_v1` are retired: EXECUTE is revoked from every role except their owner (the v2 functions call them as the owner), and migration 062 asserts the effective authority itself — PUBLIC, `anon`, `authenticated`, `service_role` and any other non-owner grantee — and aborts otherwise.
- **Not covered by this correction:** `inventory.adjust` (manual stock adjustment) still writes its mandatory audit row *before* the movement, as a separate statement — an audit row can exist for an adjustment whose insert then failed; `customers.export` and the `team.*` mandatory audits are separate writes too. Payment verification and recording keep best-effort audits (not mandatory actions).
- **Deployment dependency:** migration 062 must be applied together with (or before) the application release that contains it. Code without 062 fails closed on refund, reversal and correction (the v2 functions are missing); 062 under older code fails closed too (the v1 functions are revoked). It has not been applied to staging or production.
- **Outstanding:** real-PostgreSQL concurrency verification. The local proofs run on PGlite (PostgreSQL 17, one connection): simultaneous requests are verified as interleaved outcomes, not as independent sessions contending for the order, payment and advisory locks. Until that is independently performed against a real PostgreSQL instance, lock contention is reasoned from the lock order (advisory key lock, then Order, then Payment), not tested.
**Reason:** Without a durable, actor-bound replay identity, a member could be handed another member's payment or refund as their own success — and the refund path then audited it under the wrong member. Without a required key, a refund retried after a lost response refunded twice. And a mandatory audit written after the money committed could fail, leaving money moved with no audit trail while the merchant was told it was blocked; neither writing the audit first nor compensating afterwards can make the two atomic — only one transaction can.

---

### CORRECTION-004

**Date:** 2026-10-10
**Affects:** src/server/auth/expected-principal.ts (`assertExpectedPrincipal`, the one check), src/api/orders.ts (`createOrderFn`, `transitionOrderLifecycleFn`, `transitionOrderFulfillmentFn`, `recoverOrderParcelFn`, `updateOrderShippingFn`), src/api/payments.ts (`recordPaymentFn`, `attachPaymentEvidenceFn`, `verifyPaymentFn`, `refundPaymentFn`, `reversePaymentFn`, `correctPaymentFn`), src/api/parcels.ts (`createParcelFn`), src/server/orders/service.ts (`createOrder`, `transitionLifecycleStatus`, `transitionFulfillmentStatus`, `recoverOrderParcel`, `updateOrderShippingSnapshot`), src/server/parcels/service.ts (`createParcelForOrder`), src/server/payments/service.ts (`recordPayment`, `attachEvidence`, `verifyPayment`, `refundPayment`, `reversePayment`, `correctPayment`), src/lib/initiating-principal.ts (`InitiatingPrincipal`), src/lib/api/index.ts (`CreateRealOrderInput`, `createRealOrder`, `confirmRealOrder`, `cancelRealOrder`, `recoverRealOrderParcel`, `updateOrderShipping`, `RecordRealPaymentInput`, `recordRealPayment`, `verifyRealPayment`, `refundRealPayment`, `reverseRealPayment`), src/components/pos/PosCheckoutSheet.tsx (`completeReal`, payment), src/components/orders/CreateRealOrderSheet.tsx (`submit`), src/components/inbox/PrepareOrderSheet.tsx (`submit`, `confirm`, `discardAndEdit`), src/routes/app.orders.$id.tsx (confirm, cancel, record payment), src/routes/app.payments.$id.tsx (verify, refund, reverse), src/components/fulfillment/ParcelRecoveryAction.tsx, src/components/orders/ShippingDestinationSheet.tsx (and its host src/components/labels/ParcelLabelDialog.tsx), and the order/payment invariant tests (order-domain Tests 6 and 20, order-inventory-integration Test 11, order-ui-integration, create-real-order-variant, pos-order-integration, merchant-sale-journey, payment-domain Test 30, payments-operations-ui) via src/tests/helpers/refuse-only-principal.ts; the per-layer contract is src/tests/initiating-principal-contract.test.ts
**Section:** Order creation — no tenant or actor identity on the client → server order path (SECURITY.md §9 "Never trust organization_id sent by client", §105)
**Original:** No `organizationId` / `userId` field of any kind may cross the order-creation API, and the invariant tests forbade the names outright, so the server learned nothing about who STARTED a request.
**Correction:** Project owner decision (PR #121 review P2) — POS checkout sends exactly one refuse-only precondition, `expectedPrincipal: { userId, organizationId }`: the principal the checkout attempt was started as. The server still derives the acting principal from the session and the member's active organization, and authorizes and records ownership (`created_by`, `organization_id`) from that derivation only. `expectedPrincipal` is compared for equality with it before anything else (before the permission check, the rate limit and any write); on a mismatch the request is refused with 409 `principal_changed` and nothing is written. It can never grant, select, scope or attribute anything. No other identity field is allowed on the order path; the invariant tests strip exactly the sanctioned snippets (each must occur exactly once) and still assert the invariant over everything else.
**Reason:** The server derives the principal when it HANDLES a request. A member or organization switch between the tap and that moment (the lazily imported server function, the trip, another tab signing in, or an active-organization write landing before the route updates) executed member A's checkout as member B under A's replay key; A's identical retry then met an idempotency creator mismatch and the sale was left unreconciled. No client-side check can see that window; only the server can, and only if it knows who started the request.
**Shared-rule addendum (2026-10-10, same PR):** the precondition belongs to order creation, not to POS. Orders → New Order and Inbox → Prepare Order reach the same `createRealOrder` → `createOrderFn` path and did not send it; the same window was reproduced against the real migrations (order-entry-principal-mounted): a member switch, in this tab or another, created member A's order as member B under A's replay key — in the other-tab case both sheets reported it as A's success and the conversation recorded it — and A's retry was refused `idempotency_conflict` for good; an organization switch sent A's customer and variant into B and was refused as a misleading 404 after spending B's rate-limit token. Every order-creation entry point now sends `expectedPrincipal` = the principal its attempt was started as: the attempt token's for POS and New Order, the replay scope's for Inbox (whose sheet the conversation route keys by member + organization). Nothing else changes: the server's derivation remains the only authority and the only source of `created_by` / `organization_id`, a mismatch is still refused before the permission check, the rate limit and any write, and the invariant tests sanction exactly one snippet per call site.
**Lifecycle and payment addendum (2026-10-10, same PR — independent review P2 ×2):** the same window existed after an order was created. Reproduced against the real migrations (order-mutation-principal-mounted, 16 of 21 cases failing before): a member switch between the tap and the server — in this tab or another — confirmed or cancelled member A's order as member B (B's status-history row, sale/return stock movements, APSA Parcel and audit row) and recorded A's payment as B's (B as `recorded_by`, B's payment event, audit row and rate-limit token); with B holding a grant A lacked, B's permission decided A's request; A's identical-key payment retry then replayed B's payment back to A as success; an organization switch was a misleading 404 after spending B's organization's payment rate-limit token. The rule is extended, and only, to: **order lifecycle transitions** (`transitionOrderLifecycleFn` → `transitionLifecycleStatus`: Order detail Confirm/Cancel, Inbox draft Confirm/Discard, POS sale confirm) and **payment recording** (`recordPaymentFn` → `recordPayment`: Order detail and POS Record payment). Each sends `expectedPrincipal` = the principal the action was started as (Order detail hands it to each mutation as a variable at the tap; POS uses one per checkout attempt for its create and its confirm; Inbox its replay scope's); `confirmRealOrder`, `cancelRealOrder` and `recordRealPayment` REQUIRE it. The check is the service's first statement — before the permission check, any rate-limit token, the target read, and every status, history, stock, parcel, payment, payment-event and audit write — and a mismatch is 409 `principal_changed` with nothing written; a refused payment never consumes its key. Authorization, `changed_by`, `created_by`, `recorded_by`, the ledger actor and the audit actor stay the server's own derivation. The "Not protected" list that closed this addendum is superseded by the next one.
**Fail-closed and coverage addendum (2026-10-11, same PR — independent review P2 #1, #2):** reproduced through the real server functions against every migration (financial-mutation-integrity): an absent `expectedPrincipal` skipped the check, so a pre-repair browser bundle (or any caller that omitted it) created, confirmed and recorded payments unchecked; and payment verify, refund, reverse, correct and evidence, fulfillment transitions, parcel recovery, parcel creation and shipping-destination edits took no principal at all — with member B's session in place when A's request landed, B's grant decided A's request and B was recorded as its actor. Now:
- The precondition is **REQUIRED and fails closed.** Every protected server function's validator requires a strict `{ userId, organizationId }` (UUIDs, no other key) and forwards it unconditionally; a request without one — the exact payload of a browser bundle from before this rule — is refused by the validator (400) before the handler runs, so nothing is read, rate-limited or written. Every protected service takes it as a required parameter and checks it as its first statement: missing or malformed is 428 `principal_required`, different is 409 `principal_changed`. A future server-initiated caller (a bank adapter, a job) has no browser principal and must get its own explicit entry point — never an omitted field. Old browser bundles therefore fail closed; reloading the app picks up the current bundle.
- **Protected (12 server functions):** `createOrderFn`, `transitionOrderLifecycleFn`, `transitionOrderFulfillmentFn`, `recoverOrderParcelFn`, `updateOrderShippingFn`, `createParcelFn`, `recordPaymentFn`, `attachPaymentEvidenceFn`, `verifyPaymentFn`, `refundPaymentFn`, `reversePaymentFn`, `correctPaymentFn`. The client spells the shape once (`InitiatingPrincipal`); every adapter requires it; Payment detail (verify / refund / reverse), parcel recovery and the shipping sheet pass the principal captured at the tap. The contract test fails if any POST server function in src/api/orders.ts, src/api/payments.ts or src/api/parcels.ts is neither protected nor explicitly exempt.
- **Exempt:** `transitionOrderPaymentFn` (deprecated; always refuses after its permission check, writes nothing).
- **Not protected (the same race may exist; not covered by this correction):** every POST server function outside those three files — deliveries (create, start preparing, ready, in transit, delivered, failed, cancel), packing (mark packed, retry ready), courier handoff, inventory movements, receiving, stock counts, customer returns, customers, conversations, products and categories, organization, team, and auth/session functions.

---

### CORRECTION-003

**Date:** 2026-10-03 (revised 2026-10-03: the shipping label carries a small, secondary APSA Parcel QR — see **Shipping label**)
**Affects:** supabase/migrations/050_parcels.sql (header — historical, not edited), src/server/parcels/service.ts, src/server/orders/service.ts (`transitionLifecycleStatus`), src/server/packing/service.ts (`getPackRequirements`), src/server/deliveries/service.ts (`createDelivery`), src/server/fulfillment/service.ts, src/lib/labels/*, src/components/labels/*, src/routes/app.orders.$id.tsx, src/routes/app.pack.tsx
**Section:** Fulfillment — APSA Parcel (internal identity) vs Carrier Shipment
**Original:** The parcel identity was created lazily when a parcel label was first printed (or, in the unmerged PR #109, when delivery was arranged), and a single label mixed the APSA QR/Code 128 with carrier, tracking and receiver data.
**Correction:** Project owner decision — APSA has two separate objects:
- **APSA Parcel** — the ORDER's internal warehouse identity (Parcel ID + QR + Code 128 of the same opaque `APSA:PCL:v1:` code). Created when the order is confirmed (enters fulfillment); stable for the life of the parcel; independent of any carrier shipment. Used by merchant operations: Pack Order, Mark Packed, parcel lookup, warehouse/shelf search, inventory operations, Courier Handoff, returns and internal audit. The courier never scans it.
- **Carrier Shipment** (`deliveries`) — created only by Arrange Delivery; carries carrier, tracking number, service and shipping metadata. It can be cancelled and recreated. It ATTACHES to the existing APSA Parcel and never creates, replaces or voids it.
- **Internal APSA Parcel label** — APSA QR, Code 128 and Parcel ID; no carrier, no customer data. Always available for an order in fulfillment.
- **Shipping label** — available only once a shipment exists. It carries TWO machine-readable identifiers that serve different domains and never replace one another:
  - **Primary: carrier tracking barcode (Code 128)** — external logistics; scanned by the courier company. The courier scans ONLY this barcode.
  - **Secondary: small APSA Parcel QR (or Code 128)** — merchant warehouse operations (Pack Order, parcel lookup, warehouse search, Courier Handoff, returns, internal audit). Merchant staff scan ONLY this code.
  - Also on the label: the APSA Parcel ID as text; a packing list (product, variant, quantity); payment information — Paid → "Payment Verified" with no amount; COD → "Collect: <Amount>", visually prominent.
  - This supersedes the earlier wording of this entry that the shipping label shows the APSA Parcel ID only as text and never as a scannable APSA code.
- **Cancellation.** Cancelling a shipment leaves the APSA Parcel, its label and packing history untouched; the replacement shipment attaches to the same parcel and gets a new shipping label. No repacking.
- **Courier Handoff** identifies the parcel by its APSA Parcel ID, then confirms the carrier shipment attached to it.
- Attachment is resolved through the order (one active parcel per order, `uniq_parcels_org_order_active`); an explicit `deliveries.parcel_id` column is deferred until split shipments need it.
**Reason:** The parcel is a physical warehouse object owned by the order; a courier booking is replaceable. Tying the identity to label printing or to delivery arrangement blocked packing before delivery and would have forced re-identification (and repacking) whenever a shipment was cancelled.

---

### CORRECTION-002

**Date:** 2026-09-28
**Affects:** supabase/migrations/016_customer_permissions.sql (header comments — historical, not edited), PERMISSIONS_MATRIX.md §customers, src/server/customers/service.ts (`updateCustomer`), src/lib/capabilities.ts, src/components/customers/EditCustomerSheet.tsx
**Section:** Customer edits — `customers.update_basic` vs `customers.view_sensitive`
**Original:** Migration 016 describes `customers.update_basic` as "edit display name, phone, email, language" and seeds it to every staff role, implying any role holding it may write a customer's phone and email. `customers.view_sensitive` (the grant that lets a member READ those values) is seeded only to OWNER/MANAGER, with ⚠️ for the other roles in PERMISSIONS_MATRIX.md. Taken together, a Cashier/Sales/Customer Service member who is shown the phone as hidden could still overwrite it blind.
**Correction:** Project owner decision — keep the stricter, fail-closed rule:
- `customers.update_basic` authorizes editing a customer's basic, non-sensitive fields (display name, language).
- Writing `primary_phone` or `primary_email` additionally requires `customers.view_sensitive`, checked server-side in `updateCustomer()` before any read or write.
- A role that cannot read a sensitive value may not blind-overwrite it. The UI offers the phone field only when `canSensitive("customers.view_sensitive")` holds and the server marked the payload `sensitiveVisible`, but the server check is the authority.
- The update response is PII-gated exactly like every other customer read.
Affected permissions: `customers.update_basic`, `customers.view_sensitive`. No grant is added or removed; migration 016 stays as written (historical migrations are not edited) and this entry supersedes its comment.
**Reason:** Sensitive values must not be writable by roles that cannot read them — a blind overwrite lets a member replace a customer's contact details they are not allowed to see (e.g. redirecting COD or delivery contact) with no way to know what they destroyed. Raised in the independent review of PR #78; resolved by the project owner.

---

### CORRECTION-001

**Date:** 2026-09-10
**Affects:** PERMISSIONS_MATRIX.md, supabase/migrations/041_team_invitations.sql, supabase/migrations/042_team_permissions.sql, src/server/team/service.ts
**Section:** §7 TEAM & MEMBERSHIP — `team.update_role` / `team.roles_assign`, ⚠️ (limited/conditional) for MANAGER
**Original:** PERMISSIONS_MATRIX.md marks `team.update_role` as ⚠️ for MANAGER without defining what the limit is. Migration 042 (PR #39) granted MANAGER the `team.roles_assign` permission unconditionally — resolving the ⚠️ to unrestricted role-assignment authority, equal to OWNER's.
**Correction:** MANAGER role authority is LIMITED as follows:
- OWNER may assign/change the MANAGER role (promote to Manager, demote a Manager, or change a Manager's own role).
- MANAGER may assign/change only roles strictly BELOW Manager: Cashier, Sales, Customer Service.
- MANAGER may NOT: assign the Manager role to anyone; modify a membership whose current role is Manager (including their own); promote anyone to a role equal to or higher than their own; modify the Owner's membership.
- No staff member (Owner included, by the pre-existing last-owner-protection rule; every other role, by permission) may promote themselves.
This is enforced server-side in `src/server/team/service.ts` (`assertRoleAuthority()` / `assertAuthorityOverRole()`), not by the `team.roles_assign` DB grant alone — the permission system is a coarse bit, not fine-grained by role hierarchy, so the DB grant to MANAGER stays as migration 042 wrote it and the cap lives in application code. The cap applies to the full membership-authority surface, not only role changes: `inviteStaff` (against the invited email's existing membership, if any), `changeRole`, `deactivateMember`, `reactivateMember`, and `resendInvite`/`cancelInvite` (against the invitation's own offered role) all call one of these two functions before mutating anything.
**Reason:** Independent review of PR #39 flagged the unconditional grant as an overstatement of the matrix's ⚠️ marker and a merge blocker. Project owner resolved the ambiguity directly.
**Round 2 addendum (2026-09-10):** a second independent review found the cap did not survive the invite→accept path — a Manager could invite a suspended Owner's or peer Manager's email at a *lower* role, and `accept_invitation()` (migration 041) would reactivate that existing membership at the invited role with no authority check at all, since the RPC never consulted CORRECTION-001. Closed at both layers: `inviteStaff()` now resolves the invited email to any existing membership (any status) via `findMembershipByEmail()` and applies the same authority check before creating the invitation; and migration 041 now persists the issuer's authority (`invitations.issued_by_role`, snapshotted as `'OWNER'` or `'MANAGER'` at invite time) and independently re-checks it inside `accept_invitation()`, against the target membership's role as it stands at accept time (not invite time), before allowing a reactivation to overwrite it. A Manager-issued invitation can never reactivate an Owner- or Manager-grade membership, regardless of what role it offers. `resendInvite`/`cancelInvite` gained the same check against the invitation's own role, closing the adjacent gap where a Manager could resend or cancel a Manager-grade invitation they had no authority to touch.
**Round 3 addendum (2026-09-10):** a third independent review found the round-2 fix's own re-check in `accept_invitation()` rested on two structural gaps, neither an authority-model change: (1) the caller's email for the email-match gate was read from `public.profiles.email`, a column the authenticated user can write themselves via the `profiles_update_own` RLS policy (001_auth_profiles.sql) — a holder of a leaked/forwarded invite link could rewrite their own profile row to the invited address and clear the gate with no inbox/account proof at all; and (2) the existing-membership lookup that authority is checked against was a plain, unlocked `SELECT` — the advisory lock is keyed on the *invitation* id and only serializes two accepts of the *same* invitation, so a concurrent `changeRole`/`deactivateMember`/`reactivateMember` call (or a second, different invitation targeting the same membership) could commit a role/status change to that row between this RPC's read and its own `UPDATE`, letting the authority check act on stale data. Both closed in migration 041: the email-match identity now comes from `auth.users.email` (the same source `src/api/auth.ts#getSessionFn` already trusts, and one the authenticated user cannot write), and the existing-membership `SELECT` is now `... FOR UPDATE`, so this transaction blocks until any concurrent writer of that row commits and then re-reads it before the authority check runs. Neither change alters who is allowed to do what — CORRECTION-001's rule is unchanged — they close two paths by which the RPC could evaluate that rule against the wrong data. A related, lower-severity gap was folded in at the same time: `accept_invitation()`'s `team.invite_accept` audit row now carries the membership's prior `role_id`/`status` in `before_json` on reactivation (previously only `{invitation_id, reactivated}`), matching the before/after shape used elsewhere for role and status changes.

---

This section will be updated as decisions evolve, errors are found, or earlier guidance is superseded.

---

# 4. CORRECTION ENTRY FORMAT

When adding a new correction, use this exact format:

```
---

### CORRECTION-[NNN]

**Date:** YYYY-MM-DD  
**Affects:** [filename(s)]  
**Section:** [section name or topic]  
**Original:** [what the document said]  
**Correction:** [what is now true]  
**Reason:** [why this changed]
```

Number entries sequentially starting from CORRECTION-001.

---

# 5. RULES FOR ALL AGENTS

1. Read this file before reading any other APSA document.
2. If a correction in this file conflicts with another document, follow this file.
3. Do not implement something from another document if a correction here explicitly overrides it.
4. If you discover a contradiction between documents that is not yet recorded here, stop and flag it rather than guessing.
5. Do not modify this file yourself unless explicitly instructed by the project owner.

---

# 6. DOCUMENT HIERARCHY

When documents conflict, apply this priority order (highest to lowest):

1. `CORRECTIONS.md` — this file
2. Direct instruction in the current session
3. `APSA_MASTER_PLAN.md` — product and engineering vision
4. `ARCHITECTURE.md` — structural and technical constraints
5. `SECURITY.md` — security requirements (non-negotiable)
6. `PERMISSIONS_MATRIX.md` — role and access rules
7. `DATA_MODEL.md` — data structure and relationships
8. `API_AND_EVENTS.md` — API contracts and event standards
9. `MVP_ROADMAP.md` — implementation sequence
10. `UX_FLOWS.md` — user journeys and screen flows

---

*This file should remain under version control and be updated whenever a meaningful decision changes.*

# Approved financial semantics — 2026-09-06

Payment ↔ Order integration preserves `payment_status=paid` after partial
and full refunds. Refund state belongs on an independent authoritative Order
axis, `refund_status=none|partial|full`, derived from immutable Payment events.
For a fully paid $100 Order, refunding $20 yields `paid/partial`; refunding
$100 yields `paid/full`. Refunds must never be mapped to `failed` or
`unpaid`, and original Payment amounts/history must never be rewritten.
