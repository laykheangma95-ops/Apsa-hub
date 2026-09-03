# APSA — PRODUCT & ENGINEERING MASTER PLAN

**Document type:** Product + Engineering Source of Truth  
**Project:** APSA  
**Market:** Cambodia-first, international-ready  
**Product category:** Business Operating System / Social Commerce OS  
**Development philosophy:** Mobile-first, AI-assisted, production-grade architecture, progressive feature rollout  
**Primary engineering model:** Modular monolith  
**Primary source of truth:** GitHub

---

# 1. PRODUCT VISION

APSA is not a POS application.

APSA is a long-term **Cambodian Business Operating System** designed to bring the fragmented daily operations of Cambodian merchants into one simple platform.

APSA should eventually connect:

**Messages → Customers → Orders → Products → Inventory → Payments → Delivery → CRM → Promotions → Staff → Analytics → Automation**

The long-term ambition is:

> Build the operating infrastructure Cambodian businesses run on.

The product must be simple enough for a one-person Facebook seller while structurally capable of supporting a large multi-location business later.

APSA should combine:

**consumer-app simplicity + professional business capability + Cambodian market understanding + international engineering quality**

---

# 2. CORE CUSTOMER PROBLEM

Cambodian social sellers currently operate across disconnected tools.

A merchant may use:

- Facebook
- Instagram
- Telegram
- TikTok
- KHQR/bank app
- POS
- delivery application
- spreadsheets
- paper notes

As message/order volume increases, merchants face problems such as:

- unread customers being forgotten
- difficult follow-up
- orders getting lost
- staff not responding properly
- no visibility into which staff close sales
- unclear payment status
- customer complaints caused by incorrect products
- no consolidated customer order history
- inventory mistakes
- delivery tracking difficulty
- unclear best-selling products
- weak customer retention
- no structured promotion system

APSA's core promise is:

> **Never lose a customer, message, order, payment, or follow-up again.**

---

# 3. FIRST TARGET MARKET

## Primary launch customers

### A. Solo social-commerce sellers

Especially sellers using:

- Facebook
- Instagram
- Telegram

and later TikTok where official APIs support the required integration.

### B. Physical shops that also sell through social media

Examples:

- fashion
- beauty
- electronics
- accessories
- general retail
- online shops with physical stock

---

# 4. FIRST PRODUCT FOCUS

Launch first for businesses selling **physical products**.

Do NOT initially optimize APSA for:

- clinics
- salons
- agencies
- repair businesses
- appointment businesses

However, architecture must allow future service businesses without rebuilding the platform.

Future service concepts should be able to reuse:

- Customer
- Order
- Item
- Payment
- Conversation
- Staff
- Location

---

# 5. ONE APPLICATION — MULTIPLE WORKSPACES

APSA should NOT become separate applications for creators and sellers.

One APSA account can access different workspace experiences.

## Workspace A — Inbox / Creator

Target:

- creators
- influencers
- agencies
- customer-support teams
- teams that primarily manage conversations

Core modules:

- Inbox
- Contacts
- Team
- Insights
- Settings

Commerce modules should remain hidden.

A creator can later select:

**Enable Selling**

without:

- creating another account
- migrating contacts
- reconnecting channels
- losing previous conversations

---

## Workspace B — Business / Sell

For merchants.

Includes Inbox capabilities plus:

- Home
- POS
- Orders
- Products
- Inventory
- Customers
- Payments
- Delivery
- Analytics
- Team
- Settings

---

# 6. CORE SIGNATURE WORKFLOW

APSA's most important workflow:

**MESSAGE → CUSTOMER → ORDER → PAYMENT → INVENTORY → DELIVERY → CUSTOMER HISTORY → ANALYTICS**

Example:

Customer messages through Instagram.

↓

APSA receives conversation.

↓

Staff sees customer history.

↓

Staff presses **Create Order** inside conversation.

↓

Product/variant/quantity selected.

↓

Order created.

↓

Inventory reserved/deducted appropriately.

↓

Payment status recorded.

↓

Delivery arranged.

↓

Tracking follows the parcel.

↓

Customer history updates.

↓

Owner analytics update.

This should feel dramatically easier than switching between multiple apps.

---

# 7. SOCIAL CHANNEL STRATEGY

Desired major channels:

- Facebook
- Instagram
- Telegram
- TikTok

However:

APSA must use **official APIs only**.

Never build integrations through:

- scraping
- stolen tokens
- unofficial reverse-engineered APIs
- unsafe browser automation

Provider architecture must allow channels to be added/changed independently.

---

# 8. FACEBOOK COMMENTS

Where official API permissions allow it, APSA should support:

**Messages**

and

**Comments**

Comments should be treated as customer interactions.

Possible workflow:

Facebook comment

↓

staff sees unanswered interaction

↓

staff replies or moves conversation toward private communication

↓

contact/customer identified

↓

order can eventually be created

Do not force Comments and DMs into identical data structures if platform behavior differs.

They should share the broader interaction/customer architecture.

---

# 9. FOLLOW-UP MANAGEMENT

Inbox must provide more than chronological messaging.

Required conceptual statuses:

- Unread
- Needs Reply
- Follow Up
- Waiting Customer
- Order Created
- Closed

The seller must immediately understand:

> Which customer still requires action?

Follow-up management is a core differentiator.

---

# 10. STAFF PERFORMANCE

APSA should provide owners with professional staff-performance intelligence.

Possible metrics:

