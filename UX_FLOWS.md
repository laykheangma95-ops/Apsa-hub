# APSA — UX FLOWS

**Document:** `UX_FLOWS.md`  
**Project:** APSA  
**Status:** Source of truth for core user journeys  
**Primary client:** Mobile-first Web/PWA  
**Future clients:** Native iOS/Android using the same product logic  
**Audience:** Product designers, Lovable, Claude Code, Codex, frontend engineers, QA

---

# 1. PURPOSE

This document defines how real APSA users move through the product.

It exists to prevent a common failure:

> technically correct screens that create a confusing business workflow.

Every APSA flow should optimize for:

- speed
- clarity
- low cognitive load
- few taps
- strong mobile usability
- Khmer readability
- safe destructive actions
- clear status
- recoverability from mistakes
- obvious next action

The product should feel:

> powerful underneath, simple on the surface.

---

# 2. CORE UX PRINCIPLES

Every major flow should follow these rules:

1. Show the next useful action clearly.
2. Avoid forcing users to leave context unnecessarily.
3. Use progressive disclosure.
4. Prefer bottom sheets on mobile for quick sub-actions.
5. Use full pages for complex work.
6. Keep destructive actions explicit.
7. Never hide critical business state.
8. Make error recovery obvious.
9. Preserve draft/state where reasonable.
10. Optimize repeated daily actions more aggressively than rare settings actions.
11. Do not make merchants understand APSA's internal architecture.
12. Minimize unnecessary data entry.
13. Reuse existing customer/product/order data instead of asking again.
14. Never make mobile feel like a shrunk desktop.
15. Make important states understandable without relying only on color.

---

# 3. PRIMARY MOBILE NAVIGATION

Recommended Business workspace navigation:

```text
HOME
INBOX
SELL
ORDERS
MORE
```

SELL opens:

- POS
- Products
- Inventory

MORE contains:

- Customers
- Delivery
- Analytics
- Team
- Settings

Creator/Inbox workspace:

```text
HOME
INBOX
CONTACTS
INSIGHTS
MORE
```

MORE:

- Team
- Settings
- Enable Selling

Do not expose every module in bottom navigation.

---

# 4. FIRST-TIME USER FLOW

```text
Landing
↓
Start Free
↓
Create Account
↓
Verify Account if required
↓
Create APSA Workspace
↓
Choose Usage Type
↓
Creator / Inbox
OR
Business / Sell
↓
Short Guided Setup
↓
Home
```

Goal:

User should reach usable product quickly.

Do not force full company setup before showing value.

---

# 5. ACCOUNT CREATION FLOW

## Screen 1

Fields:

- Name
- Email or supported login method
- Password where applicable
- Language

Primary action:

**Create Account**

Secondary:

**Sign In**

Requirements:

- clear validation
- password rules shown before error where possible
- preserve entered values after recoverable error

---

# 6. WORKSPACE TYPE SELECTION

After account creation:

Question:

> How do you want to use APSA?

Card A:

### Manage Messages

For creators, social teams, support.

Card B:

### Run My Business

For sellers and shops.

Supporting note:

> You can enable more tools later.

This is important.

The choice must not feel permanent.

---

# 7. BUSINESS ONBOARDING

Keep initial onboarding short.

Recommended steps:

## Step 1 — Business

- business name
- business category
- preferred language
- default currency

Default Cambodia options:

- USD
- KHR

## Step 2 — Location

- location name
- basic location/address

Allow:

**Skip detailed address for now**

if not necessary.

## Step 3 — First Goal

Ask:

What do you want to set up first?

- Connect Messages
- Add Products
- Start POS

Do not force every onboarding step.

---

# 8. CREATOR ONBOARDING

Ask only:

- workspace name
- language
- primary social goal

Then direct toward:

**Connect your first channel**

Keep commerce hidden.

---

# 9. ONBOARDING HOME STATE

New Business workspace should not show an empty dead dashboard.

Use a guided setup checklist:

```text
□ Add your first product
□ Connect a social channel
□ Create your first order
□ Invite staff
```

Show only 3–4 important actions.

Avoid overwhelming onboarding checklist with 15 tasks.

---

# 10. HOME — BUSINESS WORKSPACE

Home answers:

> What needs attention right now?

Priority sections:

## Attention

- unread customers
- unpaid orders
- deliveries waiting
- low stock

## Today

- sales
- orders
- gross profit estimate

## Quick Actions

- New Sale
- Create Order
- Add Product
- Open Inbox

Do not make dashboard primarily decorative charts.

---

# 11. HOME PRIORITY LOGIC

Use operational urgency.

