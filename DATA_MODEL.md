# APSA — DATA MODEL & DATA STRATEGY

**Document:** `DATA_MODEL.md`  
**Project:** APSA  
**Status:** Source of truth for business data architecture  
**Scope:** MVP + long-term expansion  
**Primary database:** PostgreSQL / Supabase initially  
**Architecture:** Multi-tenant, normalized core, event-aware, analytics-ready

---

# 1. PURPOSE

This document defines how APSA should structure, protect, connect, and eventually derive value from its data.

APSA must not become a collection of unrelated tables.

The database should represent the real relationships between:

**merchant → staff → customer → conversation → product → order → payment → inventory → delivery → promotion → behavior → business performance**

The long-term objective is:

> Build a high-quality Cambodian commerce data network while maintaining merchant trust, privacy, security, and clear ownership boundaries.

Data will become one of APSA’s most important strategic advantages.

But the advantage must come from:

- structured data;
- historical depth;
- network participation;
- high-quality events;
- merchant adoption;
- aggregated intelligence;
- better predictions;
- integrations;
- workflow history;

not from casually exposing or exploiting private merchant/customer information.

---

# 2. DATA STRATEGY PRINCIPLE

APSA should collect data because it improves a legitimate product or operational function.

Every important data point should answer one of these questions:

1. Does this help the merchant operate?
2. Does this improve customer service?
3. Does this improve payments/delivery/order accuracy?
4. Does this improve fraud/security?
5. Does this enable future analytics or automation?
6. Does this enable a future platform product?
7. Is collection legally/ethically appropriate?

Do not collect sensitive information merely because it might be useful someday.

---

# 3. APSA DATA MOAT

The long-term data moat comes from relationships.

A competitor may know:

“Product X sold 1,000 units.”

APSA could eventually understand:

- what channel customers discovered it from;
- which messages commonly convert;
- which price points convert;
- which locations buy it;
- which customer segments repeat;
- how fast the product sells;
- which staff convert best;
- which delivery option performs best;
- which products are often purchased together;
- what stock-outs caused lost sales;
- what promotions increased repeat purchases;
- which categories are growing.

This creates much richer intelligence than basic POS data.

---

# 4. DATA LAYERS

APSA should conceptually separate data into four major layers.

## Layer 1 — Operational Data

Used to run the merchant’s business.

Examples:

- customers
- products
- stock
- orders
- payments
- deliveries
- messages
- employees

## Layer 2 — Event Data

Records what happened.

Examples:

- product viewed
- order created
- payment received
- message received
- stock adjusted
- delivery completed

## Layer 3 — Analytical Data

Derived metrics.

Examples:

- conversion rate
- repeat rate
- sales velocity
- average order value
- retention
- staff response time

## Layer 4 — Aggregated Platform Intelligence

Future APSA-level insights using properly governed aggregated/anonymized data.

Examples:

- category growth
- seasonal demand
- pricing bands
- regional purchase trends
- delivery performance benchmarks

Keep these conceptual layers distinct.

---

# 5. TENANT OWNERSHIP

Merchant operational data belongs to its organization context.

Most business records must carry:

`organization_id`

and when relevant:

`workspace_id`

`location_id`

Never infer tenancy indirectly when explicit tenant ownership can be stored safely.

---

# 6. CORE IDENTITY MODEL

Primary structure:

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

The User represents a human account.

The Organization represents a business/company.

Workspace controls product mode/context.

Location represents operating branch/shop/warehouse.

Membership determines access.

---

# 7. USER

Conceptual fields:

```text
User
id
email
phone
display_name
avatar_url
locale
timezone
status
created_at
updated_at
```

Authentication-specific secrets remain in the authentication provider.

Do not duplicate password storage.

---

# 8. ORGANIZATION

```text
Organization
id
legal_name
display_name
slug
business_type
default_currency
country
timezone
status
created_by
created_at
updated_at
```

Future:

- registration number
- tax information
- verification state
- business reputation metadata

Sensitive legal data should be stored only when needed.

---

# 9. WORKSPACE

```text
Workspace
id
organization_id
name
type
status
settings
created_at
updated_at
```

Initial types:

```text
INBOX
BUSINESS
```

Do not create separate user systems for different workspace types.

---

# 10. LOCATION

```text
Location
id
organization_id
workspace_id
name
type
phone
address_id
timezone
status
created_at
```

Possible types:

- STORE
- WAREHOUSE
- OFFICE
- ONLINE
- OTHER

---

# 11. MEMBERSHIP

```text
Membership
id
user_id
organization_id
role_id
status
joined_at
invited_by
```

Potential future:

- default workspace
- location restrictions
- schedule
- employment metadata

Do not mix HR data unnecessarily into authentication membership.

---

# 12. ROLE

```text
Role
id
organization_id nullable
name
system_role
created_at
```

System roles may include:

- OWNER
- MANAGER
- CASHIER
- SALES
- CUSTOMER_SERVICE

Custom roles later.

---

# 13. PERMISSION

```text
Permission
id
key
description
risk_level
```

Examples:

```text
orders.read
orders.create
orders.refund
inventory.adjust
payments.confirm
customers.export_sensitive
financials.profit
team.manage
roles.manage
```

---

# 14. ROLE_PERMISSION

```text
RolePermission
role_id
permission_id
```

Authorization must remain permission-driven rather than plan/role-name hardcoding.

---

# 15. CUSTOMER

Customer is one of APSA’s most important entities.

```text
Customer
id
organization_id
display_name
primary_phone
primary_email
status
first_seen_at
last_seen_at
created_at
updated_at
```

Future derived fields may include:

- first_order_at
- last_order_at
- lifetime_value
- order_count
- average_order_value
- customer_segment

Avoid making derived analytics authoritative transactional values unless carefully maintained.

---

# 16. CUSTOMER IDENTITY

One Customer may have many identities.

```text
CustomerIdentity
id
organization_id
customer_id
provider
provider_user_id
handle
display_name
identity_metadata
confidence
verified_at
created_at
```

Providers:

- FACEBOOK
- INSTAGRAM
- TELEGRAM
- TIKTOK
- PHONE
- EMAIL
- APSA_CONSUMER
- MINI_STORE

---

# 17. IDENTITY RESOLUTION

