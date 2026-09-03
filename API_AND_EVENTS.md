# APSA — API & EVENTS STANDARD

**Document:** `API_AND_EVENTS.md`  
**Project:** APSA  
**Status:** Source of truth for API contracts, provider integration boundaries, internal events, webhooks, idempotency, retries, and future native-app compatibility  
**Architecture:** API-first modular monolith with event-aware internal design  
**Initial clients:** Web/PWA  
**Future clients:** Native iOS/Android, merchant mini-store, marketplace, partner APIs, automation, AI services

---

# 1. PURPOSE

This document defines how APSA components communicate.

The goal is to prevent APSA from becoming tightly coupled as features expand.

APSA must support:

- Web/PWA today
- Native mobile later
- Social providers
- Payment providers
- Courier providers
- Public storefronts
- Marketplace
- Automation
- AI
- Future partner APIs

without rebuilding core business logic.

This document defines the stable rules now.

Detailed endpoint catalogs should evolve feature-by-feature.

---

# 2. CORE PRINCIPLE

APSA follows:

> **Stable domain contracts now. Expand implementation details later.**

Do not design hundreds of unused future endpoints.

Do not build features directly against random database tables either.

The approved path is:

```text
Client
↓
Application/API Layer
↓
Domain Service
↓
Repository / Provider
↓
Database or External System
```

---

# 3. CLIENTS

Initial:

```text
Web / PWA
```

Future:

```text
Native iOS
Native Android
Public Mini Store
Consumer App
Marketplace
Partner API
Internal Admin
Automation
AI Services
```

All clients should use the same business rules.

Do not duplicate business logic per client.

---

# 4. API TYPES

APSA may use several API categories.

## Internal Application APIs

Used by APSA frontend and trusted internal clients.

## Public Merchant APIs — Later

Used by merchants/partners.

## Provider Webhooks

Used by:

- Meta
- Telegram
- payments
- courier services

## Public Store APIs

Used by public merchant storefronts.

## Internal Service Interfaces

Used inside the modular monolith.

These categories must not be treated as having identical security requirements.

---

# 5. API-FIRST RULE

Business rules must never live only in React components.

Example:

Incorrect:

```text
POS React component
→ directly updates inventory
→ directly creates payment
```

Correct:

```text
POS UI
↓
Checkout Application Service
↓
Order Domain
↓
Payment Record
↓
Inventory Service
↓
Repositories
```

This enables future native apps to reuse the same system.

---

# 6. API VERSIONING

Public/external APIs should use explicit versions.

Example:

```text
/api/v1/orders
/api/v1/customers
```

Do not version every internal function unnecessarily.

Versioning becomes mandatory when external consumers depend on the contract.

---

# 7. API NAMING

Use predictable resource naming.

Examples:

```text
/organizations
/workspaces
/locations
/customers
/conversations
/orders
/products
/inventory
/payments
/deliveries
```

Prefer nouns for resources.

Actions that represent real domain commands may use explicit command endpoints where clearer.

Example:

```text
POST /orders/{id}/cancel
POST /orders/{id}/refund
```

Do not force every domain action into awkward CRUD semantics.

---

# 8. TENANT CONTEXT

Never trust `organization_id` from a client without verification.

Every protected request must derive/validate:

- authenticated user
- membership
- organization
- workspace/location scope
- permission
- resource ownership

Possible client context:

```text
current organization
current workspace
current location
```

but server remains authoritative.

---

# 9. AUTHENTICATION

Internal user APIs:

- authenticated session/token

Future public APIs:

- scoped API key
- OAuth where appropriate

Provider webhooks:

- provider signature/token verification

Do not reuse merchant session logic for provider webhooks.

---

# 10. AUTHORIZATION

Authentication answers:

> Who are you?

Authorization answers:

> Are you allowed to do this?

Every sensitive API must enforce both.

Permissions are defined by `SECURITY.md`.

---

# 11. STANDARD API RESPONSE

Keep API responses predictable.

Example success concept:

```text
{
  data: ...
}
```

