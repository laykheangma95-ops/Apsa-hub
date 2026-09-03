# APSA — Implementation Tracker

**File:** `APSA_BUILD_STATUS.md`
**Project:** APSA — Cambodian Business Operating System / Social Commerce OS
**Last updated:** 2026-09-03 (rev 2)
**Branch:** `claude/apsa-build-status-7bueea`
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

## Repository Snapshot (as of inspection)

**Stack found:** TanStack Start + Vite + React 19 + TypeScript + Tailwind CSS v4 + TanStack Router + TanStack Query + i18next + Radix UI + recharts  
**Database:** NONE — no Supabase, no Postgres, no ORM, no migrations  
**Auth:** NONE — no auth library, no session management, no login route  
**Backend APIs:** NONE — `server.ts` is SSR handler only, not an API server  
**Data layer:** Pure in-memory mock data in `src/lib/mock/` consumed via `src/lib/api/index.ts`  
**Routes:** 10 routes: `/`, `/app`, `/app/inbox`, `/app/inbox/$id`, `/app/customers/$id`, `/app/deliveries/$id`, `/app/orders/$id`, `/app/pos`, `/app/team`, `/design`

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

**Status:** `CLAUDE_CODE`

**What exists today:** No orders list route exists (`app.orders.$id.tsx` exists but `app.orders.tsx` does not). `getOrders` mock API function exists and returns a sorted array. The screen itself has not been built by Lovable.

**Repository evidence:** Routes listing — no `app.orders.tsx` found. `src/lib/api/index.ts#getOrders` returns sorted mock orders.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (orders list view), UX_FLOWS.md, MVP_ROADMAP.md Phase 7

**Owner:** Claude Code (route + real backend query behind the existing API boundary)

**Dependencies:** Authentication, Order domain, Database

**Next action:** Claude Code — build `/app/orders` route with filterable orders list (status filter, channel filter, date range, search by code/customer) and wire to real Supabase query. Link each row to existing `app.orders.$id`.

---

### 15. Customers List

**Status:** `CLAUDE_CODE`

**What exists today:** No customers list route exists (`app.customers.$id.tsx` exists but `app.customers.tsx` does not). `getCustomers` and `searchCustomers` mock API functions exist. The screen itself has not been built by Lovable.

**Repository evidence:** Routes listing — no `app.customers.tsx` found. `src/lib/api/index.ts#getCustomers`, `#searchCustomers` return mock data.

**Source-of-truth doc:** APSA_MASTER_PLAN.md, UX_FLOWS.md, MVP_ROADMAP.md Phase 6

**Owner:** Claude Code (route + real backend query behind the existing API boundary)

**Dependencies:** Authentication, Customer domain, Database

**Next action:** Claude Code — build `/app/customers` route with searchable/filterable customers list wired to real Supabase query. Link each row to existing `app.customers.$id`.

---

### 16. Products

**Status:** `CLAUDE_CODE`

**What exists today:** No products route exists. Product type, mock data (`src/lib/mock/products.ts`), and `getProducts` / `getRecentProducts` / `getPosProducts` API functions exist. POS uses products via the mock API but there is no standalone product management screen.

**Repository evidence:** Routes listing — no `app.products.tsx` or `app.products.$id.tsx`. `src/lib/mock/products.ts`, `src/lib/api/index.ts#getProducts`, `#getPosProducts`.

**Source-of-truth doc:** DATA_MODEL.md (Product, ProductVariant), MVP_ROADMAP.md Phase 5, APSA_MASTER_PLAN.md

**Owner:** Claude Code (route + Product/ProductVariant domain + real backend persistence)

**Dependencies:** Authentication, Product domain, Database, Inventory ledger (ProductVariant stock must come from InventoryMovement, not a mutable field)

**Next action:** Claude Code — build `/app/products` list + create/edit product screens with variant support, price (integer minor units), SKU, category, barcode. Implement Product + ProductVariant tables. Never add a mutable `stock` column — balance comes from InventoryMovement ledger.

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

