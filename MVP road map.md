# APSA — MVP ROADMAP

**Document:** `MVP_ROADMAP.md`  
**Project:** APSA  
**Purpose:** Exact implementation sequence for the first production-ready MVP  
**Primary users:** Cambodian social-commerce sellers and physical shops selling through social media  
**Primary clients:** Mobile-first Web/PWA  
**Future clients:** Native iOS/Android using the same backend and domain logic

---

# 1. MVP OBJECTIVE

The MVP is not meant to prove every future APSA idea.

It must prove one core business hypothesis:

> Cambodian merchants will rely on APSA to manage social conversations, customers, orders, stock, payments, and delivery more effectively than using separate tools.

The MVP must demonstrate APSA's signature workflow:

**MESSAGE → CUSTOMER → ORDER → PAYMENT → INVENTORY → DELIVERY → HISTORY → INSIGHT**

---

# 2. MVP SUCCESS CRITERIA

The MVP is successful when a real merchant can:

1. create an APSA business;
2. invite staff;
3. add products and variants;
4. manage stock;
5. use POS;
6. receive supported social messages;
7. identify customer history;
8. convert a conversation into an order;
9. record payment status;
10. create and track a basic delivery;
11. understand unread/follow-up customers;
12. see basic business performance;
13. use the system safely from mobile.

---

# 3. FIRST TARGET USERS

Prioritize:

## A. Solo social sellers

Main pain:

- too many messages
- forgotten follow-up
- payment confusion
- order mistakes
- no customer history

## B. Physical shops with social selling

Additional pain:

- stock differences
- staff accountability
- POS + online orders disconnected
- delivery workflow
- sales visibility

Do not optimize MVP for service businesses, wholesale, marketplace, restaurants, or enterprise chains.

Prepare architecture for them only.

---

# 4. MVP NON-GOALS

Do NOT include:

- full marketplace
- Swipe-to-Buy consumer app
- own delivery fleet
- full accounting
- lending
- merchant wallet
- financial custody
- advanced autonomous AI
- supplier marketplace
- food-delivery aggregation
- full loyalty network
- advertising network
- advanced warehouse management
- complex enterprise SSO
- microservices
- Kubernetes

---

# 5. RELEASE PHASES

APSA MVP rollout:

```text
FOUNDATION
↓
INTERNAL ALPHA
↓
5 MERCHANT PILOT
↓
20 MERCHANT PILOT
↓
100 MERCHANT BETA
↓
1,000 ACTIVE MERCHANT TARGET
```

Every phase requires quality review before expanding.

---

# 6. PHASE 0 — PRODUCT + DESIGN FOUNDATION

## Goal

Freeze the product direction before major backend development.

## Build

- APSA landing/product frontend prototype
- mobile-first navigation
- Creator/Inbox workspace UX
- Business/Sell workspace UX
- unified Inbox UX
- Message → Order UX
- POS UX
- order/payment/delivery UX
- design system
- typography
- Khmer/English layout
- responsive behavior
- motion rules

## Tool strategy

Lovable:

- visual design
- UX exploration
- reusable frontend foundation
- mock data only

GitHub:

- source of truth after prototype approval

Claude Code:

- audit/refactor generated frontend before backend integration

Codex:

- secondary code/review support

## Exit Criteria

- mobile UX reviewed;
- design system coherent;
- no permanent insecure backend decisions;
- code synchronized to APSA private GitHub repo;
- major frontend structure approved.

---

# 7. PHASE 1 — REPOSITORY + ENGINEERING FOUNDATION

## Goal

Create a production-quality codebase before business features.

## MUST Build

- Next.js/React/TypeScript foundation
- project folder conventions
- linting
- formatting
- strict TypeScript settings
- environment handling
- `.env.example`
- test framework
- CI pipeline
- staging configuration
- production configuration
- error boundary patterns
- logging foundation
- feature flag foundation
- localization framework
- money/currency utilities
- documentation links to:
  - `APSA_MASTER_PLAN.md`
  - `ARCHITECTURE.md`
  - `SECURITY.md`
  - `MVP_ROADMAP.md`

## Security

- no production secrets in code;
- protected GitHub main branch;
- 2FA on founder accounts;
- separate APSA Supabase/Vercel;
- staging separate from Domner.

## Exit Criteria

- build passes;
- lint passes;
- typecheck passes;
- CI functioning;
- local/staging environments understood;
- no production data exists yet.

