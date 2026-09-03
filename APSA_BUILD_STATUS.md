# APSA — Implementation Tracker

**File:** `APSA_BUILD_STATUS.md`
**Project:** APSA — Cambodian Business Operating System / Social Commerce OS
**Last updated:** 2026-09-03
**Branch:** `claude/apsa-live-supabase-verification` (live Supabase verification tooling)
**Purpose:** Single source of truth for what is built, what is mock-only, what Lovable must still deliver, what Claude Code must productionize, and what is intentionally post-MVP.

> **Rule:** Read CORRECTIONS.md before acting on any status here. CORRECTIONS.md overrides this file.

---

## Status Legend

| Status | Meaning |
|--------|---------|
| `DONE_LOVABLE` | Lovable has produced a production-quality UI screen/component; data may still be mock |
| `PARTIAL` | Some real implementation exists but major work remains (usually: UI done, backend absent) |
| `LOVABLE_REMAINING` | Lovable must still build or polish this before Claude Code takes over |
| `CLAUDE_CODE` | Backend/production implementation required; no provider blocker |
| `NOT_BUILT` | Nothing exists yet |
| `BLOCKED_EXTERNAL` | Needs a third-party API credential or approval gate before any work can proceed |
| `POST_MVP` | Intentionally deferred; supported by source-of-truth documents |

---

## Repository Snapshot (as of 2026-09-03 — Production Foundation Sprint)

**Stack found:** TanStack Start + Vite + React 19 + TypeScript + Tailwind CSS v4 + TanStack Router + TanStack Query + i18next + Radix UI + recharts + @supabase/supabase-js  
**Database:** MIGRATIONS WRITTEN — 8 migration files in `supabase/migrations/`. Awaiting Supabase project provisioning by project owner.  
**Auth:** FOUNDATION BUILT — Supabase client architecture, server-side session validation, membership verification. Awaiting Supabase project to activate.  
**Backend APIs:** NONE YET — server auth layer built; API route handlers are next sprint.  
**Data layer:** Still mock — production repositories are next (mock not ripped out; UI unbroken).  
**Routes:** 10 routes (unchanged): `/`, `/app`, `/app/inbox`, `/app/inbox/$id`, `/app/customers/$id`, `/app/deliveries/$id`, `/app/orders/$id`, `/app/pos`, `/app/team`, `/design`

### Live Supabase Verification Tooling Added (2026-09-03)

| Area | Status | Files |
|---|---|---|
| Connection probe script | BUILT | `scripts/verify-supabase-connection.ts` |
| `verify:supabase` npm script | ADDED | `package.json` |
| Test seed SQL | BUILT | `supabase/seed-test.sql` |
| Migration verification SQL | BUILT | `supabase/verify-migrations.sql` |
| Unit tests (U1–U3) | PASSING | 40/40 pass without Supabase credentials |
| Live DB tests (T1–T15) | SKIP-READY | Skip cleanly until credentials + migrations are in place |

**How to activate live tests:**
1. Open APSA's Supabase project (Seoul region)
2. Copy `.env.example` → `.env.local`, fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
3. Apply migrations 001–008: `supabase db push` (or paste each file in SQL Editor)
4. Run connection probe: `bun run verify:supabase`
5. Run migration verification: paste `supabase/verify-migrations.sql` in SQL Editor
6. Seed test data: paste `supabase/seed-test.sql` in SQL Editor (test project only), update UUIDs in `src/tests/tenant-isolation.test.ts`
7. Run full integration tests: `bun test src/tests/tenant-isolation.test.ts`

---

### Production Foundation Added (2026-09-03)

| Area | Status | Files |
|---|---|---|
| Supabase client — browser | BUILT | `src/lib/supabase/client.ts` |
| Supabase client — server/admin | BUILT | `src/lib/supabase/server.ts` |
| Database type definitions | BUILT | `src/lib/supabase/types.ts` |
| Migration 001: auth_profiles | WRITTEN | `supabase/migrations/001_auth_profiles.sql` |
| Migration 002: organizations | WRITTEN | `supabase/migrations/002_organizations.sql` |
| Migration 003: roles_permissions | WRITTEN + SEEDED | `supabase/migrations/003_roles_permissions.sql` |
| Migration 004: workspaces | WRITTEN | `supabase/migrations/004_workspaces.sql` |
| Migration 005: locations | WRITTEN | `supabase/migrations/005_locations.sql` |
| Migration 006: memberships | WRITTEN | `supabase/migrations/006_memberships.sql` |
| Migration 007: rls_deferred_member_policies | WRITTEN | `supabase/migrations/007_rls_deferred_member_policies.sql` |
| Migration 008: audit_logs | WRITTEN | `supabase/migrations/008_audit_logs.sql` |
| RLS policies | IN MIGRATIONS | All 8 tables have RLS enabled + policies |
| Session validation | BUILT | `src/server/auth/session.ts` |
| Membership verification | BUILT | `src/server/auth/membership.ts` |
| Authorization service | BUILT | `src/server/auth/authorization.ts` |
| Audit log service | BUILT | `src/server/auth/audit.ts` |
| Domain types (tenancy) | ADDED | `src/types/index.ts` (appended, no breaking changes) |
| Tenant isolation tests | WRITTEN | `src/tests/tenant-isolation.test.ts` |
| Env var template | CREATED | `.env.example` |
| Supabase setup guide | CREATED | `supabase/README.md` |

---

## PRODUCT / UX

---

### 1. Design System

**Status:** `DONE_LOVABLE`

**What exists today:** A comprehensive, purpose-built design system at `src/design-system/`. Includes: `AppHeader`, `BottomNav`, `BottomSheet`, `ChannelBadge`, `ConversationRow`, `CurrencyInput`, `CustomerSummaryCard`, `EmptyState`, `ErrorState`, `LoadingState`, `MessageBubble`, `MetricTile`, `Money`, `QuantityStepper`, `QuickActionGrid`, `StatusChip`, `Timeline`, `ApsiInsightCard`, `ApsiIllustration`, `AttentionCard`. Full shadcn/Radix UI component library at `src/components/ui/`. Tailwind CSS v4 custom design tokens. Mobile-first layout with pull-to-refresh hook (`use-pull-to-refresh.ts`). `use-mobile.tsx` breakpoint hook. `/design` route showcases all primitives.

**Repository evidence:** `src/design-system/index.ts`, `src/design-system/*.tsx`, `src/components/ui/*.tsx`, `src/hooks/use-mobile.tsx`, `src/hooks/use-pull-to-refresh.ts`, `src/routes/design.tsx`

**Source-of-truth doc:** UX_FLOWS.md (mobile-first, bottom sheets, progressive disclosure), APSA_MASTER_PLAN.md §§ Lovable responsibilities

**Owner:** Lovable

**Dependencies:** None (complete)

**Next action:** Lovable — Product Polish Pass will refine tokens, spacing, motion. No Claude Code action required now.

---

### 2. Business Home / Dashboard

**Status:** `PARTIAL`

**What exists today:** Full home screen UI at `src/routes/app.index.tsx`. Shows revenue metrics with sparklines, attention cards (unread conversations, awaiting payment, awaiting delivery, low stock), quick-action grid, and metric tiles with period tabs (today/week/month). Uses `MetricTile`, `AttentionCard`, `QuickActionGrid`, `ApsiInsightCard` from design system.

**Repository evidence:** `src/routes/app.index.tsx`, `src/lib/mock/home.ts`, `src/lib/api/index.ts#getHomeSummary`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (owner insights), UX_FLOWS.md (home navigation), MVP_ROADMAP.md Phase 14

**Owner:** Claude Code (backend data); Lovable (Polish Pass)

**Dependencies:** Authentication, Organization model, real aggregation queries

**Next action:** Claude Code — implement real `getHomeSummary` endpoint backed by Supabase aggregation queries after auth/DB are in place. Lovable — no additional screens needed here.

---

### 3. Unified Inbox

**Status:** `PARTIAL`

**What exists today:** Full inbox list UI at `src/routes/app.inbox.tsx`. Filter chips by status (unread, needs_reply, follow_up, waiting_customer, order_created, closed) and by channel (facebook, instagram, telegram). Search by name, phone, or message text. `ConversationRow` design system component. Count badges per status.

**Repository evidence:** `src/routes/app.inbox.tsx`, `src/lib/mock/conversations.ts`, `src/lib/api/index.ts#getConversations`, `src/lib/api/index.ts#getConversationCounts`, `src/design-system/ConversationRow.tsx`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (Inbox), API_AND_EVENTS.md (conversation API), MVP_ROADMAP.md Phases 10-12