Never automatically merge people based solely on weak similarities.

Potential matching signals:

- exact verified phone
- authenticated APSA account
- verified email
- provider linkage
- merchant confirmation

Future resolution model could use:

```text
IdentityMatchCandidate
id
identity_a
identity_b
confidence_score
reason
status
reviewed_by
```

Possible statuses:

- SUGGESTED
- CONFIRMED
- REJECTED

All merges should be auditable.

---

# 18. CUSTOMER MERGE HISTORY

Future important table:

```text
CustomerMerge
id
organization_id
source_customer_id
target_customer_id
reason
merged_by
merged_at
```

Do not permanently lose the lineage.

This becomes extremely important when social identities grow.

---

# 19. CUSTOMER ADDRESS

```text
CustomerAddress
id
organization_id
customer_id
label
recipient_name
phone
country
province
district
commune
village
street_address
landmark
postal_code
latitude
longitude
is_default
created_at
updated_at
```

Cambodian address fields should be first-class.

International structure must still remain possible.

---

# 20. CUSTOMER TAG

```text
CustomerTag
id
organization_id
name
created_at
```

Join:

```text
CustomerTagAssignment
customer_id
tag_id
created_at
created_by
```

Examples:

- VIP
- Repeat
- Wholesale
- Follow Up
- High Value

---

# 21. CUSTOMER NOTE

```text
CustomerNote
id
organization_id
customer_id
author_user_id
body
visibility
created_at
updated_at
```

Future visibility:

- all authorized team
- management only

Do not place private notes in generic Customer columns.

---

# 22. CUSTOMER CONSENT

This is mandatory for future promotions.

```text
CustomerConsent
id
organization_id
customer_id
consent_type
status
source
captured_at
revoked_at
evidence_metadata
created_at
```

Consent types:

- MERCHANT_MARKETING
- APSA_PLATFORM_MARKETING
- SMS
- EMAIL
- PUSH
- TELEGRAM
- OTHER_CHANNEL

Never treat order contact details as universal marketing consent.

---

# 23. CONVERSATION

```text
Conversation
id
organization_id
workspace_id
customer_id nullable
provider
provider_conversation_id
status
assigned_user_id
priority
last_message_at
created_at
updated_at
```

Provider-specific IDs should be unique within appropriate provider/account scope.

---

# 24. CONNECTED CHANNEL ACCOUNT

Important entity:

```text
ConnectedChannel
id
organization_id
workspace_id
provider
provider_account_id
display_name
status
capabilities
connected_by
token_reference
token_expires_at
created_at
updated_at
```

Tokens/secrets should not be stored casually in normal JSON fields.

Use secure server-side secret storage/encryption patterns.

---

# 25. MESSAGE

```text
Message
id
organization_id
conversation_id
provider_message_id
direction
sender_type
sender_reference
message_type
body
sent_at
received_at
status
metadata
created_at
```

Direction:

- INBOUND
- OUTBOUND

Types:

- TEXT
- IMAGE
- VIDEO
- AUDIO
- FILE
- SYSTEM

Avoid storing unnecessary full provider payloads forever.

Keep only what APSA legitimately needs.

---

# 26. MESSAGE ATTACHMENT

```text
MessageAttachment
id
organization_id
message_id
storage_key
mime_type
size_bytes
original_name
provider_url_reference
created_at
```

Sensitive/private attachments should use protected storage.

---

# 27. CONVERSATION ASSIGNMENT HISTORY

Do not only store current assigned employee.

Also preserve history.

```text
ConversationAssignment
id
conversation_id
assigned_user_id
assigned_by
assigned_at
unassigned_at
```

This enables:

- workload analytics
- service accountability
- response attribution

---

# 28. CONVERSATION STATUS HISTORY

```text
ConversationStatusHistory
id
conversation_id
from_status
to_status
changed_by
changed_at
```

Useful for future operational analytics.

---

# 29. SAVED REPLY

```text
SavedReply
id
organization_id
title
body
language
status
created_by
created_at
```

Future analytics may track usage and conversion impact, but avoid overcomplication early.

---

# 30. PRODUCT

```text
Product
id
organization_id
workspace_id
name_km
name_en
description_km
description_en
category_id
brand_id nullable
status
created_by
created_at
updated_at
```

Potential status:

- DRAFT
- ACTIVE
- ARCHIVED

---

# 31. PRODUCT VARIANT

```text
ProductVariant
id
organization_id
product_id
sku
barcode
name
price
cost
currency
weight
status
created_at
updated_at
```

Variant options may later be normalized separately.

---

# 32. PRODUCT OPTION

Future:

```text
ProductOption
id
product_id
name
```

Example:

Color

and:

```text
ProductOptionValue
id
option_id
value
```

Example:

Black

Do not implement excessive variant complexity until needed.

---

# 33. PRODUCT CATEGORY

```text
ProductCategory
id
organization_id
parent_id nullable
name_km
name_en
status
```

Parent allows category trees later.

---

# 34. PLATFORM CATEGORY MAPPING

Future strategic entity:

```text
PlatformCategoryMapping
merchant_category_id
platform_category_id
confidence
source
```

This can help APSA understand market-wide category trends without forcing every merchant into identical naming.

Example:

Merchant categories:

“Skin Care”

“Beauty Serum”

“Face”

could map to broader APSA taxonomy:

Beauty → Skincare → Serum

This becomes important for aggregated business intelligence.

---

# 35. PRODUCT BRAND

```text
Brand
id
organization_id
name
```

Future platform-level canonical brand matching may exist separately.

Do not merge merchant-created Brand and APSA canonical brand prematurely.

---

# 36. PRODUCT IMAGE

```text
ProductImage
id
organization_id
product_id
storage_key
position
alt_text
created_at
```

---

# 37. PRODUCT CHANNEL LISTING

Future powerful entity:

```text
ProductChannelListing
id
organization_id
product_id
variant_id nullable
channel
status
channel_reference
price_override nullable
published_at
```

Channels:

- MINI_STORE
- MARKETPLACE
- SWIPE
- FACEBOOK
- INSTAGRAM
- FUTURE_CHANNEL

This avoids duplicating Product truth.

---

# 38. INVENTORY LOCATION

```text
InventoryLocation
id
organization_id
location_id
name
type
status
```