Where useful:

```text
{
  data: ...,
  meta: ...
}
```

Avoid returning internal database implementation details.

---

# 12. STANDARD ERROR MODEL

Use a stable error shape.

Conceptually:

```text
{
  error: {
    code: "ORDER_INVALID_STATE",
    message: "This order cannot be cancelled after delivery.",
    request_id: "..."
  }
}
```

Possible categories:

- AUTHENTICATION_REQUIRED
- PERMISSION_DENIED
- RESOURCE_NOT_FOUND
- VALIDATION_FAILED
- CONFLICT
- RATE_LIMITED
- PROVIDER_ERROR
- TEMPORARY_UNAVAILABLE
- BUSINESS_RULE_VIOLATION

Do not expose stack traces to users.

---

# 13. ERROR CODES

Error codes should be machine-readable and stable.

Do not make clients depend on human message text.

Example:

Good:

```text
INVENTORY_INSUFFICIENT
```

Bad:

```text
"Sorry there are not enough items left."
```

as the only programmatic signal.

---

# 14. VALIDATION

Every mutation validates server-side.

Examples:

- quantity
- currency
- amount
- order status
- product ownership
- customer ownership
- permissions
- provider IDs

Client validation improves UX but is not security.

---

# 15. PAGINATION

All potentially large collections must support pagination.

Examples:

- customers
- orders
- conversations
- messages
- products
- audit logs

Do not return 50,000 records in a single request.

---

# 16. CURSOR PAGINATION

Prefer cursor pagination for fast-changing feeds where appropriate.

Especially:

- conversations
- messages
- events
- activity timelines

Offset pagination may remain acceptable for smaller stable business lists.

---

# 17. FILTERING

Use explicit filters.

Example:

```text
status
source
assigned_user
location
date range
customer
```

Avoid arbitrary client-generated SQL/filter expressions.

---

# 18. SORTING

Define supported sorts explicitly.

Example:

```text
created_at
last_message_at
order_total
```

Do not expose unrestricted dynamic database sort fields.

---

# 19. FIELD SELECTION

Return only necessary fields.

Public mini-store APIs must never accidentally expose:

- product cost
- merchant financial metrics
- internal notes

Create dedicated DTOs/read models for public APIs.

---

# 20. COMMAND VS QUERY

Conceptually separate:

## Query

Reads data.

Example:

```text
get order
list conversations
```

## Command

Changes business state.

Example:

```text
create order
confirm payment
adjust inventory
```

Commands should enforce business rules.

Do not allow direct uncontrolled state mutation.

---

# 21. STATE TRANSITIONS

State changes must use domain operations.

Example:

Do not allow:

```text
PATCH order.status = "DELIVERED"
```

from arbitrary clients.

Prefer:

```text
markOrderDelivered(...)
```

that validates current state and permissions.

---

# 22. IDEMPOTENCY

Critical write operations should support idempotency.

Especially:

- order creation
- payment confirmation
- payment provider callbacks
- delivery booking
- inventory mutations
- offline POS sync

Conceptual input:

```text
Idempotency-Key
```

Same request + same key must not create duplicate financial/business effects.

---

# 23. IDEMPOTENCY STORE

Store enough information to detect duplicate operations.

Possible fields:

```text
key
organization_id
operation
request_hash
result_reference
status
created_at
expires_at
```

Do not keep idempotency records forever if unnecessary.

---

# 24. REQUEST IDS

Production requests should have a correlation/request ID.

Benefits:

- debugging
- tracing
- support
- provider reconciliation

User-facing error can include safe request ID.

---

# 25. API RATE LIMITS

Rate limits should be applied based on risk.

Examples:

- authentication
- messaging send
- exports
- AI endpoints
- public APIs
- public storefront abuse

Do not use one global limit for all merchants.

---

# 26. PROVIDER ABSTRACTION

External APIs must be accessed through provider adapters.

Example:

```text
DeliveryService
↓
DeliveryProvider
↓
Courier Adapter
```

Core domain should not know provider-specific HTTP details.

---