**Status:** `CLAUDE_CODE`

**What exists today:** Delivery detail screen exists (`app.deliveries.$id.tsx`). No delivery list/management screen exists. Mock couriers list and `arrangeDelivery` / `applyDeliveryAction` API functions exist. The list screen has not been built by Lovable.

**Repository evidence:** Routes listing — `app.deliveries.$id.tsx` only, no `app.deliveries.tsx`. `src/lib/api/index.ts#arrangeDelivery`, `#getCouriers`, `#applyDeliveryAction`.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (delivery management), MVP_ROADMAP.md Phase 13

**Owner:** Claude Code (route + Delivery domain + real backend with COD settlement tracking)

**Dependencies:** Authentication, Order domain, Delivery domain, Database

**Next action:** Claude Code — build `/app/deliveries` list route with status filter (in_transit, delivered, failed, etc.) wired to real Supabase query. Implement Delivery table with COD settlement tracking and DeliveryEvent history.

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

**Status:** `CLAUDE_CODE`

**What exists today:** Nothing. No settings route, no settings screen, no organization settings.

**Repository evidence:** No `app.settings.tsx` in routes listing. No settings-related types or mock data.

**Source-of-truth doc:** APSA_MASTER_PLAN.md (business settings, channel connections), UX_FLOWS.md

**Owner:** Claude Code (route + organization profile persistence, connected channel management, preference storage)

**Dependencies:** Authentication, Organization domain, ConnectedChannel model, Database

**Next action:** Claude Code — build `/app/settings` screens: organization profile edit, connected channels management (with placeholder state until providers are integrated), localization preference, notification preferences. All settings must persist via real API, not localStorage.

---

### 22. Onboarding

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No onboarding flow, no organization creation wizard, no channel connection wizard, no staff invite flow from onboarding.

**Repository evidence:** No onboarding route in routes listing. No onboarding-related types or mock data.

**Source-of-truth doc:** MVP_ROADMAP.md Phase 1 (engineering foundation includes org creation), APSA_MASTER_PLAN.md

**Owner:** Claude Code (org creation API, first-run detection logic, invitation token flow, channel connection setup)

**Dependencies:** Authentication, Organization/Workspace creation domain, Database, Membership domain

**Next action:** Claude Code — implement org creation API and first-run detection (redirect to onboarding if no organization exists for the authenticated user). Build onboarding route: create org → create first workspace → invite first staff → connect first channel. Onboarding is gated by authentication being complete first.

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

**Status:** `NOT_BUILT`

**What exists today:** No authentication library, no session management, no login route, no JWT. `currentRole` in `src/lib/api/index.ts` is hardcoded as `"manager"`. No Supabase Auth, no OAuth, no email/phone OTP.

**Repository evidence:** `src/lib/api/index.ts` line ~275: `export const currentRole: StaffRole = "manager";` — hardcoded mock. `package.json` — no auth library present.

**Source-of-truth doc:** SECURITY.md §§ Auth, Session Management; ARCHITECTURE.md (security work required); DATA_MODEL.md (User, Session); MVP_ROADMAP.md Phase 1

**Owner:** Claude Code

**Dependencies:** Supabase project (external), domain types

**Next action:** Claude Code — implement Supabase Auth (email/password + phone OTP). Session middleware that attaches authenticated user + membership context to every API request. This is the first backend task — nothing else can be production without it.

---

### 25. Organization / Tenancy

**Status:** `NOT_BUILT`

**What exists today:** Mock `Shop` type and `activeShopId` in `src/lib/mock/shop.ts`. Type `WorkspaceSummary` exists in `src/types/index.ts`. The multi-tenant model (User → Membership → Organization → Workspace → Location) is not implemented.

**Repository evidence:** `src/types/index.ts#WorkspaceSummary`, `src/lib/mock/shop.ts`, no Organization table or migration.