---

# 8. PHASE 2 — AUTHENTICATION + TENANCY

## Goal

Build the most important structural foundation correctly before merchant data exists.

## Build

### User

- authentication
- profile
- session

### Organization

- create organization
- organization settings
- organization ID

### Workspace

Initial types:

- INBOX
- BUSINESS

### Location

- basic location entity
- default location

### Membership

- user ↔ organization relationship
- membership status
- role

## Important Rule

Never attach business-owned data directly to user ownership.

Use:

```text
User
↓
Membership
↓
Organization
↓
Workspace
↓
Location
```

## Security

- tenant-isolation strategy;
- RLS/application authorization;
- membership checks;
- removed user loses access;
- organization ID manipulation tests.

## Exit Criteria

Automated tests prove:

- Merchant A cannot access Merchant B;
- user without membership cannot access organization;
- removed member loses access;
- workspace/location checks work correctly.

This phase is a release blocker for all future merchant data.

---

# 9. PHASE 3 — ROLES & PERMISSIONS

## Goal

Create professional staff access without hard-coded role logic.

## Build

- Permission model
- Role model
- role-permission relationship
- membership role assignment

Initial preset roles:

- Owner
- Manager
- Cashier
- Sales
- Customer Service

Possible permission examples:

- products.read
- products.manage
- inventory.read
- inventory.adjust
- orders.read
- orders.create
- orders.cancel
- payments.read
- payments.confirm
- messages.read
- messages.reply
- customers.read
- financials.revenue
- financials.profit
- team.manage

## UX

Keep MVP role management simple.

Do not expose massive enterprise permission matrix initially.

## Exit Criteria

Authorization tests for every sensitive role difference.

---

# 10. PHASE 4 — CUSTOMER FOUNDATION

## Goal

Create APSA's universal customer system.

## Build

### Customer

- name
- phone
- email optional
- organization ownership
- notes
- created date

### CustomerIdentity

Possible providers:

- phone
- facebook
- instagram
- telegram

TikTok prepared but not falsely implemented.

### Customer Address

- phone
- province
- district
- commune
- village
- landmark
- freeform address
- map coordinates later

### Tags

Examples:

- VIP
- Follow Up
- Repeat
- Wholesale later

### Marketing Consent

Prepare:

- merchant marketing
- APSA platform marketing
- channel preferences
- timestamps

Do not build campaigns yet.

## Exit Criteria

One customer can have multiple identities without duplicate customer models.

---

# 11. PHASE 5 — PRODUCT CATALOG

## Goal

Create one product truth reusable everywhere later.

## Build

### Product

- Khmer name
- English name
- description
- images
- category
- brand optional
- status

### ProductVariant

- SKU
- barcode
- options
- price
- cost
- weight optional

### Categories

Basic categories.

## UX

Advanced fields progressively disclosed.

Small seller must be able to add a basic product quickly.

## Exit Criteria

Same product structure can later feed:

- POS
- social orders
- mini store
- marketplace
- Swipe Deals

without duplication.

---

# 12. PHASE 6 — INVENTORY LEDGER

## Goal

Make inventory auditable and trustworthy.

## Build

### InventoryMovement

Movement types:

- INITIAL_STOCK
- PURCHASE
- SALE
- RETURN
- DAMAGE
- ADJUSTMENT
- RESERVATION
- RESERVATION_RELEASE
- TRANSFER later

### Stock Calculation

Track:

- on hand
- reserved
- available

### Stock Adjustment

Require:

- quantity
- reason
- staff actor

### Low Stock

Basic threshold/alert.

## Critical Rules

Do not make direct silent stock overwrite the normal workflow.

Use transactions/concurrency-safe updates.

## Exit Criteria

Tests prove:

- sale reduces correct stock;
- return restores correct stock;
- duplicate operations don't double-deduct;
- tenant isolation preserved;
- stock history traceable.

---

# 13. PHASE 7 — UNIVERSAL ORDER ENGINE

## Goal

Create APSA's central commerce transaction.

## Build

### Order

Sources:

- POS
- FACEBOOK
- INSTAGRAM
- TELEGRAM
- MANUAL

Future sources prepared:

- TIKTOK
- MINI_STORE
- MARKETPLACE
- SWIPE
- API
- FOOD

### OrderItem

Snapshot:

- product
- variant
- name
- SKU
- quantity
- price
- cost