**Owner:** Claude Code (real-time provider sync, webhook ingestion); Lovable (Polish Pass)

**Dependencies:** Authentication, ConnectedChannel model, Facebook/Instagram/Telegram provider integration, real-time subscription

**Next action:** Claude Code — implement ConnectedChannel → Conversation → Message data model and webhook ingestion pipeline. Inbox becomes live only after at least one provider is connected.

---

### 4. Conversation Detail

**Status:** `PARTIAL`

**What exists today:** Full conversation thread UI at `src/routes/app.inbox.$id.tsx` with `MessageBubble` components, message direction (inbound/outbound/system), delivery state indicators. `CustomerDetailSheet` and `CreateOrderSheet` sub-components.

**Repository evidence:** `src/routes/app.inbox.$id.tsx`, `src/components/inbox/CustomerDetailSheet.tsx`, `src/components/inbox/CreateOrderSheet.tsx`, `src/design-system/MessageBubble.tsx`, `src/lib/mock/conversations.ts`

**Source-of-truth doc:** UX_FLOWS.md (conversation flow), API_AND_EVENTS.md (message.received, message.sent events)

**Owner:** Claude Code (message persistence, real-time); Lovable (Polish Pass)

**Dependencies:** Unified Inbox backend, provider webhook ingestion, real-time message streaming

**Next action:** Claude Code — implement Message table, conversation assignment, real-time subscription (Supabase Realtime or similar) after provider integration.

---

### 5. Message → Order

**Status:** `PARTIAL`

**What exists today:** `CreateOrderSheet` component inside conversation view allows selecting products, quantities, setting discount, arranging delivery, and confirming order from within the inbox context. Mock API `createOrder` enforces an order approval limit (orders over $500 throw `permission_denied`).

**Repository evidence:** `src/components/inbox/CreateOrderSheet.tsx`, `src/lib/api/index.ts#createOrder`, `src/lib/api/index.ts#ORDER_APPROVAL_LIMIT_CENTS`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (signature workflow: Message → Customer → Order → Payment → Delivery), MVP_ROADMAP.md Phase 12

**Owner:** Claude Code (real order creation API, permission enforcement server-side); Lovable (Polish Pass)

**Dependencies:** Authentication, Order domain, Product/Inventory domain, Permission system

**Next action:** Claude Code — implement `POST /api/orders` with server-side permission check (not just mock limit), linked to conversation context and real inventory deduction.

---

### 6. POS (Point of Sale)

**Status:** `PARTIAL`

**What exists today:** Complete POS UI: `PosProductList`, `PosCart`, `PosVariantSheet`, `PosCustomerSheet`, `PosCheckoutSheet`, `PosNotice` components. Barcode entry field, category filter, variant selection, cart with quantity stepper, cash/KHQR/bank transfer payment methods, change calculation in KHR, optional customer attachment.

**Repository evidence:** `src/routes/app.pos.tsx`, `src/components/pos/*.tsx`, `src/lib/api/index.ts#createSale`, `src/lib/pos-cart.ts`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (POS), MVP_ROADMAP.md Phase 8, UX_FLOWS.md (POS flow)

**Owner:** Claude Code (real sale persistence, inventory deduction, receipt); Lovable (Polish Pass)

**Dependencies:** Authentication, Product/Inventory domain, Order domain (POS sale = Order with source=pos), Money system

**Next action:** Claude Code — implement `POST /api/sales` that creates an Order (source=pos), deducts inventory via InventoryMovement ledger, and records payment. No barcode scanner API integration needed for MVP.

---

### 7. Order Detail

**Status:** `PARTIAL`

**What exists today:** Full order detail screen at `src/routes/app.orders.$id.tsx` with `OrderActionSheets` component. Shows order items, payment records, delivery status, order event timeline, staff name, customer card. Actions: record payment, create refund, create return, arrange delivery. Permission-gated actions (refund requires `manager` or above).

**Repository evidence:** `src/routes/app.orders.$id.tsx`, `src/components/orders/OrderActionSheets.tsx`, `src/lib/api/index.ts#getOrderDetail`, `src/lib/api/index.ts#recordPayment`, `src/lib/api/index.ts#createRefund`, `src/lib/api/index.ts#createReturn`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (order lifecycle), DATA_MODEL.md (Order, Payment, Refund), PERMISSIONS_MATRIX.md (`orders.refund`, `orders.cancel`)

**Owner:** Claude Code (real persistence, idempotency, event sourcing); Lovable (Polish Pass)

**Dependencies:** Authentication, Order domain, Payment domain, Delivery domain, RBAC

**Next action:** Claude Code — implement order state machine with domain events (`order.status_changed`, `payment.paid`, `payment.refunded`) using transactional outbox pattern. Idempotency required on all financial mutations.

---

### 8. Customer 360

**Status:** `PARTIAL`

**What exists today:** Full customer profile screen at `src/routes/app.customers.$id.tsx`. Shows customer info, lifetime spend, order count, social identities, address, tags, notes, order history timeline, customer events, active conversation link.

**Repository evidence:** `src/routes/app.customers.$id.tsx`, `src/lib/api/index.ts#getCustomer360`, `src/lib/api/index.ts#addCustomerNote`, `src/design-system/CustomerSummaryCard.tsx`, `src/design-system/Timeline.tsx`

**Source-of-truth doc:** DATA_MODEL.md (Customer, CustomerIdentity, CustomerEvent), UX_FLOWS.md (Customer 360), MVP_ROADMAP.md Phase 15

**Owner:** Claude Code (real customer DB, identity merge, consent); Lovable (Polish Pass)

**Dependencies:** Authentication, Customer domain with CustomerIdentity model, Conversation domain

**Next action:** Claude Code — implement Customer table + CustomerIdentity table (universal identity model, not per-channel duplicates). Customer merge/link API required before production.

---

### 9. Delivery Tracking

**Status:** `PARTIAL`

**What exists today:** Delivery detail screen at `src/routes/app.deliveries.$id.tsx` with `DeliveryProgress` component. Shows courier name, tracking number, delivery status timeline, COD amount, settlement pending flag, failure reason, address.

**Repository evidence:** `src/routes/app.deliveries.$id.tsx`, `src/components/delivery/DeliveryProgress.tsx`, `src/lib/api/index.ts#getDeliveryDetail`, `src/lib/api/index.ts#applyDeliveryAction`, `src/lib/mock/fulfillment.ts`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (delivery), MVP_ROADMAP.md Phase 13, API_AND_EVENTS.md (`delivery.status_changed` events)

**Owner:** Claude Code (real courier API integration via DeliveryProvider abstraction); Lovable (Polish Pass)

**Dependencies:** Authentication, Order domain, Delivery domain, Courier provider (manual MVP → J&T/Wing later)

**Next action:** Claude Code — implement Delivery table and manual courier tracking MVP (no real courier API required initially — staff marks status). BLOCKED_EXTERNAL for live courier webhook integration.

---

### 10. Workspace Switcher

**Status:** `PARTIAL`

**What exists today:** `WorkspaceSwitcherSheet` component with multiple workspace display, workspace switching (updates active flag in mock). Workspace types (business/creator).

**Repository evidence:** `src/components/team/WorkspaceSwitcherSheet.tsx`, `src/lib/api/index.ts#getWorkspaces`, `src/lib/api/index.ts#switchWorkspace`, `src/lib/mock/shop.ts`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (multi-tenancy: User → Membership → Organization → Workspace → Location), DATA_MODEL.md (WorkspaceSummary)

**Owner:** Claude Code (real org/workspace model with RLS-isolated tenants); Lovable (Polish Pass)

**Dependencies:** Authentication, Organization/Workspace/Membership domain, RLS

**Next action:** Claude Code — implement Organization → Workspace → Membership data model with full tenant isolation. Switching workspace must change the active tenant context in the session/JWT, not just a UI flag.

---

### 11. Team / Staff Invite

**Status:** `PARTIAL`

**What exists today:** Full team management screen at `src/routes/app.team.tsx`. `StaffRow`, `StaffDetailSheet`, `InviteStaffSheet`, `RoleOption` components. Invite by email or phone. Role assignment (owner/manager/cashier/sales/customer_service). Remove staff, change role, resend/cancel invite. Mock guard: owner role cannot be granted; last owner cannot be removed.