Example:

```text
12 Needs Reply
4 Waiting Payment
7 Ready for Delivery
3 Low Stock
```

These should appear before less important analytics.

A merchant opens APSA to act, not admire charts.

---

# 12. UNIFIED INBOX — LIST

Each conversation row should expose enough context without opening it.

Show:

- avatar
- customer name/identity
- channel icon
- last message
- unread indicator
- time
- assigned staff if useful
- follow-up/order status

Possible badges:

- Needs Reply
- Follow Up
- Waiting Customer
- Order Created

Do not overload each row with excessive badges.

---

# 13. INBOX FILTERS

Important filters:

- All
- Unread
- Needs Reply
- Follow Up
- Mine

Later:

- channel
- staff
- order status

Default view should remain simple.

---

# 14. CONVERSATION FLOW

```text
Inbox
↓
Tap Conversation
↓
Conversation Screen
```

Conversation screen should include:

Header:

- Customer name
- Channel
- Assignment/status

Body:

- messages

Composer:

- reply

Quick actions:

- Create Order
- Customer
- Follow Up

Do not make staff navigate through multiple pages for core actions.

---

# 15. CUSTOMER QUICK VIEW FROM CONVERSATION

Tap customer/header.

Open mobile bottom sheet.

Show:

- name
- phone if authorized
- tags
- recent orders
- lifetime spend if appropriate
- last purchase

Actions:

- View Full Customer
- Add Note
- Edit Basic Details

Preserve conversation state behind sheet.

---

# 16. MESSAGE → ORDER — SIGNATURE FLOW

This is APSA's highest-priority UX.

```text
Conversation
↓
Create Order
↓
Bottom Sheet / Fast Order Builder
↓
Choose Product
↓
Variant
↓
Quantity
↓
Price/Discount if permitted
↓
Delivery option optional
↓
Create Order
↓
Success
↓
Return to Conversation
```

Goal:

Fast enough that staff prefer this over writing order details elsewhere.

---

# 17. MESSAGE → ORDER DETAILS

The order builder should prefill:

- Customer
- Conversation source
- Staff member
- Channel

Staff should not reselect existing customer.

Show product search immediately.

Product row:

- image
- name
- variant
- price
- available stock

Tap product.

Select quantity.

Add more items if needed.

---

# 18. ORDER CREATION SUCCESS

After order creation:

Show compact confirmation:

```text
Order #APSA-1028 created
$24.00
Pending Payment
```

Actions:

- Record Payment
- Arrange Delivery
- View Order

Then allow returning directly to conversation.

Do not redirect automatically into unrelated long order page unless needed.

---

# 19. QUICK ORDER FROM OUTSIDE INBOX

Path:

```text
Orders
↓
New Order
```

or:

```text
Home
↓
Create Order
```

Flow:

Customer

↓

Products

↓

Payment/Delivery optional

↓

Create

Allow:

**Guest / No Customer**

for POS/manual situations where appropriate.

---

# 20. CUSTOMER SEARCH DURING ORDER

Search:

- name
- phone

Results show recent context.

If not found:

**Create New Customer**

Inline creation should require minimal fields:

- name
- phone optional according to workflow

Do not push user into full Customer setup page.

---

# 21. POS FLOW

```text
SELL
↓
POS
↓
Search/Scan Product
↓
Add to Cart
↓
Adjust Quantity
↓
Customer Optional
↓
Discount Optional
↓
Checkout
↓
Payment Method
↓
Complete Sale
↓
Receipt / New Sale
```

Primary design objective:

Speed.

Repeated sale flow should require minimal taps.

---

# 22. POS PRODUCT SELECTION

Show:

- search
- recent/popular products
- categories where useful
- product cards/list

Product card:

- name
- price
- stock indicator

Avoid showing cost/profit to cashier without permission.

---

# 23. POS CART

Persistent cart summary.

Show:

- product
- variant
- quantity
- unit price
- line total

Bottom area:

- subtotal
- discount
- total

Primary:

**Checkout**

Do not hide total below scroll.

---

# 24. POS DISCOUNT FLOW

Tap Discount.

If cashier has limited permission:

show allowed options.

Example:

- 5%
- 10%
- Custom if allowed

If attempted discount exceeds authorization:

show:

> Manager approval required.

Do not silently fail.

---

# 25. POS PAYMENT FLOW

Payment methods:

- Cash
- KHQR
- Bank Transfer
- COD where relevant

Cash:

Optional amount received.

Show change.

KHQR/Bank:

Initially manual confirmation.

Explicitly indicate:

**Mark as Paid**

only for authorized staff.