# 27. PROVIDER CAPABILITIES

Different providers support different features.

Maintain capability awareness.

Example:

```text
supportsReplies
supportsComments
supportsAttachments
supportsCOD
supportsCancellation
supportsLiveTracking
```

Do not assume every provider behaves identically.

---

# 28. PROVIDER STATUS NORMALIZATION

Map provider-specific statuses into APSA domain statuses.

Example courier:

Provider says:

```text
driver_pickup_success
```

APSA maps to:

```text
PICKED_UP
```

Keep original provider status metadata if useful for debugging.

---

# 29. PROVIDER ERRORS

External provider errors should be normalized.

Example:

```text
PROVIDER_AUTH_EXPIRED
PROVIDER_RATE_LIMITED
PROVIDER_TEMPORARY_FAILURE
PROVIDER_INVALID_REQUEST
```

Do not expose raw provider internals directly to merchants.

---

# 30. WEBHOOK ARCHITECTURE

Provider webhook flow:

```text
Provider
↓
Webhook Endpoint
↓
Signature Verification
↓
Payload Validation
↓
Deduplication
↓
Persist Provider Event
↓
Queue / Processing
↓
Domain Service
↓
APSA Event
```

Do not execute large workflows synchronously in webhook request when avoidable.

---

# 31. WEBHOOK SECURITY

Required:

- verify signature/token
- validate content type
- validate payload schema
- reject invalid source
- record provider event ID
- rate-limit where appropriate
- never expose secret verification data

---

# 32. WEBHOOK DEDUPLICATION

Provider events may arrive multiple times.

Store:

```text
provider
provider_event_id
received_at
processed_at
status
```

Duplicate event must not duplicate:

- payment
- inventory change
- order state
- delivery state

---

# 33. WEBHOOK ACKNOWLEDGEMENT

Where provider expectations require fast response:

1. validate;
2. persist event;
3. acknowledge;
4. process asynchronously.

This reduces provider retries and timeout issues.

---

# 34. RETRIES

External requests may fail temporarily.

Use controlled retry rules.

Example:

```text
Attempt 1
↓
short delay
Attempt 2
↓
longer delay
Attempt 3
```

Use exponential backoff where appropriate.

---

# 35. NON-RETRYABLE ERRORS

Do not retry blindly for:

- invalid credentials
- invalid request schema
- permission denial
- permanently missing resource

Retry only errors that may recover.

---

# 36. DEAD-LETTER / FAILED JOBS

As scale grows, failed integration jobs need a review path.

Future concept:

```text
FailedJob
provider
operation
resource
error
attempts
last_attempt
status
```

Do not build complex dead-letter infrastructure too early.

But preserve failure visibility.

---

# 37. INTERNAL DOMAIN EVENTS

Events describe facts that already happened.

Examples:

```text
customer.created
message.received
conversation.assigned
order.created
order.status_changed
payment.paid
payment.refunded
inventory.changed
inventory.low
delivery.created
delivery.status_changed
```

Events must not mean:

“Maybe this happened.”

Only publish after domain operation is accepted.

---

# 38. EVENT NAMING

Use:

```text
noun.action
```

Examples:

```text
order.created
payment.paid
delivery.delivered
```

Use consistent lower-case naming.

Avoid random names like:

```text
NEW_ORDER_EVENT_X
```

---

# 39. EVENT VERSIONING

Important event contracts should be versionable.

Possible format:

```text
order.created.v1
```

or event metadata:

```text
event_name = order.created
version = 1
```

Do not break downstream consumers silently.

---

# 40. EVENT ENVELOPE

Recommended conceptual event envelope:

```text
id
event_name
event_version
organization_id
workspace_id nullable
aggregate_type
aggregate_id
actor_type
actor_id nullable
occurred_at
correlation_id
causation_id nullable
payload
```

This allows tracing related actions.

---

# 41. CORRELATION ID

Used to link related operations.

Example:

Message received

↓

Create Order

↓

Payment

↓

Delivery

can potentially be connected across system logs/events.

---