- conversations handled
- median/average response time
- unread conversations
- unresolved conversations
- orders created
- sales conversion
- refunds
- complaints
- stock adjustments
- orders handled
- revenue associated with salesperson

Use this for:

- coaching
- customer-service improvement
- business visibility
- workload balancing

Do not position it as employee-surveillance software.

---

# 11. CUSTOMER 360

APSA must have ONE universal customer model.

Do NOT create:

- FacebookCustomer
- InstagramCustomer
- TelegramCustomer
- POSCustomer

Create:

**Customer**

plus:

**CustomerIdentity**

Possible identities:

- Facebook
- Instagram
- Telegram
- TikTok
- phone
- email
- future APSA consumer account
- marketplace identity

Example:

Dara Sok

- Instagram @dara
- Facebook profile
- Telegram account
- phone +855...
- APSA consumer ID later

Customer profile should eventually show:

- identities
- phone
- addresses
- tags
- notes
- order history
- spending
- average order value
- last purchase
- conversations
- delivery history
- payment history
- loyalty later

---

# 12. CUSTOMER TIMELINE

Each customer/order should have an event timeline.

Example:

10:32 Instagram message  
10:41 Order created  
10:47 Payment confirmed  
11:03 Packed  
11:16 Courier pickup  
13:48 Delivered

This supports:

- complaint investigation
- customer service
- staff accountability
- analytics
- future AI summaries

---

# 13. ORGANIZATION ARCHITECTURE — MUST NOW

Do NOT model:

User → Business Data

Use:

**User → Organization → Workspace → Location → Membership**

Example:

Founder Account

→ Organization A

→ Shop 1  
→ Shop 2  
→ Warehouse

and possibly:

→ Organization B

One user can belong to multiple organizations.

One organization can have many users.

---

# 14. MULTIPLE BUSINESS SUPPORT — MUST NOW

One account should eventually manage:

- clothing shop
- beauty brand
- café
- warehouse
- second company

Provide a workspace/business switcher.

Do not architect:

one account = one business.

---

# 15. BUSINESS DATA OWNERSHIP

Operational records belong to the organization/workspace, not individual employee users.

Examples:

- customers
- orders
- products
- conversations
- payments
- delivery
- inventory

should carry tenant ownership such as:

`organization_id`

and appropriate workspace/location references.

---

# 16. ROLE & PERMISSION ARCHITECTURE — MUST NOW

Use granular RBAC.

Example permissions:

messages.read  
messages.reply  
messages.assign

customers.read  
customers.edit  
customers.export_sensitive

orders.read  
orders.create  
orders.cancel  
orders.refund

inventory.read  
inventory.adjust

payments.read  
payments.confirm

financials.revenue  
financials.profit

staff.manage

settings.manage

Roles are collections of permissions.

Example roles:

- Owner
- Manager
- Cashier
- Sales
- Customer Service
- Warehouse
- Accountant
- Custom Role later

Never rely only on hiding UI buttons.

Authorization must be enforced server-side/database-side where applicable.

---

# 17. DATA ACCESS & PRIVACY

APSA's company will control its infrastructure and may derive valuable commerce intelligence from legitimately collected platform activity.

Strategically important categories may include:

- product categories
- demand trends
- purchasing behavior
- order behavior
- geographic demand
- delivery behavior
- customer retention
- campaign performance
- category growth

However:

Merchant-private operational data must remain protected.

Raw sensitive information such as phone numbers should not become unrestricted internal browsing data.

Sensitive internal access should require:

- privileged role
- reason
- audit event
- appropriate authorization

---

# 18. MARKETING CONSENT — MUST NOW

Phone number possession does NOT automatically equal marketing permission.

Store separate consent concepts such as:

- merchant marketing consent
- APSA/platform marketing consent
- SMS consent
- push consent
- email consent
- messaging-channel consent

Store:

- consent status
- consent source
- consent timestamp
- revocation timestamp

This must exist structurally before APSA builds large marketing features.

---

# 19. CRM & PROMOTIONS

Promotions will eventually become an important revenue/product layer.

Future merchant segments:

- VIP
- repeat customer
- high spend
- inactive 30/60/90 days
- category buyer
- location
- new customer
- frequent customer

Campaigns may eventually use:

- push
- SMS
- Telegram
- supported platform messaging
- email

Campaign analytics:

- audience
- sent
- delivered
- opened where measurable
- conversions
- revenue
- ROI

Do not build advanced campaigns in MVP.

Prepare consent/data architecture now.

---

# 20. PRODUCT CATALOG — MUST NOW

Product data must be reusable across future channels.

Product may include:

- ID
- Khmer name
- English name
- description
- images
- category
- brand
- SKU
- barcode
- price
- cost
- tax metadata later
- status
- weight
- dimensions
- variants
- tags

Variants:

Product

→ Black

→ S / M / L

→ White

→ S / M / L

Products should eventually power:

- POS
- social sales
- mini store
- marketplace
- clearance Swipe product
- APIs

Merchant must not upload the same product separately for every channel.

---

# 21. INVENTORY — MUST USE LEDGER

Do not treat inventory as only:

`stock = 20`

Use inventory movements.

Examples:

+100 Purchase  
-2 POS Sale  
-1 Instagram Order  
-3 Damage  
+1 Return  
-10 Transfer

Possible future inventory states:

- Available
- Reserved
- Incoming
- Damaged
- Transfer
- Returned

This enables:

- auditability
- stock history
- fraud investigation
- multi-location inventory
- accurate reporting

---

# 22. OFFLINE POS — PREPARE NOW

Offline operation is important.

APSA should eventually allow sales while internet connection is unavailable.

Possible UX states:

- Online
- Offline
- Pending Sync
- Syncing
- Synced
- Sync Failed

Full offline synchronization can be implemented progressively.

Architecture must not assume every operation always has internet access.

---

# 23. UNIVERSAL ORDER MODEL — MUST NOW

One Order model.

Possible sources:

- POS
- Facebook
- Instagram
- Telegram
- TikTok
- mini-store
- marketplace
- future Swipe
- API
- food-order channels later

Store source metadata.

Do NOT build separate order databases for different channels.

---

# 24. ORDER STATE MACHINE

Recommended main statuses:

DRAFT

→ PENDING_PAYMENT

→ PAID

→ CONFIRMED

→ PICKING/PACKING

→ READY_FOR_DELIVERY

→ IN_TRANSIT

→ DELIVERED

Exceptions:

- CANCELLED
- RETURN_REQUESTED
- RETURNED
- REFUNDED
- FAILED

Avoid uncontrolled arbitrary status strings.

---

# 25. PAYMENT MODEL — MUST NOW

Payment must be a proper entity.

Possible fields:

- payment ID
- order ID
- provider
- method
- amount
- currency
- status
- reference
- paid_at
- refund amount
- reconciliation metadata

Initial MVP methods:

- Cash
- KHQR
- Bank Transfer
- COD

Initially confirmation may be manual.

Later:

- bank API
- KHQR integrations
- payment-provider webhooks
- revenue-sharing partnerships

---

# 26. PAYMENT COMMISSION — LATER

Initial architecture:

Customer → Merchant's payment account.

APSA records or verifies status.

Later:

Licensed payment institution/bank

↓

Merchant payment flow

↓

Commercial agreement/revenue share with APSA

Do not start by holding merchant funds directly unless regulatory/business requirements are properly satisfied.

---

# 27. FUTURE SETTLEMENT MODEL

Prepare conceptually for:

Order

↓

Payment

↓

Fees / refunds / adjustments

↓

Settlement

↓

Merchant payout

But do not build a TikTok-like stored merchant balance in MVP.

---

# 28. MULTI-CURRENCY — MUST NOW

Cambodia requires strong support for:

- USD
- KHR

Do not use floating-point math for financial values.

Store safe decimal/minor-unit representations according to technical design.

Record exchange rate when conversion occurs.

---

# 29. DELIVERY — CORE PRODUCT

APSA should own the merchant-facing delivery-management experience.

Do not initially own delivery drivers.

APSA is an aggregator/orchestration layer first.

Merchant selects among delivery partners.

Example:

Courier A — $0.90 — Same Day  
Courier B — $0.75 — Next Day  
Courier C — $1.20 — Express

---

# 30. DELIVERY PROVIDER ABSTRACTION — MUST NOW

Define a provider interface conceptually similar to:

`DeliveryProvider`

operations may include:

- quote()
- createDelivery()
- cancelDelivery()
- getTracking()
- handleWebhook()

Each courier receives its own adapter.

Do not write core order logic specifically for one courier.

---

# 31. DELIVERY ENTITY — MUST NOW

Fields may include:

- delivery ID
- order ID
- provider
- provider tracking ID
- pickup address
- dropoff address
- phone
- COD amount
- provider cost
- merchant-facing delivery price
- status
- picked_up_at
- delivered_at
- failure reason
- proof-of-delivery reference

MVP can support manual entry/tracking before APIs exist.

---

# 32. COD MODEL

Initial direction:

Courier collects COD.

Courier settles directly with merchant.

APSA tracks:

- delivery
- COD amount
- status
- expected settlement
- settlement state where integration allows

APSA does not initially hold the COD funds.

Future revenue may come from courier volume agreements/API-driven commission.

---

# 33. DELIVERY REVENUE

Future commercial model:

APSA aggregates parcel volume.

Negotiate platform rate with couriers.

Possible revenue:

- per-parcel commission
- spread/margin
- referral fee
- API partnership economics

Do not assume any fixed rate until contracts exist.

---

# 34. OWN DELIVERY FLEET — LATER ONLY

Do NOT build APSA Logistics initially.

Owning logistics requires:

- drivers
- vehicles
- insurance
- cash operations
- hubs
- route operations
- fraud control
- lost parcel management
- operations teams

Reconsider only after APSA has enough delivery data to prove a service gap.

---

# 35. MESSAGING PROVIDER ABSTRACTION — MUST NOW

Conceptual interface:

`MessagingProvider`

possible operations:

- connectAccount()
- refreshAuthorization()
- receiveMessage()
- sendMessage()
- syncConversation()
- receiveWebhook()

Adapters:

- Meta
- Telegram
- future TikTok if supported
- future WhatsApp
- future direct/web chat

Core messaging logic must not depend directly on one provider.

---

# 36. PAYMENT PROVIDER ABSTRACTION — MUST NOW

Concept:

`PaymentProvider`

possible operations:

- createPayment()
- verifyPayment()
- refund()
- handleWebhook()

Adapters may later include:

- KHQR/bank integrations
- licensed payment providers
- cards

---

# 37. AI PROVIDER ABSTRACTION — MUST NOW

AI should never become APSA's permanent database.

Define an AI abstraction:

`AIService`

Adapters may include:

- Claude
- OpenAI
- future Khmer models
- other providers

Possible AI tasks later:

- conversation summary
- suggested replies
- translation
- order extraction
- product categorization
- sales analysis
- owner business assistant

Do not lock APSA to one model/provider.

---

# 38. AI DATA PRINCIPLE

System of record:

**APSA-controlled database/infrastructure**

AI receives only necessary authorized context.

Example:

Owner asks:

“Why did sales fall?”

APSA retrieves:

- relevant sales
- refunds
- discounts
- product performance
- channels

Then sends only required context to AI.

Never upload the entire database unnecessarily.

---

# 39. EVENT ARCHITECTURE — MUST NOW

Prepare internal business events.

Examples:

- customer.created
- message.received
- conversation.assigned
- order.created
- order.paid
- inventory.changed
- inventory.low
- delivery.created
- delivery.picked_up
- delivery.delivered

Initially this can remain lightweight.

Do NOT build Kafka-scale infrastructure prematurely.

Use simple reliable event handling appropriate to modular-monolith architecture.

---

# 40. FUTURE AUTOMATION

Events will later enable automation.

Examples:

WHEN order.paid

→ reserve inventory  
→ notify packing  
→ prepare delivery

WHEN delivery.delivered

WAIT 7 days

→ request review

WHEN stock < threshold

→ notify manager

Future automation builder:

Trigger → Conditions → Actions

Do not build full automation engine in MVP.

---

# 41. AUDIT LOGS — MUST NOW

Sensitive changes must be traceable.

Examples:

Employee changed price $15 → $10.

Employee adjusted stock 20 → 14.

Manager refunded $40.

Owner changed role permissions.

Audit records should capture:

- actor
- action
- resource
- previous state where appropriate
- new state where appropriate
- timestamp
- contextual reason where required

Audit records should not be casually editable.

---

# 42. PUBLIC MERCHANT PROFILE

Every merchant should eventually have a professional public identity.

Example:

`apsa.com/shopname`

Possible content:

- merchant name
- logo
- verification status
- location
- products
- promotions
- contact
- order button

This becomes a strong free acquisition feature.

---

# 43. FREE MINI STORE

Merchant products inside APSA should automatically power a simple online storefront.

No duplicate upload.

Architecture:

Product Catalog

→ POS  
→ Mini Store  
→ Marketplace later  
→ Clearance Swipe later

This can eventually give small Cambodian merchants instant e-commerce presence.

---

# 44. MERCHANT IDENTITY NETWORK — PREPARE NOW

Each merchant receives a permanent platform identity.

Possible future benefits:

- verified profile
- unified store identity
- payments
- delivery
- marketplace
- reviews
- consumer app
- API integrations

Do not create a second merchant database later.

---

# 45. FUTURE CONSUMER IDENTITY

Eventually consumers may have one APSA account across participating businesses.

Future capabilities:

- saved address
- order history
- tracking
- loyalty
- push notifications
- marketplace
- Swipe Deals

Do not build full consumer app in MVP.

---

# 46. CLEARANCE SWIPE-TO-BUY — FUTURE

Future consumer product should focus on:

**clearance + special discounts**

rather than becoming another general marketplace.

Possible flow:

Merchant marks product as clearance.

↓

APSA inventory knows actual availability.

↓

Discount item becomes eligible for consumer Swipe feed.

↓

Consumer purchases.

↓

Order enters merchant's existing APSA order system.

Do not build now.

Prepare:

- discount data
- channel eligibility
- inventory
- universal order source

---

# 47. MARKETPLACE — FUTURE

Marketplace should launch only after APSA already has:

- merchants
- product catalogs
- inventory
- payments
- delivery integrations

Merchant should activate:

**Sell on Marketplace**

without uploading everything again.

Marketplace revenue may eventually include:

- commission
- advertising
- promoted listings
- fulfillment partnerships

---

# 48. SUPPLIER NETWORK — FUTURE

Possible future B2B marketplace:

Supplier → APSA → Merchants

Revenue opportunities:

- commissions
- supplier advertising
- wholesale transaction fees
- group purchasing
- logistics

Do not build in MVP.

---

# 49. GROUP PURCHASING — FUTURE

APSA may aggregate merchant demand.

Example:

100 merchants collectively need 10,000 units.

APSA negotiates wholesale pricing.

Possible benefits:

- merchant savings
- supplier volume
- APSA transaction margin

---

# 50. FOOD CHANNELS — FUTURE

Restaurant/food businesses can eventually receive orders from:

- direct APSA store
- social media
- supported food-ordering integrations
- POS
- phone/manual entry

All become universal Orders.

Do not build food aggregation in initial MVP.

---

# 51. WHOLESALE — PREPARE, DO NOT BUILD

Initial retail product should not include complex wholesale functionality.

But avoid blocking future concepts:

- customer pricing tier
- quantity pricing
- supplier
- purchase order
- credit terms

---

# 52. ACCOUNTING STRATEGY

Do NOT build complete accounting initially.

MVP/business analytics should understand:

Revenue  
- product cost  
- discount  
- refunds  
- payment fees  
- delivery subsidy/cost  

= estimated gross profit

Later:

- expenses
- accounting exports
- accounting integrations

Build full accounting only if merchant demand proves it is strategically necessary.

---

# 53. ANALYTICS

Analytics should answer questions rather than merely show charts.

Owner home:

- sales today
- orders
- estimated gross profit
- unread customers
- unpaid orders
- pending delivery
- low stock

