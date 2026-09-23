# APSA — Staging → Production Release Checklist

**Purpose:** one document to run through before every staging rehearsal and
before every staging → production promotion. It does not replace
`docs/STAGING_BOOTSTRAP.md` (environment setup) or `docs/STAGING_VERIFICATION.md`
(what the verification tooling proves) or `docs/GITHUB_GOVERNANCE.md` (PR
lifecycle/CI mechanics) — it is the checklist that ties all three together into
one pass/fail sequence. Read those three first; this document assumes them.

Contains no secrets. Safe to commit.

---

## 0. When to run this

- Before requesting the `009` → `043` migration rehearsal on a dedicated
  staging Supabase project.
- Before recording `STAGING VERIFIED` on any PR.
- Before every staging → production promotion.

---

## 1. Automated gates (run locally or read off CI)

Run in this order; stop at the first failure.

```
bun run typecheck
bun run lint
bun test src/tests/
bun run build
bun test src/tests/bundle-boundary.test.ts
bun test src/tests/i18n-key-parity.test.ts
bun run scripts/check-migration-safety.ts --base=origin/main
bun run check:staging-readiness
```

| Gate | Proves | Blocking? |
|---|---|---|
| `typecheck` | `tsc --noEmit` clean | Yes |
| `lint` | ESLint clean repo-wide | Yes (0 errors; pre-existing `react-refresh`/`exhaustive-deps` warnings are a documented baseline, see `docs/GITHUB_GOVERNANCE.md` §4) |
| `bun test src/tests/` | Full automated suite, offline | Yes, except the documented `auth-hardening.test.ts` subprocess-timeout carve-out (§4 of GITHUB_GOVERNANCE.md) |
| `build` | Production Vite/Nitro build succeeds | Yes |
| `bundle-boundary.test.ts` | No `supabaseAdmin`/service-role key reaches the client bundle | Yes |
| `i18n-key-parity.test.ts` | Khmer/English locale key sets match | Yes |
| `check-migration-safety.ts` | No duplicate migration numbers, no edits to hosted-locked migrations, no un-revoked `SECURITY DEFINER` / ambiguous overload in new/changed files | Yes for new/changed files; pre-existing baseline findings are warning-only (see current baseline below) |
| `check:staging-readiness` | Offline: migration inventory, hosted-parity, generated-type freshness, staging credential presence | Yes for blocking findings; `PENDING`/`NOT CONFIGURED` are informational, never a silent pass |

None of these connect to a hosted database. Passing all eight proves the code
is internally consistent — it proves nothing about RLS, auth, or multi-tenant
behavior on a live project. That is what §5–§8 below are for, executed via
`bun run verify:staging` against a real dedicated staging project.

**Current documented baseline** (do not treat these as new findings — they are
tracked, not hidden):
- 17 lint warnings (`react-refresh/only-export-components` ×16,
  `react-hooks/exhaustive-deps` ×1 in `app.pos.tsx`) — structural refactors,
  non-blocking, `app.pos.tsx` is Lovable-owned.
- 17 `check-migration-safety` `SECURITY DEFINER` warnings — all pre-existing
  internal trigger/RLS-helper functions in migrations `001`–`034`, all
  warning-only because none were added or modified in the current diff.
- `auth-hardening.test.ts`'s isolated-runtime subprocess check has a documented
  ~5s timeout on a clean checkout, run informationally in CI, excluded from
  the blocking test run.

If a run reports something **not** in this list, treat it as a real, new
finding — investigate before promoting.

---

## 2. Migration rehearsal plan (009 → 043)

**Do not apply.** This section is the ordered plan `docs/STAGING_BOOTSTRAP.md`
§10 refers to as a "separate, explicitly approved phase" — it is documented
here so that phase has a single reference to execute against once staging
credentials exist and application is explicitly authorized.

- Recorded hosted baseline: `001`–`008` (locked by sha256 in
  `supabase/hosted-migrations.lock.json`).
- Pending, in required numeric order: `009` → `043` (33 files). Numbering
  gaps at `028`/`029` are never-created numbers, not deletions —
  `check:staging-readiness` reports this as informational, not blocking.