### Order Status

Initial useful statuses:

- DRAFT
- PENDING_PAYMENT
- PAID
- CONFIRMED
- PACKING
- READY_FOR_DELIVERY
- IN_TRANSIT
- DELIVERED
- CANCELLED
- RETURNED
- REFUNDED

Backend uses controlled transitions.

Frontend may simplify visible states.

## Exit Criteria

Merchant can create, edit where allowed, cancel and inspect order history correctly.

---

# 14. PHASE 8 — PAYMENT RECORDS

## Goal

Track money accurately without building financial custody.

## Build

Payment methods:

- Cash
- KHQR
- Bank Transfer
- COD

Statuses:

- PENDING
- PAID
- FAILED
- REFUNDED

### Manual Confirmation

Authorized employee may mark payment paid.

Audit:

- actor
- amount
- time
- method

## Important

No real payment provider required for first beta.

Do not use screenshots as automatic payment truth.

## Future Plug-in

`PaymentProvider`

later supports:

- KHQR
- bank APIs
- payment partners

## Exit Criteria

Owner can clearly determine:

- unpaid
- paid
- refunded

for every order.

---

# 15. PHASE 9 — POS

## Goal

Make APSA operational for physical shops.

## Build

- product search
- barcode preparation
- cart
- quantity
- optional customer
- discount
- checkout
- payment method
- receipt
- order creation
- inventory deduction

## Mobile First

Must work well on:

- phone
- tablet

## Offline Preparation

Expose conceptual states:

- online
- offline
- syncing

Do not build unreliable pseudo-offline financial sync yet.

## Exit Criteria

Merchant can complete a normal sale quickly and stock/order/payment records remain correct.

---

# 16. PHASE 10 — CONVERSATION + INBOX CORE

## Goal

Build APSA's major differentiation.

## Build

### Conversation

- customer link
- source channel
- assigned staff
- status
- unread count
- last message

### Message

- sender
- content
- timestamp
- provider message ID
- attachment reference where needed

### Follow-Up States

- Needs Reply
- Follow Up
- Waiting Customer
- Order Created
- Closed

### Assignment

- assign staff
- reassign

### Tags / Saved Replies

Basic.

## Exit Criteria

Inbox is useful even before AI.

---

# 17. PHASE 11 — FIRST REAL MESSAGING PROVIDER

## Goal

Connect APSA to one real official communication source safely.

## Selection

Choose the provider offering the strongest legitimate first implementation path.

Likely candidates:

- Telegram
- Meta-supported Facebook/Instagram integration

Do not promise all four channels simultaneously if approval/API restrictions delay one.

## Build

- official authentication/connect flow
- provider token handling
- webhook verification
- message ingestion
- send reply where officially supported
- provider event deduplication
- token refresh/revocation

## Security

Never expose provider secrets client-side.

## Exit Criteria

Real conversations flow reliably into APSA.

---

# 18. PHASE 12 — APSA MAGIC: MESSAGE → ORDER

## Goal

Deliver the defining MVP moment.

## Flow

Conversation

↓

Customer identified

↓

Staff taps:

**Create Order**

↓

Bottom sheet:

- product
- variant
- quantity
- price
- discount
- delivery option later

↓

Order created

↓

Conversation remains open

↓

Order linked to customer and conversation

## Important

Do not require staff to leave Inbox and manually recreate the customer.

## Exit Criteria

Real merchant can turn a social conversation into an order faster than their current workflow.

This is one of the strongest MVP launch gates.

---

# 19. PHASE 13 — DELIVERY RECORD + TRACKING

## Goal

Create APSA's own merchant-facing delivery workflow before real courier APIs.

## Build

### Delivery

- order
- courier/provider name
- tracking number
- customer
- address
- delivery fee
- COD amount
- status

Statuses:

- REQUESTED
- DRIVER_ASSIGNED
- PICKED_UP
- IN_TRANSIT
- DELIVERED
- FAILED
- CANCELLED

### Manual Provider Mode

Merchant can select/enter courier manually.

### Timeline

Display delivery progress clearly.

## Future Plug-in

`DeliveryProvider`

later allows real courier integrations without changing Order.

## Exit Criteria

Merchant can see which parcels:

- need delivery
- are in transit
- delivered
- failed

---

# 20. PHASE 14 — OWNER HOME + ANALYTICS

## Goal

Answer:

> What needs my attention?