Later:

- channel revenue
- top products
- customer retention
- staff conversion
- promotion performance
- inventory velocity

---

# 54. BUSINESS INTELLIGENCE

APSA may eventually create aggregated/anonymized intelligence such as:

- category growth
- pricing trends
- regional demand
- inventory velocity
- seasonal trends
- customer retention benchmarks

Do NOT expose merchant-private competitive information to other merchants.

---

# 55. SUBSCRIPTION PHILOSOPHY

Keep subscription affordable.

Primary goal early:

**Merchant adoption + activity + transaction volume**

Revenue later can come from:

- subscriptions
- delivery commission
- payments
- marketing/CRM
- automation/AI usage
- marketplace commission
- marketplace advertising
- supplier network
- API/integrations
- financial-service partnerships
- premium analytics

---

# 56. FREE PLAN PHILOSOPHY

Free should demonstrate APSA's magic.

Potential Free experience:

- one owner
- one business/location
- POS
- products
- basic inventory
- customers
- orders
- one social channel
- limited chat-to-order
- basic analytics
- basic delivery record/tracking

Do not make Free only a generic POS.

Users should understand why APSA is different.

---

# 57. FUTURE SUBSCRIPTION STRUCTURE

Potential categories:

## Free

Micro seller.

## Starter

Small business.

## Business

Growing SME.

## Pro

Multi-location/advanced operations.

## Enterprise

Custom.

Use entitlements rather than hard-coded plan checks.

---

# 58. ENTITLEMENT SYSTEM — MUST NOW

Avoid:

`if plan == PRO`

scattered around the code.

Use feature entitlements.

Examples:

social_channels

Free = 1  
Starter = 3  
Business = higher/unlimited

staff_members

Free = 1  
Starter = 3  
Business = 10

advanced_analytics

Free = false  
Business = true

This enables pricing changes without product rewrites.

---

# 59. USAGE METERING — MUST NOW

Track:

- users
- social channels
- messages
- orders
- products
- locations
- automations later
- AI usage
- storage
- API usage

Even before charging.

Pricing decisions should eventually use real usage data.

---

# 60. FEATURE FLAGS — MUST NOW

Support staged rollouts.

Example:

`NEW_INBOX=true` only for selected merchants.

Rollout:

internal

↓

5 merchants

↓

50

↓

500

↓

everyone

This prevents dangerous all-user releases.

---

# 61. MOBILE-FIRST WEB / PWA

First production client:

**responsive mobile-first web/PWA**

Reasons:

- lower cost
- faster iteration
- easy deployment
- accessible from phone/tablet/desktop
- no app-store delay
- same backend later supports native clients

Do not build desktop-first.

---

# 62. FUTURE NATIVE MOBILE

Future native iOS/Android app should reuse:

- backend
- authentication
- API
- business logic
- database
- events
- permissions
- domain types

Native UI can be adapted for platform-specific UX.

No backend/business-system rewrite.

---

# 63. DESIGN PRINCIPLE

APSA should feel:

**consumer-level simple + business-grade underneath**

Brand feeling:

- trustworthy
- professional
- tech
- premium
- easy
- calm
- modern

Avoid:

- old ERP
- cheap POS
- crypto dashboards
- visual clutter
- excessive glass
- excessive animation

---

# 64. KHMER-FIRST

Launch:

- Khmer
- English

Localization architecture should use keys.

Do not hard-code text inside components.

Future:

- Chinese
- Thai
- Vietnamese
- other regional languages

Khmer typography must be treated professionally.

---

# 65. DESIGN SYSTEM

Create reusable:

- colors/tokens
- typography
- spacing
- radii
- buttons
- inputs
- forms
- cards
- tables
- navigation
- sheets
- drawers
- dialogs
- badges
- status
- skeletons
- errors
- empty states

Do not design each screen independently.

---

# 66. MOTION

Use subtle motion for:

- order created
- payment confirmed
- new message
- panel open/close
- product added
- delivery completed

Business software must remain fast.

Avoid unnecessary visual entertainment.

---

# 67. ACCESSIBILITY

Support:

- strong contrast
- keyboard navigation
- visible focus
- meaningful labels
- large touch targets
- semantic markup
- status indicators beyond color

---

# 68. CORE TECHNICAL APPROACH

Start as a:

**Modular Monolith**

Do NOT start with:

- Kubernetes
- dozens of microservices
- expensive distributed infrastructure

Possible modules:

auth  
organizations  
workspaces  
memberships  
permissions  
customers  
messaging  
products  
inventory  
orders  
payments  
delivery  
analytics  
subscriptions  
audit  
events

---

# 69. FRONTEND / BACKEND SEPARATION

Do not make the web frontend the business logic.

Desired architecture:

Frontend

↓

Application/API

↓

Domain/Services

↓

Repositories/Data Access

↓

PostgreSQL/Supabase

This enables:

Web today

↓

Native app tomorrow

without rewriting core business rules.

---

# 70. DATABASE PORTABILITY

Supabase/PostgreSQL is initial system of record.

Do not scatter Supabase-specific calls throughout UI components.

Create a proper data-access layer.

Future migration should be possible if scale requires:

Supabase PostgreSQL

→ larger managed PostgreSQL

→ regional architecture

without rebuilding APSA.

---

# 71. SUPABASE

Use a completely separate Supabase project from Domner.

Supabase initially provides:

- PostgreSQL
- Auth
- Storage
- realtime where appropriate