**Repository evidence:** `src/routes/app.team.tsx`, `src/components/team/*.tsx`, `src/lib/api/index.ts#inviteStaff`, `src/lib/api/index.ts#changeStaffRole`, `src/lib/api/index.ts#removeStaff`

**Source-of-truth doc:** PERMISSIONS_MATRIX.md (RBAC, role constraints), DATA_MODEL.md (Membership, Role), APSA_MASTER_PLAN.md (staff management)

**Owner:** Claude Code (real invitation system, email/SMS delivery, Membership table, permission enforcement); Lovable (Polish Pass)

**Dependencies:** Authentication, Membership/RBAC domain, Email/SMS provider for invitations

**Next action:** Claude Code — implement Membership table, server-side role change guards (managers cannot grant roles higher than their own), real invitation delivery (email link or SMS OTP).

---

### 12. Product Polish Pass

**Status:** `LOVABLE_REMAINING`

**What exists today:** Individual screens are functionally complete as prototypes but have not been through a unified polish pass for consistency, micro-interactions, motion, empty states, error states, and mobile edge cases.

**Repository evidence:** `src/design-system/EmptyState.tsx`, `src/design-system/ErrorState.tsx`, `src/design-system/LoadingState.tsx` exist but are not consistently wired across all routes.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (Lovable responsibilities, polish before handoff), MVP_ROADMAP.md

**Owner:** Lovable

**Dependencies:** All core screens must exist first (most do)

**Next action:** Lovable — run a full Product Polish Pass across all screens: loading/empty/error states, pull-to-refresh consistency, bottom sheet animation uniformity, tap target sizes, long-text truncation, Khmer font rendering.

---

### 13. Landing Page

**Status:** `LOVABLE_REMAINING`

**What exists today:** A functional landing page exists at `src/routes/index.tsx` with hero, problem statement, inbox showcase, workflow steps, ops feature cards, history card, Cambodia-specific features section (KHQR, dual currency, couriers, Khmer), and a CTA. Fully i18n-keyed. Responsive.

**Repository evidence:** `src/routes/index.tsx`, `src/locales/km.json`, `src/locales/en.json`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (landing page = Lovable final redesign), MVP_ROADMAP.md Phase 16

**Owner:** Lovable

**Dependencies:** None (content-only)

**Next action:** Lovable — final Landing Page redesign (visual identity pass, real hero imagery/illustrations, brand polish, mobile-optimized layout). Current version is functional prototype.

---

### 14. Orders List

**Status:** `LOVABLE_REMAINING`

**What exists today:** No orders list route exists (`app.orders.$id.tsx` exists but `app.orders.tsx` does not). Order data model and mock data are complete.

**Repository evidence:** Routes listing — no `app.orders.tsx` found. `src/lib/api/index.ts#getOrders` exists and returns a sorted order array.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (orders list view), UX_FLOWS.md, MVP_ROADMAP.md Phase 7

**Owner:** Lovable (build the screen); Claude Code (real backend)

**Dependencies:** Order data model (exists in mock form)

**Next action:** Lovable — build `/app/orders` route with filterable orders list (status filter, channel filter, date range, search by code/customer). Link each row to `app.orders.$id`.

---

### 15. Customers List

**Status:** `LOVABLE_REMAINING`

**What exists today:** No customers list route exists (`app.customers.$id.tsx` exists but `app.customers.tsx` does not). Customer data model and mock data are complete. `searchCustomers` API exists.

**Repository evidence:** Routes listing — no `app.customers.tsx` found. `src/lib/api/index.ts#getCustomers` and `#searchCustomers` exist.

**Source-of-truth doc:** APSA_MASTER_PLAN.md, UX_FLOWS.md, MVP_ROADMAP.md Phase 6

**Owner:** Lovable (build the screen); Claude Code (real backend)

**Dependencies:** Customer data model (exists in mock form)

**Next action:** Lovable — build `/app/customers` route with searchable/filterable customers list. Link each row to `app.customers.$id`.

---

### 16. Products

**Status:** `LOVABLE_REMAINING`

**What exists today:** No products route exists. Product data model, mock data (`src/lib/mock/products.ts`), and `getProducts` API exist. POS uses products but there is no standalone products management screen.

**Repository evidence:** Routes listing — no `app.products.tsx` or `app.products.$id.tsx`. `src/lib/mock/products.ts`, `src/lib/api/index.ts#getProducts`.

**Source-of-truth doc:** DATA_MODEL.md (Product, ProductVariant), MVP_ROADMAP.md Phase 5, APSA_MASTER_PLAN.md

**Owner:** Lovable (build screen); Claude Code (real backend with variant model)

**Dependencies:** Product data model

**Next action:** Lovable — build `/app/products` list + create/edit product screens with variant support, price, SKU, category, barcode.

---

### 17. Inventory

**Status:** `NOT_BUILT`

**What exists today:** `Product.stock` field exists as a mutable integer in `src/types/index.ts` (anti-pattern per DATA_MODEL.md). No inventory management screen exists. No ledger-based inventory model exists.

**Repository evidence:** `src/types/index.ts#Product.stock` (integer field), no inventory routes, no InventoryMovement type.

**Source-of-truth doc:** DATA_MODEL.md (Inventory as ledger — InventoryMovement table; NEVER mutable integer), APSA_MASTER_PLAN.md (inventory ledger)

**Owner:** Claude Code (ledger model); Lovable (adjustment UI after model exists)

**Dependencies:** Product domain, Authentication

**Next action:** Claude Code — implement InventoryMovement ledger (never update `stock` directly). Lovable — build inventory adjustment and history UI after ledger model is confirmed.

---

### 18. Payments

**Status:** `NOT_BUILT`

**What exists today:** Payment recording exists inside Order Detail (via `OrderActionSheets`). No standalone payments/reconciliation screen exists. No payment provider integration. Manual confirmation only.

**Repository evidence:** `src/components/orders/OrderActionSheets.tsx` (inline payment recording), `src/lib/api/index.ts#recordPayment`. No `/app/payments` route.

**Source-of-truth doc:** DATA_MODEL.md (Payment, Refund), API_AND_EVENTS.md (`payment.paid`, `payment.refunded`), SECURITY.md (financial custody requirements)

**Owner:** Claude Code (payment records persistence, reconciliation); Lovable (payments list UI)

**Dependencies:** Order domain, Authentication, RBAC

**Next action:** Lovable — build `/app/payments` reconciliation list. Claude Code — implement real Payment persistence with idempotency.

---

### 19. Delivery Management

**Status:** `LOVABLE_REMAINING`

**What exists today:** Delivery detail screen exists (`app.deliveries.$id.tsx`). No delivery list/management screen exists. Mock couriers list and delivery arrangement exist in API layer.

**Repository evidence:** Routes listing — `app.deliveries.$id.tsx` only, no `app.deliveries.tsx`. `src/lib/api/index.ts#arrangeDelivery`, `src/lib/api/index.ts#getCouriers`.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (delivery management), MVP_ROADMAP.md Phase 13

**Owner:** Lovable (delivery list screen); Claude Code (real delivery domain, COD tracking)

**Dependencies:** Order domain, Delivery domain model

**Next action:** Lovable — build `/app/deliveries` list with status filter (in_transit, delivered, failed, etc.). Claude Code — implement Delivery table with COD settlement tracking.

---

### 20. Analytics / Insights

**Status:** `PARTIAL`

**What exists today:** Home screen (`app.index.tsx`) shows revenue sparklines and metric tiles with mock data. `MetricTile`, `ApsiInsightCard`, `recharts` chart components are wired. No standalone analytics/insights route.

**Repository evidence:** `src/routes/app.index.tsx`, `src/design-system/MetricTile.tsx`, `src/design-system/ApsiInsightCard.tsx`, `src/lib/mock/home.ts`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (Owner Insights), MVP_ROADMAP.md Phase 14

**Owner:** Lovable (dedicated analytics screen); Claude Code (real aggregation queries)

**Dependencies:** Authentication, Order/Payment/Inventory domain, analytics aggregation

**Next action:** Lovable — build `/app/analytics` (or `/app/insights`) screen with expanded metrics. Claude Code — implement aggregation endpoints (revenue by day/week/month, orders by channel, top products).

---

### 21. Settings

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No settings route, no settings screen, no organization settings.

**Repository evidence:** No `app.settings.tsx` in routes listing.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (business settings, channel connections), UX_FLOWS.md

**Owner:** Lovable (settings screens); Claude Code (connected channels, organization profile persistence)

**Dependencies:** Authentication, Organization domain, ConnectedChannel model