One physical branch may later have multiple inventory zones.

Do not require this complexity for small merchants in UI.

---

# 39. INVENTORY MOVEMENT

This is authoritative stock history.

```text
InventoryMovement
id
organization_id
inventory_location_id
variant_id
type
quantity_delta
reference_type
reference_id
reason_code
note
created_by
created_at
idempotency_key nullable
```

Types:

- INITIAL
- PURCHASE
- SALE
- RETURN
- DAMAGE
- ADJUSTMENT
- TRANSFER_IN
- TRANSFER_OUT
- RESERVATION
- RESERVATION_RELEASE

---

# 40. INVENTORY BALANCE

For performance, maintain a balance/cache table if necessary.

```text
InventoryBalance
organization_id
inventory_location_id
variant_id
on_hand
reserved
available
updated_at
```

Important:

Movement history remains authoritative.

Balance is optimized state.

---

# 41. INVENTORY RESERVATION

```text
InventoryReservation
id
organization_id
variant_id
location_id
order_id
quantity
status
expires_at
created_at
released_at
```

Statuses:

- ACTIVE
- CONSUMED
- RELEASED
- EXPIRED

This will become useful for:

- social orders
- mini-store
- marketplace
- Swipe Deals

---

# 42. SUPPLIER — PREPARE

Not MVP priority.

Future:

```text
Supplier
id
organization_id
name
phone
email
address
status
```

---

# 43. PURCHASE ORDER — FUTURE

```text
PurchaseOrder
id
organization_id
supplier_id
location_id
status
currency
subtotal
total
created_at
```

PurchaseOrderItems reference variants.

This later improves true cost/inventory analysis.

---

# 44. ORDER

Central commerce entity.

```text
Order
id
organization_id
workspace_id
location_id
customer_id nullable
conversation_id nullable
source
status
currency
subtotal
discount_total
delivery_total
tax_total
grand_total
created_by
placed_at
created_at
updated_at
```

Possible sources:

- POS
- FACEBOOK
- INSTAGRAM
- TELEGRAM
- TIKTOK
- MINI_STORE
- MARKETPLACE
- SWIPE
- API
- MANUAL
- FUTURE_FOOD_CHANNEL

---

# 45. ORDER NUMBER

Use human-friendly business order identifiers in addition to UUIDs.

Example:

`APSA-2026-000123`

Do not use human-readable order number as primary database security identifier.

---

# 46. ORDER ITEM

```text
OrderItem
id
organization_id
order_id
product_id nullable
variant_id nullable
product_name_snapshot
variant_name_snapshot
sku_snapshot
quantity
unit_price
unit_cost
discount_total
line_total
created_at
```

Snapshot preserves historical truth.

---

# 47. ORDER STATUS HISTORY

```text
OrderStatusHistory
id
organization_id
order_id
from_status
to_status
changed_by
reason
changed_at
```

Never silently rewrite order history.

---

# 48. ORDER SOURCE ATTRIBUTION

Future important model:

```text
OrderAttribution
order_id
first_touch_channel
last_touch_channel
conversation_id
campaign_id nullable
promotion_id nullable
referrer
metadata
```

This enables future questions like:

- Which channel creates most orders?
- Which campaign generated revenue?
- Which social source has best conversion?

---

# 49. CART — FUTURE

For mini-store/marketplace:

```text
Cart
id
customer/consumer_reference
organization_id
status
created_at
```

Do not confuse Cart with completed Order.

---

# 50. PAYMENT

```text
Payment
id
organization_id
order_id
provider
method
currency
amount
status
reference
confirmed_by
paid_at
created_at
updated_at
```

---

# 51. PAYMENT ATTEMPT

Future official integrations:

```text
PaymentAttempt
id
payment_id
provider
provider_attempt_id
status
amount
requested_at
completed_at
error_code
```

This allows failed/successful attempts without corrupting Payment truth.

---

# 52. PAYMENT PROVIDER EVENT

```text
PaymentProviderEvent
id
provider
provider_event_id
event_type
received_at
processed_at
status
payload_hash
```

Use for:

- idempotency
- troubleshooting
- audit

Do not permanently store full sensitive webhook payload unless needed.

---

# 53. REFUND

```text
Refund
id
organization_id
payment_id
order_id
amount
reason
status
provider_reference
requested_by
approved_by nullable
created_at
completed_at
```

Refund should not be represented by simply changing payment amount.

---

# 54. DELIVERY

```text
Delivery
id
organization_id
order_id
provider
provider_delivery_id
tracking_number
customer_address_id
currency
provider_cost
merchant_price
cod_amount
status
requested_at
picked_up_at
delivered_at
failure_reason
created_at
updated_at
```

---

# 55. DELIVERY STATUS HISTORY

```text
DeliveryStatusHistory
id
organization_id
delivery_id
from_status
to_status
provider_event_reference
changed_at
```

Useful for delivery performance benchmarking later.

---

# 56. DELIVERY PROVIDER EVENT

```text
DeliveryProviderEvent
id
provider
provider_event_id
event_type
delivery_id
received_at
processed_at
status
```

Again:

Provider event ID enables deduplication.

---

# 57. COD SETTLEMENT — FUTURE

```text
CODSettlement
id
organization_id
delivery_id
courier_id
cod_amount
expected_settlement_at
settled_amount
settled_at
status
reference
```

Do not implement until real courier data/business workflow exists.

---

# 58. COURIER PROVIDER

Future platform metadata:

```text
DeliveryProviderConfiguration
id
provider
organization_scope
status
capabilities
configuration_reference
```

Do not expose API credentials in normal DB fields.

---

# 59. EVENT

APSA should create structured business events.

```text
Event
id
organization_id
event_type
aggregate_type
aggregate_id
actor_type
actor_id
metadata
occurred_at
created_at
```

Examples:

- MESSAGE_RECEIVED
- CUSTOMER_CREATED
- ORDER_CREATED
- PAYMENT_PAID
- INVENTORY_CHANGED
- DELIVERY_DELIVERED

Events are extremely important for future automation and analytics.

---

# 60. EVENT SCHEMA DISCIPLINE

Do not store random unversioned JSON forever.

Event payloads should have defined contracts.

Future:

```text
event_version
```

Example:

```text
order.created.v1
```

This matters when APSA grows.