# 42. CAUSATION ID

Used when one event causes another.

Example:

```text
payment.paid
```

causes:

```text
order.status_changed
```

Later this helps debugging and automation.

---

# 43. EVENT PAYLOAD RULE

Payload contains only data required by likely consumers.

Do not dump full database row into every event.

Avoid:

- secrets
- unnecessary PII
- giant message bodies
- raw provider tokens

---

# 44. EVENT IMMUTABILITY

Published event represents history.

Do not edit historical event silently.

If correction is required, publish another event.

---

# 45. EVENT VS AUDIT

Important distinction:

## Event

Business fact:

```text
order.created
```

## Audit

Security/accountability fact:

```text
user X changed product price from $12 to $9
```

Some operations produce both.

Do not merge these systems blindly.

---

# 46. EVENT VS NOTIFICATION

Event:

```text
inventory.low
```

Notification:

```text
Send owner push alert.
```

Events describe reality.

Notifications are reactions to events.

This separation enables future automation.

---

# 47. EVENT VS ANALYTICS

Operational event may later feed analytics.

But analytics-specific high-volume tracking may eventually use a separate event stream.

Do not overload core domain events with every UI click.

---

# 48. CORE EVENT CATALOG — MVP

Initial events should include at minimum:

## Customer

```text
customer.created
customer.updated
customer.identity_linked
```

## Messaging

```text
message.received
message.sent
conversation.created
conversation.assigned
conversation.status_changed
```

## Product

```text
product.created
product.updated
```

## Inventory

```text
inventory.movement_created
inventory.low
```

## Order

```text
order.created
order.status_changed
order.cancelled
```

## Payment

```text
payment.created
payment.paid
payment.failed
payment.refunded
```

## Delivery

```text
delivery.created
delivery.status_changed
delivery.delivered
delivery.failed
```

## Team

```text
membership.created
membership.removed
role.changed
```

---

# 49. DO NOT CREATE TOO MANY EVENTS

Do not emit meaningless events for every field change.

Only create events useful for:

- domain workflows
- integration
- automation
- audit coordination
- analytics

Keep event catalog intentional.

---

# 50. EVENT STORAGE

Initial implementation may store key domain events in PostgreSQL.

Possible:

```text
events
```

table.

High-volume analytics events may later move elsewhere.

---

# 51. TRANSACTION BOUNDARY

Important domain writes and event creation should be transactionally consistent.

Example:

Order created

must not commit without corresponding event if downstream systems depend on it.

Future recommended pattern:

Transactional Outbox.

---

# 52. TRANSACTIONAL OUTBOX

Concept:

```text
BEGIN TRANSACTION

create order
create order items
reserve inventory
write outbox event

COMMIT
```

Then worker processes outbox.

Benefits:

- reliable integration
- fewer lost events

Implement when workflows require this reliability.

---

# 53. EVENT HANDLER RULE

Handlers must be idempotent.

If:

```text
order.created
```

is handled twice,

stock/payment/delivery must not duplicate incorrectly.

---

# 54. EVENT CHAIN EXAMPLE

Example social order flow:

```text
message.received
↓
conversation updated

Staff creates order

order.created
↓
inventory reserved
↓
customer timeline updated

payment.paid
↓
order status updated
↓
inventory reservation consumed
↓
packing notification

delivery.created
↓
tracking available

delivery.delivered
↓
order delivered
↓
customer history updated
```

---

# 55. ORDER API — MVP CONTRACT DIRECTION

Possible internal routes:

```text
GET /api/orders
GET /api/orders/{id}
POST /api/orders
POST /api/orders/{id}/cancel
POST /api/orders/{id}/confirm
```

Exact implementation can evolve.

State mutation should use commands rather than arbitrary patching where business rules matter.

---

# 56. CUSTOMER API — MVP DIRECTION

Possible:

```text
GET /api/customers
GET /api/customers/{id}
POST /api/customers
PATCH /api/customers/{id}
```

Future:

```text
POST /api/customers/{id}/identities
POST /api/customers/{id}/merge
```

