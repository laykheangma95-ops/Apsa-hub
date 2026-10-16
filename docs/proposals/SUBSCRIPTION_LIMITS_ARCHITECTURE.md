# Subscription Limits — Architecture Proposal

**Status: PROPOSAL ONLY.** Nothing here is implemented or enforced. It adds no
migration, table, check or UI. Every decision marked **Owner decision** needs
approval before any code is written.

Written with Products Catalog Scalability V1 (PR #126). The first limit it
models is the product catalogue, but the design is the general entitlement
path the source documents already require.

---

## 1. What exists today (verified in this repository)

- **No plan, subscription, entitlement or usage table, and no code** that reads
  one. Nothing in `src/` or `supabase/migrations/` refers to them.
- **No product cap.** The old `CATALOG_PAGE_LIMIT = 200` capped what the
  Products screen _displayed_, never what a merchant could _own_. PR #126
  removes it from the Products screen. Inventory still pages at 200 for display.
  **A display/page size must never be reused as a plan limit.**
- **One creation path.** `createProductFn` / `createVariantFn`
  (`src/api/products.ts`) call `createProduct` / `createVariant`
  (`src/server/products/service.ts`). The repository then issues two separate
  inserts (product, then initial variant) with the server's privileged client.
  - Migration 061 revokes browser table access to `products`.
  - Creation is **not atomic** today: if the variant insert fails, the product
    row stays behind. This is pre-existing, and a limit check makes it matter
    more (see §6).
- **Re-activation is a second way in.** `updateProduct` accepts a `status`
  patch under `products.update_basic`, so `ARCHIVED → ACTIVE` is possible.
  Product statuses are `DRAFT | ACTIVE | ARCHIVED`.

## 2. Rules taken from the source documents

| Rule                                                                                                                                             | Source                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Use entitlements, never `if plan == PRO` scattered in code                                                                                       | APSA_MASTER_PLAN §57–58, DATA_MODEL §64 |
| Entitlement (does the _organization_ have it?) is separate from permission (may this _member_ use it?). Both may be required                     | PERMISSIONS_MATRIX §43                  |
| Order of checks: feature flag → entitlement → permission → scope → business rule                                                                 | PERMISSIONS_MATRIX §44, §47             |
| Plan names never decide authorization                                                                                                            | PERMISSIONS_MATRIX §1, §65              |
| On reaching a limit, explain what was reached, current usage and what upgrading unlocks. **Do not unexpectedly block critical business records** | UX_FLOWS §103                           |
| Do not lock exact pricing before merchant usage data                                                                                             | MVP_ROADMAP §37                         |
| Plan / Entitlement / PlanEntitlement / Subscription / UsageRecord shapes; entitlement keys unique                                                | DATA_MODEL §64–68, §111                 |
| No hidden founder/admin backdoors; privileged access is role-controlled and audited                                                              | CLAUDE.md, SECURITY.md                  |

## 3. Data model (follows DATA_MODEL §64–68)

```text
plans                    id, code, name, status
entitlements             id, key (unique), type: 'boolean' | 'limit', description
plan_entitlements        plan_id, entitlement_id, value   -- limit: integer ≥ 0, or NULL = unlimited
subscriptions            id, organization_id, plan_id, status, starts_at, renews_at, ends_at, provider_reference
entitlement_overrides    id, organization_id, entitlement_id, value, reason, expires_at, created_by   -- audited
entitlement_usage        organization_id, entitlement_id, used bigint, updated_at   -- PK (organization_id, entitlement_id)
usage_records            (DATA_MODEL §68: metering/history, not the enforcement counter)
```

- The first limit key is `ACTIVE_PRODUCT_LIMIT`. Provisional values follow.
  They are **not final entitlements**.

  | Plan code    | `ACTIVE_PRODUCT_LIMIT`                                                       |
  | ------------ | ---------------------------------------------------------------------------- |
  | `free`       | 100                                                                          |
  | `pro`        | 1,000                                                                        |
  | `business`   | 10,000                                                                       |
  | `enterprise` | NULL in the plan row; the negotiated value is an `entitlement_overrides` row |

  These are seed _data_ in `plan_entitlements`. Changing a number is a data
  change, never a code change.

- `entitlement_overrides` covers Enterprise, promotions, grace periods and
  support exceptions. Each one has a reason, a creator and an audit row. There
  is no email-based bypass.
- The browser gets no table grants on any of these (same posture as 061). Reads
  and writes go through server functions only.

## 4. Resolving an organization's entitlements

A single server-side resolver, `resolveEntitlements(organizationId)`, lives in
the application/service layer (e.g. `src/server/entitlements/`):

```text
effective(key) = active override (not expired)
              ?? plan_entitlements value for the org's active subscription
              ?? DEFAULT_ENTITLEMENTS[key]
```

- The organization comes from the authenticated membership
  (`AuthorizationContext.organizationId`), never from client input.
- `AuthorizationContext` gains `entitlement(key)` and
  `requireWithinLimit(key)`. They sit next to `require(permission)` but stay
  separate from it. Domain services ask for a _key_, never for a plan name.
- The capability snapshot sent to the browser may include effective values and
  usage for **presentation only** (showing the upgrade explanation in advance).
  The browser never enforces anything.
- **Owner decision:** what `DEFAULT_ENTITLEMENTS` is for an org with no
  subscription row. The proposal is **unlimited** until rollout phase 3, so
  shipping the schema changes no merchant's behaviour.

## 5. What counts

**Active product** means `products.status = 'ACTIVE'`, the sellable products
shown in POS, the order pickers and Smart Action.

- **`DRAFT` does not count.** A merchant can prepare products before
  activating them, and activation is the gated transition. **Owner decision:**
  whether drafts also get a large anti-abuse ceiling (e.g. 10× the allowance).
  If so, it is an operational guard, not a plan feature.
- **`ARCHIVED` does not count.** Archiving frees a slot immediately.
- **Variants do not count toward the allowance.** One product with sizes or
  colours is one product to the merchant, and counting SKUs would punish
  apparel and FMCG sellers for modelling stock correctly.
  - A separate **per-product variant ceiling** (e.g. 200) is proposed as
    abuse/performance protection for every plan.
  - It is not an upgrade lever: PR #126 tested 1,200 variants on one product;
    the ceiling only keeps payloads bounded.
  - **Owner decision:** whether a variant entitlement is ever wanted.
- **Every transition into `ACTIVE` is gated:** create as `ACTIVE`,
  `DRAFT → ACTIVE` and `ARCHIVED → ACTIVE`. Every transition out of `ACTIVE`
  releases a slot.

## 6. Enforcement point for `ACTIVE_PRODUCT_LIMIT`

**Authority lives in the database transaction that creates the row.** A
service-layer pre-check alone is a check-then-act race: two concurrent creates
at `limit − 1` would both pass.

The proposal has two parts.

1. **One atomic creation function.** `create_product_with_initial_variant(...)`
   is a `SECURITY DEFINER` function called only by the server, which also fixes
   the non-atomic two-insert path from §1. In one transaction it:

   When the new product is `ACTIVE`, it runs:

   ```sql
   UPDATE entitlement_usage u
      SET used = used + 1, updated_at = now()
    WHERE u.organization_id = p_org
      AND u.entitlement_id = (SELECT id FROM entitlements WHERE key = 'ACTIVE_PRODUCT_LIMIT')
      AND (p_limit IS NULL OR u.used < p_limit)
   RETURNING used;
   -- 0 rows → raise ENTITLEMENT_LIMIT_REACHED; nothing is inserted
   ```

   Then it inserts the product and its initial variant. If anything fails, the
   increment rolls back with it. A `DRAFT` create skips the increment.
   - `p_limit` is resolved inside the function from the tables in §3, not
     passed in by the caller.
   - The single-row conditional `UPDATE` serializes concurrent creates for one
     organization on that row's lock only. It does **not** lock `organizations`.
     A `FOR UPDATE` there would conflict with the `KEY SHARE` locks that every
     foreign-key insert takes.
   - It also avoids advisory locks. PR #121's real-PostgreSQL gate found a
     `hashtext` collision deadlock in the shared single-bigint advisory
     keyspace.

2. **Status transitions count too.** Any `→ ACTIVE` transition goes through the
   same conditional increment, and any `ACTIVE →` transition decrements. A
   small `BEFORE INSERT OR UPDATE OF status` trigger on `products` can enforce
   this, so that a future path (bulk import, API, admin tool) cannot skip it.
   - The trigger is the authority.
   - The atomic function exists for atomicity of product + variant and for a
     friendly error.

- **Drift:** `entitlement_usage.used` is a cache of
  `count(*) WHERE status = 'ACTIVE'`. A reconcile function recomputes it
  under the same row lock. Run it after any bulk operation and on a schedule;
  a mismatch is logged as an observability event.
- **Why not `count(*)` at insert time:** it needs the same lock to be correct.
  It costs O(catalogue) per create (the PR #126 bench reached 100k products per
  organization), and it gives the UI no cheap "used" figure.

## 7. Upgrades, downgrades, expiry and overrides

**Upgrade.** The new subscription row (or an override) takes effect on the
next resolve.

- The counter does not change, so the very next activation succeeds.
- There is no cache to wait for: the database function resolves the limit
  inside the transaction.
- The browser's snapshot may be stale for up to one capability refresh. The
  server is the authority either way.

**Downgrade below current usage** (e.g. Business with 4,000 active products →
Pro at 1,000):

- Nothing is archived, hidden or deleted. **No automatic archiving, ever.**
- All 4,000 stay active, sellable in POS, editable and searchable.
- Only _new activations_ are refused until `used < limit`. The merchant
  decides which products to archive, if any.
- The Products screen states the position plainly: "4,000 active, plan
  allows 1,000. Existing products keep selling; activating more needs an
  upgrade or archiving."

**Subscription expiry or non-payment:**

- `subscriptions.status` moves to `past_due`, then `expired`. Resolution
  falls back to the `free` plan entitlements.
- Before that, a **grace override** (e.g. 14 days at the previous value) is
  written automatically when the provider reports a failed renewal.
- Effect: the downgrade rules above. Existing records, sales and history are
  never blocked.
- Provider webhooks that change `subscriptions` follow the existing rules:
  signature verification, idempotency, and a stored `provider_reference`.

**Admin overrides** (Enterprise, promotions, support exceptions, grace):

- Written only by an **APSA internal operator role**, through an audited
  server function.
  - Never by the merchant's own Owner.
  - Never by an email or user-id special case.
- Every row carries `reason`, `created_by` and an optional `expires_at`.
  Creating, changing or expiring one writes an audit-log entry.
- Expired overrides are ignored by the resolver. No job has to delete them
  for correctness.

## 8. Existing merchants (safe migration)

Every phase below is a separate PR with its own review.

1. **Phase 0 (schema only):**
   - Create the tables and seed entitlement keys and plan values.
   - Backfill `entitlement_usage` from
     `count(*) FILTER (WHERE status = 'ACTIVE')` per organization.
   - Give organizations with no subscription row an **unlimited default**.
   - Ship the atomic create function and trigger, with the check passing
     everything.
   - Merchant-visible change: none.
2. **Phase 1 (shadow):**
   - Compute the decision and log `entitlement.would_block` events with
     organization, key, used and limit.
   - Report how many real merchants would exceed each provisional number
     before any number is final (MVP_ROADMAP §37).
3. **Phase 2 (inform):** usage in the capability snapshot and on the Products
   screen. Still no blocking.
4. **Phase 3 (new organizations):** organizations created after a published
   cut-off get a real subscription row and are enforced.
5. **Phase 4 (existing organizations):**
   - Notice in advance.
   - Every existing organization above its assigned plan's allowance receives
     a **grandfather override** at its current count (or the plan value,
     whichever is higher), with a stated expiry or none.
   - No merchant loses the ability to activate products on the day
     enforcement starts.

**Migration caution:** merging to `main` auto-applies migrations to the
production Supabase project. Phase 0 needs its own reviewed rollout. The
backfill must be safe on a live catalogue: one `INSERT … SELECT … GROUP BY`,
then the trigger takes over. Run the reconcile function immediately after
the trigger is created to close the gap between them.

## 9. Errors and upgrade prompts

**A new stable code:** `ENTITLEMENT_LIMIT_REACHED`, with `{ key, limit, used }`
in the public error.

- It must stay distinguishable from a permission `403`. A cashier without
  `products.create` sees "ask your owner". An owner at the limit sees what was
  reached, current usage and what upgrading unlocks (UX_FLOWS §103).
- Suggested HTTP status: `409`. The request is valid but the organization's
  state forbids it.

**Who sees the upgrade prompt:**

- Only members with `billing.read` see the plan and upgrade call to action.
  Other members see the limit and "ask your owner" (PERMISSIONS_MATRIX §27).
- Prompt text says what was reached, current usage, and what the next plan
  allows. It never shows prices in the operational screen.

**Products screen:**

- At about 80% of the allowance, a calm usage line such as "82 of 100 active
  products".
- At the limit, Create and Activate stay visible and explain why instead of
  disappearing. Saving as `DRAFT` still works.
- All strings use i18next keys, Khmer first. The state is never shown by
  colour alone. No Apsi here (Products is dense operational UI).

**Never blocked by the product allowance:** viewing, searching, editing, price
changes, archiving, drafts, stock movements, POS sales, orders and deliveries
for products that already exist.

**No client-only restriction:** the browser shows limits it was told about.
The trigger enforces them.

## 10. Security and audit

- Tenant isolation:
  - Usage and overrides are keyed by the membership-resolved organization.
  - Tests must include a foreign `organization_id` in the payload and a foreign
    product id on activation.
- `entitlement_usage` and `entitlement_overrides` have no browser grants.
- Audit log entries: subscription plan changes (`billing.manage_plan`), every
  override, and every reconcile correction.

## 11. Tests required before enforcement

- **Real PostgreSQL concurrency:** N parallel activations at `limit − 1` must
  give exactly one success, mixing create, `DRAFT → ACTIVE` and
  `ARCHIVED → ACTIVE`.
- **Atomicity:** a variant insert failure (duplicate SKU or barcode) leaves no
  product and no increment.
- **Errors:** a permission denial and a limit denial return different codes,
  in both languages.
- **Downgrade below current usage:** every existing read, edit, sale and
  archive still works.
- **Expiry:** after expiry plus grace, the free allowance applies and no
  records change.
- **Overrides:** an expired override is ignored, and only the operator role
  can write one.
- **Reconcile:** after an injected drift, `used` matches the real count.
- **Isolation:** cross-tenant and IDOR cases for entitlements, usage and
  overrides.

## 12. Owner decisions needed

1. Final allowances. Free 100 / Pro 1,000 / Business 10,000 / Enterprise
   custom are provisional until shadow-mode data exists.
2. Do drafts get an anti-abuse ceiling?
3. The per-product variant ceiling value. Should variants ever be an
   entitlement?
4. Grace-period length on failed renewal.
5. The default plan for organizations without a subscription row once phase 3
   starts.
6. Error status: is `409` acceptable, or does the owner prefer `402`/`403`
   plus the code?