---

# 61. AUDIT LOG

```text
AuditLog
id
organization_id
actor_user_id
action
resource_type
resource_id
before_json
after_json
reason
created_at
```

High-value audit areas:

- permissions
- refunds
- payment overrides
- inventory adjustments
- price changes
- data exports
- account access

Audit ≠ analytics event.

---

# 62. ACTIVITY TIMELINE

Instead of manually querying many tables for customer history, APSA can eventually maintain unified activity representation.

Concept:

```text
Activity
id
organization_id
subject_type
subject_id
type
related_resource_type
related_resource_id
occurred_at
metadata
```

Examples:

Customer:

- MESSAGE
- ORDER
- PAYMENT
- DELIVERY

This can power fast Customer 360 timelines.

Do not duplicate transactional truth.

Activity acts as presentation/read model.

---

# 63. FEATURE FLAG

```text
FeatureFlag
id
key
description
default_state
created_at
```

Assignments:

```text
FeatureFlagAssignment
flag_id
organization_id nullable
workspace_id nullable
enabled
```

---

# 64. PLAN

```text
Plan
id
code
name
status
```

Do not hard-code feature behavior based on plan name.

---

# 65. ENTITLEMENT

```text
Entitlement
id
key
type
description
```

Examples:

- SOCIAL_CHANNEL_LIMIT
- STAFF_LIMIT
- ADVANCED_ANALYTICS
- AUTOMATION_LIMIT

---

# 66. PLAN ENTITLEMENT

```text
PlanEntitlement
plan_id
entitlement_id
value
```

---

# 67. SUBSCRIPTION

```text
Subscription
id
organization_id
plan_id
status
starts_at
renews_at
ends_at
provider_reference
```

---

# 68. USAGE RECORD

```text
UsageRecord
id
organization_id
metric
quantity
period_start
period_end
recorded_at
```

Metrics:

- users
- channels
- messages
- orders
- AI tokens
- storage
- API calls

Do not build pricing assumptions into raw usage structure.

---

# 69. CAMPAIGN — FUTURE

```text
Campaign
id
organization_id
name
channel
status
segment_id
content_reference
scheduled_at
sent_at
created_by
```

---

# 70. SEGMENT — FUTURE

```text
CustomerSegment
id
organization_id
name
definition
created_at
```

Example definitions:

- no order in 60 days
- spent > $100
- bought category Beauty
- 3+ orders

Store segment rules in a controlled schema, not unsafe executable code.

---

# 71. CAMPAIGN RECIPIENT

```text
CampaignRecipient
id
campaign_id
customer_id
consent_validated
status
sent_at
delivered_at
converted_at
```

Important:

Consent validation should happen before sending.

---

# 72. PROMOTION

```text
Promotion
id
organization_id
name
type
value
start_at
end_at
status
conditions
```

Possible types:

- PERCENTAGE
- FIXED_AMOUNT
- BUNDLE
- CLEARANCE

---

# 73. PROMOTION REDEMPTION

```text
PromotionRedemption
id
promotion_id
customer_id
order_id
discount_amount
redeemed_at
```

This enables real promotion ROI.

---

# 74. EMPLOYEE PERFORMANCE DATA

Do not create one simplistic “employee score.”

Record objective events.

Possible derived metrics:

- conversations handled
- response time
- orders created
- conversion
- refunds
- complaints
- inventory adjustments

Source these metrics from operational data/events.

Do not duplicate unverifiable numbers manually.

---

# 75. STAFF ACTIVITY

Future read/analytics table:

```text
StaffActivity
organization_id
user_id
activity_type
resource_type
resource_id
occurred_at
```

Use only if needed for analytics performance.

Do not create surveillance-grade tracking of irrelevant behavior.

---

# 76. STORE PUBLIC PROFILE

```text
MerchantPublicProfile
id
organization_id
slug
display_name
description
logo
cover
status
published_at
```

Only explicitly public information belongs here.

---

# 77. PUBLIC STORE SETTINGS

```text
StorefrontSettings
organization_id
theme
currency
show_stock_status
contact_options
status
```

Do not leak private stock counts unless merchant intentionally enables them.

---

# 78. FUTURE APSA CONSUMER

```text
Consumer
id
user_id
status
created_at
```

One consumer may interact with many merchants.

Important:

Merchant Customer is merchant-scoped.

Consumer is APSA network identity.

Do not merge these concepts carelessly.

---

# 79. CUSTOMER ↔ CONSUMER LINK

Future:

```text
CustomerConsumerLink
organization_id
customer_id
consumer_id
verification_method
linked_at
```

This preserves merchant-scoped CRM while supporting network identity.

---

# 80. CONSUMER ADDRESS

Consumer-controlled saved address may later exist separately from merchant customer addresses.

This gives the consumer control over shared network information.

---

# 81. FAVORITES / SAVES — FUTURE

```text
ConsumerSavedProduct
consumer_id
product_id
saved_at
```

This becomes useful for:

- demand prediction
- recommendations
- merchant insights

Use responsibly and with clear consumer expectations.

---

# 82. PRODUCT VIEW — FUTURE

```text
ProductViewEvent
consumer/session
product_id
merchant_id
source
occurred_at
```

Do not store every UI interaction forever without retention strategy.

At scale, behavioral analytics belongs in an event/analytics system, not necessarily OLTP tables.

---

# 83. SEARCH EVENT — FUTURE

```text
SearchEvent
search_term
category
filters
result_count
consumer/session
occurred_at
```

Aggregated searches could become highly valuable demand intelligence.

Example:

Many Cambodian users search:

“portable mini fan”

but merchant supply is low.

APSA could later identify opportunity gaps.

---

# 84. DEMAND SIGNALS

Future demand model may combine:

- searches
- saves
- product views
- messages
- orders
- abandoned carts
- stock-outs

This provides stronger demand prediction than sales alone.

---

# 85. LOST SALE SIGNAL

Future:

```text
LostSaleSignal
organization_id
customer_id nullable
product/category
reason
source
occurred_at
```

Possible reasons:

- OUT_OF_STOCK
- PRICE
- NO_REPLY
- DELIVERY_TOO_SLOW
- PRODUCT_UNAVAILABLE

This data could become extremely useful.

Do not require merchants to enter complex forms.

