# APSA — Build & Launch-Readiness Status

**File:** `APSA_BUILD_STATUS.md` — the single launch-readiness source of truth.
**Last updated:** 2026-09-28, on branch `claude/v1-operability-launch-5wmarv`
(base `origin/main` `0582104`, PR #78 merged).
**Replaces:** the previous tracker (last updated 2026-09-05), whose per-screen
"mock-only / awaiting Supabase" statuses were months out of date. Its history
remains in git.

> **Rule:** `CORRECTIONS.md` overrides this file. This file reports evidence; it
> does not set product direction (`APSA_MASTER_PLAN.md`, `MVP_ROADMAP.md`).

---

## How to read this file

Every area gets exactly one status per column, and only on repository evidence:

| Status | Meaning |
|---|---|
| **BUILT IN CODE** | Server functions, domain service, repository and (where needed) migrations exist in this checkout and the UI calls them. Says nothing about a live database. |
| **BEHAVIORALLY TESTED** | Offline automated tests exercise the behavior — through the real SQL (all migrations in PGlite) or through the real service with faked I/O. Live-database tests in the suite are **skipped** without credentials and are not counted. |
| **REQUIRES STAGING** | Cannot be proven until migrations `009`–`045` are applied to a dedicated staging project and `verify:staging` / `verify:readiness` pass. |
| **NOT BUILT** | No production implementation exists. |
| **POST-V1** | Intentionally deferred by the source-of-truth documents. |

"REQUIRES STAGING" applies to **every** database-backed area today, because no
staging rehearsal has happened (see *Staging* and *Hosted migrations* below).

---

## Headline facts

- **Hosted migrations (repository evidence):** `supabase/hosted-migrations.lock.json`
  records **`001`–`008` applied** to the live APSA Supabase project (last verified
  2026-09-06). The repository holds **`001`–`045`**. Therefore:

  ```
  EXPECTED: 045 (045_operability_rate_limits_webhooks.sql)
  HOSTED:   008 (008_audit_logs.sql)
  ```

  Every RPC the server calls (`create_order_v2`, `record_payment_v1`,
  `consume_rate_limit`, …) is created by `009`–`045`. **A deployment against the
  hosted project today cannot run any business domain.**
- **Staging rehearsal: NOT COMPLETE.** No dedicated staging Supabase project and
  no `STAGING_*` credentials exist (docs/STAGING_BOOTSTRAP.md §0; not re-verified
  in this session). `verify:staging` and `verify:readiness` have never run against
  a hosted project.
- **Deployment:** no Vercel/hosting project is linked to this repository per
  docs/STAGING_BOOTSTRAP.md §12 (as recorded there; not re-verified).
- **Telegram provider: NOT BUILT.** No messaging provider of any kind is built.
- **Public mini-store: NOT BUILT.**
- **First Internal Alpha can test the Core Business OS (Alpha A) without any
  messaging provider** — see *Alpha sequencing* below.

---

## Status by area

| Area | Built in code | Behaviorally tested | Requires staging | Notes |
|---|---|---|---|---|
| **Auth** (sign-in/up, HttpOnly cookie sessions, verification, password recovery, resend) | BUILT IN CODE | BEHAVIORALLY TESTED — `sign-in-flow`, `session`, `auth-hardening`, `account-recovery` runtime (fake GoTrue), `operability-limits` (rate limits, anti-enumeration) | REQUIRES STAGING (real Supabase Auth, SMTP, redirect URLs) | Google OAuth: NOT BUILT (follow-up, not an Alpha blocker). |
| **Organization / Tenancy** (User → Membership → Organization → Workspace → Location) | BUILT IN CODE (migrations 002–009, `create_organization_for_founder`) | BEHAVIORALLY TESTED — `onboarding-flow`, `multi-org-resolution`, `tenant-isolation` (offline parts), PGlite cross-tenant checks in `order-money-stock-safety` | REQUIRES STAGING — `verify:staging` two-organization isolation never run | Server derives organization from membership; no client `organization_id` is trusted. |
| **Roles / Permissions** | BUILT IN CODE (003, 010, per-domain permission migrations; CORRECTION-001/-002) | BEHAVIORALLY TESTED — `capability-*`, `permission-vocabulary`, `team-domain`, `customer-sensitive-gate` | REQUIRES STAGING (role matrix against real RLS) | |
| **Customers** | BUILT IN CODE (011–016) | BEHAVIORALLY TESTED — `customer-*` suites (faked repository), PII gate | REQUIRES STAGING | Live-DB `customer-domain` tests skipped offline. |
| **Products** | BUILT IN CODE (017–020) | BEHAVIORALLY TESTED — `product-domain` offline parts, `product-catalog-ui` | REQUIRES STAGING | Live-DB tests skipped offline. |
| **Inventory** (ledger; stock = sum of movements) | BUILT IN CODE (021–022, 026) | BEHAVIORALLY TESTED — `inventory-domain`, `order-money-stock-safety` (PGlite: confirm consumes, cancel releases, no drift) | REQUIRES STAGING | |
| **Orders** (server-priced, state machine, idempotent create, delivery fee) | BUILT IN CODE (023–026, 030, 039, 044) | BEHAVIORALLY TESTED — `order-domain`, `order-money-stock-safety` (PGlite), `order-idempotency-client`, `operability-limits` (rate limit + replay) | REQUIRES STAGING | |
| **Payments** (record/verify/reverse/refund/correct, order authority, duplicate suspicion) | BUILT IN CODE (034–036, 040, 043) | BEHAVIORALLY TESTED — `payment-order-integration`, `payment-referenceless-duplicate` (PGlite), `payment-domain`, `operability-limits` | REQUIRES STAGING | No payment provider / KHQR bank verification integration (manual confirmation only). |
| **POS** | BUILT IN CODE (real products, real order creation, real payment recording) | BEHAVIORALLY TESTED — `pos-*`, `create-real-order-variant`, `merchant-sale-journey` | REQUIRES STAGING | Browser suites run only where Chromium is available. |
| **Inbox core** (conversations, messages, read state, ingestion RPC) | BUILT IN CODE (031–033, 037–038) | BEHAVIORALLY TESTED — `conversation-production` (PGlite-backed PostgREST), `conversation-*` | REQUIRES STAGING | Has no inbound source until a provider exists. |
| **Messaging provider** (Telegram, Facebook, Instagram, TikTok) | **NOT BUILT** | — | — | Webhook security primitives exist (see Operability); no provider route, token storage or send path. |
| **Delivery** (merchant-managed deliveries, COD, state machine) | BUILT IN CODE (027) | BEHAVIORALLY TESTED — `delivery-*`, `order-money-stock-safety` | REQUIRES STAGING | Courier provider integrations: NOT BUILT (POST-V1 per roadmap). |
| **Analytics** | BUILT IN CODE (server aggregates over real tables) | BEHAVIORALLY TESTED — `analytics-foundation`, `analytics-ui` | REQUIRES STAGING | |
| **Customer 360** | BUILT IN CODE (real customer, orders, notes; PII-gated) | BEHAVIORALLY TESTED — `customer-merchant-completeness`, `customer-order-history-lifecycle`, `customer-pii-cache-eviction` | REQUIRES STAGING | |
| **Team / Staff invite** | BUILT IN CODE (041–042, CORRECTION-001) | BEHAVIORALLY TESTED — `team-*` | REQUIRES STAGING | Invitation email delivery depends on Supabase SMTP configuration. |
| **Public mini-store / storefront** | **NOT BUILT** | — | — | Separate workstream. |
| **Operability** (logging, request IDs, error boundary, rate limits, webhook primitives, readiness) | BUILT IN CODE (migration 045) | BEHAVIORALLY TESTED — `observability`, `rate-limit`, `webhook-security`, `readiness`, `operability-limits`, `operability-sql` (PGlite) | REQUIRES STAGING (limits are durable only once 045 is applied) | External error-monitoring provider: NOT BUILT (interface only). Details: docs/OPERABILITY.md. |
| **Staging** | Tooling BUILT IN CODE (`check:staging-readiness`, `verify:staging`, `verify:readiness`) | Tooling tested offline | **NOT DONE** — no staging project, no rehearsal | |
| **Production** | — | — | **NOT READY** — hosted at `008`; no backup/restore drill; no linked deployment | See blockers below. |

Also built and tested but not part of the list above: Home (real aggregates),
Settings (account + business profile), Onboarding (organization creation),
Khmer-first localization with key parity (`i18n-key-parity`), bundle boundary
(`bundle-boundary`: no service-role code in the client bundle).

---

## Alpha sequencing

The roadmap's product scope is unchanged (`MVP_ROADMAP.md`). This is the order in
which Internal Alpha is exercised, so a missing messaging provider does not block
testing the whole business OS.

**ALPHA A — Core Business OS** (testable without any messaging provider)

- Products
- Inventory
- POS / manual order
- Payments
- Delivery
- Customers
- Analytics

**ALPHA B — Social Commerce** (requires a provider phase)

- Telegram provider (bot registration, webhook on the security primitives
  already built, token storage, sending)
- Inbox (live conversations from the provider)
- Conversation → Order

---

## Remaining blockers before Core Business OS Internal Alpha (Alpha A)

1. **Dedicated staging Supabase project** created by the owner, with `STAGING_*`
   credentials (docs/STAGING_BOOTSTRAP.md).
2. **Migration rehearsal `009` → `045`** on staging, as the separate approved
   phase (docs/RELEASE_CHECKLIST.md §2), then `bun run verify:staging` and
   `bun run verify:readiness` passing with **EXPECTED = HOSTED**.
3. **Staging deployment** of this app (hosting project linked, server env set:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `VITE_APP_URL`; optionally `RATE_LIMIT_KEY_SECRET`,
   `RATE_LIMIT_CLIENT_IP_HEADER`) and `/api/health` answering.
4. **Supabase Auth configuration on staging** (site URL, redirect URLs, SMTP for
   verification / reset / invitations) and the authenticated smoke tests
   (docs/RELEASE_CHECKLIST.md §3–§6) passing.
5. **Decision on the Alpha database:** apply `009` → `045` to the project that
   will hold merchant data (owner-approved), or provision a new one — and
   regenerate `src/lib/supabase/types.ts` from it.
6. **Backup / restore readiness** for that project: backups/PITR confirmed and a
   restore drill into a disposable project completed (docs/BACKUP_RESTORE.md §2).
7. **Log access confirmed** (retention, search by `requestId`) and an on-call
   person named (docs/RELEASE_CHECKLIST.md §7, docs/INCIDENT_RUNBOOK.md).
8. **Independent review** of this operability PR.

Not blockers for Alpha A: Telegram / any messaging provider, public mini-store,
external error-monitoring provider, courier integrations, Google OAuth.

---

## Known gaps (tracked, not hidden)

- Support reference IDs are shown on sign-in / sign-up failures; Lovable-owned
  operational screens (POS, order sheets, payments) still show their generic
  failure copy without the reference (`supportReferenceOf()` is ready for them).
- No alerting; the on-call person reads logs during Alpha.
- Rate limiting degrades to per-instance memory if the database limiter is
  unreachable (logged; readiness fails while migration 045 is absent).
- Lint baseline: pre-existing `react-refresh` / `exhaustive-deps` warnings
  (docs/RELEASE_CHECKLIST.md §1).
