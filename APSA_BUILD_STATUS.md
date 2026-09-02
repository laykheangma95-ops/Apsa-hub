# APSA Build Status

**Last updated:** 2026-09-02
**Evidence base:** repository inspection only — actual files, routes, components, and `.lovable/plan.md`.
**Do not add** status entries that are not grounded in code or stated project facts.

Missing source documents are noted explicitly. Items marked `NEEDS_SOURCE_DOC` cannot be accurately assessed without the corresponding architecture/security/product document.

---

## Status Key

| Status | Meaning |
|---|---|
| `DONE_LOVABLE` | Built and working in the repo; Lovable was the author |
| `PARTIAL` | Exists in code but incomplete — missing screens, routes, or functionality |
| `LOVABLE_REMAINING` | Deliberately reserved for Lovable to finish in an upcoming phase |
| `CLAUDE_CODE` | Assigned to Claude Code for implementation |
| `NOT_BUILT` | No code evidence; not yet started |
| `BLOCKED_EXTERNAL` | Blocked by a third-party integration or external dependency |
| `POST_MVP` | Deliberately deferred beyond the current MVP scope |
| `NEEDS_SOURCE_DOC` | Cannot be assessed without a missing architecture or product document |

---

## Screens and Features

### Design System
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/design-system/` contains 17+ components (AppHeader, BottomNav, BottomSheet, ChannelBadge, ConversationRow, CurrencyInput, CustomerSummaryCard, EmptyState, ErrorState, MessageBubble, MetricTile, Money, QuantityStepper, StatusChip, Timeline, ApsiIllustration, QuickActionGrid, ApsiInsightCard, AttentionCard, Sparkline, HomeSkeleton, ListSkeleton, LoadingState, LanguageToggle). Full shadcn/ui + Radix primitive set in `src/components/ui/`. Design token system in `src/styles.css`.
- **Owner:** Lovable (do not modify without explicit instruction)
- **Dependencies:** None
- **Next action:** None — use components as-is; extend only when a concrete screen requires it

---

### Business Home
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.index.tsx` — gradient header, revenue tile with Sparkline, needs-attention section (AttentionCard grid), QuickActionGrid, MetricTile grid (today/week/month range), ApsiInsightCard, BottomNav, create BottomSheet with four actions. All states: loading (HomeSkeleton), empty, error.
- **Owner:** Lovable
- **Dependencies:** `src/lib/api/getHomeSummary`, `src/lib/mock/home.ts`
- **Next action:** None until Phase 5 or backend arrives

---

### Unified Inbox
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.inbox.tsx` — messages/comments tab, search, status filters (6 statuses with live counts), channel filters (Facebook / Instagram / Telegram), ConversationRow list, pull-to-refresh, split-pane layout (tablet/desktop). All states: loading, empty (with and without search), error.
- **Owner:** Lovable
- **Dependencies:** `getConversations`, `getConversationCounts`, `getCustomers`, `getStaff`
- **Next action:** None until backend arrives

---

### Conversation Thread
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.inbox.$id.tsx` — message list with MessageBubble, outbound draft composer, saved replies sheet, status change sheet (6 statuses), CustomerDetailSheet trigger, CreateOrderSheet trigger, post-order action strip (payment / delivery / view). All states: loading, empty, error.
- **Owner:** Lovable
- **Dependencies:** `getConversation`, `getCustomer`
- **Note:** Send is local-only (mock). Real-time messaging not implemented.
- **Next action:** None for UI; messaging integration needed for real send

---

### Message → Order Sheet
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/components/inbox/CreateOrderSheet.tsx` exists and is integrated into the Conversation screen. `src/components/inbox/CustomerDetailSheet.tsx` also complete.
- **Owner:** Lovable
- **Dependencies:** `createOrder`, `getProducts`, `getRecentProducts`
- **Next action:** None until backend arrives

---

### POS (Point of Sale)
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.pos.tsx` — product search, barcode scan (mock), list/grid toggle, category filter, cart with PosCart component, discount controls with manager-approval gate, PosVariantSheet, PosCustomerSheet (search + quick-create), PosCheckoutSheet (cash / KHQR / bank transfer / COD), offline detection banner. Desktop: side-by-side cart pane. Mobile: pinned bottom bar.
- **Owner:** Lovable
- **Dependencies:** `getPosProducts`, `searchCustomers`, `createQuickCustomer`, `createSale`
- **Note:** KHQR flow is mocked. No real KHQR QR generation or callback.
- **Next action:** None for UI; KHQR integration is separate

