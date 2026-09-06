# APSA — PERMISSIONS MATRIX

**Document:** `PERMISSIONS_MATRIX.md`  
**Project:** APSA  
**Status:** Source of truth for role-based access control (RBAC)  
**Purpose:** Define exactly what each merchant role can see and do  
**Security principle:** UI visibility is not authorization. Every permission must be enforced server-side and, where appropriate, at the database/RLS layer.

---

# 1. PURPOSE

This document defines the default APSA role and permission model for MVP.

APSA must support small businesses simply at first, while remaining ready for larger teams later.

The permission system must be:

- granular;
- tenant-safe;
- understandable;
- auditable;
- location-aware later;
- reusable across web and future native apps;
- independent from subscription plan names.

Do not hard-code business logic around role names alone.

Use:

**Role → Permissions**

---

# 2. DEFAULT MVP ROLES

Initial default roles:

1. OWNER
2. MANAGER
3. CASHIER
4. SALES
5. CUSTOMER_SERVICE

Future roles may include:

- WAREHOUSE
- ACCOUNTANT
- MARKETING
- DELIVERY_OPERATOR
- CUSTOM_ROLE

Do not build all future role UI now.

Architecture must allow them later.

---

# 3. ROLE PHILOSOPHY

## OWNER

Full merchant control.

Should have access to:

- company configuration
- staff
- financials
- permissions
- sensitive exports
- refunds
- integrations

Owner actions remain audited.

---

## MANAGER

Runs day-to-day business.

Broad operational access.

Should not automatically receive every owner-level security privilege.

Examples of Owner-only or separately restricted functions:

- ownership transfer
- organization deletion
- sensitive credential management
- highest-risk exports
- changing owner permissions

---

## CASHIER

Focused on physical sales and basic customer/order tasks.

Should not see:

- business profit if not allowed;
- employee performance details;
- customer bulk exports;
- integration credentials;
- sensitive settings.

---

## SALES

Handles conversations and turns customers into orders.

Needs:

- customer context
- products
- stock availability
- order creation
- payment status visibility where needed

Usually should not:

- adjust stock arbitrarily;
- process refunds;
- see full profit/cost information.

---

## CUSTOMER SERVICE

Handles conversations, follow-up and customer support.

Needs:

- Inbox
- customer history
- order/delivery status
- notes/tags

Usually should not:

- change prices;
- confirm financial payments unless explicitly granted;
- adjust stock;
- issue refunds.

---

# 4. PERMISSION NAMING STANDARD

Use:

```text
domain.action
```

Examples:

```text
orders.read
orders.create
orders.cancel
orders.refund
inventory.adjust
messages.reply
financials.profit
```

Keep keys stable.

Never make frontend depend only on translated role labels.

---

# 5. PERMISSION LEVELS

The matrix below uses:

- ✅ = allowed by default
- ⚠️ = limited / conditional / may require approval or configuration
- ❌ = denied by default

Custom roles may override defaults later.

---

# 6. ORGANIZATION & WORKSPACE

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `organization.read` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| `organization.update_basic` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `organization.update_sensitive` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `organization.delete` | ✅* | ❌ | ❌ | ❌ | ❌ |
| `workspace.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `workspace.manage` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `location.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `location.manage` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

`organization.delete` should require re-authentication and strong confirmation.

---

# 7. TEAM & MEMBERSHIP

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `team.read` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `team.invite` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `team.remove` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `team.update_role` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `team.disable_member` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `roles.read` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `roles.manage` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `permissions.read` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `permissions.manage` | ✅ | ❌ | ❌ | ❌ | ❌ |

Manager must never be able to grant themselves or others permissions above their own effective authority.

---

# 8. CUSTOMER ACCESS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `customers.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `customers.create` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `customers.update_basic` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `customers.add_note` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `customers.tag` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `customers.view_sensitive` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| `customers.export` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `customers.export_sensitive` | ✅* | ❌ | ❌ | ❌ | ❌ |
| `customers.merge` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `customers.archive` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |

Sensitive fields can include:

- phone
- email
- full address

Visibility may later be field-masked by role.