Capture automatically where possible.

---

# 86. STOCK-OUT EVENT

```text
StockoutEvent
organization_id
variant_id
location_id
started_at
ended_at
estimated_demand_lost
```

Future analytics could show merchants:

“You were out of stock for 4 days and demand remained high.”

---

# 87. PRICE HISTORY

Future useful entity:

```text
ProductPriceHistory
organization_id
variant_id
old_price
new_price
changed_by
changed_at
```

Benefits:

- audit
- sales analysis
- promotion analysis
- pricing intelligence

---

# 88. COST HISTORY

```text
ProductCostHistory
organization_id
variant_id
old_cost
new_cost
source
changed_at
```

Important for accurate historical gross-profit calculations.

---

# 89. PRODUCT PERFORMANCE

Do not make this the source of truth.

Derived analytics may include:

```text
ProductDailyMetric
date
organization_id
variant_id
views
messages
orders
units_sold
revenue
gross_profit
refunds
```

Can later move into analytical storage.

---

# 90. CUSTOMER DAILY METRIC

Future analytical model:

- orders
- spend
- interaction count
- last activity
- channel behavior

Do not calculate massive CRM segments synchronously from raw tables forever.

---

# 91. MERCHANT DAILY METRIC

Useful materialized analytics:

```text
MerchantDailyMetric
organization_id
date
orders
revenue
gross_profit
messages
new_customers
repeat_customers
refunds
delivery_success
```

This can power fast dashboard queries.

---

# 92. CHANNEL PERFORMANCE

Derived:

```text
ChannelDailyMetric
organization_id
channel
date
messages
orders
revenue
conversion
response_time
```

This allows merchant to understand:

Facebook vs Instagram vs Telegram performance.

---

# 93. DELIVERY PERFORMANCE

Future platform intelligence may measure:

- success rate
- average delivery time
- failed deliveries
- COD settlement speed
- region
- parcel type

This could help APSA rank delivery options intelligently.

Never manipulate rankings unfairly without disclosure.

---

# 94. PAYMENT PERFORMANCE

Future aggregated analytics:

- payment-method usage
- failure rate
- confirmation time
- refund rate

This may help APSA negotiate partnerships.

---

# 95. MARKET INTELLIGENCE LAYER

Long-term APSA intelligence can potentially answer:

- What categories are growing?
- What price ranges convert?
- Which provinces show demand growth?
- What items are often purchased together?
- Which products receive searches but limited supply?
- Which merchant segments grow fastest?
- Which delivery providers perform best by area?
- Which customer cohorts retain best?

This should be built using governed aggregated/anonymized data.

---

# 96. CANONICAL PRODUCT INTELLIGENCE — FUTURE

Merchants may upload the same real-world product differently.

Example:

“iPhone 17 Pro Max 256GB”

“iPhone17 PM 256”

“Apple 17 Pro Max”

Future APSA intelligence may map these to a canonical entity:

```text
CanonicalProduct
id
brand
model
attributes
category
```

Then:

```text
MerchantProductCanonicalLink
product_id
canonical_product_id
confidence
source
```

This could become extremely powerful for market intelligence.

Do NOT force canonical matching during MVP.

---

# 97. CANONICAL CATEGORY TAXONOMY

APSA should eventually maintain platform taxonomy independent of merchant categories.

Example:

```text
Beauty
├── Skincare
│   ├── Cleanser
│   ├── Serum
│   └── Moisturizer
```

Merchant can still call their category:

“Face Care.”

Mapping creates standardized analytics.

---

# 98. BUSINESS TYPE TAXONOMY

Future:

```text
PlatformBusinessCategory
```

Examples:

- Beauty retailer
- Fashion
- Electronics
- Restaurant
- Pharmacy
- Home goods

This enables benchmark analytics by similar business type.

---

# 99. MERCHANT BENCHMARKING — FUTURE

Could eventually show:

“Your repeat purchase rate is above similar beauty merchants.”

Use only properly aggregated groups.

Never expose:

“Merchant X has revenue $100,000.”

Benchmark privacy thresholds must exist.

---

# 100. ANONYMIZATION / AGGREGATION

Platform-level analytics should avoid exposing identifiable merchant/customer information where individual identification is unnecessary.

Possible controls:

- minimum cohort size
- remove direct identifiers
- pseudonymization
- geographic aggregation
- time aggregation

Do not claim data is anonymous if re-identification remains easy.

---

# 101. RAW DATA VS DERIVED DATA

Distinguish:

Raw:

```text
Order
Payment
Message
InventoryMovement
```

Derived:

```text
CustomerLifetimeValue
ChannelConversionRate
ProductVelocity
```

Raw records are the foundational truth.

Derived metrics can be recalculated.

Never overwrite raw history merely to change an analytical definition.

---

# 102. IMMUTABILITY

Important records should be immutable or append-oriented where practical.

Especially:

- audit log
- payment provider events
- inventory movement
- important status history

Corrections should create compensating records rather than erasing history.

---

# 103. SOFT DELETE

Use archive/soft-delete for operational entities where appropriate:

- product
- customer
- user membership

Do not hard-delete linked financial history casually.

---

# 104. DATA RETENTION

Define retention by data class.

Potential categories:

- auth logs
- application logs
- messages
- attachments
- analytics events
- audit logs
- financial records

Retention should follow:

- product need
- security need
- storage economics
- applicable legal requirements

Do not retain unlimited high-volume behavioral data by default.

---

# 105. DATA EXPORT

Merchant should eventually export legitimate business data.

Examples:

- customers
- orders
- products
- inventory
- sales

Sensitive exports require:

- permission
- audit
- potential re-authentication
- secure temporary link

---

# 106. DATA PORTABILITY

Avoid making merchant data impossible to move.

Trust can increase if merchants know their legitimate operational data is exportable.

Do not use data lock-in as APSA's main moat.

The moat should be value, integrations, history, intelligence, and network.

---

# 107. DATA QUALITY

Bad data destroys analytics.

Implement:

- validation
- required fields only when truly necessary
- normalized statuses
- standardized currency
- reliable timestamps
- unique provider IDs
- deduplication
- foreign-key constraints

Do not accept arbitrary strings where controlled enums/entities are more appropriate.

---

# 108. TIMESTAMPS

Store timestamps consistently.