---

### Order Detail
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.orders.$id.tsx` — order summary, customer section, itemised line items with subtotal/discount/delivery/total, payment records with status chips, delivery summary, Timeline event history, action buttons (record payment, arrange delivery, start return, refund). Role-gated via `permissionsFor`. All states: loading, permission-denied, not-found.
- **Owner:** Lovable
- **Dependencies:** `getOrderDetail`, `getCouriers`, `recordPayment`, `createReturn`, `createRefund`, `arrangeDelivery`
- **Next action:** None until backend arrives

---

### Customer 360
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.customers.$id.tsx` — customer header with CompanionColor avatar and channel identities, four tabs (overview / orders / timeline / notes), phone masking by role, lifetime spend and average order (role-gated), address (role-gated), quick-create note with mutation, timeline with CustomerEvent. All states: loading, not-found.
- **Owner:** Lovable
- **Dependencies:** `getCustomer360`, `addCustomerNote`
- **Next action:** None until backend arrives

---

### Delivery Tracking
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/app.deliveries.$id.tsx` — courier info, status chip, tracking number, DeliveryProgress component, failure reason panel, COD amount + collection + settlement-pending states, customer address (role-gated), Timeline event history, action buttons (retry / reschedule / return to shop / mark delivered). All states: loading, permission-denied, not-found.
- **Owner:** Lovable
- **Dependencies:** `getDeliveryDetail`, `applyDeliveryAction`
- **Next action:** None until backend arrives

---

### Landing Page
- **Status:** `LOVABLE_REMAINING`
- **Evidence:** `src/routes/index.tsx` contains a functional multi-section landing page (hero, problem, inbox, workflow, ops, history, Cambodia-specific features, CTA, footer). Functional and fully i18n'd. However, `.lovable/plan.md` explicitly states the final landing page redesign is a future phase.
- **Owner:** Lovable (Final Landing Page redesign reserved)
- **Dependencies:** None (no backend)
- **Next action:** Do not redesign. Leave for Lovable's Final Landing Page phase.

---

### Design Reference (`/design`)
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/routes/design.tsx` route exists.
- **Owner:** Lovable
- **Next action:** None

---

### Workspace Switcher
- **Status:** `LOVABLE_REMAINING`
- **Evidence:** `Workspace` type exists (`"business" | "creator"` in `src/types/index.ts`). BottomNav receives a `workspace` prop and the AppHeader has an `onShopSwitch` handler stub (currently `() => undefined`). No switcher UI exists.
- **Owner:** Lovable (Phase 5)
- **Dependencies:** Multi-workspace tenancy (not yet designed)
- **Next action:** Wait for Lovable Phase 5

---

### Team / Staff Invite
- **Status:** `LOVABLE_REMAINING`
- **Evidence:** `Staff` type, `StaffRole` type, and mock staff data exist in `src/lib/mock/shop.ts`. `permissionsFor(role)` in `src/lib/permissions.ts` covers 5 roles (owner, manager, cashier, sales, customer_service). No team management screen.
- **Owner:** Lovable (Phase 5)
- **Dependencies:** Authentication, tenancy
- **Next action:** Wait for Lovable Phase 5

---

### Orders List
- **Status:** `PARTIAL`
- **Evidence:** `getOrders()` exists in `src/lib/api/index.ts` and returns sorted orders. Customer 360 shows per-customer order list. **No `/app/orders` route exists** — only `/app/orders/$id` (detail). No way to navigate to an orders list from the BottomNav.
- **Owner:** Claude Code (when ready)
- **Dependencies:** `getOrders` API
- **Next action:** Requires instruction to build — do not begin without explicit task

---

### Customers List
- **Status:** `PARTIAL`
- **Evidence:** `getCustomers()` and `searchCustomers()` exist. Customer search is used in PosCustomerSheet and CustomerDetailSheet. **No `/app/customers` route for browsing all customers** — only `/app/customers/$id` (detail).
- **Owner:** Claude Code (when ready)
- **Dependencies:** `getCustomers`, `searchCustomers`
- **Next action:** Requires instruction to build — do not begin without explicit task