---

# 26. POS SUCCESS

Show:

```text
Sale Complete
Order #APSA-1030
$8.50
Paid
```

Actions:

- New Sale
- View Receipt
- View Order

Primary action should be:

**New Sale**

for cashier efficiency.

---

# 27. OFFLINE POS UX PREPARATION

Connection state should be visible but not alarming.

Possible banner:

```text
Offline — sales will sync when connection returns.
```

Only show this once real safe offline support exists.

Before reliable offline implementation:

show:

```text
Connection lost. Reconnect before completing payment.
```

Do not claim offline capability before it is truly safe.

---

# 28. PRODUCT LIST FLOW

```text
SELL
↓
Products
```

Show:

- search
- category filter
- status
- stock indicator
- price

Quick action:

**Add Product**

Avoid enterprise-table density on phone.

Use cards/list.

Desktop may use table.

---

# 29. ADD PRODUCT FLOW

Optimize first-time product creation.

Required initially:

- name
- price

Optional/secondary:

- image
- category
- SKU
- barcode
- cost
- variants
- stock

Use progressive disclosure.

Goal:

Micro seller can create product in under a minute.

---

# 30. PRODUCT VARIANT FLOW

If user selects:

**This product has options**

Then show:

- Option Name
- Values

Example:

Color:

Black, White

Size:

S, M, L

Generate variants.

Allow editing:

- SKU
- price override
- stock

Do not expose variant machinery to merchants that don't need it.

---

# 31. PRODUCT DETAIL

Sections:

- Overview
- Variants
- Stock
- Sales/analytics later
- Channel availability later

Quick actions:

- Edit
- Adjust Stock
- Archive

Price/cost visibility follows permissions.

---

# 32. INVENTORY HOME

Show:

- Low Stock
- Out of Stock
- All Stock
- Recent Movements

Search by:

- product
- SKU
- barcode

Never show only one unexplained stock number.

---

# 33. STOCK ADJUSTMENT FLOW

```text
Product
↓
Adjust Stock
↓
Increase / Decrease
↓
Quantity
↓
Reason
↓
Confirm
```

Reasons:

- Stock Count
- Damage
- Correction
- Received Stock
- Other

Show preview:

```text
Current: 20
Adjustment: -2
New: 18
```

Then confirm.

High-risk adjustment may require permission.

---

# 34. INVENTORY HISTORY

Each movement row:

```text
-2 Sale #APSA-1008
+20 Stock Received
-1 Damaged
```

Show:

- actor
- date/time
- reference

This makes stock understandable and auditable.

---

# 35. ORDER LIST

Primary tabs/status filters:

- All
- Pending
- Paid
- Packing
- Delivery
- Completed

Do not expose all backend state names in top navigation.

Use simplified merchant-friendly groups.

Search:

- order number
- customer
- phone

---

# 36. ORDER ROW / CARD

Show:

- order number
- customer
- amount
- source
- payment status
- fulfillment status
- time

Use source icons carefully.

Do not turn every status into a rainbow.

---

# 37. ORDER DETAIL

Order detail should tell the whole story.

Sections:

## Header

- order number
- source
- status

## Customer

- name
- contact
- address

## Items

- product
- variant
- quantity
- price

## Payment

- method
- status

## Delivery

- provider
- tracking
- status

## Timeline

- created
- paid
- packed
- picked up
- delivered

## Internal

- staff
- notes

---

# 38. ORDER STATUS ACTIONS

Show only valid next actions.

Example:

Pending Payment:

- Record Payment
- Edit
- Cancel

Paid:

- Confirm
- Start Packing

Packing:

- Ready for Delivery

Delivered:

- Return/Refund where allowed

Do not show irrelevant buttons for every state.

---

# 39. CANCEL ORDER FLOW

Tap Cancel.

Show:

- reason
- impact summary

Example:

```text
This will:
• release reserved stock
• keep order history
• cancel pending delivery if possible
```

Confirm.

Never delete order.

---

# 40. RETURN FLOW

```text
Order
↓
Return
↓
Choose Items
↓
Quantity
↓
Reason
↓
Inventory Outcome
↓
Refund Decision
↓
Confirm
```

Inventory outcome may include:

- Return to Stock
- Damaged / Do Not Restock

Keep refund separate from physical return logic where necessary.

---

# 41. REFUND FLOW

Refund is high-risk.

Show:

- original payment
- refundable amount
- amount to refund
- reason

If provider/manual:

display correct handling method.

Require permission.

Success should create clear audit/timeline entry.

---

# 42. PAYMENT FLOW FROM ORDER

Order:

**Record Payment**

Bottom sheet:

- method
- amount
- reference optional
- date/time

For manual KHQR/bank confirmation:

explicit action:

**Confirm Payment Received**

Do not automatically infer payment from uploaded screenshot in MVP.

---

# 43. PAYMENT STATUS DISPLAY

Use clear labels:

- Unpaid
- Pending
- Paid
- Refunded
- Failed

Merchant should never need to infer payment state from icons alone.

---

# 44. DELIVERY CREATION FLOW

From paid/confirmed order:

```text
Arrange Delivery
↓
Delivery Form
```

Prefill:

- customer
- phone
- address
- order
- COD amount

Then:

Courier selection.

MVP:

- Manual Courier
- predefined courier names where useful

Later:

live quotes.

---

# 45. MULTI-COURIER FUTURE FLOW

When APIs exist:

```text
Arrange Delivery
↓
Available Couriers
```

Cards:

Courier A

- $0.75
- ETA Tomorrow
- COD supported

Courier B

- $1.00
- Same Day

Allow merchant to compare.

Do not force cheapest provider if reliability is worse.

---

# 46. DELIVERY TRACKING FLOW

Delivery detail:

- courier
- tracking ID
- customer
- address
- COD
- status
- timeline

Timeline:

```text
Requested
Driver Assigned
Picked Up
In Transit
Delivered
```

Failures should clearly show reason.

---

# 47. DELIVERY FAILURE FLOW

When failed:

Display:

**Delivery Failed**

Reason:

- customer unavailable
- wrong address
- rejected
- courier issue
- unknown

Actions:

- Retry Delivery
- Contact Customer
- Cancel
- Edit Address

Do not hide failed deliveries deep in list.

---

# 48. CUSTOMER LIST

Search first.

Show:

- name
- phone masked according to permission
- last order
- order count
- tags

Filters later:

- VIP
- Repeat
- Inactive
- Follow Up

Do not overload MVP.

---

# 49. CUSTOMER PROFILE

Sections:

## Overview

- name
- contact
- tags
- notes

## Summary

- orders
- spend
- last order

## Timeline

- messages
- orders
- payment
- delivery

## Identities

- Facebook
- Instagram
- Telegram
- phone

This is Customer 360.

---

# 50. CUSTOMER EDIT FLOW

Basic edits:

- name
- phone
- email
- tags
- address

Identity linking/merging should be more controlled.

Do not let ordinary edit flow overwrite provider identity IDs.

---

# 51. CUSTOMER MERGE FLOW — FUTURE

When duplicate suspected:

```text
Possible Duplicate
↓
Compare Customer A / B
↓
Choose Primary
↓
Review Data Merge
↓
Confirm
```

Warn that merge affects:

- orders
- conversations
- identities

Must be auditable.

Not MVP unless duplicate problem becomes real.

---

# 52. STAFF INVITE FLOW

```text
MORE
↓
Team
↓
Invite Staff
```

Fields:

- name/email/phone as supported
- role

Role cards:

Manager  
Cashier  
Sales  
Customer Service

Each card explains in plain language.

Example:

**Sales**

Can reply to customers and create orders. Cannot change stock or issue refunds.

---

# 53. STAFF INVITATION SUCCESS

Show:

- invited person
- role
- invitation status

Actions:

- Copy Invite Link if supported
- Resend
- Cancel Invite

Do not expose technical membership IDs.

---

# 54. STAFF DETAIL

Show:

- role
- status
- assigned locations later
- basic activity metrics where permitted

Actions:

- Change Role
- Disable Access
- Remove

High-risk actions should be clear.

---

# 55. CHANGE ROLE FLOW

```text
Staff Detail
↓
Change Role
↓
Select New Role
↓
Permission Summary
↓
Confirm
```

If escalation:

show stronger warning.

Manager must not be able to grant Owner if not permitted.

---

# 56. REMOVE STAFF FLOW

Show impact:

```text
This staff member will immediately lose access to APSA.
Their historical actions/orders remain recorded.
```

Confirm.

Do not delete historical attribution.

---

# 57. WORKSPACE SWITCHING

Top-level workspace/business switcher should be easy to reach.

Example:

Header business name.

Tap:

```text
APSA Beauty
Bao Bao Shop
Creator Inbox
```

Switch.

Do not require logging out.

---

# 58. MULTI-BUSINESS SWITCH FLOW

When switching organization:

- clear previous business context
- load new organization safely
- avoid showing stale previous data
- permissions recalculate

Show current business identity clearly.

Cross-tenant UI confusion is a security risk.

---

# 59. ENABLE SELLING FLOW