**Source-of-truth doc:** DATA_MODEL.md (Organization, Workspace, Location, Membership), APSA_MASTER_PLAN.md (multi-tenancy model), ARCHITECTURE.md

**Owner:** Claude Code

**Dependencies:** Authentication, Supabase database

**Next action:** Claude Code — create Organization, Workspace, Location, Membership tables with RLS. Org creation API. This enables all tenant-scoped data.

---

### 26. Membership

**Status:** `NOT_BUILT`

**What exists today:** `Staff` type and mock invite/remove/role-change logic exist in mock API. No real Membership table, no invitation tokens, no email/SMS delivery.

**Repository evidence:** `src/types/index.ts#Staff`, `src/lib/api/index.ts#inviteStaff` (mock only).

**Source-of-truth doc:** DATA_MODEL.md (Membership, Role), PERMISSIONS_MATRIX.md, MVP_ROADMAP.md Phase 3

**Owner:** Claude Code

**Dependencies:** Authentication, Organization domain

**Next action:** Claude Code — implement Membership table (userId + organizationId + role + status). Invitation via time-limited token (email link or SMS OTP). Server-side enforcement that members cannot grant roles higher than their own.

---

### 27. RBAC / Permissions

**Status:** `PARTIAL`

**What exists today:** `src/lib/permissions.ts` defines a pure-function permission model keyed by `StaffRole`. Components call `permissionsFor(role)` using the hardcoded `currentRole = "manager"`. Correct role names (owner/manager/cashier/sales/customer_service) and granular permissions (refund, cancelOrder, viewCustomerPhone, manageTeam, etc.) are present. Guards are frontend-only — the backend never checks them.

**Repository evidence:** `src/lib/permissions.ts`, `src/lib/api/index.ts` comment: "Mocked; a real app resolves it from auth."

**Source-of-truth doc:** PERMISSIONS_MATRIX.md (centralized AuthorizationService, 30-category permission matrix, server-side enforcement), SECURITY.md

**Owner:** Claude Code

**Dependencies:** Authentication, Membership domain

**Next action:** Claude Code — implement server-side `AuthorizationService` that resolves role from the authenticated session (not from client input). Permission keys must follow `domain.action` format (e.g., `orders.refund`, `inventory.adjust`) per PERMISSIONS_MATRIX.md. Frontend guards are UI-only; the backend must independently enforce every permission.

---

### 28. Database

**Status:** `NOT_BUILT`

**What exists today:** No database. No Supabase project. No migrations. No schema. No ORM.

**Repository evidence:** `package.json` — no `@supabase/supabase-js`, no Prisma, no Drizzle, no database client.

**Source-of-truth doc:** ARCHITECTURE.md (PostgreSQL/Supabase), DATA_MODEL.md (30+ entities), MVP_ROADMAP.md Phase 1

**Owner:** Claude Code

**Dependencies:** Supabase project (requires external provisioning)

**Next action:** Claude Code — provision Supabase project (BLOCKED_EXTERNAL until credentials are provided). Then implement migrations for all MVP entities per DATA_MODEL.md. **Critical:** Supabase project must be entirely separate from any other project (ARCHITECTURE.md constraint).

---

### 29. Row-Level Security (RLS)

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No database, no RLS policies.

**Repository evidence:** No database exists; RLS is impossible without it.

**Source-of-truth doc:** SECURITY.md (RLS on every table, non-negotiable), ARCHITECTURE.md (security requirements), PERMISSIONS_MATRIX.md

**Owner:** Claude Code

**Dependencies:** Database (Supabase), Membership domain

**Next action:** Claude Code — implement RLS policy on every table keyed to `organization_id` derived from the authenticated session. Organization A must never access Organization B's data. This is the most critical security requirement in the entire system.

---

### 30. Audit Logging

**Status:** `NOT_BUILT`