Prefer UTC internally.

Display using merchant/user timezone.

Important records should include:

- created_at
- updated_at

and domain-specific times:

- paid_at
- delivered_at
- sent_at

Do not infer business event time solely from row creation time.

---

# 109. ID STRATEGY

Use globally unique primary IDs such as UUID/ULID as approved by implementation.

Human-visible identifiers remain separate.

Benefits:

- distributed future systems
- safer external references
- less predictable IDs

Tenant authorization is still required.

Unpredictable IDs are not security by themselves.

---

# 110. FOREIGN KEYS

Use database foreign keys for core relational integrity where practical.

Examples:

OrderItem → Order

Payment → Order

Delivery → Order

CustomerIdentity → Customer

Do not rely exclusively on application code for core referential integrity.

---

# 111. UNIQUE CONSTRAINTS

Examples:

Provider message ID should not duplicate within provider scope.

SKU rules may be unique within merchant/organization where appropriate.

Entitlement keys unique.

Order public number unique in appropriate scope.

Use database constraints to prevent impossible data states.

---

# 112. CHECK CONSTRAINTS

Use safe constraints when useful.

Examples:

- quantity > 0 for order lines
- money values not nonsensical
- valid enum status
- refund amount ≤ valid payment total according to business logic

Not every complex business rule belongs in DB constraints.

---

# 113. JSON USAGE

Use JSON/JSONB for:

- provider metadata
- flexible external payload references
- settings with evolving shape

Do NOT turn the entire database into JSON.

Core searchable/business-critical properties belong in typed columns/tables.

---

# 114. PROVIDER PAYLOADS

Do not indefinitely store full raw external payloads unless justified.

Potential approach:

- store normalized APSA fields;
- preserve minimal provider metadata;
- temporarily retain raw event payload for debugging if required;
- apply retention.

This reduces privacy/security/storage risks.

---

# 115. DATA ENCRYPTION

Use provider/platform encryption in transit and at rest.

Highly sensitive fields may later require application-level encryption depending on risk/regulation.

Never invent custom cryptography.

Use proven standards/libraries.

---

# 116. DATA MASKING

Internal APSA tools may display masked information where full value is unnecessary.

Example:

`+855 12 *** 123`

Support agents may not need full phone visibility for every task.

---

# 117. INTERNAL DATA ACCESS LOGGING

Sensitive internal actions should eventually generate:

```text
InternalDataAccessLog
actor
resource
reason
timestamp
```

Especially:

- customer data lookup
- merchant financial access
- large data exports

This helps build trust and internal security.

---

# 118. ANALYTICS DATABASE EVOLUTION

Do NOT create a large warehouse during MVP.

Stage 1:

PostgreSQL + indexes/materialized views.

Stage 2:

background aggregation.

Stage 3:

analytics warehouse when volume/complexity justifies it.

Potential later architecture:

```text
Operational PostgreSQL
↓
CDC / Event Pipeline
↓
Analytics Warehouse
↓
BI / ML
```

Only introduce when real bottlenecks exist.

---

# 119. EVENT PIPELINE EVOLUTION

MVP:

application events + database event/outbox pattern where needed.

Later:

workers/queues.

Much later:

dedicated streaming/event infrastructure if usage requires it.

Do not build Kafka because it sounds scalable.

---

# 120. DATA FOR AI

APSA’s structured data enables future AI.

Possible AI questions:

- “Which products are declining?”
- “Which customers should I follow up with?”
- “Why was yesterday slower?”
- “Which stock should I reorder?”
- “Summarize this customer.”
- “Which staff needs support?”
- “What promotion should I test?”

AI should query/retrieve authorized structured data.

Do not send entire databases to AI providers.

---

# 121. AI FEATURE DATA ACCESS

Recommended architecture:

```text
User request
↓
Authorization
↓
Data retrieval service
↓
Minimized structured context
↓
AI provider
↓
Validated output
↓
User
```

Never:

```text
Browser
↓
AI
↓
Raw database unrestricted
```

---

# 122. AI FEEDBACK DATA — FUTURE

Future:

```text
AIFeedback
organization_id
feature
model
response_id
rating
correction
created_at
```

This can improve APSA AI quality.

Do not collect private conversation corrections for unrelated training without proper policy/consent.

---

# 123. RECOMMENDATION SYSTEM — FUTURE

Potential signals:

- purchases
- saves
- views
- category affinity
- price range
- repeat behavior

Consumer recommendations must not become manipulative.

Allow relevant controls/preferences later.

---

# 124. CLEARANCE INTELLIGENCE

For Swipe Deals future, data can identify:

- aging inventory
- low velocity
- excessive stock
- upcoming expiration where applicable
- seasonal products

APSA could recommend:

“Consider 15% clearance.”

Merchant chooses whether to publish.

Do not automatically discount merchant inventory without authorization.

---

# 125. REORDER INTELLIGENCE

Future model:

Inputs:

- current stock
- daily velocity
- supplier lead time
- seasonality
- expected demand

Output:

- reorder date
- recommended quantity

This becomes especially valuable once APSA has historical data.

---

# 126. CUSTOMER RETENTION INTELLIGENCE

Possible future signal:

Customer normally purchases every 30 days.

It has now been 47 days.

APSA can suggest:

“Customer may be due for follow-up.”

Use consent-aware communication.

---

# 127. CHURN RISK

Future merchant-level AI could detect:

- decline in orders
- declining conversation response
- stock-outs
- fewer active staff
- reduced usage

This helps APSA customer success identify merchants who need help.

Do not use sensitive data unfairly.

---

# 128. FRAUD INTELLIGENCE

Future fraud signals:

- unusual refunds
- extreme discounting
- repeated stock adjustment
- unusual payment overrides
- abnormal exports
- suspicious logins

Begin with alerts, not automatic accusations.

---

# 129. MARKET OPPORTUNITY INTELLIGENCE

Long term, APSA may detect:

High search demand

+

few merchants supplying product

+

frequent out-of-stock

= possible supply opportunity.

This could support:

- merchants
- suppliers
- group purchasing

This is one of the most strategic future uses of aggregated platform data.

---

# 130. SUPPLIER INTELLIGENCE

Future supplier network can benefit from:

- aggregate demand
- category growth
- regional needs
- reorder cycles