**Next action:** Lovable — build settings screens: organization profile, connected channels (placeholder until providers are integrated), localization preference, notification preferences.

---

### 22. Onboarding

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No onboarding flow, no organization creation wizard, no channel connection wizard, no staff invite flow from onboarding.

**Repository evidence:** No onboarding route in routes listing.

**Source-of-truth doc:** MVP_ROADMAP.md Phase 1 (engineering foundation includes org creation), APSA_MASTER_PLAN.md

**Owner:** Lovable (onboarding UI); Claude Code (org creation, first-run logic)

**Dependencies:** Authentication, Organization/Workspace creation domain

**Next action:** Lovable — design and build onboarding flow: create org → create first workspace → invite first staff → connect first channel.

---

### 23. Public Storefront / Profile

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No public-facing profile or mini-store route.

**Repository evidence:** No public route in routes listing.

**Source-of-truth doc:** MVP_ROADMAP.md Phase 16, APSA_MASTER_PLAN.md

**Owner:** Lovable (design); Claude Code (public route, shareable product catalog)

**Dependencies:** Product domain, Organization domain

**Next action:** Lovable — design public storefront/profile page. Claude Code — implement public read-only route (no auth required) with organization branding and product catalog. This is MVP Phase 16 (late MVP).

---

## PLATFORM / BACKEND

---

### 24. Authentication

**Status:** `PARTIAL` — Foundation implemented; not yet wired to routes or live-tested.

**What exists today:**
- `src/server/auth/session.ts` — server-side JWT validation via `supabase.auth.getUser()`. Never trusts client-provided userId.
- `src/server/auth/membership.ts` — `verifyActiveMembership()` + `resolveOrganizationId(slug)`. Org ID derived from slug, not from client body.
- `src/server/auth/authorization.ts` — `AuthorizationService.forRequest/forSlug/can`, `AuthorizationContext.require/requireOwner`, `assertOwnerWouldRemain`.
- `src/lib/supabase/client.ts` + `src/lib/supabase/server.ts` — Supabase client (browser) and service-role client (server-only).
- `currentRole` in mock API is still hardcoded `"manager"` — existing UI routes are unaffected (mock data only).

**Not yet done:** Auth login/signup UI screens, session middleware wired to API routes, Supabase Auth configured in the live project, email/phone OTP.

**Repository evidence:** `src/server/auth/`, `src/lib/supabase/`, `src/lib/api/index.ts` (still mock).

**Source-of-truth doc:** SECURITY.md §§ Auth, Session Management; ARCHITECTURE.md; DATA_MODEL.md (User, Session); MVP_ROADMAP.md Phase 1

**Owner:** Claude Code

**Dependencies:** Live Supabase project credentials, auth UI (Lovable)

**Next action:** Claude Code — wire `AuthorizationService` into TanStack Start server functions for each protected route. Build Supabase Auth login/signup screens. This is the first backend integration task before any real data can be accessed.

---

### 25. Organization / Tenancy

**Status:** `PARTIAL` — Migrations written and reviewed; not yet applied to live Supabase project.

**What exists today:**
- `supabase/migrations/002_organizations.sql` — Organizations table with slug uniqueness, status, audit fields.
- `supabase/migrations/004_workspaces.sql` — Workspaces (INBOX/BUSINESS types) scoped to organization.
- `supabase/migrations/005_locations.sql` — Locations scoped to organization + workspace; cross-org workspace trigger enforced at DB level.
- `supabase/migrations/006_memberships.sql` — User↔Org membership with role, status, invite flow structure; cross-org role trigger; last-owner protection trigger.
- `supabase/migrations/007_rls_deferred_member_policies.sql` — Membership-based SELECT RLS on all tenant-scoped tables.
- `src/types/index.ts` — Production types for Organization, Membership, Role, Location, ProductionWorkspace added.
- Mock `Shop` and `WorkspaceSummary` remain in UI code (unaffected — mock data only).

**Not yet done:** Migrations not applied to live Supabase project. Org creation API not implemented. UI routes not wired to real data.

**Repository evidence:** `supabase/migrations/002–008_*.sql`, `src/types/index.ts`.

**Source-of-truth doc:** DATA_MODEL.md, APSA_MASTER_PLAN.md (multi-tenancy model), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Live Supabase credentials (owner must apply migrations), Authentication

**Next action:** Project owner applies migrations to the live APSA Supabase project. Claude Code implements org creation API and wires routes to real tenant data.

---

### 26. Membership

**Status:** `PARTIAL` — Membership table + triggers written in migration; not yet applied or wired.

**What exists today:**
- `supabase/migrations/006_memberships.sql` — Memberships table with role assignment, status enum, unique active-or-invited index.
- Cross-org role integrity trigger (`check_membership_role_org_integrity`) — prevents assigning a role from another org.
- Last-owner protection trigger (`enforce_last_owner_protection`) — database-level, concurrency-safe, blocks removing/demoting last active owner.
- `src/server/auth/authorization.ts#assertOwnerWouldRemain` — application-level guard (defense-in-depth layer above DB trigger).
- Mock `inviteStaff` / `changeStaffRole` / `removeStaff` remain in UI mock API (unaffected).

**Not yet done:** Invitation token system, email/SMS delivery, UI routes wired to real membership data, manager-cannot-grant-above-self enforcement.

**Repository evidence:** `supabase/migrations/006_memberships.sql`, `src/server/auth/authorization.ts`.

**Source-of-truth doc:** DATA_MODEL.md (Membership, Role), PERMISSIONS_MATRIX.md, MVP_ROADMAP.md Phase 3

**Owner:** Claude Code

**Dependencies:** Live Supabase (migrations applied), Authentication, Email/SMS provider for invitations

**Next action:** Apply migrations. Implement invitation token flow (time-limited signed token sent via email/SMS). Wire Team screen to real Membership API.

---

### 27. RBAC / Permissions

**Status:** `PARTIAL` — Server-side AuthorizationService implemented; not yet wired to any live route.

**What exists today:**
- `supabase/migrations/003_roles_permissions.sql` — roles, permissions, role_permissions tables with 37 permission keys and 5 system role seeds (OWNER/MANAGER/CASHIER/SALES/CUSTOMER_SERVICE). Role uniqueness fixed: partial unique indexes prevent duplicate system templates and enforce org-scoped custom role name uniqueness.
- `src/server/auth/authorization.ts` — `AuthorizationService.forRequest/forSlug/can`, `AuthorizationContext.require/requireOwner`. Never trusts client-provided orgId. Derives auth from server-side session.
- `src/server/auth/membership.ts` — `verifyActiveMembership()` loads membership + role + permissions from DB via service-role key.
- `src/lib/permissions.ts` — client-side pure-function guard remains (UI-only decorative, no security value).
- `currentRole = "manager"` still hardcoded in mock API (mock UI unaffected).

**Not yet done:** AuthorizationService not wired to any production API route. Frontend guards still consuming hardcoded role. Manager-cannot-grant-above-self rule not yet enforced in application code (DB triggers prevent worst cases).

**Repository evidence:** `supabase/migrations/003_roles_permissions.sql`, `src/server/auth/`.

**Source-of-truth doc:** PERMISSIONS_MATRIX.md, SECURITY.md

**Owner:** Claude Code

**Dependencies:** Live Supabase (migrations applied), Authentication, Membership

**Next action:** Wire AuthorizationService into all server functions that handle mutations. Add manager-cannot-grant-above-self enforcement in the team.role_change flow.

---

### 28. Database

**Status:** `PARTIAL` — 8 migrations written and reviewed; not yet applied to the live APSA Supabase project.

**What exists today:**
- `supabase/migrations/001–008_*.sql` — 8 migration files covering: auth profiles, organizations, roles/permissions, workspaces, locations, memberships, deferred RLS policies, and audit logs.
- All tables have RLS enabled. Write paths blocked for JWT clients (service role only). Cross-tenant integrity enforced by DB triggers. Last-owner protection at DB level with advisory lock concurrency guard.
- `@supabase/supabase-js` is added to `package.json`.
- `src/lib/supabase/types.ts` is hand-authored scaffolding — **must be replaced** with `supabase gen types typescript` after migrations are applied.
- Supabase project exists: Seoul region, `laykheangma95-ops/Apsa-hub`.

**Not yet done:** Migrations not applied to live project. 20+ domain tables (Customer, Product, Order, etc.) not yet written. All domain data still in mock arrays.

**Repository evidence:** `supabase/migrations/`, `package.json` (@supabase/supabase-js), `src/lib/supabase/`.