Merge must be privileged/audited.

---

# 57. PRODUCT API — MVP DIRECTION

Possible:

```text
GET /api/products
GET /api/products/{id}
POST /api/products
PATCH /api/products/{id}
POST /api/products/{id}/archive
```

Variants nested or separate according to implementation quality.

---

# 58. INVENTORY API

Avoid generic:

```text
PATCH stock = 50
```

Prefer:

```text
POST /api/inventory/adjustments
```

with:

```text
variant
location
quantity_delta
reason
```

This preserves ledger integrity.

---

# 59. PAYMENT API

Possible:

```text
GET /api/orders/{id}/payments
POST /api/orders/{id}/payments
POST /api/payments/{id}/confirm
POST /api/payments/{id}/refund
```

Provider confirmation later uses webhook/provider service.

---

# 60. DELIVERY API

Possible:

```text
POST /api/orders/{id}/delivery
GET /api/deliveries/{id}
POST /api/deliveries/{id}/cancel
```

Future:

```text
GET /api/delivery/quotes
```

via multiple providers.

---

# 61. CONVERSATION API

Possible:

```text
GET /api/conversations
GET /api/conversations/{id}
GET /api/conversations/{id}/messages
POST /api/conversations/{id}/reply
POST /api/conversations/{id}/assign
POST /api/conversations/{id}/status
```

Do not let frontend call social providers directly.

---

# 62. CHAT-TO-ORDER API

Signature APSA command:

```text
POST /api/conversations/{id}/orders
```

Server determines:

- tenant
- conversation/customer
- products
- stock
- pricing
- permission

This creates a linked universal Order.

---

# 63. PUBLIC STORE API

Public storefront must use separate public read models.

Possible:

```text
GET /api/public/stores/{slug}
GET /api/public/stores/{slug}/products
```

Do not reuse internal product response blindly.

---

# 64. FUTURE NATIVE APP API

Native app should call the same application/domain interfaces as web.

Native-specific concerns:

- push tokens
- device sessions
- offline sync
- app version

Do not create a second business backend for mobile.

---

# 65. OFFLINE SYNC API — FUTURE

Offline operations require stable IDs and idempotency.

Concept:

```text
POST /api/sync/operations
```

Client sends:

```text
operation_id
operation_type
client_timestamp
payload
```

Server returns:

```text
accepted
duplicate
conflict
rejected
```

Do not implement until offline POS is ready.

---

# 66. OFFLINE CONFLICTS

Conflicts must be explicit.

Examples:

- stock changed while offline
- product deleted
- permission revoked
- price changed

Do not silently overwrite server truth.

---

# 67. WEBHOOK ENDPOINT NAMES

Example:

```text
/api/webhooks/meta
/api/webhooks/telegram
/api/webhooks/payments/{provider}
/api/webhooks/delivery/{provider}
```

Do not mix provider webhooks with merchant APIs.

---

# 68. WEBHOOK PAYLOAD LOGGING

Do not log full sensitive webhook bodies by default.

Log:

- provider event ID
- type
- status
- safe metadata
- error context

Temporary raw payload retention may exist for debugging with retention limits.

---

# 69. PROVIDER ACCOUNT CONNECTION API

External account connection flows should be server-controlled.

Example:

```text
POST /api/integrations/meta/connect
```

OAuth callback:

```text
/api/integrations/meta/callback
```

Tokens should be processed/stored server-side.

---

# 70. INTEGRATION STATUS

Every connected provider should expose operational health.

Example:

```text
CONNECTED
TOKEN_EXPIRING
REAUTH_REQUIRED
ERROR
DISCONNECTED
```

Merchant should know if channel stops syncing.

---

# 71. PROVIDER HEALTH EVENTS

Possible:

```text
integration.connected
integration.disconnected
integration.auth_expired
integration.error
```

Useful for operational monitoring.

---

# 72. API OBSERVABILITY

Track:

- endpoint
- duration
- status
- request ID
- organization where safe
- error code

Do not log sensitive bodies unnecessarily.