---

# 9. CUSTOMER CONSENT

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `consent.read` | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| `consent.record` | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| `consent.revoke` | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| `consent.override` | ❌ by default | ❌ | ❌ | ❌ | ❌ |

No role should be allowed to invent consent manually without proper evidence/source.

---

# 10. INBOX / CONVERSATIONS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `messages.read` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `messages.reply` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `messages.assign` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| `messages.reassign_self` | ✅ | ✅ | ❌ | ✅ | ✅ |
| `messages.mark_followup` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `messages.close_conversation` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `messages.view_all_team` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| `messages.delete_local_note` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |

External-provider message deletion must follow provider rules and should not be treated as a normal APSA destructive action.

---

# 11. SAVED REPLIES

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `saved_replies.read` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `saved_replies.use` | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| `saved_replies.create` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| `saved_replies.manage` | ✅ | ✅ | ❌ | ❌ | ❌ |

---

# 12. PRODUCTS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `products.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `products.create` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `products.update_basic` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `products.update_price` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `products.view_cost` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `products.update_cost` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `products.archive` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `products.manage_categories` | ✅ | ✅ | ❌ | ❌ | ❌ |

Cost should remain restricted because it directly affects profit visibility.

---

# 13. INVENTORY

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `inventory.read` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `inventory.view_movements` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| `inventory.adjust` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `inventory.receive_stock` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `inventory.mark_damage` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `inventory.transfer` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `inventory.override_reservation` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

Every manual adjustment requires:

- actor
- quantity
- reason
- timestamp
- audit trail

---

# 14. ORDERS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `orders.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `orders.create` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `orders.update_before_confirm` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `orders.confirm` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `orders.cancel` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| `orders.change_price` | ✅ | ⚠️ | ⚠️* | ⚠️* | ❌ |
| `orders.apply_discount` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| `orders.large_discount` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `orders.return` | ✅ | ✅ | ⚠️ | ❌ | ⚠️ |
| `orders.refund` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

Cashier/Sales price changes should be limited by configured rules later.

Example:

Discount ≤ 10%.

---

# 15. CHAT → ORDER

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `chat_order.create` | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| `chat_order.edit` | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| `chat_order.confirm` | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |

This is one of APSA's core workflows.

Permissions should not make it unnecessarily slow for Sales staff.

---

# 16. POS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `pos.access` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `pos.create_sale` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `pos.apply_discount` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| `pos.custom_price` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `pos.void_sale` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| `pos.reprint_receipt` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `pos.open_cash_session` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `pos.close_cash_session` | ✅ | ✅ | ✅ | ❌ | ❌ |

Cash-drawer sessions can be implemented later.

---

# 17. PAYMENTS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `payments.read` | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| `payments.record` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `payments.manual_confirm` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| `payments.mark_cod` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `payments.refund` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `payments.override_status` | ✅* | ❌ | ❌ | ❌ | ❌ |
| `payments.view_provider_reference` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| `payments.verify` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `payments.reverse` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `payments.reconcile` | ✅ | ✅ | ❌ | ❌ | ❌ |

`payments.verify`, `payments.reverse` and `payments.reconcile` were added by the
Payment Domain foundation phase (migration `036_payment_permissions.sql`) to make the
verification model's finer distinctions enforceable: `payments.verify` gates escalating
a payment past staff-level confirmation (manager re-confirmation, a future bank-adapter
result, or flagging/clearing a mismatch or suspected duplicate) — the same Owner+Manager
tier as `payments.view_provider_reference`; `payments.reverse` gates voiding a claimed or
settled payment outright — the same Owner-only tier as `payments.refund` and
`payments.override_status`; `payments.reconcile` gates the read-only organization-wide
reconciliation aggregate — the same Owner+Manager tier as `financials.revenue` (§18).

Manual confirmation and override should always be audited.

---

# 18. FINANCIALS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `financials.revenue` | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| `financials.cost` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `financials.profit` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `financials.refunds` | ✅ | ✅ | ⚠️ | ❌ | ⚠️ |
| `financials.export` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