**Source-of-truth doc:** ARCHITECTURE.md (PostgreSQL/Supabase), DATA_MODEL.md, MVP_ROADMAP.md Phase 1

**Owner:** Claude Code

**Dependencies:** Project owner must apply migrations (requires Supabase service-role credentials)

**Next action:** Project owner applies migrations 001–008 to the live APSA Supabase project. Regenerate types. Then implement remaining domain entity migrations per DATA_MODEL.md.

---

### 29. Row-Level Security (RLS)

**Status:** `PARTIAL` — RLS policies written in migrations; not yet applied or live-tested against real Supabase.

**What exists today:**
- All 8 migration files have `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
- Organizations, workspaces, locations: SELECT gated on active membership (via 007_rls_deferred_member_policies.sql). All writes blocked for JWT clients.
- Memberships: SELECT for own row + org roster. All writes blocked.
- Roles: System roles readable by authenticated users; org-specific roles require membership (migration 007).
- Role_permissions: System mappings readable by authenticated users; org-specific mappings require membership (migration 007). FIX: Custom org role mappings no longer leak to members of other orgs.
- Audit logs: SELECT requires `org.read` permission (via has_audit_access() function). Only Owner and Manager can read. FIX: Cashier, Sales, Customer Service cannot read audit logs.

**Not yet done:** RLS policies not verified against live project. Future domain tables (Customer, Order, etc.) need RLS added when their migrations are written.

**Repository evidence:** `supabase/migrations/002–008_*.sql`.

**Source-of-truth doc:** SECURITY.md (RLS on every table), ARCHITECTURE.md, PERMISSIONS_MATRIX.md

**Owner:** Claude Code

**Dependencies:** Live Supabase project (migrations applied)

**Next action:** Apply migrations. Verify RLS via Supabase Dashboard → Policies. Run integration tests to confirm org A cannot read org B data.

---

### 30. Audit Logging

**Status:** `PARTIAL` — Audit infrastructure implemented; not yet live or integrated with domain mutations.

**What exists today:**
- `supabase/migrations/008_audit_logs.sql` — audit_logs table with actor, action, resource_type, resource_id, org, before/after JSON, IP, user agent. Append-only enforced by UPDATE/DELETE triggers. RLS restricted to org.read holders (Owner + Manager only).
- `src/server/auth/audit.ts` — two-path audit design:
  - `auditLog()` — best-effort, never throws, for informational actions.
  - `auditLogRequired()` — fail-closed, throws if write fails, for mandatory high-risk actions (refunds, role changes, stock adjustments, exports, staff removal).
- `MANDATORY_AUDIT_ACTIONS` constant enumerates which actions require fail-closed audit.
- Actor and orgId always derived from validated `AuthorizationContext`, never from client input.

**Not yet done:** Audit calls not wired into any domain mutation handlers (none exist yet). Transactional audit + mutation atomicity not yet implemented (requires domain service layer).

**Repository evidence:** `supabase/migrations/008_audit_logs.sql`, `src/server/auth/audit.ts`.

**Source-of-truth doc:** DATA_MODEL.md (AuditLog), SECURITY.md §§ Audit, APSA_MASTER_PLAN.md

**Owner:** Claude Code

**Dependencies:** Live Supabase (migrations applied), domain service layer

**Next action:** When domain mutation handlers are implemented (orders, payments, inventory, team), call `auditLogRequired()` for all mandatory actions before returning success.

---

### 31. API / Application Boundary

**Status:** `PARTIAL`

**What exists today:** `src/lib/api/index.ts` is a well-structured API boundary — all components call these functions, never mock data directly. The functions simulate async with 180ms latency. Comments say "When a real backend arrives, only the bodies change." Pattern is correct.

**Repository evidence:** `src/lib/api/index.ts` (all API functions), comment at top of file.

**Source-of-truth doc:** API_AND_EVENTS.md (Client → Application/API Layer → Domain Service → Repository → Database), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Authentication, Database, all domain services

**Next action:** Claude Code — replace mock function bodies with real Supabase/server calls. The API boundary contract is already correctly established by Lovable. This is the correct pattern; do not break it.

---

### 32. Domain Types

**Status:** `PARTIAL`

**What exists today:** Strong TypeScript domain types in `src/types/index.ts`. `Money` is integer minor units with explicit currency — correct. `Customer` has `identities: SocialIdentity[]` — approaching universal customer model. `Order` has `source?: OrderSource` — good. Status enums are comprehensive.

**Repository evidence:** `src/types/index.ts`

**Source-of-truth doc:** DATA_MODEL.md, ARCHITECTURE.md (things expensive to change later)

**Owner:** Claude Code (align with canonical DATA_MODEL.md before any migration is written)

**Dependencies:** None (pure types)

**Next action:** Claude Code — review and align `src/types/index.ts` with DATA_MODEL.md canonical model before writing migrations. Key gaps: `Product.stock` should not exist (ledger-based); `SocialIdentity` should become `CustomerIdentity` with merge history; `Order.channel` should use open enum (not union of 4). Fix types before writing any DB schema.

---

### 33. Events / Outbox

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No event types, no outbox table, no event processing.

**Repository evidence:** No event-related code beyond UI-level `OrderEvent` (display only) and `CustomerEvent` (display only) types.

**Source-of-truth doc:** API_AND_EVENTS.md (transactional outbox pattern, domain events), APSA_MASTER_PLAN.md (event architecture, never publish before transaction commits)

**Owner:** Claude Code

**Dependencies:** Database, all domain services

**Next action:** Claude Code — implement transactional outbox table. Emit events after successful transactions: `order.created`, `payment.paid`, `payment.refunded`, `inventory.movement_created`, `message.received`, `delivery.status_changed` etc.

---

### 34. Usage Metering

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No usage tracking, no metering tables, no subscription model.

**Repository evidence:** No UsageRecord, Subscription, or Entitlement types. No metering code.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (usage metering: users, channels, messages, orders, products, locations, AI usage, storage), DATA_MODEL.md (UsageRecord, Subscription)

**Owner:** Claude Code

**Dependencies:** Database, Organization domain, Authentication

**Next action:** Claude Code — implement UsageRecord table and increment on write operations (orders created, messages sent, etc.). Required before any subscription billing can be added.

---

### 35. Feature Flags

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No feature flag system, no staged rollout.

**Repository evidence:** No FeatureFlag type or logic. No feature-gated code paths.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (feature flags: internal → 5 → 50 → 500 → everyone), DATA_MODEL.md (FeatureFlag)

**Owner:** Claude Code

**Dependencies:** Database, Organization domain

**Next action:** Claude Code — implement FeatureFlag table keyed by organization_id. Simple `isEnabled(orgId, flagKey)` check. Required before any staged rollout of new features.

---

### 36. Entitlements

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No entitlement checks, no plan-based feature access.

**Repository evidence:** No Entitlement type or logic. Mock API does not gate features by plan.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (entitlements, not if-plan-equals checks), DATA_MODEL.md (Entitlement, Subscription)

**Owner:** Claude Code

**Dependencies:** Database, Organization domain, Subscription model

**Next action:** Claude Code — implement Entitlement table keyed by organization_id + feature_key. Check entitlements server-side in API middleware before executing plan-gated operations.

---

### 37. Localization

**Status:** `PARTIAL`

**What exists today:** Fully functional i18next setup with Khmer (km) as default and English (en) as toggle. `src/lib/i18n.tsx` with `LanguageProvider`, `useLanguage` hook, localStorage persistence. 680-line locale JSON files for both languages covering all UI strings. `data-lang` attribute on `<html>` element. Language toggle persisted across sessions.

**Repository evidence:** `src/lib/i18n.tsx`, `src/locales/km.json`, `src/locales/en.json`

**Source-of-truth doc:** APSA_MASTER_PLAN.md (Khmer-first, i18n key-based, no hardcoded text), UX_FLOWS.md

**Owner:** Lovable (content/string additions for new screens); Claude Code (server-side locale handling, API response localization)

**Dependencies:** None for client-side (complete); Supabase for server-side locale

**Next action:** Lovable — add i18n keys for all new screens as they are built (Orders List, Customers List, Products, Settings, Onboarding). Claude Code — ensure API error messages are locale-aware.

---

### 38. Money System

**Status:** `PARTIAL`

**What exists today:** Excellent money library at `src/lib/money.ts`. `Money` type is integer minor units + explicit currency (correct). `usd()` and `khr()` constructors. `formatMoney`, `addMoney`, `subtractMoney`, `multiplyMoney`. USD↔KHR conversion at 4100 riel/dollar. KHR rounding to nearest 100 (Cambodia has no coins). `calculateChange` returns KHR. `CurrencyInput` design system component exists.

**Repository evidence:** `src/lib/money.ts`, `src/types/index.ts#Money`, `src/design-system/CurrencyInput.tsx`, `src/design-system/Money.tsx`