## Home

Show:

- today's sales
- orders
- estimated gross profit
- unread conversations
- unpaid orders
- orders waiting for delivery
- low stock

## Basic Analytics

- top-selling products
- sales by source
- order count
- average order value

## Staff Basics

- conversations handled
- response time where measurable
- orders created
- conversion estimate later

Do not build complex BI.

## Exit Criteria

Owner can understand business status within seconds.

---

# 21. PHASE 15 — CUSTOMER HISTORY + COMPLAINT CONTROL

## Goal

Reduce merchant disputes and operational mistakes.

Customer screen should show:

- messages
- orders
- payments
- delivery
- notes
- staff involvement

Order detail should preserve:

- product snapshot
- staff
- source
- timeline

## Exit Criteria

When a customer complains:

> “You sent me the wrong size.”

merchant can reconstruct what happened without searching multiple apps.

---

# 22. PHASE 16 — PUBLIC MERCHANT PROFILE / MINI STORE BETA

## Goal

Create an acquisition/value feature for small SMEs.

Possible URL:

`apsa.com/shopname`

Display:

- merchant
- logo
- products
- location
- contact
- promotions later

Reuse existing catalog.

Do not create a separate product database.

## MVP Scope

May initially be:

- public profile
- product browsing
- contact/order inquiry

Full consumer checkout can come later.

## Exit Criteria

Merchant can receive a professional public APSA link with minimal setup.

---

# 23. PHASE 17 — HARDENING

Before broad beta, focus exclusively on quality.

## Security

- tenant tests
- RBAC tests
- RLS tests
- IDOR testing
- webhook signature testing
- backdoor scan
- secret scan
- customer export controls

## Reliability

- retries
- idempotency
- error handling
- safe migrations
- backups
- restore procedure

## Performance

- mobile load
- query performance
- pagination
- image optimization

## UX

- Khmer
- English
- mobile
- empty states
- errors
- loading
- permission denied
- offline indication

## Exit Criteria

No known critical security/reliability issue.

---

# 24. PHASE 18 — INTERNAL ALPHA

Use APSA internally or with extremely trusted test merchants.

Goal:

Find catastrophic assumptions before external pilot.

Test full journey:

```text
Create Business
↓
Add Product
↓
Receive Stock
↓
Receive Message
↓
Create Order
↓
Record Payment
↓
Prepare Delivery
↓
Deliver
↓
Inspect Analytics
```

Fix major problems before 5-merchant pilot.

---

# 25. PHASE 19 — 5 MERCHANT PILOT

Select merchants personally.

Recommended mix:

- 3 solo social sellers
- 2 physical/social hybrid retailers

Founder observes them directly.

Do not explain every action.

Watch where they become confused.

Track:

- onboarding time
- first product
- first order
- first message
- first chat-to-order
- support requests
- bugs
- missing workflow

Do not add every requested feature.

Look for repeated patterns.

---

# 26. PHASE 20 — 20 MERCHANT PILOT

After fixing 5-merchant issues:

Expand to 20.

Test:

- real staff teams
- higher conversation volume
- more products
- more orders
- delivery workflow
- permissions
- mobile performance

Begin measuring:

- weekly active merchant
- weekly orders
- retention
- feature usage

---

# 27. PHASE 21 — 100 MERCHANT BETA

This is the first meaningful operating test.

Before reaching 100:

- automated tenant security tests required;
- monitoring required;
- backups working;
- support process defined;
- production incidents traceable.

Start testing pricing/plan assumptions without aggressively monetizing.

---

# 28. FIRST 1,000 ACTIVE MERCHANT TARGET

Primary success metric:

**1,000 weekly-active merchants**

An active merchant should generate real weekly business activity such as:

- orders
- POS transactions
- conversations
- customer updates

Registrations alone do not count.

---

# 29. MVP METRICS

Track from early beta:

## Activation

- registration complete
- organization created
- workspace selected
- first product
- first staff invite
- first social connection
- first order

## Core Value

- first Message → Order
- weekly orders
- weekly conversations handled
- POS transactions
- delivery records

## Retention

- day 7
- day 30
- weekly active merchants

## Operational Quality

- failed messages
- failed orders
- payment inconsistencies
- stock inconsistencies
- support requests

---

# 30. STAFF PERFORMANCE MVP

Initial staff analytics should remain simple.

Track:

- messages handled
- orders created
- response time where reliable
- unresolved conversations