---

# 73. SLOW API DETECTION

Monitor expensive endpoints.

Examples likely to require attention later:

- Inbox
- customer history
- owner dashboard
- inventory
- large exports

Optimize based on real metrics.

---

# 74. API COMPATIBILITY

When changing an API used by current clients:

Prefer additive changes.

Avoid removing/renaming fields without coordinated migration.

Public APIs require stronger compatibility guarantees.

---

# 75. DEPRECATION

Future public API deprecation should include:

- announcement
- replacement
- migration period
- end date

Do not break external merchants suddenly.

---

# 76. PUBLIC API KEYS — FUTURE

Merchant API credentials should support scopes.

Example:

```text
orders:read
orders:write
products:read
inventory:read
```

Never create one permanent unlimited merchant secret as the only model.

---

# 77. API KEY ROTATION

Future keys must support:

- creation
- naming
- scopes
- last used
- revoke
- rotate

Secrets displayed minimally.

---

# 78. PARTNER WEBHOOKS — FUTURE

APSA may eventually send merchant events to partners.

Examples:

```text
order.created
order.paid
delivery.delivered
```

Outbound webhook system should include:

- signing secret
- retries
- delivery logs
- idempotent event IDs
- disable on repeated failure

---

# 79. OUTBOUND WEBHOOK SIGNATURE

APSA should sign outbound partner webhook payloads.

Partner can verify message is genuinely from APSA.

---

# 80. FUTURE AUTOMATION ENGINE

Automation should consume events.

Example:

```text
Trigger:
order.paid

Condition:
order.total > $50

Action:
notify manager
```

Do not hard-code automation rules into Order Service.

---

# 81. AI EVENTS

Possible future AI events:

```text
ai.summary_requested
ai.summary_completed
ai.order_extraction_requested
ai.order_extraction_completed
```

Avoid storing prompts/responses as unrestricted permanent logs containing sensitive information.

---

# 82. AI API BOUNDARY

UI should call an APSA-controlled endpoint/service.

Example:

```text
POST /api/ai/conversations/{id}/summary
```

APSA:

1. checks permission;
2. retrieves authorized context;
3. minimizes data;
4. calls AIProvider;
5. validates response;
6. returns safe result.

Never let frontend directly send arbitrary merchant database content to AI provider.

---

# 83. AI ACTIONS

AI suggestions should not automatically execute sensitive commands.

Example:

AI says:

“Refund this order.”

Required:

authorized user confirms

↓

Refund Service validates

↓

refund occurs.

---

# 84. NOTIFICATION ARCHITECTURE

Future notifications should consume domain events.

Channels:

- in-app
- push
- email
- Telegram
- SMS

Example:

```text
inventory.low
↓
NotificationService
↓
Owner alert
```

Do not embed notification delivery directly throughout domain code.

---

# 85. PUBLIC EVENT SCHEMA — FUTURE

If APSA exposes events to partners, public schemas must be documented.

Example:

```text
{
  "id": "...",
  "type": "order.created",
  "version": 1,
  "created_at": "...",
  "data": {
    "order_id": "..."
  }
}
```

Never expose internal/private metadata unnecessarily.

---

# 86. SECURITY EVENTS

Security-related events may include:

```text
auth.login_failed
auth.mfa_disabled
membership.permission_changed
data.export_requested
api_key.created
api_key.revoked
```

These are useful for security monitoring.

---

# 87. AUDIT EVENTS

Sensitive domain changes should generate AuditLog records.

Examples:

```text
inventory.adjust
payment.manual_confirm
refund.create
role.permission_change
```

Audit trail must preserve actor context.

---

# 88. ANALYTICS EVENT SEPARATION

Future UI analytics examples:

```text
screen.viewed
button.clicked
```

These should not pollute core business event tables indefinitely.

Use a dedicated analytics system when scale justifies it.

---

# 89. EVENT RETENTION

Domain event retention should be based on:

- operational need
- automation
- auditability
- analytics
- legal requirements
- storage cost