Creator user:

```text
Settings / More
↓
Enable Selling
```

Explain:

> Add POS, products, stock, orders, payments and delivery to this workspace.

Then setup:

- business name if needed
- currency
- first location
- first product optional

Existing conversations/contacts remain.

No account migration.

---

# 60. CONNECT SOCIAL CHANNEL FLOW

```text
Settings
↓
Channels
↓
Connect Channel
```

Show supported providers.

Example:

Facebook

Instagram

Telegram

TikTok:

**Coming when supported / available**

Do not falsely present a connection as available.

---

# 61. CHANNEL CONNECTION

Provider flow:

```text
Connect
↓
Official OAuth / Authorization
↓
Return APSA
↓
Choose Page/Account if required
↓
Confirm
↓
Syncing
↓
Connected
```

Show channel health afterward.

---

# 62. CHANNEL HEALTH

Status states:

- Connected
- Syncing
- Reconnect Required
- Error
- Disconnected

If failure:

show action:

**Reconnect**

not technical OAuth errors alone.

---

# 63. INTEGRATION FAILURE UX

Example:

> Facebook connection expired. New messages are not syncing.

Actions:

- Reconnect
- Learn More

This should appear:

- on channel settings
- Inbox warning if actively affecting operations

Do not let merchant unknowingly miss messages.

---

# 64. SAVED REPLY FLOW

Inside conversation:

tap shortcut.

Show:

- Search saved replies
- recent replies

Tap reply.

Insert into composer.

Allow edit before sending.

Do not auto-send immediately.

---

# 65. FOLLOW-UP FLOW

Inside conversation:

tap:

**Follow Up**

Options:

- Later Today
- Tomorrow
- Custom

or simply status in MVP.

Conversation moves to Follow Up queue.

Future:

reminder time.

Keep first implementation lightweight.

---

# 66. ASSIGNMENT FLOW

Inside conversation:

tap assignee.

Show:

- Me
- Unassigned
- Team members

Select.

Update visibly.

Avoid complex routing rules in MVP.

---

# 67. SEARCH UX

Global search later may include:

- customer
- order
- product
- SKU
- phone

For MVP, search within relevant modules.

Search should handle Khmer and English reasonably.

---

# 68. NOTIFICATIONS

Initial in-app notification priorities:

- new assigned conversation
- low stock
- payment/delivery exception
- role/access changes

Avoid notifying for every normal event.

Future:

push.

---

# 69. ANALYTICS FLOW

```text
MORE
↓
Analytics
```

Start with overview.

Cards:

- Sales
- Orders
- Gross Profit
- Average Order

Then:

- Products
- Channels
- Customers
- Team if authorized

Do not present advanced analytics on Home by default.

---

# 70. ANALYTICS DRILLDOWN

Example:

Tap Sales.

Show:

- Today
- 7 Days
- 30 Days
- Custom later

Then chart + totals.

Tap product:

see product performance.

Keep metric definitions consistent.

---

# 71. LOW STOCK FLOW

Home alert:

**3 products low stock**

Tap.

List products.

Product action:

- Receive Stock
- Adjust
- View Product

Future:

Reorder.

---

# 72. RECEIVE STOCK FLOW

```text
Inventory
↓
Receive Stock
↓
Select Product
↓
Quantity
↓
Cost Optional
↓
Supplier Optional later
↓
Confirm
```

Creates inventory movement.

Do not directly replace stock count.

---

# 73. PUBLIC PROFILE SETUP

```text
More
↓
Online Store / Public Profile
```

Setup:

- store name
- logo
- description
- public slug
- contact options

Preview.

Publish.

Reuse existing products.

---

# 74. PRODUCT PUBLISH FLOW

Product detail:

toggle:

**Show on Online Store**

Future channels:

Marketplace  
Swipe

Do not make merchant duplicate product.

---

# 75. PUBLIC STORE CUSTOMER FLOW — EARLY

```text
Merchant Link
↓
Store Profile
↓
Browse Products
↓
Product Detail
↓
Contact / Order Inquiry
```

Full checkout later.

The first goal is merchant web presence, not marketplace complexity.

---

# 76. LANGUAGE SWITCH FLOW

Settings:

Language:

- Khmer
- English

Switch should update interface immediately where possible.

Do not require new account/session.

Business data names may remain multilingual according to stored values.

---

# 77. CURRENCY UX

Default merchant currency selection during setup.

When displaying money:

Use clear formatting.

Support:

- USD
- KHR

Do not mix currencies ambiguously.

If conversion shown later:

display rate/context.

---

# 78. ERROR STATE STANDARD

