# APSA — Architecture notes

Not for Lovable. This file goes into the repo for Claude Code and Codex at the production stage. It holds everything from the original brief that is about *not foreclosing options later* — instructions that would only cause a prototyping tool to build speculative abstraction it doesn't need.

---

## Project isolation

APSA is entirely separate from any other project. Its own GitHub repository, its own Vercel project, its own Supabase instance, its own domain, its own environment variables. No shared packages, no shared database, no shared auth. Nothing is imported across projects in either direction.

---

## System of record

Production data lives in company-controlled infrastructure — PostgreSQL via Supabase initially, with a migration path to independently hosted Postgres.

AI providers are a processing layer only. Customer records, orders, messages, and business data never live inside an AI provider as their canonical home. No architecture may assume otherwise.

The AI provider must be swappable. Route all AI calls through a single internal service interface so Claude, OpenAI, or a future Khmer-language model can be substituted without touching feature code.

---

## Domain model — constraints that protect future products

These constraints cost nothing now and prevent a rewrite later.

**Order** must not assume physical goods. Give the line item a `type` discriminator (`product` | `service` | `fee`) so salon, clinic, repair and agency businesses can use the same order object later without a schema migration.

**Product** must not assume a single price. Model price as a resolvable value against a `priceList` so customer pricing tiers and wholesale can be added later.

**Inventory** is a ledger, not a number. Stock is the sum of movements, never a mutable integer field. Movement types: purchase, sale, transfer, adjustment, damage, return, reservation. This is the single most common mistake in POS systems and it is unrecoverable once live data exists.

**Customer** must support multiple channel identities mapping to one person — Facebook PSID, Instagram IGSID, Telegram user ID, phone number — with a merge operation and an audit trail of merges.

**Order source** is an open enum. POS, Facebook, Instagram, Telegram, website, mini store, marketplace, clearance deals. Adding a source must never require touching the order table.

**Discount** must be modelled richly enough to support a future clearance/deals product: percentage, fixed amount, clearance flag, validity window, quantity threshold.

**Money** is always an integer minor unit with an explicit currency. This must survive from the prototype into production unchanged. `KHR_PER_USD` is configurable, not constant — the rate moves.

---

## Multi-tenancy

One account may own several businesses. The data model is `User → Membership → Business`, never `User → Business`. Roles attach to the membership, not the user. This must be right from the first migration.

---

## Security work required before production

None of this exists in the prototype and all of it is required:

- Authentication with session management and refresh
- Row-level security on every table, tenant-scoped
- Role and permission model: owner, manager, staff, and a read-only role
- Re-authentication gates on sensitive actions: refunds, payouts, staff removal, data export, permission changes
- Audit logging on every read of customer personal data, not only writes
- Rate limiting on all public endpoints
- Encrypted storage for channel access tokens
- Webhook signature verification for Meta and Telegram
- Two-factor authentication for owner accounts

**No unrestricted personal-data export tool. No founder-level browsing of merchant customer data.** Any cross-tenant access is authorised, logged, and time-bounded.

---

## Consent model

Possessing a phone number does not grant permission to market to it. The model must separate:

- Merchant marketing consent (this shop may message this customer)
- Platform marketing consent (APSA may message this customer)
- Channel preference (which of SMS, Telegram, email is permitted)
- Withdrawal, with a timestamp and a record of how consent was originally obtained

Campaign tooling must be unable to select a customer who has not consented — enforced in the data layer, not the UI.

---

## Channel integration reality

Verify current API capability before promising anything in marketing copy:

- **Facebook Messenger** works for Pages, not personal profiles. A merchant selling from a personal account cannot be onboarded until they convert to a Page. Onboarding must handle this failure clearly and helpfully.
- **Instagram** messaging requires a Professional account linked to a Page.
- **Telegram** Bot API cannot read a personal account's direct messages. The merchant runs a bot; customers must message the bot.
- **Facebook comments** — confirm current Page comment webhook scope before building the Comments tab.
- **TikTok** — do not list as a channel until an official API supports the required functionality.

This materially shapes the addressable market and should shape the pitch, not just the code.

---

## Offline POS

Design the UI states now; implement later. When implemented: local-first writes with a durable queue, server-authoritative conflict resolution, idempotency keys on every order creation, and clear surfacing of unsynced sales. Never silently drop a sale. Never create duplicates on retry.

---

## Deferred products — supported by the model, not built

Marketplace, clearance/swipe deals, consumer accounts, loyalty, wholesale, purchase orders, supplier records, service businesses, public partner API, full accounting. The domain constraints above are what keep these open. Nothing else about them should exist in the codebase.

Accounting stays out of scope. APSA provides commerce finance visibility — revenue, COGS, discounts, refunds, payment fees, delivery cost, estimated gross profit — and integrates with a specialist accounting system later.

---

## Delivery and settlement

Initial model: the courier settles COD directly to the merchant. APSA is the aggregator, tracker and orchestrator, and does not hold merchant funds. Holding funds changes the regulatory position entirely and is a deliberate future decision, not a drift.

Courier integrations sit behind one provider-neutral interface. No courier's field names appear in APSA's domain types.

---

## Things that are expensive to change later

Review these before the first production deployment:

1. Money as integer minor units
2. Inventory as a ledger rather than a mutable count
3. `User → Membership → Business` tenancy
4. Order line item type discriminator
5. Channel identity to customer mapping and merge history
6. i18n key coverage — retrofitting extracted strings is brutal
7. Order ID format, once customers have quoted them on the phone
8. Consent model, once real customer data exists under it