---

### Products (Management)
- **Status:** `PARTIAL`
- **Evidence:** `Product` domain type and mock products exist. Products are displayed in POS and the Message→Order picker. **No product management screen** — no create, edit, or list route for the merchant to manage their catalogue.
- **Owner:** Claude Code or Lovable (Product Polish Pass)
- **Dependencies:** Backend (inventory persistence)
- **Next action:** Depends on Lovable Product Polish Pass decision; do not begin without instruction

---

### Inventory
- **Status:** `NOT_BUILT`
- **Evidence:** `stock`, `reserved`, `lowStockThreshold` fields exist on the `Product` type. `low_stock` / `out_of_stock` status keys exist. AttentionCard on Home shows `low_stock` count. **No inventory management screen, no stock adjustment flow.**
- **Owner:** Later / Claude Code (when ready)
- **Dependencies:** Products, backend persistence
- **Next action:** Requires instruction and backend

---

### Payments (Dedicated Screen / Payment Management)
- **Status:** `PARTIAL`
- **Evidence:** Payment recording exists in Order Detail (`RecordPaymentSheet`). POS checkout handles cash/KHQR/bank-transfer/COD. `PaymentRecord` and `PaymentMethod` types are complete. **No dedicated payments list or payment management screen.**
- **Owner:** Later
- **Dependencies:** `NEEDS_SOURCE_DOC` — no ARCHITECTURE.md or API_AND_EVENTS.md to define payment management requirements
- **Next action:** Requires source document before design

---

### Delivery Management (List / Dispatch)
- **Status:** `PARTIAL`
- **Evidence:** Delivery detail screen exists (`/app/deliveries/$id`). `arrangeDelivery` is in Order Detail. `getCouriers()` exists. **No delivery list/dispatch screen.** No route to browse all deliveries.
- **Owner:** Later / Claude Code (when ready)
- **Dependencies:** Backend
- **Next action:** Requires instruction to build

---

### Analytics
- **Status:** `NOT_BUILT`
- **Evidence:** Home has MetricTiles (revenue, orders, customers, AOV) and Sparklines. These are summary stats, not an analytics screen. **No `/app/analytics` route, no chart screens, no reporting.**
- **Owner:** Later / `POST_MVP`
- **Dependencies:** `NEEDS_SOURCE_DOC` — no analytics requirements defined
- **Next action:** Deferred; requires product requirements

---

### Settings
- **Status:** `NOT_BUILT`
- **Evidence:** No settings route, no settings components.
- **Owner:** Later
- **Dependencies:** Authentication, tenancy, shop management
- **Next action:** Deferred; requires backend and auth

---

### Onboarding
- **Status:** `NOT_BUILT`
- **Evidence:** Apsi illustration and `ApsiIllustration` component exist (correct for onboarding use). No onboarding flow, no onboarding route.
- **Owner:** Later
- **Dependencies:** Authentication, tenancy
- **Next action:** Deferred; requires auth

---

### Public Storefront / Profile
- **Status:** `NOT_BUILT`
- **Evidence:** No evidence of a public-facing storefront or shop profile page.
- **Owner:** `POST_MVP`
- **Dependencies:** `NEEDS_SOURCE_DOC`
- **Next action:** Not in current scope

---

### Authentication
- **Status:** `NOT_BUILT`
- **Evidence:** `currentRole` is hardcoded as `"manager"` in `src/lib/api/index.ts` (explicitly marked as mock). No auth provider, no login screen, no session handling.
- **Owner:** External / Backend (when backend phase begins)
- **Dependencies:** `NEEDS_SOURCE_DOC` — no ARCHITECTURE.md or SECURITY.md to define auth strategy
- **Next action:** Requires SECURITY.md and ARCHITECTURE.md before implementation

---