Manager profit visibility should be configurable by owner.

---

# 19. DELIVERY

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `delivery.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `delivery.create` | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| `delivery.update_manual_status` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| `delivery.cancel` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| `delivery.view_cost` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `delivery.view_margin` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `delivery.manage_provider` | ✅ | ❌ | ❌ | ❌ | ❌ |

---

# 20. COD

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `cod.read` | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| `cod.record` | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `cod.settlement_read` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `cod.settlement_adjust` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

COD settlement adjustments must be audited.

---

# 21. ANALYTICS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `analytics.basic` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| `analytics.sales` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| `analytics.products` | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| `analytics.customers` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| `analytics.staff` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `analytics.profit` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

Users should see only analytics relevant to their job.

---

# 22. STAFF PERFORMANCE

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `staff_metrics.read_team` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `staff_metrics.read_self` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `staff_metrics.export` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

A staff member can see their own performance where product UX supports it.

---

# 23. PROMOTIONS / CRM — FUTURE

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `crm.segments.read` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| `crm.segments.manage` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `crm.campaigns.create` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `crm.campaigns.send` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `crm.campaigns.analytics` | ✅ | ✅ | ❌ | ❌ | ❌ |

Campaign send is higher risk because it can contact large customer groups.

---

# 24. MINI STORE / PUBLIC PROFILE

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `storefront.read_settings` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `storefront.manage` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `storefront.publish_product` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `storefront.change_slug` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

Future custom domains may be owner-only.

---

# 25. SOCIAL / PROVIDER INTEGRATIONS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `integrations.read` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `integrations.connect` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `integrations.disconnect` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `integrations.reauthenticate` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `integrations.view_health` | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| `integrations.manage_credentials` | ✅* | ❌ | ❌ | ❌ | ❌ |

No role should ever see raw provider secret values in normal UI.

---

# 26. API ACCESS — FUTURE

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `api_keys.read` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `api_keys.create` | ✅* | ❌ | ❌ | ❌ | ❌ |
| `api_keys.revoke` | ✅* | ❌ | ❌ | ❌ | ❌ |
| `webhooks.manage` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

API secrets are high-risk.

---

# 27. SUBSCRIPTION & BILLING

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `billing.read` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `billing.manage_plan` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `billing.payment_method` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `billing.invoices` | ✅ | ⚠️ | ❌ | ❌ | ❌ |

---

# 28. AUDIT LOG

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `audit.read` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `audit.read_sensitive` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `audit.export` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `audit.modify` | ❌ | ❌ | ❌ | ❌ | ❌ |

Normal merchant users must never edit audit history.

---

# 29. DATA EXPORTS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `exports.products` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `exports.orders` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `exports.inventory` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `exports.financials` | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| `exports.customers_sensitive` | ✅* | ❌ | ❌ | ❌ | ❌ |

Sensitive exports should require:

- re-authentication later;
- audit log;
- secure temporary file;
- expiration.

---

# 30. SETTINGS

| Permission | Owner | Manager | Cashier | Sales | Customer Service |
|---|---:|---:|---:|---:|---:|
| `settings.read` | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| `settings.business_basic` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `settings.order_workflow` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `settings.inventory` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `settings.financial` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `settings.security` | ✅ | ❌ | ❌ | ❌ | ❌ |

---

# 31. SECURITY SETTINGS

Owner-only by default:

```text
security.manage_mfa
security.manage_sessions
security.manage_export_controls
security.manage_sensitive_access
security.view_security_events
```

Internal APSA admin security is separate from merchant security.

---

# 32. LOCATION-SCOPED PERMISSIONS — FUTURE-READY

A user may have a permission but only for certain locations.

Example:

```text
inventory.read
```

with scope:

```text
BKK1 Store only
```

Manager:

```text
Orders: all BKK1
Inventory: all BKK1
Financials: BKK1 only
```

Owner:

all locations.

Architecture should support:

```text
permission + scope
```

Do not make all permissions organization-wide forever.

---

# 33. OWN-RECORD VS TEAM-RECORD ACCESS — FUTURE

Some permissions may later include scope such as:

- SELF
- ASSIGNED
- LOCATION
- WORKSPACE
- ORGANIZATION

Example:

Sales employee may see:

```text
messages.read = ASSIGNED
```

while Manager receives:

```text
messages.read = ORGANIZATION
```

This is more scalable than creating dozens of special permissions.

Do not expose this complexity in MVP role UI unless needed.

---

# 34. PERMISSION RISK LEVELS

Classify permissions:

## LOW

Examples:

```text
products.read
delivery.read
```

## MEDIUM

Examples:

```text
orders.create
messages.reply
customers.update_basic
```

## HIGH

Examples:

```text
inventory.adjust
payments.manual_confirm
team.remove
```

## CRITICAL

Examples:

```text
orders.refund
customers.export_sensitive
roles.manage
api_keys.create
organization.delete
```

Critical actions may later require:

- re-authentication;
- owner approval;
- MFA;
- reason.

---

# 35. HIGH-RISK ACTION AUDIT

At minimum audit:

- role/permission change
- employee removal
- stock adjustment
- refund
- manual payment confirmation
- payment override
- large discount
- customer-sensitive export
- provider connection/disconnection
- API key creation/revocation
- organization deletion

---

# 36. APPROVAL WORKFLOW — FUTURE

Larger merchants may need:

Employee requests:

$300 refund

↓

Manager approves

↓

Refund processed

Do not build approval engine into initial MVP.

But permission architecture must not prevent it.

Possible future permissions:

```text
refund.request
refund.approve
```

---

# 37. DISCOUNT CONTROL — FUTURE

Owner may configure:

Cashier:

```text
max_discount_percent = 10
```

Manager:

```text
max_discount_percent = 30
```

Owner:

unlimited according to policy.

This should be implemented as policy/configuration, not dozens of permissions.

---

# 38. FINANCIAL PRIVACY

Not every employee should know:

- product cost
- gross profit
- company-wide revenue
- courier margin

Keep operational visibility separate from sensitive financial visibility.

Example:

Sales can see:

Product price = $15.

Should not necessarily see:

Product cost = $4.

---

# 39. CUSTOMER PRIVACY

A Customer Service staff member may need:

- customer phone for active support/delivery

But may not need:

- bulk customer export
- full customer database download

Field visibility and export capability must remain separate permissions.

---

# 40. DELETED/DISABLED MEMBERS

When membership becomes:

```text
DISABLED
REMOVED
```

all organization access must stop immediately.

Do not rely only on removing their navigation.

Existing sessions must respect updated membership state.

---

# 41. OWNER PROTECTION

APSA should prevent accidental lockout.

Rules:

- organization must retain at least one valid owner;
- non-owner cannot remove final owner;
- manager cannot promote themselves to owner;
- ownership transfer requires secure workflow;
- final owner removal requires transfer or organization closure.

---

# 42. ROLE ESCALATION PREVENTION

A Manager with:

```text
team.update_role
```

must not grant a user:

```text
OWNER
```

unless policy explicitly permits it.

A user cannot grant permissions they do not possess.

This must be validated server-side.

---

# 43. SUBSCRIPTION VS PERMISSION

Important distinction:

Entitlement:

> Does this organization have access to this feature?

Permission:

> Can this user use that available feature?

Example:

Business plan includes Advanced Analytics.

Then:

Organization entitlement:

```text
advanced_analytics = true
```

Manager permission:

```text
analytics.advanced = true
```

Cashier:

```text
analytics.advanced = false
```

Both checks may be required.

---

# 44. FEATURE FLAG VS PERMISSION

Feature flag:

> Is feature rolled out?

Entitlement:

> Has organization purchased/received it?

Permission:

> Can this person use it?

Example:

```text
feature flag
↓
entitlement
↓
permission
↓
business rule
```

Keep these separate.

---

# 45. CREATOR / INBOX WORKSPACE

Creator workspace primarily exposes:

- Inbox
- contacts
- team
- insights
- settings

If commerce disabled:

even Owner should not see irrelevant commerce modules.

This is workspace capability, not a lack of permission.

After:

**Enable Selling**

commerce entitlements/features become available without changing account identity.

---

# 46. BUSINESS WORKSPACE

Business workspace can expose:

- Inbox
- POS
- products
- inventory
- orders
- payment
- delivery
- customers
- analytics

Role permissions then determine access.

---

# 47. PERMISSION CHECKING FLOW

Every sensitive command should conceptually evaluate:

```text
Authenticated?
↓
Active Membership?
↓
Correct Organization?
↓
Feature Available?
↓
Entitlement Allows?
↓
Permission Allows?
↓
Scope Allows?
↓
Business Rule Allows?
↓
Execute
↓
Audit if required
```

Do not skip layers.

---

# 48. AUTHORIZATION SERVICE

Centralize authorization.

Avoid random checks like:

```text
if user.role === "manager"
```

throughout the code.

Preferred concept:

```text
AuthorizationService.can(
  user,
  "orders.refund",
  context
)
```

or equivalent.

This provides:

- consistency
- testing
- future scope support
- easier native API reuse

---

# 49. DATABASE/RLS

Where RLS is used:

it should reinforce tenant isolation.

Do not attempt to encode every complex business permission entirely in unreadable RLS if application authorization is a better layer.

Use defense in depth.

---

# 50. PERMISSION SEED DATA

Default permission keys should be version-controlled.

Do not manually create them differently in staging and production.

Use migrations/seeds.

---

# 51. SYSTEM ROLES

Default roles should be seeded as system role templates.

Merchant may later create custom roles.

System role behavior can evolve carefully through migrations/versioning.

Do not unexpectedly grant new dangerous permissions to existing roles during upgrades.

---

# 52. NEW PERMISSION MIGRATION RULE

Whenever Claude adds a new permission:

it must determine:

1. permission key;
2. description;
3. risk level;
4. which default roles receive it;
5. whether audit is required;
6. whether RLS/data scope changes;
7. whether existing users gain access automatically.

Never add permissions silently.

---

# 53. PERMISSION TESTING

Automated tests must include:

### Owner

Can perform expected owner actions.

### Manager

Cannot perform Owner-only actions.

### Cashier

Cannot access cost/profit/customer exports.

### Sales

Cannot adjust inventory or refund payments by default.

### Customer Service

Cannot change product prices or financial settings.

---

# 54. CROSS-TENANT TESTS

Regardless of role:

Owner of Organization A

must never access:

Organization B.

Even Owner permission cannot cross tenant boundaries.

Tenant ownership comes before role privilege.

---

# 55. LOCATION TESTS — WHEN IMPLEMENTED

Example:

Manager assigned only Location A.

Attempt:

```text
GET Location B orders
```

Expected:

Denied.

Even if:

```text
orders.read = true
```

because scope fails.

---

# 56. FIELD-LEVEL RESPONSE CONTROL

Some API responses may need conditional fields.

Example Product:

Cashier response:

```text
name
sku
selling_price
stock
```

Owner response:

```text
name
sku
selling_price
cost
profit
stock
```

Do not rely only on hiding cost in React after API returns it.

Sensitive fields should not be over-returned.

---

# 57. ACTION REASONS

Some high-risk actions should require reason text or reason codes.

Examples:

- stock adjustment
- refund
- payment override
- large discount
- manual delivery correction

Reason becomes part of audit trail.

---

# 58. UI PRINCIPLE

Do not overwhelm merchant with “Permission Settings” during simple onboarding.

Default roles should work immediately.

Advanced custom permissions can be exposed later.

Small businesses need simplicity.

Architecture needs granularity.

---

# 59. MVP ROLE UX

When inviting staff:

Merchant selects:

**Manager**

Can manage most daily operations.

**Cashier**

POS and sales.

**Sales**

Chats + orders.

**Customer Service**

Chats + support.

Then show a short human-readable summary.

Avoid showing 80 checkboxes.

---

# 60. CUSTOM ROLE — LATER

Future:

Create Role:

“Warehouse Supervisor”

Select permissions.

Potential scopes:

- warehouse only
- inventory
- transfers
- orders read

Do not build custom role builder until real merchant need.

---

# 61. TEMPORARY ACCESS — FUTURE

Possible later:

Staff receives elevated permission for:

2 hours

or support receives temporary business access.

This can reduce permanent privilege.

Not MVP.

---

# 62. INTERNAL APSA ROLES

APSA company/admin roles must NOT use merchant role model directly.

Separate internal permission domain.

Potential internal roles:

- SUPPORT
- OPERATIONS
- ENGINEERING
- FINANCE
- SECURITY
- PLATFORM_ADMIN

All sensitive access audited.

Do not make `OWNER` mean platform superadmin.

---

# 63. IMPERSONATION — FUTURE

If APSA support ever needs “view as merchant” capability:

it must be:

- explicit;
- time-limited;
- strongly authenticated;
- permission restricted;
- visibly indicated;
- fully audited.

Never create hidden impersonation.

---

# 64. EMERGENCY ACCESS — FUTURE

If emergency/break-glass admin access is ever introduced:

require:

- strong MFA;
- reason;
- incident reference;
- alerting;
- audit;
- review afterward.

Do not implement casual universal admin.

---

# 65. PERMISSION ANTI-PATTERNS — FORBIDDEN

Do NOT:

- rely only on hidden buttons;
- trust role name sent by frontend;
- allow managers to grant more privilege than themselves;
- expose customer export to all staff;
- expose product cost to everyone;
- allow unrestricted stock adjustments;
- allow arbitrary payment status changes;
- use `OWNER` as platform superadmin;
- let removed employees keep sessions/access;
- couple subscription plan names directly to authorization;
- assume organization permission means every location forever;
- return sensitive fields then simply hide them in UI.

---

# 66. MVP PERMISSION PRIORITY

## MUST NOW

Implement:

- permission keys
- default system roles
- role-permission mapping
- membership role
- centralized authorization
- tenant checks
- owner protection
- staff removal enforcement
- high-risk action auditing
- tests

## SHOULD NOW

- basic location-aware foundation
- sensitive field filtering
- discount configuration hooks

## LATER

- custom roles
- approval workflows
- temporary privilege
- fine-grained SELF/ASSIGNED/LOCATION scopes
- enterprise SSO roles
- advanced policy engine

---

# 67. CLAUDE CODE REQUIREMENTS

Before implementing RBAC Claude Code must read:

- `APSA_MASTER_PLAN.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `MVP_ROADMAP.md`
- `DATA_MODEL.md`
- `API_AND_EVENTS.md`
- `PERMISSIONS_MATRIX.md`