Scale gradually.

Do not pay for massive future infrastructure before usage exists.

---

# 72. GITHUB

Use existing GitHub account if desired.

Create:

**separate private APSA repository**

Do not mix with Domner.

Later create/move to GitHub Organization when team/company structure warrants it.

GitHub is the code source of truth.

---

# 73. VERCEL

Create a completely separate APSA Vercel project.

Never mix with Domner deployment/secrets.

Use:

Development

↓

Staging

↓

Production

Claude/Codex should never casually experiment against production.

---

# 74. SECRETS

Never:

- commit `.env`
- expose production secrets client-side
- paste sensitive production secrets into public code
- reuse Domner secrets

Use separate:

- dev
- staging
- production

credentials.

---

# 75. ACCOUNT OWNERSHIP

Founder/company must remain top-level owner of:

- GitHub
- Vercel
- Supabase
- domain
- Meta app
- Telegram credentials
- payment accounts
- courier accounts
- cloud infrastructure

Developers receive:

**least privilege**

through individual accounts.

Never give contractors your main passwords.

---

# 76. SECURITY BASELINE

Design toward principles such as:

- least privilege
- secure authentication
- server-side authorization
- tenant isolation
- secrets management
- encryption in transit
- database security/RLS where appropriate
- rate limiting
- secure webhooks
- file-upload safety
- audit logs
- backup/recovery
- secure dependencies

Future commercial maturity can target standards such as:

- SOC 2
- ISO 27001

Certification is not required for MVP.

Architecture should not prevent future compliance.

---

# 77. MULTI-TENANT SECURITY — CRITICAL

Absolute security requirement:

> Organization A must NEVER access Organization B's private business records.

Test specifically for:

- URL ID manipulation
- API ID manipulation
- broken RLS
- broken authorization
- IDOR
- privilege escalation

Never rely only on frontend filtering.

---

# 78. DEVELOPER/CONTRACTOR SECURITY

External specialists must not receive unrestricted permanent access.

Use:

- separate developer accounts
- least privilege
- protected production resources
- temporary access where appropriate
- audit logging
- remove access after project completion
- credential rotation when appropriate

---

# 79. BACKDOOR REVIEW

Before production or after sensitive contractor work, explicitly inspect for:

- hidden admin accounts
- hard-coded passwords
- hidden API keys
- undocumented admin endpoints
- authorization bypasses
- unusual scheduled tasks
- suspicious dependencies
- data sent to unknown servers
- secret exports
- suspicious analytics/exfiltration
- privileged debug routes

AI code review can help.

For meaningful scale, independent human security review/penetration testing remains recommended.

---

# 80. PRODUCTION WORKFLOW

Required professional pipeline:

Developer / Claude

↓

local checks

↓

GitHub branch

↓

automated tests

↓

code review

↓

staging

↓

QA/security validation

↓

production

Never:

AI code change → direct production

---

# 81. BRANCH PROTECTION

Protect main/production branches.

Require:

- pull request
- checks
- controlled merge

Critical production changes should be traceable.

---

# 82. BACKUPS

Required:

- automated database backups
- point-in-time recovery where plan permits
- storage backups strategy
- restore testing

A backup is not enough.

The company must know it can restore.

---

# 83. OBSERVABILITY

Production should eventually monitor:

- API errors
- latency
- failed login
- failed message ingestion
- failed outgoing messages
- order failures
- inventory inconsistencies
- payment webhook errors
- courier webhook errors
- database performance
- queue backlog
- suspicious activity

Do not rely on merchants to report every outage.

---

# 84. IDEMPOTENCY

Critical transactional actions must support duplicates safely.

If a webhook arrives 3 times:

payment must not count 3 times.

Delivery event must not duplicate status incorrectly.

Inventory must not deduct repeatedly.

Implement idempotent processing where required.

---

# 85. TESTING STANDARD

Use:

- unit tests
- integration tests
- API tests
- permission tests
- database/RLS tests
- end-to-end tests
- responsive tests

Critical workflows:

Business creation  
Product creation  
Stock receive  
POS sale  
Conversation  
Chat → Order  
Payment  
Delivery  
Return  
Refund

---

# 86. SECURITY TEST CASES

Explicitly test:

- tenant leakage
- IDOR
- broken authorization
- privilege escalation
- SQL injection
- XSS
- CSRF where relevant
- insecure file upload
- forged webhook
- API-key exposure
- brute force
- duplicate transactional events

---

# 87. LOVABLE ROLE

Lovable is used for:

- UX exploration
- frontend prototype
- design system
- branding direction
- landing page
- responsive product UI
- motion exploration

Use mock data initially.

Do NOT let Lovable decide permanent:

- production schema
- auth
- RLS
- payment security
- courier security

---

# 88. CLAUDE CODE ROLE

Claude Code becomes the primary technical builder.

Responsibilities:

- architecture
- Supabase/database
- migrations
- security
- APIs
- integrations
- tests
- production code
- refactoring Lovable output
- deployment architecture

Always prefer the lowest-cost Claude model capable of the task.

Use stronger model only when necessary.

---

# 89. CODEX ROLE

Codex is used as:

- second engineering reviewer
- debugging partner
- regression reviewer
- test reviewer
- security reviewer
- deployment/debugging assistant

Do not let multiple AI tools create competing independent architectures.

GitHub is the common source of truth.

---

# 90. AI DEVELOPMENT FLOW

Recommended:

Lovable

↓

GitHub

↓

Claude Code

↓

Codex review

↓

Staging

↓

Testing

↓

Production

---

# 91. COST PHILOSOPHY

APSA is AI-first.

Do not reduce engineering quality because founder capital is small.

Instead:

> **Reduce scope, not standards.**

Build fewer live integrations early.

But still build:

- clean architecture
- tests
- security
- backups
- future-ready interfaces

---

# 92. $200-FIRST PRINCIPLE

An early private beta can be built with very low external spending by:

- using AI coding
- free/low-cost infrastructure
- manual payment confirmation
- manual courier tracking
- mock integrations during prototype

Do not activate expensive external services until required.

---

# 93. BUILD STRUCTURE NOW, PLUG SERVICE LATER

Example:

Payment entity/provider interface NOW.

↓

Bank/KHQR integration LATER.

Delivery entity/provider interface NOW.

↓

Courier APIs LATER.

Messaging abstraction NOW.

↓

Additional channels LATER.

Marketing consent NOW.

↓

Campaign system LATER.

Marketplace-ready catalog NOW.

↓

Marketplace LATER.

This is APSA's core capital-efficiency principle.

---

# 94. MVP DEFINITION

Initial APSA MVP should contain:

## Platform Core

- account/auth
- organization
- workspace
- location
- memberships
- roles/permissions
- Khmer/English architecture
- feature flags
- events
- audit foundation
- entitlement architecture

## Inbox

- conversations
- messages
- contacts/customer identity
- unread
- follow-up
- assignment
- tags
- saved replies
- one initial real messaging integration

## Commerce

- products
- variants
- inventory ledger
- customers
- universal orders
- order items
- payment record

## POS

- product search
- cart
- quantity
- customer optional
- discount
- payment method
- receipt

## Signature Workflow

**Message → Customer → Order**

## Delivery

- delivery record
- manual courier
- tracking status
- COD record
- timeline

## Owner Insights

- sales
- orders
- gross-profit estimate
- unread messages
- unpaid orders
- waiting delivery
- low stock

---

# 95. MVP — DO NOT BUILD

Do NOT include in first MVP:

- consumer marketplace
- Swipe-to-Buy consumer app
- own courier fleet
- full accounting
- lending
- advanced AI autonomous selling
- supplier marketplace
- food-delivery aggregation
- complex loyalty network
- advertising network
- giant enterprise infrastructure

---

# 96. MVP FREE HOOK

Free plan must show APSA's differentiation.

Recommended early free hook:

POS

+

Products / Stock

+

Customers / Orders

+

**one social channel**

+

limited Chat → Order

A free POS alone is not enough differentiation.

---

# 97. PILOT STRATEGY

Do not jump directly to 10,000 merchants.

Roll out:

Internal

↓

5 merchants

↓

20 merchants

↓

100 merchants

↓

1,000 active merchants

↓

10,000

---

# 98. FIRST CUSTOMER PILOT MIX

Recommended:

5 solo social sellers

5 physical/social hybrid stores

2–3 creator/inbox users

Observe them directly.

Founder should participate personally.

---

# 99. METRICS

Do not measure success by registrations alone.

Primary early definition:

**Active merchant = business creating real business activity/orders every week.**

Track:

- signup completion
- first business created
- first product
- first connected social channel
- first conversation
- first Chat → Order
- first POS sale
- first delivery
- 7-day retention
- 30-day retention
- weekly active merchants
- weekly orders per merchant

---

# 100. FIRST MAJOR SUCCESS TARGET

Target:

**1,000 weekly-active merchants**

before obsessing about 10,000 registrations.

Then scale toward:

10,000 active businesses.

---

# 101. LONG-TERM REVENUE MODEL

Possible revenue streams:

1. subscriptions
2. payment revenue/revenue sharing
3. delivery commission
4. COD tools
5. CRM/promotions
6. SMS/messaging margin where appropriate
7. AI/automation usage
8. marketplace commission
9. marketplace advertising
10. supplier marketplace
11. group purchasing
12. fulfillment later
13. hardware
14. enterprise setup
15. APIs/integrations
16. developer marketplace
17. business intelligence
18. licensed financial-service referrals
19. mini-store premium features

---

# 102. COMPANY MOAT

Do NOT rely on UI alone.

UI can be copied.

APSA moat should become:

- Khmer-native UX
- Cambodian merchant workflow knowledge
- merchant network
- customer/order graph
- delivery integrations
- payment integrations
- platform data intelligence
- customer retention
- staff/workflow history
- merchant identity network
- ecosystem
- Cambodian commerce AI
- trust

---

# 103. WHAT COMPETITORS CAN COPY

Easy:

- screens
- logo style
- POS UI
- simple chat screen

Harder:

- Meta/Telegram integrations
- customer identity resolution
- reliable order workflows
- delivery partnerships
- payment partnerships
- merchant network
- transaction history
- local merchant knowledge
- trust
- ecosystem

Therefore:

Launch early.

Learn quickly.

Build network effects.

---

# 104. PRODUCT QUALITY RULE

A feature is not complete just because it functions.

Evaluate:

- simplicity
- correctness
- mobile UX
- Khmer UX
- security
- accessibility
- performance
- auditability
- testing
- error handling
- observability

---

# 105. ERROR STATES

Every major module must define:

- loading
- empty
- no results
- error
- retry
- offline
- permission denied
- success

No blank broken screens.

---