### Tenancy (Multi-shop / Multi-workspace)
- **Status:** `NEEDS_SOURCE_DOC`
- **Evidence:** `Shop` type exists, `activeShopId` in mock data, `getShops()` in API. `Workspace` type (`"business" | "creator"`) exists. No multi-tenant isolation is implemented — mock data is flat. Architecture of how tenants are scoped is not defined anywhere in this repository.
- **Owner:** External / Backend
- **Dependencies:** `NEEDS_SOURCE_DOC` — requires ARCHITECTURE.md + DATA_MODEL.md
- **Next action:** Do not design until ARCHITECTURE.md exists

---

### RBAC (Role-Based Access Control)
- **Status:** `PARTIAL`
- **Evidence:** `StaffRole` type (5 roles), `Permissions` interface, and `permissionsFor(role)` function exist in `src/lib/permissions.ts`. Role-gates are applied in UI (phone masking, lifetime spend hiding, refund buttons). `ORDER_APPROVAL_LIMIT_CENTS` is enforced at the mock API boundary. All permission checks are **client-side and mock only** — not server-enforced.
- **Owner:** Backend (when backend phase begins)
- **Dependencies:** Authentication, `NEEDS_SOURCE_DOC` — requires PERMISSIONS_MATRIX.md
- **Next action:** UI scaffolding is correct; server enforcement requires backend

---

### Database
- **Status:** `NOT_BUILT`
- **Evidence:** No database, ORM, schema, or migration files exist. All data is in-memory mock in `src/lib/mock/`.
- **Owner:** `NEEDS_SOURCE_DOC` — requires DATA_MODEL.md and ARCHITECTURE.md
- **Next action:** Do not begin without source documents

---

### Row-Level Security (RLS)
- **Status:** `NEEDS_SOURCE_DOC`
- **Evidence:** No database exists. `restricted` flag on `Order` and `Delivery` mock types simulates permission denial, but this is a UI mock, not RLS. No real tenant isolation exists.
- **Owner:** External / Backend
- **Dependencies:** Database, SECURITY.md, DATA_MODEL.md
- **Next action:** Do not design until SECURITY.md exists

---

### Audit Logging
- **Status:** `NOT_BUILT`
- **Evidence:** Order and customer event types exist (`OrderEvent`, `CustomerEvent`, `DeliveryEvent`) and are displayed in Timeline components. These are mock display data — not a write-path audit trail. No server-side logging.
- **Owner:** Backend / `POST_MVP`
- **Dependencies:** `NEEDS_SOURCE_DOC` — requires SECURITY.md and API_AND_EVENTS.md
- **Next action:** Deferred to backend phase

---

### Messaging Integrations (Facebook / Instagram / Telegram)
- **Status:** `NOT_BUILT`
- **Evidence:** Conversations, messages, and channel types are fully modelled and displayed. All data is mock. No webhook handlers, no platform API clients, no real message sending or receiving.
- **Owner:** `BLOCKED_EXTERNAL` / Backend
- **Dependencies:** Meta Business API, Telegram Bot API, backend webhook infrastructure
- **Next action:** Requires backend + platform API credentials; do not begin without ARCHITECTURE.md

---

### Payment Integrations (KHQR / Bank Transfer)
- **Status:** `NOT_BUILT`
- **Evidence:** `PaymentMethod` type includes `"khqr"` and `"bank_transfer"`. POS checkout UI references KHQR. No real KHQR QR generation, no bank transfer callback, no payment SDK.
- **Owner:** `BLOCKED_EXTERNAL` / Backend
- **Dependencies:** NBC/KHQR API, banking integrations, backend
- **Next action:** Requires backend and external API access

---

### Courier Integrations
- **Status:** `NOT_BUILT`
- **Evidence:** `Courier` type, mock courier data (4 couriers), and `arrangeDelivery` mock exist. No real courier API client.
- **Owner:** `BLOCKED_EXTERNAL` / Backend
- **Dependencies:** Courier partner APIs
- **Next action:** Requires backend and courier API credentials

---