- `check-migration-safety.ts` confirms today: 0 duplicate numbers across all
  41 files, all 8 hosted files hash-match their lock entries (no hosted
  migration has been edited), 0 ambiguous overloaded-function references.
- Domain dependency order embedded in the numeric sequence (verified by
  reading each file's header comment and foreign keys):
  - `009`–`010`: org RPC + permission vocabulary (depends on `002`–`008`)
  - `011`–`016`: customer domain (depends on `002`–`010`)
  - `017`–`020`: product domain + cross-tenant integrity (depends on `002`–`010`)
  - `021`–`022`: inventory ledger (depends on `017`–`019`)
  - `023`–`026`: order domain, order RPC, order permissions, order↔inventory
    integration (depends on customer + product + inventory domains)
  - `027`: delivery/fulfillment (depends on orders)
  - `030`–`033`: conversations/messages (depends on orders, for
    `source_conversation_ref`)
  - `034`–`036`: payments domain, payment RPC, payment permissions (depends
    on orders)
  - `037`–`038`: conversation read identity, conversation ingestion
  - `039`–`040`: order refund axis, payment↔order authority (depends on
    `023`–`026` and `034`–`036` both being present — apply `039` before `040`
    uses the new refund-status enum value, per `APSA_BUILD_STATUS.md` §18)
  - `041`–`042`: team invitations + team permissions (depends on `006`
    memberships)
  - `043`: payment referenceless-duplicate handling (depends on `034`–`035`)
- RLS: every migration from `011` onward enables RLS in the same file it
  creates its table(s) in — there is no separate "enable RLS later" pass, so
  applying in numeric order never leaves a tenant table briefly unprotected.
- Idempotency: none of `009`–`043` are written to be safely re-run (`CREATE
  TYPE`/`CREATE TABLE` without `IF NOT EXISTS` in most files, by design — a
  second run against the same database is expected to fail loudly rather
  than silently no-op). This is why staging starts **empty** (§10 of
  `STAGING_BOOTSTRAP.md`) rather than being re-applied onto itself.
- Each migration file's header comment carries its own rollback instructions;
  roll back in strict reverse numeric order.

**Migrations that cannot safely apply to an empty database out of order:**
none, provided the numeric sequence above is followed exactly — every
foreign key, trigger, and RPC reference in `009`–`043` points only at objects
created by an equal-or-lower-numbered migration already in this checkout.

---

## 3. Authenticated smoke test plan

Run against a bootstrapped staging project (`docs/STAGING_BOOTSTRAP.md`,
after §14's definition of done is met and the rehearsal has been applied and
verified). Use only `QA-STAGING`-prefixed data.

| # | Flow | Expected server mutation | Expected DB row(s) | Cache/UI refresh | Permission required | Failure state to verify |
|---|---|---|---|---|---|---|
| A | Sign up | `auth.users` insert via Supabase Auth | `auth.users` row, unconfirmed | Redirect to "check your email" | none (public) | Duplicate email is rejected by Supabase Auth, not silently accepted |
| B | Verify email | Supabase confirms `email_confirmed_at` | `auth.users.email_confirmed_at` set | Redirect to sign-in/onboarding | valid confirmation token | Expired/reused token is rejected; unconfirmed account cannot sign in (`verify:staging` asserts this) |
| C | Sign in | `supabase.auth.signInWithPassword` | new session/refresh token issued | Session established, redirected into `/app` | verified email | Wrong password rejected; unverified email rejected |
| D | Create/join organization | `create_organization_v1` RPC (or accept-invitation RPC) | `organizations` row + `memberships` row (role=OWNER for create; invited role for join) | Workspace switcher shows new org | authenticated, no existing membership required for create | Duplicate slug rejected; joining with a used/expired/wrong-role invitation rejected per CORRECTION-001 |
| E | Home | `getHomeSummary` server function reads aggregates | none (read-only) | Metrics/attention cards populate for the signed-in org only | `org.read`-equivalent (any active member) | Org B's data never appears (tenant isolation, §4) |
| F | Products | Product server functions (`getProducts`, create/update) | `products`/`product_variants` rows scoped to caller's org | List reflects new/edited product without stale cache | `products.view` / `products.manage` | Cross-org SKU with same value in two orgs both succeed (org-scoped uniqueness, not global) |
| G | Inventory | Inventory movement RPC | `inventory_movements` ledger row (never a mutated stock column) | Stock figure recomputes as SUM of movements | `inventory.adjust`/`inventory.receive` | Movement never produces a negative on-hand quantity unless the design explicitly allows backorder (confirm against current `021_inventory_movements.sql` constraints before treating a negative as a bug) |
| H | Customer | Customer server functions | `customers` (+ identity/note/tag/address) row(s) | Customer 360 shows new record immediately | `customers.view`/`customers.manage` | Staff without `customers.export` cannot trigger export path |
| I | POS sale | `createSale`/`createRealOrder` + inventory deduction + payment record | `orders`, `order_items`, `inventory_movements` (deduction), `payments` | Order appears in Orders list; stock reflects deduction | `pos.sell` / `orders.create` | Double-submit of the same sale must not create two orders (idempotency) |
| J | Order creation | `create_order_v1` RPC | `orders`, `order_items`, `order_status_history` (lifecycle: `draft`→`confirmed`) | Order detail loads with correct variant, no guessed variant | `orders.create` | Ambiguous/unresolved variant must block, never guess (per PR #71/#72 fixes) |
| K | Payment record | Payment RPC (`record_payment` family) | `payments` row, `payment_events` (append-only) | Order's payment axis updates independent of lifecycle axis | `payments.record` | Client-supplied total is never trusted — server recomputes from order/payment records |
| L | Delivery | Delivery RPC | `deliveries`/`delivery_status_history` row | Delivery detail shows valid status transition only | `delivery.manage` | Terminal states (`delivered`, `cancelled`) reject further transitions |
| M | Inbox → Prepare Order | Smart Action → `createRealOrder`/`confirmRealOrder` | Same as J, plus `orders.source_conversation_ref` set (opaque reference, never a FK) | Prepare Order sheet reflects real order, CTA pinned | `orders.create` + conversation linkage | 0 or 2+ matching products/variants must force merchant choice, never auto-resolve |
| N | Team invite | `inviteStaff` → `invitations` insert; `accept_invitation()` on accept | `invitations` row (with `issued_by_role` snapshot), then `memberships` row on accept | Team list shows pending invite, then active member | `team.invite` (capped by CORRECTION-001 authority rules) | Manager cannot invite/reactivate an Owner- or Manager-grade membership (CORRECTION-001, all 3 rounds) |
| O | Settings | Settings server functions | `organizations`/settings-scoped row updates | Business Profile reflects change or stays hidden on denied read | `org.settings.manage` | Denied server read hides the row rather than showing stale/fake data (PR #71 fix) |
| P | Sign out / sign back in | Supabase session revocation | access token invalidated server-side | Immediate redirect to sign-in; no stale principal | none | Token rejected **after** sign-out (not just cleared client-side); User A → sign-out → User B yields a distinct identity, never a cached principal |

---

## 4. Tenant isolation test plan (two-organization staging test)

Setup: Organization A (`QA-STAGING Shop A`: Owner A, Staff A) and Organization
B (`QA-STAGING Shop B`: Owner B, Staff B), **no shared membership** — per
`docs/STAGING_BOOTSTRAP.md` §8. This is exactly what `verify:staging` §4.2.5
already automates for the tables it covers; use this table to confirm full
coverage and to drive manual UI probing.

For every row below, verify **both** paths: (1) normal UI navigation as an
Org A member, and (2) direct server-function/RPC call or URL-parameter
substitution using Org B's real UUIDs (the IDOR case) — a client-supplied
`organization_id` must never be authorization truth (`SECURITY.md`).

| Surface | Table(s) | Cross-tenant read must return | Cross-tenant write must |
|---|---|---|---|
| Customers | `customers`, `customer_identities`, `customer_notes`, `customer_tags`, `customer_addresses` | zero rows | be refused by RLS/authorization (`42501`/`PGRST301`/`PGRST302`), not merely hidden in the UI |
| Products | `products`, `product_categories` | zero rows | refused |
| Variants | `product_variants` | zero rows | refused; cross-org variant/product mismatch also rejected by `check_variant_org_integrity()` trigger |
| Inventory | `inventory_movements` | zero rows | refused |
| Orders | `orders`, `order_items`, `order_status_history` | zero rows | refused |
| Payments | `payments`, `payment_events`, `payment_evidence` | zero rows | refused |
| Deliveries | `deliveries`, `delivery_status_history` | zero rows | refused |
| Conversations | `conversations`, `messages`, `conversation_participants`, `conversation_read_markers` | zero rows | refused |
| Team/memberships | `memberships`, `invitations` | zero rows beyond org membership roster | refused |
| Organization profile | `organizations`, `workspaces`, `locations` | zero rows for B's org record when queried as A | refused |

**Any cross-tenant exposure is a BLOCKER** — do not promote past it. Only an
explicit authorization refusal code counts as proof of denial; a malformed-ID
error, trigger error, or constraint violation is `INCONCLUSIVE`, never a pass
(`docs/STAGING_VERIFICATION.md` §4.2, "What counts as proof").

---

## 5. Role / permission test plan

Roles: OWNER, MANAGER, CASHIER/SALES/CUSTOMER_SERVICE (staff-equivalent,
least-privilege). Authority ceiling for role changes is defined by
`CORRECTIONS.md` CORRECTION-001, enforced in `src/server/team/service.ts`
(`assertRoleAuthority()`/`assertAuthorityOverRole()`), not by the DB grant
alone.

| Check | Expected |
|---|---|
| UI hiding | An action a role cannot perform is not rendered/is disabled — but this is decorative only (`src/lib/permissions.ts` is explicitly "UI-only decorative, no security value" per `APSA_BUILD_STATUS.md` §27) |
| Server enforcement | Every mutation re-checks permission server-side regardless of what the UI allowed to be attempted (`AuthorizationService`) |
| Stale capability handling | A role downgraded mid-session loses capability on the **next** server call, not just after a client refresh — verify a previously-fetched capability set is not trusted past its issuing request |
| Role downgrade | OWNER can downgrade MANAGER→CASHIER; MANAGER cannot downgrade a peer MANAGER or OWNER (CORRECTION-001); last-owner protection trigger blocks removing/demoting the sole remaining OWNER even via direct RPC |
| Session refresh | Permission changes take effect without requiring sign-out/sign-in |
| Forbidden mutations | MANAGER attempting `team.roles_assign` to MANAGER-or-above is rejected at the application layer even though migration 042 grants the DB-level permission unconditionally |
| Sensitive customer data access | Only roles with `customers.export`/`products.view_cost`-equivalent permissions can reach those fields/actions; audit log (`audit_logs`) is readable only by `org.read` holders (Owner/Manager), confirmed by `has_audit_access()` (migration 008) |

---

## 6. Money / order / inventory invariants

Grounded in the actual enums shipped in `supabase/migrations/023`, `027`,
`034`, `039`:

- **Order** has three independent axes: `lifecycle_status`
  (`draft`→`confirmed`→`completed`/`cancelled`), `payment_status`
  (`unpaid`/`pending`/`paid`/`failed`), `refund_status`
  (`none`/`partial`/`full`, per CORRECTIONS.md's approved financial
  semantics). Verify these three never collapse into one column and that a
  refund never remaps `payment_status` to `failed`/`unpaid` — a fully paid
  order that is partially refunded stays `paid` + `refund_status=partial`.
- **No duplicate submit**: re-submitting the same POS sale/order-confirm
  action must not create a second `orders` row (idempotency key or
  equivalent guard).
- **Correct variant**: order creation must never guess an ambiguous
  product/variant match (Prepare Order and Create Order both fixed for this
  in PR #71/#72) — 0 or 2+ candidate matches must force explicit merchant
  selection.
- **Payment**: `status` (pending/paid/failed/reversed/refunded) and
  `verification_state` are independent axes; `status` is only ever a
  *derived consequence* of a verification transition, never set directly.
  Client-supplied totals are never trusted — the server recomputes from
  `payments`/`payment_events`. `payment_events` is append-only at the
  database level (trigger blocks UPDATE/DELETE for every role including
  `service_role`) — verify no code path attempts to mutate history.
  Refund/reverse authority is gated by permission (`payments.refund`/
  `.reverse`), not merely by UI availability.
- **Inventory**: every stock change must produce an `inventory_movements`
  ledger row — `Product.stock`/on-hand quantity is always a `SUM` over
  movements, never a mutable counter column. Confirm no code path writes
  directly to a stock column. A negative resulting on-hand quantity is only
  acceptable if a specific movement type explicitly documents backorder
  support in `021_inventory_movements.sql`; otherwise it is a blocker.
- **Delivery**: `delivery_status` transitions
  (`pending`→`preparing`→`ready`→`in_transit`→`delivered`/`failed`/`cancelled`)
  must reject any transition attempted from a terminal state
  (`delivered`, `cancelled`).

---

## 7. Release observability — minimum launch-critical gaps

Audit scope: structured logs, server errors, failed-mutation visibility,
Vercel logs, Supabase logs, audit events. Do not add a new observability
platform — use what Vercel/Supabase already provide.

Current state found in this checkout:
- `auditLog()`/`auditLogRequired()` exist (`src/server/auth/audit.ts`) and are
  wired into sensitive actions (price changes, exports, refunds, permission
  changes) per `SECURITY.md`'s requirement — `customers.export` fails closed
  if the audit write fails; most other actions are best-effort (logged as a
  console warning on failure, e.g. the `order audit_log write failed
  (best-effort)` line observed during the local test run above, which is
  expected in an unconfigured-Supabase test environment, not a staging gap).
- No dedicated error-tracking service (Sentry, etc.) is wired in this
  checkout. Minimum launch-critical gap: **before the first real production
  traffic**, confirm Vercel's own function/runtime logs are being retained
  long enough to debug a failed mutation after the fact, and confirm
  Supabase's Postgres logs are reachable from the dashboard for the
  production project. Neither requires new code — it is a dashboard
  configuration check, not a build task.
- No alerting on best-effort audit-log failures. If a launch-blocking gap is
  later found here, the minimal fix is upgrading specific high-sensitivity
  actions from best-effort to fail-closed (as `customers.export` already is),
  not introducing a new logging platform.

---

## 8. Full promotion checklist

Run this exact sequence before recording `STAGING VERIFIED` or promoting to
production. Do not continue past a failure; do not downgrade `PENDING`/
`NOT CONFIGURED`/`INCONCLUSIVE` to a pass.

1. `bun run typecheck`
2. `bun run lint`
3. `bun test src/tests/`
4. `bun run build`
5. `bun test src/tests/bundle-boundary.test.ts`
6. `bun test src/tests/i18n-key-parity.test.ts`
7. `bun run scripts/check-migration-safety.ts --base=origin/main`
8. `bun run check:staging-readiness`
9. Browser suites, if a Chromium runtime is available in the environment
   (none of the above exercises a real browser)
10. `bun run verify:staging` against the dedicated staging project — must
    exit 0 with no `INCONCLUSIVE`/`NOT CONFIGURED` lines
11. Manual smoke test plan (§3 above), all 16 flows
12. Tenant isolation test plan (§4 above), all 10 surfaces, both UI and
    direct-probe paths
13. Role/permission test plan (§5 above)
14. Money/order/inventory invariant checks (§6 above)
15. Observability minimum check (§7 above)
16. Independent review record valid for the current commit SHA
    (`docs/GITHUB_GOVERNANCE.md` §5)

Only when all 16 pass is a PR eligible for `STAGING VERIFIED`, and only after
a **separate**, explicitly authorized production deploy step is it eligible
for `PRODUCTION VERIFIED`.