**Source-of-truth doc:** DATA_MODEL.md (Money always integer minor units + explicit currency, never floating-point), APSA_MASTER_PLAN.md

**Owner:** Claude Code (persist money correctly in DB as integer + currency column)

**Dependencies:** Database

**Next action:** Claude Code — ensure all financial columns in Postgres are `integer` (not `numeric`, not `float`) with a companion `currency` column or currency-explicit design. Never divide amounts in the DB layer. The existing `money.ts` library is correct and must be used consistently.

---

## INTEGRATIONS

---

### 39. Facebook / Meta Messaging

**Status:** `BLOCKED_EXTERNAL`

**What exists today:** `channel: "facebook"` enum value in types. Mock conversations with Facebook source. `ChannelBadge` shows Facebook icon. No real API integration.

**Repository evidence:** `src/types/index.ts#Channel`, `src/lib/mock/conversations.ts`, `src/design-system/ChannelBadge.tsx`.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (official APIs only, no scraping), API_AND_EVENTS.md (MessagingProvider abstraction), MVP_ROADMAP.md Phase 10-11

**Owner:** External (Meta approval) → Claude Code (webhook ingestion after approval)

**Dependencies:** Meta Developer App approval, Page access tokens (encrypted at rest), Webhook signature verification

**Next action:** Apply for Meta Messenger API access (Business Verification required). Once approved, Claude Code implements `MessagingProvider` abstraction with Facebook adapter: webhook ingestion → signature verification → deduplication → create/update Conversation + Message records.

---

### 40. Instagram Messaging

**Status:** `BLOCKED_EXTERNAL`

**What exists today:** `channel: "instagram"` enum value in types. Mock data. No real integration.

**Repository evidence:** Same as Facebook — `src/types/index.ts#Channel`, mock data.

**Source-of-truth doc:** Same as Facebook — official Instagram Messaging API only, no scraping.

**Owner:** External (Meta approval, same app as Facebook) → Claude Code

**Dependencies:** Same as Facebook Messaging; Instagram Direct requires Messenger API for Instagram (same Meta review)

**Next action:** Same Meta App as Facebook. Claude Code — implement Instagram adapter behind same `MessagingProvider` interface after Facebook is approved and working.

---

### 41. Telegram

**Status:** `BLOCKED_EXTERNAL`

**What exists today:** `channel: "telegram"` enum value in types. Mock conversations and orders with Telegram source. `ChannelBadge` shows Telegram icon.

**Repository evidence:** `src/types/index.ts#Channel`, mock data sources.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (official Telegram Bot API only), API_AND_EVENTS.md

**Owner:** External (Telegram Bot token from @BotFather) → Claude Code

**Dependencies:** Telegram Bot token, webhook URL, webhook secret verification

**Next action:** Create Telegram Bot via @BotFather. Claude Code — implement Telegram adapter: `setWebhook` registration, incoming update validation via secret token header, create/update Conversation + Message records.

---

### 42. TikTok (where officially supported)

**Status:** `BLOCKED_EXTERNAL`

**What exists today:** Nothing. TikTok is not in the `Channel` type.

**Repository evidence:** No TikTok code anywhere.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (TikTok only where officially supported), CORRECTIONS.md (no scraping, no unofficial APIs)

**Owner:** External (TikTok Business API access) → Claude Code (if/when officially available)

**Dependencies:** TikTok Business Center verification, TikTok Shop API or TikTok Messaging API official access

**Next action:** Monitor TikTok Business API availability for Cambodia. Do not implement until official API is available. No scraping. No third-party workarounds.

---

### 43. Payment Provider Integration

**Status:** `CLAUDE_CODE`

**What exists today:** `PaymentMethod` type includes `cash | khqr | bank_transfer | cod`. Manual payment recording in Order Detail. No real payment provider SDK. No webhook handling.

**Repository evidence:** `src/types/index.ts#PaymentMethod`, `src/lib/api/index.ts#recordPayment` (manual confirmation only, comment: "APSA never claims a provider verified the money").

**Source-of-truth doc:** APSA_MASTER_PLAN.md (payment providers via abstraction), SECURITY.md (financial custody checklist), DATA_MODEL.md (Payment, Refund)

**Owner:** Claude Code (PaymentProvider abstraction); External (provider credentials)

**Dependencies:** Database, Authentication, PaymentProvider credentials (ABA, Wing, etc.)

**Next action:** Claude Code — implement `PaymentProvider` abstraction. MVP can start with manual confirmation only (staff records cash/KHQR payment). Real provider webhook integration (ABA/Wing) requires provider API credentials — BLOCKED_EXTERNAL until credentials are provided.

---

### 44. KHQR / Bank Payment Integration

**Status:** `BLOCKED_EXTERNAL`

**What exists today:** `PaymentMethod.khqr` exists as an enum value. No QR code generation, no KHQR SDK, no bank integration.

**Repository evidence:** `src/types/index.ts#PaymentMethod`, landing page mentions KHQR as a Cambodia-specific feature.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (KHQR ready), MVP_ROADMAP.md

**Owner:** External (National Bank of Cambodia KHQR API or bakong-js SDK) → Claude Code

**Dependencies:** NBC KHQR API access or approved acquirer, bank account verification

**Next action:** Research NBC KHQR SDK (`bakong-js` or equivalent). Claude Code — implement QR code generation for order payment screen once SDK access is confirmed.

---

### 45. Courier / Delivery Integration

**Status:** `CLAUDE_CODE`

**What exists today:** Mock couriers list (J&T, Wing, Flash Express, Phnom Penh Express) in `src/lib/mock/shop.ts`. Mock `arrangeDelivery` API. Delivery tracking screen exists. No real courier API.

**Repository evidence:** `src/lib/mock/shop.ts` (mock couriers), `src/lib/api/index.ts#arrangeDelivery` (mock only).

**Source-of-truth doc:** APSA_MASTER_PLAN.md (DeliveryProvider abstraction, manual MVP), MVP_ROADMAP.md Phase 13

**Owner:** Claude Code (DeliveryProvider abstraction + manual tracking MVP); External (courier API credentials for live integration)

**Dependencies:** Database, Delivery domain

**Next action:** Claude Code — implement `DeliveryProvider` abstraction. MVP = manual tracking only (staff updates status). Real courier API (J&T Cambodia, etc.) requires courier API credentials — BLOCKED_EXTERNAL for live booking.

---

### 46. Webhooks

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No webhook endpoint, no signature verification, no deduplication, no async processing.

**Repository evidence:** No webhook route in routes listing. No webhook-related code.

**Source-of-truth doc:** API_AND_EVENTS.md (webhook architecture: signature → deduplication → async processing), SECURITY.md (webhook signature verification non-negotiable)

**Owner:** Claude Code

**Dependencies:** Database (deduplication table), Domain services, provider integrations

**Next action:** Claude Code — implement webhook endpoint(s) with: (1) signature verification before any processing, (2) idempotency key deduplication, (3) async queue or Supabase Edge Function for processing, (4) dead-letter queue for failed events.

---

## PRODUCTION / SECURITY

---

### 47. Tenant Isolation

**Status:** `NOT_BUILT`

**What exists today:** Nothing. All data is in shared in-memory arrays. No organization_id on any record. No isolation boundary exists.

**Repository evidence:** `src/lib/mock/*.ts` — flat arrays shared across the entire process. No organization_id in any type.