Do not reveal individual merchant purchasing plans to suppliers without authorization.

---

# 131. DELIVERY INTELLIGENCE

APSA may eventually recommend couriers based on:

- destination
- price
- delivery time
- failure rate
- COD settlement performance

Example:

“Courier B performs better for this district.”

This makes APSA more valuable than simply listing courier logos.

---

# 132. PAYMENT INTELLIGENCE

Future recommendation:

“KHQR has highest completion rate for this business.”

or:

“COD failure is high for this area.”

This requires reliable data and careful interpretation.

---

# 133. MERCHANT REPUTATION LAYER — FUTURE

Possible signals:

- delivery success
- cancellation rate
- response rate
- refund handling
- consumer reviews
- verified identity

Use carefully.

Never create opaque reputation scores that unfairly damage merchants.

Provide clear criteria and correction mechanisms.

---

# 134. DATA NETWORK EFFECT

APSA’s network effect should work like this:

More merchants

↓

more structured commerce activity

↓

better integrations and aggregate intelligence

↓

better recommendations and operational tools

↓

higher merchant value

↓

more merchants

The data network effect must remain compatible with privacy and trust.

---

# 135. DATA SHOULD IMPROVE THE PRODUCT

Every major dataset should feed back into merchant value.

Example:

Collecting delivery history should improve:

- tracking
- provider recommendation
- ETA estimation
- failed-delivery reduction

Collecting product history should improve:

- stock planning
- trends
- profit insights
- promotions

Data collection without product benefit should be challenged.

---

# 136. MVP DATA PRIORITY

## MUST NOW

Implement correctly:

- User
- Organization
- Workspace
- Location
- Membership
- Role
- Permission
- Customer
- CustomerIdentity
- CustomerAddress
- CustomerConsent
- Conversation
- Message
- Product
- ProductVariant
- ProductCategory
- InventoryMovement
- InventoryBalance
- InventoryReservation
- Order
- OrderItem
- OrderStatusHistory
- Payment
- Refund foundation
- Delivery
- DeliveryStatusHistory
- Event
- AuditLog
- Subscription foundation
- Entitlement foundation
- UsageRecord
- FeatureFlag

## SHOULD NOW / EARLY BETA

- Customer tags
- Customer notes
- assignment history
- public merchant profile
- product channel listing
- staff analytics read models
- daily merchant metrics

## LATER

- platform taxonomy
- canonical products
- consumer identity network
- campaigns
- marketplace
- behavioral event warehouse
- supplier network
- recommendation engine
- benchmarking
- fraud models
- demand prediction
- AI intelligence
- advanced analytics warehouse

---

# 137. DATABASE MIGRATION RULE

Claude Code must never create random schema changes outside versioned migrations.

Every migration must specify:

- purpose
- tables impacted
- indexes
- constraints
- tenant ownership
- RLS implications
- rollback/forward-fix strategy
- expected data migration

High-risk migrations require staging validation.

---

# 138. RLS DATA REQUIREMENT

Every table must be classified:

1. tenant-private
2. user-private
3. platform-internal
4. intentionally public
5. shared reference data

Do not create RLS policies without first deciding the table classification.

---

# 139. TABLE CLASSIFICATION EXAMPLES

## Tenant-private

- customers
- orders
- messages
- products
- inventory
- payments
- deliveries

## User-private

- personal preferences
- sessions

## Platform-internal

- system provider configuration
- internal audit/security records

## Public

- intentionally published merchant profile
- intentionally published products

## Shared reference

- country/province taxonomy
- permission keys
- platform category taxonomy later

---

# 140. PUBLIC DATA SEPARATION

Never expose operational Product rows directly as public API responses without filtering.

Use public projection/DTO.

Public product may expose:

- name
- image
- selling price
- availability indicator

Never expose:

- cost
- supplier
- internal SKU if merchant considers private
- exact hidden stock
- sales velocity
- merchant notes

---

# 141. PII MINIMIZATION

For platform analytics, remove direct identifiers whenever not needed.

Examples:

Analytics generally does not need:

- full customer name
- phone
- exact street address

Use:

- customer internal ID
- region
- category
- cohort

where possible.

---

# 142. GEOGRAPHIC DATA

Cambodia-first geographic structure can become valuable.

Potential reference tables:

```text
Country
Province
District
Commune
Village
```

Benefits:

- delivery
- regional demand
- location normalization
- search
- merchant analytics

Use official/reliable geographic reference data.

---

# 143. ADDRESS NORMALIZATION

Free-text address should remain available because local addresses vary.

But normalized administrative areas allow analytics and delivery matching.

Store both:

structured geographic IDs

+

human-readable address.

---

# 144. PHONE NORMALIZATION

Store phone in normalized international format when possible.

Example concept:

E.164.

Keep display formatting separate.

Do not deduplicate customers solely based on unverified phone without policy.

---

# 145. SEARCH ARCHITECTURE

Start with PostgreSQL search/indexing.

As product grows, search may include:

- customer
- phone
- product
- SKU
- order ID
- conversation

Only introduce dedicated search engine when measured need exists.

---

# 146. DUPLICATION PREVENTION

Use reasonable unique/index constraints.

Examples:

- provider message ID
- provider conversation ID
- order public number
- SKU within organization if business rule requires

But do not create over-strict uniqueness that blocks real merchant workflows.

---

# 147. DATA RECONCILIATION

Critical systems need reconciliation.

Examples:

Inventory:

movement total ↔ balance

Payments:

provider paid events ↔ Payment

Delivery:

provider tracking ↔ Delivery state

Future scheduled reconciliation jobs should identify inconsistencies.

---

# 148. DATA CORRECTION

Do not delete history to fix errors.

Example:

Inventory wrong by -5.

Create:

ADJUSTMENT +5

with reason.

Payment mistaken as paid.

Create controlled correction/status history.

Preserve traceability.

---

# 149. ANALYTICS DEFINITION GOVERNANCE

Metrics need clear definitions.

Example:

“Conversion Rate” could mean:

orders / conversations

or:

buyers / unique customers

Define formulas centrally.

Do not let every dashboard calculate metrics differently.

Future file could be:

`METRICS_DICTIONARY.md`

---

# 150. DATA VERSIONING

If important schema/payload definitions evolve, version them.