Do not keep unlimited provider/event payloads forever by default.

---

# 90. EVENT REPLAY — FUTURE

Some event systems may later support replay.

If introduced:

handlers must remain idempotent.

Do not assume event replay is safe unless explicitly designed.

---

# 91. SCHEDULING / DELAYED EVENTS — FUTURE

Example:

```text
delivery.delivered
WAIT 7 days
→ followup.due
```

Use a job/scheduler system.

Do not keep HTTP requests alive for delays.

---

# 92. INTEGRATION CONFIGURATION

Separate provider configuration from business records.

Do not store secrets directly on Order/Delivery/Conversation.

Use secure provider configuration references.

---

# 93. API SECURITY BASELINE

Every new endpoint must answer:

- Is authentication required?
- Which permission?
- Which tenant owns resource?
- Does location scope matter?
- Is input validated?
- Is rate limit needed?
- Is audit needed?
- Is idempotency needed?
- Does it expose PII?
- Is response minimal?
- Can it be abused via ID guessing?

---

# 94. EVENT DESIGN CHECKLIST

Before adding an event:

1. What fact happened?
2. Who owns it?
3. Which aggregate?
4. Does it need a version?
5. Which consumers need it?
6. Does it contain unnecessary PII?
7. Could duplicate delivery cause harm?
8. Does handler need idempotency?
9. Is event durable/reliable enough for its purpose?
10. Is this really an event or just an audit/log entry?

---

# 95. API DESIGN CHECKLIST

Before adding endpoint:

1. What domain capability is exposed?
2. Is this query or command?
3. Is it tenant-safe?
4. Which role/permission?
5. What validation?
6. What errors?
7. Does it require pagination?
8. Is it idempotent?
9. Does it create domain events?
10. Does it require audit?
11. Will future native client reuse it?
12. Are provider-specific details leaking?

---

# 96. API ANTI-PATTERNS — FORBIDDEN

Do NOT:

- let UI update database tables directly for critical operations
- allow arbitrary order status patches
- expose internal provider secrets
- trust client organization IDs
- return giant unpaginated collections
- create one endpoint per frontend button without domain reasoning
- embed courier-specific logic inside Order domain
- embed Meta-specific logic inside Customer domain
- use human-readable error strings as the only API contract
- process duplicate webhooks multiple times
- expose raw DB rows publicly
- create a second API/business system for native mobile

---

# 97. EVENT ANTI-PATTERNS — FORBIDDEN

Do NOT:

- publish events before transaction commits
- use random naming conventions
- edit historical event records casually
- put secrets in event payloads
- create an event for every trivial field change
- let duplicate events cause duplicate money/stock effects
- use event bus as replacement for clear domain logic
- introduce Kafka/microservices without measured need

---

# 98. MVP API PRIORITY

## MUST NOW

Define/implement contracts for:

- Auth context
- Organizations
- Workspaces
- Membership/permissions
- Customers
- Products
- Inventory adjustments
- Orders
- Payments
- Conversations
- Chat-to-order
- Delivery
- Feature/entitlement checks

## SHOULD NOW

- public mini-store read APIs
- staff analytics
- provider health
- usage metrics

## LATER

- marketplace APIs
- supplier APIs
- consumer APIs
- external merchant API
- public webhooks
- automation API
- advanced AI APIs

---

# 99. MVP EVENT PRIORITY

## MUST NOW

- customer.created
- customer.identity_linked
- message.received
- message.sent
- conversation.assigned
- order.created
- order.status_changed
- payment.paid
- payment.refunded
- inventory.movement_created
- inventory.low
- delivery.created
- delivery.status_changed
- membership.created
- membership.removed

## LATER

- campaign events
- marketplace events
- consumer behavior events
- supplier events
- AI workflow events
- advanced fraud events

---

# 100. FIRST PROVIDER IMPLEMENTATION RULE

When adding first real provider:

Do not let its peculiarities redefine APSA's domain.

Example:

Meta may have concepts that Telegram does not.

Map what is common.

Store provider-specific metadata separately.