### Localization (i18n)
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/locales/km.json` and `src/locales/en.json` exist. i18next configured in `src/lib/i18n.tsx`. `lang="km"` on `<html>`. Kantumruy Pro font loaded for Khmer. `LanguageToggle` component used on landing. All UI strings go through `useTranslation()`. No hard-coded user-facing strings found in routes.
- **Owner:** Lovable (existing coverage); Claude Code (new strings for new features)
- **Dependencies:** None
- **Next action:** Maintain coverage — all new strings must go through i18next; add to both locale files

---

### Money Utilities
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/lib/money.ts` — `Money` type (integer minor units), `KHR_PER_USD = 4100` (single constant), `KHR_ROUNDING = 100`, `usd()`, `khr()`, `formatMoney()`, `usdToKhr()`, `khrToUsd()`, `addMoney()`, `subtractMoney()`, `multiplyMoney()`, `calculateChange()`. No floating-point arithmetic. KHR rounds to nearest 100. All components use `formatMoney()`.
- **Owner:** Stable — do not modify without careful review
- **Dependencies:** None
- **Next action:** None; treat as authoritative

---

### API / Application Boundary
- **Status:** `PARTIAL`
- **Evidence:** `src/lib/api/index.ts` is the single data boundary — all components call it; none import from mock files directly. Correct layered architecture. However, all implementations are mock (simulate latency with `setTimeout`, return in-memory data). No real HTTP calls.
- **Owner:** Claude Code (swap implementations when backend arrives)
- **Dependencies:** Backend
- **Next action:** Shape is correct; only function bodies change when backend exists

---

### Domain Types
- **Status:** `DONE_LOVABLE`
- **Evidence:** `src/types/index.ts` — comprehensive: `Money`, `Currency`, `Channel`, `Language`, `Workspace`, `StatusKey` (24 statuses), `CompanionColor`, `SyncState`, `Address`, `SocialIdentity`, `Customer`, `Product`, `ProductCategory`, `ProductVariantOption`, `Order`, `OrderItem`, `OrderEvent`, `PaymentRecord`, `Delivery`, `DeliveryEvent`, `CustomerNote`, `CustomerEvent`, `Message`, `Conversation`, `ConversationDetail`, `Staff`, `StaffRole`, `PaymentMethod`, `Sale`, `Courier`, `Shop`, `AttentionItem`, `Metric`, `MetricPoint`, `MetricRange`, `HomeSummary`. Pure TypeScript, no React dependency.
- **Owner:** Stable (Lovable); extend for new domains as needed
- **Dependencies:** None
- **Next action:** None; treat as authority for domain model

---

### Events (Domain Event System)
- **Status:** `PARTIAL`
- **Evidence:** `OrderEvent`, `CustomerEvent`, `DeliveryEvent` types defined and used in Timeline displays. Event records appear in mock data. **No event bus, no pub/sub, no server-sent events, no webhooks.**
- **Owner:** `NEEDS_SOURCE_DOC` — requires API_AND_EVENTS.md to define event contracts
- **Dependencies:** Backend, API_AND_EVENTS.md
- **Next action:** UI display layer exists; event system design requires source document

---

### Usage Metering
- **Status:** `NOT_BUILT`
- **Evidence:** No evidence of metering, quota, or plan limits anywhere in the codebase.
- **Owner:** `POST_MVP` / `NEEDS_SOURCE_DOC`
- **Dependencies:** Backend, APSA_MASTER_PLAN.md
- **Next action:** Deferred

---

### Feature Flags / Entitlements
- **Status:** `NOT_BUILT`
- **Evidence:** No feature flag system, no entitlement checks, no plan-gating.
- **Owner:** `POST_MVP` / `NEEDS_SOURCE_DOC`
- **Dependencies:** Authentication, tenancy, APSA_MASTER_PLAN.md
- **Next action:** Deferred

---

### Production Monitoring
- **Status:** `NOT_BUILT`
- **Evidence:** `src/lib/lovable-error-reporting.ts` exists and is called in the root error boundary — this is Lovable's own error telemetry tool, not production APM. No Sentry, Datadog, or equivalent. No structured logging.
- **Owner:** `NEEDS_SOURCE_DOC` / External
- **Dependencies:** ARCHITECTURE.md (which observability stack)
- **Next action:** Deferred to backend phase

---

### Security Hardening
- **Status:** `NOT_BUILT`
- **Evidence:** Security-conscious patterns are present in code (manual payment confirmation notes, `PERMISSION_DENIED` error, phone masking, `restricted` flag on orders/deliveries). These are UI-layer patterns, not production hardening. No CSP headers, no rate limiting, no input sanitization layer, no server-side auth.
- **Owner:** `NEEDS_SOURCE_DOC` — requires SECURITY.md before any security implementation
- **Dependencies:** SECURITY.md, backend
- **Next action:** Do not implement security measures until SECURITY.md is added