**What exists today:** Nothing. No AuditLog table, no audit events, no logging infrastructure.

**Repository evidence:** No AuditLog type in `src/types/index.ts`. No audit-related code anywhere.

**Source-of-truth doc:** DATA_MODEL.md (AuditLog), SECURITY.md §§ Audit, APSA_MASTER_PLAN.md (audit foundation)

**Owner:** Claude Code

**Dependencies:** Database, Authentication, Domain events

**Next action:** Claude Code — implement AuditLog table with actor, action, resource_type, resource_id, organization_id, timestamp. All financial mutations (payment, refund, stock adjustment) and permission-sensitive actions (role change, staff removal) must write an audit record.

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

Lovable's remaining deliverables before Claude Code productionizes are exactly two:

1. **Product Polish Pass** — motion, micro-interactions, empty states, error states, pull-to-refresh consistency, Khmer font rendering, mobile edge cases across all existing screens
2. **Final Landing Page redesign** — final brand identity, real imagery, visual polish

All other missing screens (Orders List, Customers List, Products, Delivery Management list, Settings, Onboarding) are classified `CLAUDE_CODE` or `NOT_BUILT` and are the responsibility of Claude Code to build end-to-end once the backend exists.

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
| **`currentRole` hardcoded** | `lib/api/index.ts`: `export const currentRole: StaffRole = "manager"` | PERMISSIONS_MATRIX.md: role derived from authenticated session | Acceptable for prototype/mock — it is intentional scaffolding. Must never become production authorization truth. Production server-side AuthorizationService must derive role from the authenticated session, never from a constant. |
| **Permissions are frontend-only** | `lib/permissions.ts`: pure function, no server enforcement | SECURITY.md: security is not frontend visibility | Critical — any authenticated user can call any endpoint |
| **No `organization_id` on any record** | All types lack org scoping | SECURITY.md: tenant isolation non-negotiable | Critical — multi-tenancy impossible without this |
| **`SocialIdentity` ≠ `CustomerIdentity`** | `SocialIdentity { channel, handle }` (no merge history) | DATA_MODEL.md: CustomerIdentity with merge history, primary flag | Medium — functional for prototype; needs richer model for production |

---

## URGENT SECURITY / ARCHITECTURE CONCERNS

1. **No authentication exists.** Any user who opens the app is automatically a manager. There is no login, no session, no identity. This is acceptable for a UI prototype but must be the first thing built before any real data is handled.

2. **No tenant isolation exists.** All mock data is shared in-memory. When a real database is added, if RLS is not implemented correctly from the start, every organization will see every other organization's data. This is the highest-severity production risk.

3. **`currentRole = "manager"` is acceptable prototype scaffolding, not a bug.** The mock API intentionally assumes a manager role so all UI flows are exercisable during prototyping. However, this constant must never survive into production. Production server-side authorization must derive role from the authenticated session token; the frontend `permissionsFor()` function controls only what the UI shows and has no security value until a real AuthorizationService enforces the same rules server-side.

4. **`Product.stock` is a mutable integer.** The spec (DATA_MODEL.md) requires a ledger-based inventory model. If a migration is written with `stock integer` on the products table, it will be expensive to migrate later and will cause stock drift under concurrent updates.

5. **Tech stack divergence from ARCHITECTURE.md.** ARCHITECTURE.md references Next.js; the actual build uses TanStack Start. This is not a security concern, but it means ARCHITECTURE.md needs updating or Claude Code must decide whether to accept TanStack Start as the production stack.

6. **No CI, no tests.** There are zero automated tests in the repository. Security and permission tests cannot run. This means regressions cannot be caught before deployment.

7. **APSA must be on a completely separate Vercel project and Supabase project.** ARCHITECTURE.md is explicit about this. Verify this constraint is met when provisioning infrastructure.

---

*Confirmation: No application code was modified during this inspection. Only `APSA_BUILD_STATUS.md` was created.*