**Source-of-truth doc:** SECURITY.md (Organization A must NEVER access Organization B's data — the most important rule), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Database, RLS, Authentication, Organization domain

**Next action:** Claude Code — first priority after auth. Every database table must have `organization_id` with RLS policy. `organization_id` must come from the server-side session, never from the client request body. This is non-negotiable.

---

### 48. Session Security

**Status:** `NOT_BUILT`

**What exists today:** No sessions. No auth. No tokens.

**Repository evidence:** No session management anywhere in codebase.

**Source-of-truth doc:** SECURITY.md §§ Session Management; ARCHITECTURE.md (re-auth gates on sensitive actions, 2FA)

**Owner:** Claude Code

**Dependencies:** Authentication (Supabase Auth)

**Next action:** Claude Code — implement secure session management: short-lived JWTs, refresh token rotation, re-auth gates before refunds/role changes/staff removal, device/IP logging. Supabase Auth handles most of this out of the box; configure correctly.

---

### 49. Secrets Management

**Status:** `NOT_BUILT`

**What exists today:** No secrets, no environment variables (no real credentials needed since there is no backend). No `.env` file with real secrets.

**Repository evidence:** No `.env` file in repository root. No secrets handling code.

**Source-of-truth doc:** SECURITY.md (secrets in environment variables only, never in code, never in git), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Supabase project, provider credentials

**Next action:** Claude Code — configure all secrets as Supabase Edge Function environment variables or Vercel environment variables. Never commit secrets. Use Supabase Vault for provider tokens. Document required environment variables in a `.env.example` file.

---

### 50. Provider Token Encryption

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No provider tokens (since no providers are connected). No encryption infrastructure.

**Repository evidence:** No encryption code, no Vault integration.

**Source-of-truth doc:** SECURITY.md (encrypted channel tokens, Supabase Vault or equivalent), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Supabase Vault, provider integrations

**Next action:** Claude Code — store all channel tokens (Facebook Page token, Telegram Bot token, payment provider API keys) in Supabase Vault. Never store in plaintext in the database. Decrypt only at execution time in Edge Functions.

---

### 51. Authorization

**Status:** `NOT_BUILT`

**What exists today:** Mock `permissionsFor(role)` function in `src/lib/permissions.ts` with correct role structure. All enforcement is frontend-only. Backend has no authorization.

**Repository evidence:** `src/lib/permissions.ts`, `src/lib/api/index.ts` — comment: "Mocked; a real app resolves it from auth."

**Source-of-truth doc:** SECURITY.md (security is not frontend visibility), PERMISSIONS_MATRIX.md (centralized AuthorizationService, 7-step check flow), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Authentication, Membership domain

**Next action:** Claude Code — implement server-side `AuthorizationService`. Every API handler must: (1) authenticate the request, (2) resolve the active membership + role, (3) check the permission key (e.g., `orders.refund`), (4) check org scope (correct organization_id), (5) apply business rules. The frontend permission guards are decorative until this exists.

---

### 52. Rate Limiting

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No rate limiting on any endpoint.

**Repository evidence:** No rate limiting middleware in `src/server.ts` or any API handler.

**Source-of-truth doc:** SECURITY.md §§ Rate Limiting, APSA_MASTER_PLAN.md

**Owner:** Claude Code

**Dependencies:** API boundary, Authentication

**Next action:** Claude Code — implement rate limiting on auth endpoints (login, OTP), order creation, payment recording, and all webhook ingestion endpoints. Use Supabase Edge Functions + Upstash Redis or equivalent. Auth endpoints are the highest priority.

---

### 53. Monitoring / Logging

**Status:** `NOT_BUILT`

**What exists today:** `src/lib/lovable-error-reporting.ts` exists (Lovable-specific dev error reporting). `src/lib/error-capture.ts` and `src/lib/error-page.ts` exist for SSR error handling. No production monitoring, no structured logging, no alerting.

**Repository evidence:** `src/lib/lovable-error-reporting.ts`, `src/lib/error-capture.ts`, `src/lib/error-page.ts`, `src/server.ts` (SSR error handling).

**Source-of-truth doc:** APSA_MASTER_PLAN.md (monitoring), MVP_ROADMAP.md (before 100 merchant beta), SECURITY.md

**Owner:** Claude Code

**Dependencies:** Supabase project, API boundary

**Next action:** Claude Code — implement structured logging on all API endpoints (request ID, user ID, org ID, action, duration, result). Integrate Sentry (or equivalent) for error tracking. Set up uptime monitoring before any real merchants.

---

### 54. Backups / Restore

**Status:** `NOT_BUILT`

**What exists today:** No database = no backups possible yet.

**Repository evidence:** No database infrastructure.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (backups, PITR), SECURITY.md (before financial custody), MVP_ROADMAP.md

**Owner:** Claude Code / External (Supabase project configuration)

**Dependencies:** Supabase project (PITR is a Supabase Pro feature)

**Next action:** Claude Code — enable Supabase PITR (point-in-time recovery) on the Supabase Pro plan before accepting any real money. Verify restore procedure quarterly.

---

### 55. Security Testing

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No tests at all in the repository (no test files, no test runner in package.json).

**Repository evidence:** `package.json` — no `vitest`, no `jest`, no `playwright` in scripts or dependencies.

**Source-of-truth doc:** SECURITY.md §§ Security Testing (OWASP Top 10, tenant isolation tests, permission bypass tests), MVP_ROADMAP.md

**Owner:** Claude Code

**Dependencies:** API boundary, Authentication, Database

**Next action:** Claude Code — implement test suite: (1) tenant isolation tests (org A cannot read org B data), (2) permission bypass tests (cashier cannot call refund endpoint), (3) auth bypass tests (unauthenticated requests rejected). These tests must pass before any merchant goes live.

---

### 56. CI / Production Build

**Status:** `PARTIAL`

**What exists today:** `vite build` script in `package.json`. TypeScript compilation. ESLint config. Prettier. `@lovable.dev/vite-tanstack-config` for Lovable-specific build. No CI pipeline (no `.github/workflows/`). No deployment pipeline.

**Repository evidence:** `package.json` scripts: `dev`, `build`, `lint`, `format`. No `.github/` directory found.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (CI/CD), MVP_ROADMAP.md (before production), ARCHITECTURE.md (Vercel deployment)

**Owner:** Claude Code

**Dependencies:** Supabase project, Vercel project (separate from any other project per ARCHITECTURE.md)

**Next action:** Claude Code — create `.github/workflows/` with CI pipeline: typecheck → lint → build → test. Configure Vercel deployment with environment variables. This must be on a separate Vercel project, not shared with any other application.

---

### 57. Incident Response

**Status:** `NOT_BUILT`

**What exists today:** Nothing.

**Repository evidence:** No incident response runbook, no on-call setup.

**Source-of-truth doc:** SECURITY.md §§ Incident Response, MVP_ROADMAP.md (before 100 merchant beta)

**Owner:** External (process) + Claude Code (runbook, monitoring hooks)

**Dependencies:** Monitoring, Logging

**Next action:** Document incident response runbook: detection → containment → notification → recovery → post-mortem. Required before any real merchants. Set up PagerDuty or equivalent alerting.

---

## CURRENT BUILD SUMMARY

### What Lovable Has Visually Completed

Lovable has delivered a high-quality, mobile-first UI prototype that covers the core APSA workflow end-to-end. The following screens exist and are functionally demonstrable:

- **Landing page** — i18n-keyed, Khmer-first, responsive, with hero, product sections, and CTA
- **Business home** — revenue metrics, attention cards, quick actions, metric sparklines
- **Unified inbox** — conversation list with status/channel filters and search
- **Conversation detail** — message thread with inline customer card and order creation
- **POS** — full point-of-sale with cart, variants, payment method selection, change calculation
- **Order detail** — full lifecycle view: items, payments, events timeline, delivery status, actions
- **Customer 360** — profile, lifetime value, order history, notes, social identities
- **Delivery tracking** — progress steps, courier info, COD, delivery actions
- **Team management** — staff list, role assignment, invite, remove
- **Workspace switcher** — multi-workspace with type and role display
- **Design system** — 18+ purpose-built components exported from `src/design-system/`

### What Remains Mock-Only

Everything above is mock-only. All data comes from `src/lib/mock/` — in-memory TypeScript arrays. There is no database, no authentication, no real API, no provider connection. Key specifics:

- All customers, orders, products, conversations, deliveries are hardcoded test data
- `currentRole = "manager"` is hardcoded — any user is a manager
- `createOrder`, `createSale`, `recordPayment`, `createRefund` return mock objects; nothing persists between page reloads
- No invitation is ever delivered (mock only)
- No message is ever sent to or received from Facebook/Instagram/Telegram

### What Claude Code Must Productionize

After Lovable completes the Product Polish Pass and Landing Page redesign, Claude Code must build the entire backend from scratch. This includes:

1. **Supabase project** — database, auth, RLS, realtime, vault, edge functions
2. **Authentication** — Supabase Auth, session management, JWT, re-auth gates
3. **Organization/Workspace/Membership** — full multi-tenant model with tenant isolation
4. **RBAC** — server-side AuthorizationService with domain.action permission keys
5. **All domain tables** — Organization, Workspace, Location, Membership, Customer, CustomerIdentity, Product, ProductVariant, InventoryMovement, Order, OrderItem, Payment, Refund, Delivery, Conversation, ConnectedChannel, Message, AuditLog, FeatureFlag, Entitlement, UsageRecord, Event (outbox)
6. **RLS on every table** — organization_id-keyed isolation, non-negotiable
7. **Real API handlers** — replace all `src/lib/api/index.ts` mock bodies with Supabase calls
8. **Money system persistence** — integer minor units + currency column in Postgres
9. **Inventory ledger** — InventoryMovement table, never update stock directly
10. **Provider integrations** — Telegram (first, easiest), Facebook/Instagram (after Meta approval), payment providers
11. **Webhooks** — signature verification, deduplication, async processing
12. **Domain events / outbox** — transactional outbox pattern for all state changes
13. **CI/CD pipeline** — GitHub Actions + Vercel deployment

### What Is Still Reserved for Lovable

Before Claude Code productionizes, Lovable must complete:

1. **Product Polish Pass** — motion, micro-interactions, empty states, error states, pull-to-refresh consistency, Khmer font rendering, mobile edge cases
2. **Landing Page redesign** — final brand identity, real imagery, visual polish
3. **Orders List screen** (`/app/orders`) — filterable list linking to existing order detail
4. **Customers List screen** (`/app/customers`) — searchable list linking to existing customer 360
5. **Products screen** (`/app/products`) — create/edit product with variants
6. **Delivery Management list** (`/app/deliveries`) — list of all deliveries with status filter
7. **Settings screens** — organization profile, connected channels (placeholder UI), preferences
8. **Onboarding flow** — org creation → workspace → staff invite → channel connect wizard

---

## NEXT 10 ENGINEERING PRIORITIES

These are the next 10 Claude Code engineering priorities, ranked by dependency order and MVP criticality. **Do not implement until Lovable has completed the Product Polish Pass and Landing Page.**

---

**Priority 1: Supabase Project + Authentication**
Provision the Supabase project (separate from any other project). Implement Supabase Auth (email/password + phone OTP). Session middleware that attaches `userId + organizationId + role` to every API request. Without auth, nothing else can be production.

**Priority 2: Organization / Workspace / Membership + Tenant Isolation**
Create Organization, Workspace, Location, Membership tables. Implement org creation API. Apply `organization_id`-keyed RLS policy to every table. Verify with automated isolation tests (org A cannot read org B data). This is the most critical security requirement.

**Priority 3: RBAC / AuthorizationService**
Implement server-side `AuthorizationService` using `domain.action` permission keys per PERMISSIONS_MATRIX.md. Wire into all API handlers. Replace the hardcoded `currentRole = "manager"` with session-derived role. Add manager-cannot-grant-above-self guard on role change.

**Priority 4: Core Domain Tables + Money Persistence**
Implement all MVP entity migrations: Customer + CustomerIdentity, Product + ProductVariant, Order + OrderItem, Payment + Refund, Delivery, Conversation + Message, ConnectedChannel, AuditLog. All financial columns as `integer` + `currency`. Inventory as InventoryMovement ledger (no mutable stock field). Fix `src/types/index.ts` anti-patterns (remove `Product.stock`, align with DATA_MODEL.md canonical model).

**Priority 5: Replace Mock API with Real Supabase Calls**
Replace mock function bodies in `src/lib/api/index.ts` with real Supabase queries. The API boundary contract is already correct — only the implementations change. Start with: `getConversations`, `getCustomer360`, `getOrders`, `getOrderDetail`, `getTeam`. Verify RLS enforces organization scoping on every query.

**Priority 6: Domain Events + Transactional Outbox**
Implement outbox table and event emission after successful mutations: `order.created`, `payment.paid`, `payment.refunded`, `inventory.movement_created`, `delivery.status_changed`, `membership.created`. Never publish before transaction commits. AuditLog writes must be part of the same transaction as the mutation they record.

**Priority 7: Telegram Integration (First Provider)**
Create Telegram Bot via @BotFather. Implement `MessagingProvider` abstraction with Telegram adapter. Register webhook, verify secret token on every incoming update, create/update Conversation + Message records. This makes the inbox live for the first time. Telegram is chosen first because it has no approval gate.

**Priority 8: POS → Real Sale + Inventory Deduction**
Connect POS `createSale` to a real `POST /api/orders` endpoint (source=pos) that: creates an Order record, creates InventoryMovement records for each item, records the payment, emits `order.created` + `payment.paid` domain events. Idempotency key required.

**Priority 9: CI/CD Pipeline + Security Testing**
Create `.github/workflows/` with CI: typecheck → lint → build → tenant isolation tests → permission bypass tests → auth bypass tests. Configure Vercel deployment with proper environment variables. Enable Supabase PITR. No real merchants without this passing.

**Priority 10: Monitoring, Rate Limiting, Secrets Audit**
Structured logging on all endpoints (request ID, user ID, org ID, action, duration). Sentry error tracking. Rate limiting on auth + order creation + webhooks. Audit all environment variables — no secret must be in git or in client-side code. This is the gate before opening to any real merchant.

---

## CONFLICTS BETWEEN CODE AND SOURCE-OF-TRUTH DOCS

| Conflict | Code | Source-of-Truth | Severity |
|----------|------|-----------------|----------|
| **Tech stack** | TanStack Start + Vite | ARCHITECTURE.md says Next.js | Medium — TanStack Start is a valid SSR framework; ARCHITECTURE.md may be aspirational. Do not migrate; build backend as Supabase Edge Functions. |
| **No database** | No DB, no Supabase, no migrations | ARCHITECTURE.md: PostgreSQL/Supabase | Critical — entire backend is missing |
| **`Product.stock` is mutable integer** | `src/types/index.ts` line ~89 | DATA_MODEL.md: inventory is ledger-based, never mutable integer | High — anti-pattern that will cause data loss; fix before writing any migration |
| **`Channel` is closed 4-value union** | `types/index.ts`: `"facebook" \| "instagram" \| "telegram" \| "pos"` | DATA_MODEL.md: OrderSource is an open enum | Low — easy to extend; note for migration design |
| **`currentRole` hardcoded** | `lib/api/index.ts`: `export const currentRole: StaffRole = "manager"` | PERMISSIONS_MATRIX.md: role derived from authenticated session | Critical — every user is a manager in current code |
| **Permissions are frontend-only** | `lib/permissions.ts`: pure function, no server enforcement | SECURITY.md: security is not frontend visibility | Critical — any authenticated user can call any endpoint |
| **No `organization_id` on any record** | All types lack org scoping | SECURITY.md: tenant isolation non-negotiable | Critical — multi-tenancy impossible without this |
| **`SocialIdentity` ≠ `CustomerIdentity`** | `SocialIdentity { channel, handle }` (no merge history) | DATA_MODEL.md: CustomerIdentity with merge history, primary flag | Medium — functional for prototype; needs richer model for production |

---

## URGENT SECURITY / ARCHITECTURE CONCERNS

1. **No authentication exists.** Any user who opens the app is automatically a manager. There is no login, no session, no identity. This is acceptable for a UI prototype but must be the first thing built before any real data is handled.

2. **No tenant isolation exists.** All mock data is shared in-memory. When a real database is added, if RLS is not implemented correctly from the start, every organization will see every other organization's data. This is the highest-severity production risk.

3. **Permissions are frontend-only.** The `permissionsFor()` function controls only what the UI shows. There is no server-side enforcement. Any caller who bypasses the UI can perform any action regardless of role.

4. **`Product.stock` is a mutable integer.** The spec (DATA_MODEL.md) requires a ledger-based inventory model. If a migration is written with `stock integer` on the products table, it will be expensive to migrate later and will cause stock drift under concurrent updates.

5. **Tech stack divergence from ARCHITECTURE.md.** ARCHITECTURE.md references Next.js; the actual build uses TanStack Start. This is not a security concern, but it means ARCHITECTURE.md needs updating or Claude Code must decide whether to accept TanStack Start as the production stack.

6. **No CI, no tests.** There are zero automated tests in the repository. Security and permission tests cannot run. This means regressions cannot be caught before deployment.

7. **APSA must be on a completely separate Vercel project and Supabase project.** ARCHITECTURE.md is explicit about this. Verify this constraint is met when provisioning infrastructure.

---

*Confirmation: No application code was modified during this inspection. Only `APSA_BUILD_STATUS.md` was created.*