Do not build aggressive ranking/scoring system immediately.

Later:

- conversion rate
- refunds
- complaint rate
- sales
- customer satisfaction

Need careful context to avoid misleading owners.

---

# 31. CRM MVP

Do NOT build full campaign engine.

Prepare:

- customer tags
- customer history
- consent records
- segmentation-ready attributes

Simple possible segment UI later:

- repeat customer
- inactive
- high spend

Campaign sending belongs after core product proves retention.

---

# 32. SOCIAL CHANNEL PRIORITY

Desired channels:

1. Facebook
2. Instagram
3. Telegram
4. TikTok

However, launch sequence depends on official API capability and approval.

Rule:

> Do not delay the entire MVP waiting for every channel.

Start with one reliable provider.

Add additional providers progressively.

---

# 33. FACEBOOK COMMENT SUPPORT

If official Meta API permissions support required behavior:

Add:

- comment ingestion
- unanswered comment state
- assignment
- reply
- customer link where possible

If not available/reliable:

Do not scrape.

Prepare UI/provider capability for future.

---

# 34. OFFLINE POS ROADMAP

## MVP

- online POS
- connection state
- safe retry behavior

## Beta Later

- durable local operation queue
- IndexedDB or approved storage
- unique operation IDs
- server idempotency
- sync state

## Native Later

Native local DB may provide stronger offline architecture.

Do not rush full offline mode before correctness.

---

# 35. PAYMENT ROADMAP

## MVP

Manual:

- Cash
- KHQR
- Bank Transfer
- COD

## Next

Official transaction verification where partner/API allows.

## Later

Commercial payment partnership:

- preferred rates
- revenue sharing
- settlement integration

## Much Later

Only consider custody/wallet after legal/regulatory/security review.

---

# 36. DELIVERY ROADMAP

## MVP

Manual courier record/tracking.

## Next

First courier API integration.

## Then

Multiple providers:

- compare price
- speed
- service level

## Revenue Later

- per parcel commission
- margin/spread
- commercial partnership

## Do Not Build Yet

APSA-owned driver fleet.

---

# 37. SUBSCRIPTION ROADMAP

Early:

Cheap or free-first acquisition.

Potential Free:

- 1 owner
- 1 business
- POS
- product/stock
- customers
- orders
- 1 social channel
- limited chat-to-order
- basic analytics

Paid later unlocks:

- more staff
- more channels
- automation
- advanced analytics
- campaigns
- multi-location
- API

Do not lock exact pricing before merchant usage data.

---

# 38. FUTURE PHASE — CRM & PROMOTIONS

Only after core retention.

Build:

- segments
- campaign builder
- message channel selection
- consent filtering
- campaign analytics
- conversion attribution

Possible revenue:

- subscription
- usage
- messaging margin

---

# 39. FUTURE PHASE — REAL DELIVERY AGGREGATOR

Once provider partnerships exist:

- quote comparison
- booking
- tracking
- webhook status
- COD visibility
- reliability score
- negotiated pricing

Do not expose courier partner economics publicly unless strategically appropriate.

---

# 40. FUTURE PHASE — PAYMENT PARTNERSHIPS

Once meaningful GMV exists:

Negotiate with licensed institutions around:

- merchant acquisition
- payment verification
- transaction volume
- preferred merchant terms
- commercial revenue share

APSA should own the orchestration UX, not necessarily custody.

---

# 41. FUTURE PHASE — AUTOMATION ENGINE

After merchants already use structured workflows.

Build:

```text
WHEN
+
IF
+
THEN
```

Examples:

Payment confirmed

→ notify packing.

Delivery delivered

→ follow-up after seven days.

Stock low

→ alert owner.

Do not build automation before business events are reliable.

---

# 42. FUTURE PHASE — AI

AI comes after structured data and workflows.

Priority:

1. reply suggestions
2. conversation summaries
3. Khmer translation/improvement
4. order extraction
5. owner business insights

High-risk AI actions always require deterministic authorization/human confirmation.

---

# 43. FUTURE PHASE — MULTI-LOCATION

Architecture supports it from Day 1.

Build full UX when merchant demand proves it.

Features:

- location inventory
- transfers
- branch performance
- manager permissions

---

# 44. FUTURE PHASE — MARKETPLACE

Do not launch marketplace until APSA has a meaningful merchant/catalog base.

Future:

Merchant selects:

**Sell on APSA Marketplace**

Products publish from existing catalog.

Orders return into universal APSA Order.

---

# 45. FUTURE PHASE — CLEARANCE SWIPE

Purpose:

Consumer discovery of:

- clearance
- special discounts
- excess inventory

Do not turn it into a generic marketplace feed.

Use same:

- products
- stock
- discounts
- orders
- delivery

---

# 46. FUTURE PHASE — SUPPLIER NETWORK

Possible:

Supplier catalogs

↓

Merchant purchasing

Revenue:

- commissions
- advertising
- group purchasing
- logistics

Only after merchant network exists.

---

# 47. FUTURE PHASE — SERVICE BUSINESSES

When product sellers are proven:

Add item/service capability.

Potential future:

- appointments
- packages
- service staff
- commission

Do not contaminate MVP with service complexity.

---

# 48. FUTURE PHASE — WHOLESALE

Add later:

- customer pricing tiers
- bulk quantities
- purchase orders
- credit terms
- sales representatives

Architecture should not prevent this.

---

# 49. FUTURE PHASE — ACCOUNTING INTEGRATION

Do not become full accounting software unless strategically justified.

Prefer:

- clean financial records
- exports
- accounting integrations

Only build general ledger/full accounting after strong merchant demand.

---

# 50. QUALITY GATE FOR EVERY SPRINT

Before marking sprint complete:

- requirements met;
- architecture respected;
- tenant ownership preserved;
- authorization reviewed;
- tests added;
- typecheck/lint pass;
- migration reviewed;
- mobile UX tested;
- Khmer strings/layout checked;
- error states handled;
- no secrets added;
- audit/event needs reviewed.

---

# 51. CLAUDE CODE WORKFLOW

Before every sprint Claude Code must read:

- `APSA_MASTER_PLAN.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `MVP_ROADMAP.md`

Then:

1. inspect current code;
2. summarize relevant current implementation;
3. identify risks;
4. implement only sprint scope;
5. add tests;
6. run checks;
7. report changes;
8. report security/migration impact;
9. stop before unrelated next sprint.

Do not allow Claude to continuously build multiple roadmap phases without review.

---

# 52. CODEX REVIEW WORKFLOW

Use Codex after high-risk implementation.

Codex should verify:

- requirements
- architecture consistency
- tests
- security
- regression
- duplicated logic
- unsafe migration
- tenant leakage
- concurrency
- payment/inventory integrity

Do not ask Codex simply:

“Does this look good?”

Give explicit review scope.

---

# 53. PRODUCTION RELEASE CHECKLIST

Before any significant release:

- [ ] CI passing
- [ ] staging tested
- [ ] migrations applied successfully in staging
- [ ] tenant tests pass
- [ ] authorization tests pass
- [ ] mobile test complete
- [ ] Khmer/English test complete
- [ ] backup current
- [ ] monitoring active
- [ ] no known critical issue
- [ ] rollback/forward-fix understood
- [ ] feature flags configured where appropriate

---

# 54. MVP DEFINITION OF DONE

APSA MVP is ready for controlled merchant launch when:

### Foundation

- organizations/workspaces work;
- staff and permissions work;
- tenant isolation proven.

### Commerce

- products work;
- inventory ledger works;
- POS works;
- universal orders work;
- payment records work.

### Inbox

- one real social provider works reliably;
- unread/follow-up works;
- staff assignment works.

### APSA Magic

- message → customer → order works smoothly.

### Delivery

- manual courier/tracking workflow works.

### Insight

- owner can see basic operational status.

### Quality

- mobile-first;
- Khmer-ready;
- secure;
- tested;
- monitored;
- recoverable.

---

# 55. MVP FOUNDER RULE

Do not add a feature simply because:

- competitor has it;
- AI can code it quickly;
- merchant requests it once;
- it looks impressive.

Ask:

1. Does it strengthen the core workflow?
2. Do multiple merchants need it?
3. Does it increase retention/revenue?
4. Does it introduce architecture risk?
5. Can it safely wait?

Build APSA around merchant dependency, not feature count.

---

# 56. FINAL MVP NORTH STAR

The first version succeeds if a Cambodian seller can say:

> “Before APSA, I had to check social messages, write orders separately, check payment, remember delivery, search customer history, and ask staff what happened. Now I open one place and I can see everything.”

That experience matters more than having the largest feature list.

Build that first.