Especially:

- events
- public APIs
- AI structured outputs
- integration payloads

Do not make integrations depend on undocumented shapes.

---

# 151. DATA OBSERVABILITY — FUTURE

Monitor:

- unexpected null rates
- duplicate provider records
- broken foreign keys
- inventory inconsistencies
- failed event processing
- unusual data growth

Bad data should be detected before it damages analytics.

---

# 152. DATA BACKUP

Data strategy includes recoverability.

Require:

- database backups
- restore testing
- storage backup strategy
- migration safety
- incident plan

The data moat has no value if the company can lose it.

---

# 153. DATA SECURITY

All rules in `SECURITY.md` apply.

Especially:

- tenant isolation
- RBAC
- sensitive exports
- secrets
- audit
- internal access
- backups
- production controls

Data value makes APSA a more attractive attack target as it grows.

Security investment should increase with data value.

---

# 154. DATA ETHICS

APSA should not secretly use merchant private data to directly compete against merchants.

Do not build:

- private merchant sales spying dashboard
- internal tool to identify a specific merchant’s best product for copying
- unauthorized customer contact harvesting

Platform intelligence should support ecosystem value, not undermine trust.

---

# 155. DATA COMMERCIALIZATION

Potential legitimate future monetization:

- premium analytics for merchants
- anonymized category reports
- supplier market-intelligence products
- demand forecasting
- benchmark subscriptions
- API access
- fraud/risk tooling
- delivery intelligence
- promotional optimization

Any external commercial data product should undergo:

- privacy review
- aggregation review
- contract review
- legal review

Do not sell raw customer lists or private merchant data.

---

# 156. DATA PRODUCT EXAMPLE — MERCHANT

Future merchant insight:

“Your black size M sells 2.4× faster than other variants and may run out in 4 days.”

This creates direct merchant value.

---

# 157. DATA PRODUCT EXAMPLE — CATEGORY TREND

Future APSA intelligence:

“Skincare serum demand increased across participating merchants during the last 8 weeks.”

This uses aggregate data rather than exposing specific shops.

---

# 158. DATA PRODUCT EXAMPLE — DELIVERY

“Courier A is cheaper, but Courier B currently has a higher successful-delivery rate in this area.”

That turns delivery data into a product advantage.

---

# 159. DATA PRODUCT EXAMPLE — CUSTOMER RETENTION

“218 customers who previously purchased this category have not returned in 60+ days.”

Then:

Create Segment

subject to marketing consent.

---

# 160. DATA PRODUCT EXAMPLE — INVENTORY

“12 products represent 71% of your revenue but 4 are close to stock-out.”

This transforms raw inventory/orders into operational intelligence.

---

# 161. DATA PRODUCT EXAMPLE — STAFF

“Response time improved 24% this week and follow-up orders increased.”

Use contextual, constructive analytics rather than surveillance scoring.

---

# 162. APSA DATA FLYWHEEL

Long-term:

```text
Messages
↓
Customer Identity
↓
Orders
↓
Products
↓
Payments
↓
Inventory
↓
Delivery
↓
Retention
↓
Aggregated Intelligence
↓
Better Merchant Decisions
↓
More Merchant Usage
↓
Better Data
```

This is one of APSA’s strongest long-term strategic flywheels.

---

# 163. CLAUDE CODE DATA RULES

Before creating or changing schema, Claude Code must read:

- `APSA_MASTER_PLAN.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `MVP_ROADMAP.md`
- `DATA_MODEL.md`

For every table Claude proposes, it must determine:

1. Who owns this data?
2. Is it tenant-private?
3. Does it need `organization_id`?
4. Does it require workspace/location?
5. What are its foreign keys?
6. What constraints protect integrity?
7. What indexes support expected queries?
8. What RLS/security policy is needed?
9. Does it need audit history?
10. Does it need an event?
11. Does it contain PII?
12. Does it require retention rules?
13. Is it raw truth or derived analytics?
14. Could it become expensive at scale?
15. Is this table truly necessary now?

---

# 164. CLAUDE MIGRATION OUTPUT REQUIREMENT

For every schema sprint, Claude should report:

- tables created
- columns
- enums
- constraints
- indexes
- RLS
- migrations
- seed/reference data
- tests
- security impact
- future compatibility

Do not accept unexplained generated SQL.

---

# 165. CODEX DATA REVIEW

Codex should independently inspect major schema work for:

- broken tenant isolation
- missing foreign keys
- duplicate data models
- unsafe nullable relationships
- bad financial types
- missing indexes
- dangerous cascade deletes
- RLS errors
- inventory integrity
- event duplication
- PII exposure

---

# 166. DATA MODEL ANTI-PATTERNS — FORBIDDEN

Do NOT:

- create FacebookCustomer / InstagramCustomer as separate customer truth
- create POSOrder / InstagramOrder / MarketplaceOrder as separate order systems
- store only current stock with no movement history
- use float for money
- put provider secrets in generic metadata
- store entire external API payloads forever without reason
- put all fields in JSON
- duplicate products for each channel
- let analytics tables become transactional truth
- hard-delete financial history casually
- make customer phone lists unrestricted
- use raw private merchant data as a competitive spying tool
- let AI query the entire database without authorization
- build an analytics warehouse before scale requires it

---

# 167. DATA MODEL DEFINITION OF SUCCESS

APSA’s data architecture is successful if:

- one customer can exist across many channels;
- every order uses one commerce model;
- stock history can always be reconstructed;
- payment history remains trustworthy;
- delivery performance can be measured;
- customer history can be understood;
- staff actions remain attributable;
- products can later appear in multiple channels;
- public mini-store does not duplicate merchant catalog;
- marketplace reuses existing data;
- consumer identity can be layered in later;
- analytics can evolve without corrupting operational data;
- AI can use structured information safely;
- data remains secure between merchants;
- aggregated intelligence becomes more valuable as APSA grows;
- APSA can create powerful business intelligence without destroying merchant trust.

---

# 168. FINAL DATA PRINCIPLE

APSA should not become powerful because it owns the largest pile of data.

It should become powerful because it has:

**the cleanest relationships, deepest history, strongest merchant network, most useful commerce events, and the ability to turn that information into better decisions for merchants and customers.**

That is the data advantage APSA should build.