Claude must report:

1. permission keys added;
2. system roles;
3. role-permission seed mappings;
4. authorization service design;
5. tenant checks;
6. RLS implications;
7. location-scope preparation;
8. sensitive response filtering;
9. audit events;
10. test matrix.

Claude must not simplify RBAC to:

```text
user.role === "admin"
```

---

# 68. CODEX REVIEW REQUIREMENTS

Codex should independently test for:

- privilege escalation;
- manager becoming owner;
- cashier accessing profit;
- sales adjusting inventory;
- customer-service issuing refund;
- removed staff retaining access;
- cross-tenant access;
- API returning hidden sensitive fields;
- direct endpoint calls bypassing UI;
- missing audit for high-risk actions.

---

# 69. DEFINITION OF SUCCESS

The APSA permission architecture succeeds when:

- small businesses can choose a simple staff role in seconds;
- staff see only what they need;
- owners retain business control;
- managers can operate without becoming hidden superadmins;
- financial and customer-sensitive information remains protected;
- permissions work identically on web and future native clients;
- UI cannot bypass backend rules;
- future multi-location businesses can scope access cleanly;
- custom roles can be added later without rewriting the authorization system;
- every high-risk action remains accountable.

---

# 70. FINAL RULE

APSA should make permissions feel simple to merchants while keeping the underlying authorization model powerful.

The user should experience:

> “I choose what this employee can do.”

The engineering system should enforce:

> **Every action is tenant-scoped, permission-checked, scope-aware, auditable, and secure.**