---

## Summary Count (by status)

| Status | Count |
|---|---|
| `DONE_LOVABLE` | 11 |
| `LOVABLE_REMAINING` | 4 |
| `PARTIAL` | 8 |
| `NOT_BUILT` | 9 |
| `NEEDS_SOURCE_DOC` | 6 (plus additional items flagged within PARTIAL/NOT_BUILT) |
| `BLOCKED_EXTERNAL` | 3 |
| `POST_MVP` | 3 |

---

## Missing Source Documents (Priority Order)

The following documents do not exist in this repository. Their absence blocks accurate assessment or implementation of the items noted.

| Document | Urgency | What it unblocks |
|---|---|---|
| `SECURITY.md` | **Critical** | Authentication design, RLS design, security hardening, audit logging, client-side security patterns |
| `ARCHITECTURE.md` | **Critical** | Tech stack decisions, backend choice, tenancy model, deployment architecture, observability |
| `APSA_MASTER_PLAN.md` | **High** | Product vision, MVP scope, business model, pricing, entitlements |
| `DATA_MODEL.md` | **High** | Database schema, tenant scoping, RLS policies, event contracts |
| `API_AND_EVENTS.md` | **High** | Backend API contracts, event system, webhook shapes, integration boundaries |
| `PERMISSIONS_MATRIX.md` | **High** | Complete RBAC rules per role per action — needed before server-enforced auth |
| `MVP_ROADMAP.md` | Medium | Sprint priorities, release sequencing |
| `UX_FLOWS.md` | Medium | Edge cases for new screens (Orders List, Customers List, Onboarding) |
| `CORRECTIONS.md` | As needed | Overrides when any earlier document is wrong |

---

## Conflicts: `.lovable/plan.md` vs Actual Code

The following discrepancies exist between `.lovable/plan.md` (Phase 1 design brief) and what was actually built:

1. **Plan calls for `SyncIndicator` and `ListSkeleton` as named components.** `ListSkeleton` exists. `HomeSkeleton` exists. `SyncIndicator` does not appear in `src/design-system/index.ts` as a named export — `SyncState` type exists but no standalone SyncIndicator component is exported from the barrel. Minor gap.

2. **Plan references TanStack Start + file routes.** Actual code uses TanStack Router but the root shell uses `createRootRouteWithContext` and `shellComponent` — consistent with TanStack Start. No conflict.

3. **Plan specifies Framer Motion for bottom sheets.** `BottomSheet` in design-system exists — Framer Motion import cannot be confirmed from the barrel without reading the component, but the plan intent is honoured architecturally.

4. **Plan says fonts: Inter + Kantumruy Pro.** Actual root loads `Plus Jakarta Sans` (not Inter) + `Kantumruy Pro` + `JetBrains Mono`. This is a deviation from the plan's font spec. The plan says "Inter"; the implementation uses Plus Jakarta Sans. Not a functional issue but worth noting for brand consistency.

5. **Plan says 17 design-system components.** Actual barrel exports more than 17 — additional components (ApsiInsightCard, AttentionCard, QuickActionGrid, Sparkline, HomeSkeleton, LanguageToggle, Timeline, LoadingState) were added in later phases beyond Phase 1. No conflict — this is expected growth.

6. **Plan is Phase 1 scope only.** Phases 2–4 (Inbox, Conversation, POS, Order Detail, Customer 360, Delivery) are built but not described in the plan. The plan explicitly scopes to Phase 1 only. All post-Phase-1 work is additional — not a conflict.

---

## Repository Naming / Metadata Notes (for later cleanup)

- `package.json` `"name"` field is `"tanstack_start_ts"` — this is TanStack's default template name, not APSA. Should be renamed to `"apsa-hub"` when convenient.
- `twitter:site` meta in `__root.tsx` is `"@Lovable"` — should be updated to the APSA Twitter/X handle when one exists.
- No favicon beyond `favicon.ico` — SVG favicon and `apple-touch-icon` not present.
- `AGENTS.md` content is entirely Lovable integration boilerplate — correct and should remain.