Every major page should define:

- Loading
- Empty
- Error
- Permission Denied
- Offline/Connection issue
- Success

Never leave blank content.

---

# 79. EMPTY STATE STANDARD

Empty state should teach next action.

Bad:

```text
No products.
```

Better:

```text
No products yet.
Add your first product to start selling.
[Add Product]
```

---

# 80. PERMISSION DENIED UX

Do not say:

`403 Forbidden`

to normal merchant.

Say:

> You don't have permission to do this.

Optionally:

> Ask your Owner or Manager.

Do not expose sensitive resource details.

---

# 81. VALIDATION UX

Validation should happen near field.

Example:

Phone invalid.

Show message below phone field.

Do not show one generic top-of-page error for every form mistake.

---

# 82. NETWORK FAILURE UX

If saving fails:

Do not silently discard user's work.

Show:

> Couldn't save. Check your connection and try again.

Retry.

Preserve entered form data.

---

# 83. DUPLICATE ACTION UX

If user taps Create Order twice:

UI should disable/reveal progress.

Backend still handles idempotency.

Never rely only on disabled button.

---

# 84. LOADING UX

For quick actions:

button loading state.

For page loads:

skeletons.

Avoid full-screen spinners for every interaction.

---

# 85. SUCCESS FEEDBACK

Use lightweight success feedback.

Examples:

- Order created
- Stock updated
- Payment recorded

Do not show large celebratory animations for routine business operations.

---

# 86. DESTRUCTIVE ACTION STANDARD

For actions such as:

- refund
- cancel delivery
- remove staff
- archive product
- delete organization

Use:

- clear action label
- consequence explanation
- confirmation

Critical actions may require re-auth later.

---

# 87. MOBILE SHEET VS PAGE RULE

Use bottom sheets for:

- quick status change
- assignment
- add tag
- quick order
- payment record
- basic filter

Use full page for:

- complex product edit
- organization settings
- analytics detail
- advanced permission management
- customer full profile

---

# 88. MOBILE TOUCH TARGETS

All important actions should have comfortable tap size.

Avoid tiny:

- icons
- checkboxes
- inline links

especially within operational flows used rapidly.

---

# 89. DESKTOP UX

Desktop can use:

- sidebar
- split Inbox
- tables
- multi-column detail

But workflow and concepts must remain identical.

Desktop is enhancement, not separate product logic.

---

# 90. INBOX DESKTOP

Recommended:

```text
Conversation List | Conversation | Customer/Order Context
```

Three-pane if screen permits.

Mobile:

single pane + sheets.

Same data/actions.

---

# 91. KEYBOARD / POWER USER SUPPORT — LATER

Desktop merchants may benefit from:

- keyboard search
- shortcuts
- barcode scanning
- quick commands

Not necessary for initial mobile-first MVP.

---

# 92. ACCESSIBILITY

UX flows must support:

- keyboard navigation where applicable
- visible focus
- semantic buttons
- labels
- screen-reader meaning
- status beyond color

Do not sacrifice accessibility for visual minimalism.

---

# 93. KHMER UX RULE

Khmer text needs more space.

Do not lock components to English-only heights.

Check:

- buttons
- tabs
- badges
- cards
- table cells
- navigation

No clipped Khmer text.

---

# 94. NOTIFICATION COPY

Operational copy should be direct.

Examples:

Good:

> Payment confirmed.

> 3 orders are ready for delivery.

> Facebook needs to be reconnected.

Avoid:

> Awesome! Your spectacular payment journey is complete!

APSA is business software.

---

# 95. MVP UX PRIORITY

## MUST PERFECT

- onboarding
- mobile navigation
- Inbox
- conversation
- Message → Order
- POS
- order detail
- payment
- delivery
- customer history
- stock adjustment

## SHOULD BE STRONG

- analytics
- staff invite
- product setup
- public profile
- workspace switching

## LATER

- marketplace
- Swipe
- advanced automation
- complex campaigns
- supplier tools
- custom role builder

---

# 96. USER TEST SCRIPT — FIRST MERCHANTS

Give merchant phone with APSA.

Ask them to:

1. create business;
2. add product;
3. create stock;
4. process POS sale;
5. open customer message;
6. create order from message;
7. mark payment;
8. arrange delivery;
9. find customer history;
10. identify low stock.

Do not guide unless necessary.

Record where they hesitate.

Hesitation is UX data.

---

# 97. UX SUCCESS METRICS

Possible early metrics:

- onboarding completion rate
- time to first product
- time to first order
- time from message to order
- POS checkout completion
- failed/abandoned forms
- repeated back navigation
- support questions
- weekly use of Inbox/POS/Orders

