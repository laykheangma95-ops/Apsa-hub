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

### CORRECTION-004

**Date:** 2026-10-10
**Affects:** src/api/orders.ts (`createOrderFn`), src/server/orders/service.ts (`createOrder`, `assertExpectedPrincipal`), src/lib/api/index.ts (`CreateRealOrderInput`, `createRealOrder`), src/components/pos/PosCheckoutSheet.tsx (`completeReal`), and the order-API invariant tests (order-domain Tests 6 and 20, order-inventory-integration Test 11, order-ui-integration, pos-order-integration, merchant-sale-journey) via src/tests/helpers/refuse-only-principal.ts
**Section:** Order creation — no tenant or actor identity on the client → server order path (SECURITY.md §9 "Never trust organization_id sent by client", §105)
**Original:** No `organizationId` / `userId` field of any kind may cross the order-creation API, and the invariant tests forbade the names outright, so the server learned nothing about who STARTED a request.
**Correction:** Project owner decision (PR #121 review P2) — POS checkout sends exactly one refuse-only precondition, `expectedPrincipal: { userId, organizationId }`: the principal the checkout attempt was started as. The server still derives the acting principal from the session and the member's active organization, and authorizes and records ownership (`created_by`, `organization_id`) from that derivation only. `expectedPrincipal` is compared for equality with it before anything else (before the permission check, the rate limit and any write); on a mismatch the request is refused with 409 `principal_changed` and nothing is written. It can never grant, select, scope or attribute anything. No other identity field is allowed on the order path; the invariant tests strip exactly the sanctioned snippets (each must occur exactly once) and still assert the invariant over everything else.
**Reason:** The server derives the principal when it HANDLES a request. A member or organization switch between the tap and that moment (the lazily imported server function, the trip, another tab signing in, or an active-organization write landing before the route updates) executed member A's checkout as member B under A's replay key; A's identical retry then met an idempotency creator mismatch and the sale was left unreconciled. No client-side check can see that window; only the server can, and only if it knows who started the request.

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