# 106. DEVELOPMENT PRIORITY LABELS

Every requirement should be classified:

## MUST NOW

Expensive/dangerous to retrofit later.

Examples:

- organization/tenant model
- customer identity model
- universal orders
- inventory ledger
- RBAC
- provider abstraction
- event architecture
- audit foundation
- localization
- currency architecture
- entitlements
- usage metering
- marketing consent
- data-access boundaries
- mobile-first/API-first architecture

## SHOULD NOW

Important for MVP/product quality.

Examples:

- social inbox
- POS
- products
- delivery record
- customer profile
- staff performance basics
- analytics
- offline UX preparation
- mini-store architecture

## LATER

Network-stage features.

Examples:

- marketplace
- Swipe
- food aggregation
- supplier marketplace
- financing
- own logistics
- advanced accounting
- AI agents

---

# 107. IMPLEMENTATION SEQUENCE

## Sprint 0 — Product/Repo Foundation

- repo setup
- environments
- design tokens
- architecture docs
- linting/formatting
- testing infrastructure
- CI
- security baseline

## Sprint 1 — Identity & Tenancy

- auth
- organization
- workspace
- location
- membership
- roles
- permissions
- tenant isolation

## Sprint 2 — Customer & Product Core

- customer
- identities
- product
- variants
- categories

## Sprint 3 — Inventory

- inventory movements
- stock calculation
- adjustment
- low stock

## Sprint 4 — Orders

- universal order
- order items
- statuses
- customer history

## Sprint 5 — POS

- cart
- checkout
- payments record
- receipt

## Sprint 6 — Inbox

- conversations
- messages
- assignment
- follow-up
- first provider integration

## Sprint 7 — APSA Magic

- conversation → customer
- conversation → order

## Sprint 8 — Delivery

- delivery entity
- tracking
- COD
- manual provider workflow

## Sprint 9 — Owner Dashboard

- sales
- orders
- basic profit
- low stock
- unread
- pending payment/delivery

## Sprint 10 — Hardening

- security tests
- tenant tests
- backups
- monitoring
- error states
- performance
- mobile QA

## Sprint 11 — Pilot

- 5 users
- fixes
- 20 users
- fixes
- 100 users

---

# 108. CLAUDE CODE RULE

Before implementing a sprint, Claude Code must:

1. Inspect current repository state.
2. Read this APSA Master Plan.
3. Identify impacted modules.
4. Avoid unrelated refactors.
5. Preserve backward compatibility where applicable.
6. Create/update tests.
7. Run relevant checks.
8. Document migration/security implications.
9. Stop if a proposed implementation conflicts with a MUST NOW architecture principle.
10. Report what changed and remaining risks.

---

# 109. CODEX REVIEW RULE

Codex should independently review high-risk work.

Especially:

- tenancy
- authentication
- RBAC
- inventory
- payments
- webhooks
- delivery
- migrations
- production incidents

Review should explicitly search for:

- regression
- security vulnerability
- inconsistent domain model
- data loss
- performance problem
- duplicated business logic

---

# 110. SECURITY RELEASE GATE

Do not launch real merchants until:

- tenant isolation tested
- authorization tested
- sensitive secrets verified
- backups enabled
- restore strategy known
- critical flows covered
- production logging enabled
- staging tested
- no known critical vulnerability
- no hidden/debug admin bypass
- no unreviewed destructive migrations

---

# 111. PRODUCT RELEASE GATE

Do not call APSA ready because pages look beautiful.

MVP must prove:

- seller can onboard
- create product
- manage stock
- receive/handle supported social interaction
- create order
- record payment
- arrange/track basic delivery
- inspect customer history
- owner can understand business status

---

# 112. APSA PRODUCT PRINCIPLES

Every future decision should follow these rules:

1. Cambodia-first, international-ready.
2. Khmer is first-class.
3. Mobile-first.
4. Consumer simplicity, business power.
5. One customer across channels.
6. One order across channels.
7. Organization owns business data.
8. Security is server-side, not cosmetic.
9. Reduce scope, never engineering standards.
10. Build integrations through provider abstractions.
11. Use official APIs only.
12. Merchant trust is a moat.
13. AI is a tool, not the database.
14. GitHub is source of truth.
15. Build foundation now, activate expensive services later.
16. Do not overengineer infrastructure.
17. Measure active merchants, not vanity downloads.
18. Founder should observe real merchants.
19. Challenge features that add complexity without meaningful merchant value.
20. APSA must grow with merchants rather than forcing them to migrate later.

---

# 113. LONG-TERM NORTH STAR

APSA succeeds when a merchant can wake up and open one application to understand:

Who messaged me?

Who needs a reply?

What did customers order?

Who paid?

What needs packing?

Where is every delivery?

What stock is running low?

Which staff are performing?

Which products sell?

Which customers should I bring back?

How is my business performing?

And when that merchant grows from:

one phone

→ one shop

→ five employees

→ multiple branches

→ warehouse

→ online store

→ marketplace

APSA continues to support them without requiring a new system.

That is the product we are building.

---

# 114. SOURCE-OF-TRUTH RULE

This document defines APSA's current approved master direction.

Claude Code, Codex, Lovable, designers, engineers, contractors, and future team members must not silently change foundational decisions.

If a better solution is identified:

1. explain the conflict;
2. explain the proposed improvement;
3. evaluate migration/security/product impact;
4. update this master plan deliberately;
5. then implement.

Architecture must evolve intentionally, not accidentally.