Extend provider capabilities only where needed.

---

# 101. CLAUDE CODE REQUIREMENTS

Before creating/changing APIs or events, Claude Code must read:

- `APSA_MASTER_PLAN.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `MVP_ROADMAP.md`
- `DATA_MODEL.md`
- `API_AND_EVENTS.md`

Claude must report:

- endpoints added/changed
- permissions
- request/response contracts
- validation
- errors
- idempotency
- events emitted
- audits emitted
- provider dependencies
- tests
- backward compatibility
- security implications

---

# 102. CODEX REVIEW REQUIREMENTS

Codex should inspect major API/event changes for:

- broken authorization
- tenant leakage
- duplicate transactional effects
- wrong state transitions
- provider coupling
- missing validation
- missing idempotency
- leaking PII/secrets
- event ordering problems
- lost events
- unsafe retries
- missing tests

---

# 103. CONTRACT TESTING

Provider adapters should use contract tests.

Example:

Every `DeliveryProvider` implementation must satisfy expected behavior for:

- quote
- create
- track
- cancel where supported
- error normalization

This prevents provider implementations from behaving inconsistently.

---

# 104. INTEGRATION SANDBOX

Use provider test/sandbox environments where available.

Never make staging send accidental real:

- payments
- customer messages
- deliveries

Production credentials must stay isolated.

---

# 105. API DOCUMENTATION

Internal API behavior should be documented near code.

Future external APIs should use proper generated/documented contracts such as OpenAPI where appropriate.

Do not maintain a giant manually duplicated API document that becomes outdated.

This file defines the standards.

Implementation-level schema should come from code/contracts.

---

# 106. EVENT CATALOG DOCUMENTATION

Maintain a living event catalog as events are actually implemented.

For each event document:

- name
- version
- producer
- payload
- consumers
- idempotency expectations
- PII classification

Do not document hundreds of hypothetical events.

---

# 107. SCALING API LAYER

Initial:

```text
Next.js / Application API
↓
Domain Services
↓
PostgreSQL
```

Later if measured need requires:

```text
API
↓
Dedicated workers
↓
Cache / queues
↓
PostgreSQL
```

Much later:

split only high-load components.

Do not begin with distributed complexity.

---

# 108. SCALING EVENTS

Initial:

- local domain events
- event/outbox table
- background jobs

Later:

- queue
- workers

Much later:

- dedicated streaming infrastructure if required

The event contract should remain stable even as transport changes.

---

# 109. NATIVE READINESS

When native app arrives, it should not require rewriting:

- order creation
- inventory
- payment
- customer
- delivery
- permissions

Native client only changes presentation/device behavior.

This is a major architectural success criterion.

---

# 110. MARKETPLACE READINESS

Marketplace future flow:

```text
Marketplace Client
↓
APSA API
↓
Universal Product
↓
Universal Inventory
↓
Universal Order
↓
Universal Payment
↓
Universal Delivery
```

Do not create marketplace-specific commerce core.

---

# 111. CONSUMER APP READINESS

Future consumer app uses:

- public merchant
- catalog
- consumer identity
- order tracking
- saved addresses
- marketplace/Swipe

Business-owned customer records remain merchant-scoped.

Network consumer identity is separate.

---

# 112. API AND EVENT DEFINITION OF SUCCESS

This architecture is successful if:

- web and future native apps share the same business system;
- adding a courier does not rewrite Orders;
- adding a payment provider does not rewrite POS;
- adding a messaging provider does not rewrite Customers;
- duplicated webhooks cannot duplicate money or stock;
- events enable future automation;
- APIs remain tenant-safe;
- public responses do not leak private fields;
- provider outages can be retried and diagnosed;
- events can evolve through versioning;
- infrastructure can scale without changing fundamental contracts.

---

# 113. FINAL RULE

APSA should treat APIs and events as **contracts**, not implementation accidents.

The transport can change.

The hosting can change.

The provider can change.

The frontend can change.

But the core domain meaning should remain stable.

That is what allows APSA to grow without rewriting itself.