Do not optimize only for clicks.

---

# 98. CHAT → ORDER TARGET

This workflow should eventually feel faster than merchant's current manual process.

Target product principle:

From active conversation to created order:

**few taps, no duplicate typing.**

This is more important than fancy visual effects.

---

# 99. HOME TARGET

Merchant should understand:

> What requires my attention?

within approximately a few seconds.

Do not make them interpret complex dashboards.

---

# 100. OWNER VS STAFF UX

Owner Home emphasizes:

- business health
- money
- team
- problems

Staff Home emphasizes:

- assigned work
- orders
- conversations
- actions

Do not show identical dashboard to every role.

---

# 101. CREATOR VS BUSINESS UX

Creator:

simple messaging-first interface.

Business:

commerce-first operational tools.

Same platform.

Do not show disabled irrelevant modules everywhere.

Use workspace capabilities to simplify experience.

---

# 102. FEATURE DISCOVERY

New features should appear contextually.

Example:

Merchant creates many deliveries.

Then APSA may suggest:

> Connect a courier to automate tracking.

Do not show every future feature during first login.

---

# 103. UPGRADE UX — FUTURE

When organization reaches limit:

Explain:

- what limit was reached
- current usage
- what upgrade unlocks

Do not aggressively block critical business records unexpectedly.

Billing behavior must be predictable.

---

# 104. DATA PRIVACY UX

When collecting marketing consent:

Clearly distinguish:

- merchant updates
- APSA platform marketing

Do not pre-check consent deceptively.

---

# 105. SENSITIVE FIELD UX

If role lacks full phone access:

show masked version.

Example:

`012 *** 789`

If action requires full phone:

permission determines access.

Do not download all sensitive data to frontend then hide it.

---

# 106. SECURITY EVENT UX

If user's access changes:

Show:

> Your permissions were updated.

If removed:

session should lose business access safely.

Do not reveal internal security implementation.

---

# 107. SESSION EXPIRY UX

If session expires during form:

preserve draft if safe.

Ask user to sign in again.

Then restore workflow where possible.

Especially important for long product/order forms.

---

# 108. DUPLICATE CUSTOMER UX

During customer creation, if exact phone match:

show:

> A customer with this phone may already exist.

Actions:

- View Existing
- Create Anyway if business rules allow

Do not automatically merge without certainty.

---

# 109. OUT-OF-STOCK UX

If product unavailable:

Show:

**Out of Stock**

Do not allow staff to accidentally sell unavailable inventory if strict stock policy is enabled.

Possible action:

- Override if permission/policy allows

Audit override.

---

# 110. RESERVED STOCK UX

If stock:

On hand: 10  
Reserved: 7  
Available: 3

Staff should see **Available: 3** prominently.

Do not confuse merchant by selling from on-hand count only.

---

# 111. ORDER SOURCE UX

Source should appear subtly:

Facebook  
Instagram  
POS  
Telegram

Useful for context and analytics.

Do not make source more visually important than order state.

---

# 112. CUSTOMER TIMELINE UX

Timeline entries should be human-readable.

Example:

```text
Today, 2:10 PM
Payment confirmed — $18

1:55 PM
Order #APSA-1028 created from Instagram

1:42 PM
Instagram message received
```

Do not display raw event names.

---

# 113. AUDIT UX

Owner-facing audit history should say:

```text
Sokha changed stock
Black / M
20 → 18
Reason: Damaged
```

not:

```text
inventory.movement_created
```

Translate technical events into useful business language.

---

# 114. DESIGN CONSISTENCY RULE

The same action should have the same interaction pattern.

Example:

Status changes should not be:

- dropdown on Orders
- swipe on Delivery
- hidden menu on Inbox

unless context genuinely requires different pattern.

Consistency reduces training cost.

---

# 115. USER INTERRUPTION RULE

If merchant leaves a flow accidentally:

Preserve:

- cart
- draft order
- draft product
- unsent message

where safe and practical.

Operational apps lose trust when work disappears.

---

# 116. CONFIRMATION FATIGUE

Do not confirm every normal action.

Confirm:

- destructive
- financial
- irreversible
- unusually high-risk

Do not ask:

"Are you sure?"

after every product addition or tag change.

---

# 117. STATUS LANGUAGE

Backend may use:

`PENDING_PAYMENT`

UI should display:

**Waiting Payment**

or approved localized phrase.

Keep backend states stable while UX copy remains understandable.

---

# 118. UI COPY STANDARD

Use short action verbs:

- Add Product
- Create Order
- Record Payment
- Arrange Delivery
- Follow Up
- Invite Staff

Avoid vague:

- Proceed
- Submit
- Continue

where a specific action can be named.

---

# 119. FUTURE AI UX

AI should appear inside existing workflows.

Examples:

Conversation:

**Summarize**

**Suggest Reply**

Order:

**Extract Order from Chat**

Analytics:

**Ask APSA**

Do not create a giant separate "AI page" as the primary product.

AI should reduce work.

---

# 120. AI CONFIRMATION UX

For AI-extracted order:

Show draft:

```text
Black Shirt
Size M
Qty 2
```

User reviews.

Then:

**Create Order**

AI must not silently place commerce transactions.

---

# 121. FUTURE AUTOMATION UX

Automation setup later:

```text
When
Payment is confirmed

If
Order > $50

Then
Notify Manager
```

Use plain business language.

Do not expose event-bus terminology to merchants.

---

# 122. FUTURE MARKETPLACE UX PRINCIPLE

Merchant should publish existing products.

Flow:

```text
Product
↓
Sell on Marketplace
↓
Review Listing
↓
Publish
```

No duplicate catalog setup.

---

# 123. FUTURE SWIPE DEAL UX

Merchant:

```text
Product
↓
Create Clearance Deal
↓
Discount
↓
Quantity
↓
Publish to Swipe Deals
```

Consumer:

swipe/browse deals.

Existing inventory/order system remains behind it.

---

# 124. FUTURE MULTI-LOCATION UX

When enabled:

business switch remains organization-level.

Location filter/switch used for:

- POS
- stock
- orders
- analytics

Owner can choose:

All Locations.

Avoid forcing single-location merchants to constantly see location controls.

---

# 125. FUTURE WHOLESALE UX

Wholesale mode later may add:

- pricing tiers
- MOQ
- credit

Do not expose these controls to normal retail sellers.

---

# 126. UX ANTI-PATTERNS — FORBIDDEN

Do NOT:

- put 12 bottom-nav items
- force full onboarding before value
- require duplicate customer entry
- make Message → Order navigate through many screens
- hide payment state
- hide delivery failures
- use desktop tables as mobile UI
- expose technical provider errors to normal merchants
- use unexplained icons for critical actions
- ask confirmation for every small change
- let staff see sensitive fields simply because API already returned them
- force users to understand backend status names
- build a separate UX logic for future native app
- show every future module to MVP users

---

# 127. CLAUDE CODE UX REQUIREMENTS

Before implementing a major screen/flow, Claude Code must read:

- `APSA_MASTER_PLAN.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `MVP_ROADMAP.md`
- `DATA_MODEL.md`
- `API_AND_EVENTS.md`
- `PERMISSIONS_MATRIX.md`
- `UX_FLOWS.md`

For each flow, Claude should verify:

1. mobile path;
2. loading state;
3. empty state;
4. error state;
5. permission state;
6. success state;
7. back/cancel behavior;
8. data preservation;
9. tenant safety;
10. accessibility;
11. Khmer layout;
12. analytics/event requirements.

---

# 128. LOVABLE REQUIREMENTS

Lovable should use this document as the UX behavior source of truth.

Lovable may improve visual presentation.

It must not change core workflow meaning without documenting the reason.

Priority prototype flows:

1. onboarding
2. Home
3. Inbox
4. Conversation
5. Message → Order
6. POS
7. Product
8. Inventory
9. Orders
10. Payment
11. Delivery
12. Customer 360
13. Staff invite
14. Workspace switching

---

# 129. CODEX UX REVIEW

Codex should inspect implemented flows for:

- unnecessary steps
- broken mobile navigation
- missing errors
- state loss
- duplicate form entry
- invalid status actions
- permission leaks
- inaccessible controls
- mismatched frontend/backend state
- regressions from desktop/mobile responsive logic

---

# 130. DEFINITION OF UX SUCCESS

APSA UX succeeds when:

- a new merchant understands where to start;
- common daily tasks require very few actions;
- messages turn into orders naturally;
- POS feels fast;
- staff know what needs attention;
- owners understand business health quickly;
- payments and deliveries are never ambiguous;
- customer history reduces mistakes;
- mobile feels first-class;
- Khmer feels native, not translated afterward;
- permissions simplify the interface;
- users can recover from errors;
- future capabilities can appear progressively without cluttering MVP.

---

# 131. FINAL UX PRINCIPLE

APSA should not feel powerful because it shows users more controls.

It should feel powerful because:

> **the system already understands the context and gives the user the right next action.**

That principle should guide every APSA screen and workflow.
