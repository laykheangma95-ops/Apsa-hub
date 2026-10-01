# APSA — V1 Operability & Abuse Protection

**Scope:** what APSA does in code today to make failures observable, errors safe,
abuse bounded and readiness provable — and exactly what still needs staging proof.
Contains no secrets. Safe to commit.

Related: `docs/INCIDENT_RUNBOOK.md` (what to do when something breaks),
`docs/BACKUP_RESTORE.md` (backup/restore readiness), `docs/RELEASE_CHECKLIST.md`
(promotion gates), `APSA_BUILD_STATUS.md` (launch-readiness source of truth).

---

## 1. Error tracking — provider-neutral

**Audit of the state before this change (base `0582104`):**

| Question | Finding |
|---|---|
| What server errors were logged? | Unstructured `console.error("[APSA] …")` lines in a handful of places (audit failures, auth provider failures). TanStack Start's server-function handler also `console.error`s every thrown error, expanded with stack and cause chain by `src/lib/error-capture.ts`. |
| What client errors surfaced? | TanStack Start serializes **only `error.message`** over the server-function wire (router-core `ShallowErrorPlugin`). Repository errors are thrown as `new Error("createOrder: <PostgREST message>")`, so **raw SQL / PostgREST text (constraint names, table names, sometimes row values) reached the browser**. `signInFn` / `signUpFn` / `verifyEmailFn` returned raw Supabase/DB messages as data, and `sign-in.tsx`/`sign-up.tsx` rendered them. |
| Were unhandled exceptions observable? | Only as free-text platform log lines; no correlation handle, no consistent fields. |
| Could sensitive values enter logs? | Yes — `error-capture.ts` logs full messages; PostgREST messages can quote emails/phones (`Key (primary_email)=(…)`); `auditLogRequired` embedded the DB message in the thrown text. |
| Was an error-monitoring provider configured? | **No.** No Sentry/OpenTelemetry SDK, DSN or credential exists in the repository. |

**What exists now:**

- `src/server/observability/errors.ts` — `ErrorReporter` interface and a single
  registry (`registerErrorReporter`). **No provider is registered and none is
  fabricated.** `reportServerError()` always writes one structured log line (the
  platform log pipeline is the baseline sink) and, if a reporter is registered,
  forwards a **sanitized** report (class, code, status, scrubbed message, scrubbed
  stack frames, request/tenant/member IDs) — never the raw error, request, cookies
  or input. A failing reporter never breaks the request.
- To connect Sentry / OpenTelemetry later: implement `ErrorReporter`, register it
  once at server start, supply its DSN as a server-only env var. Nothing else
  changes. That is a separate, approved change.

## 2. Structured server logging

`src/server/observability/logger.ts` — one JSON object per line:

`ts, level, event, requestId, domain, operation, organizationId, userId,
errorClass, errorCode, statusCode, retryable` + operational extras.

`src/server/observability/redact.ts` runs on **every** field:

- **Key-based:** any field whose name contains `password`, `token`, `secret`,
  `cookie`, `authorization`, `key`, `otp`, `pin`, `session`, `signature`, `email`,
  `phone`, `address`, `street`, `card`, `body`, `content`, `text`, `note`, `name`,
  or a generic free-form key — `message`, `msg`, `payload`, `raw`, `caption`,
  `comment`, `transcript`, `snippet`, `preview` — is replaced with `[REDACTED]`
  wholesale: conversation messages and provider payloads are never logged, even
  scrubbed. Known-safe identifiers (`organizationId`, `userId`, `requestId`,
  `orderId`, …) are allow-listed. The one deliberate text field is
  `errorMessage`: an Error's message, value-scrubbed and capped at 300 chars.
- **Value-based** (every remaining string, whatever its key):
  - credential `label: value` / `label=value` / `"label": "value"` / `label is
    value` pairs — `password`, `pwd`, `pin`, `otp`, `secret`, `client_secret`,
    `webhook_secret`, `token`, `access_token`, `api_key`, `private_key`,
    `service_role`, … — redacted **whatever the value's length** (`password:
    hunter2`, `webhook_secret=ab12`);
  - `Cookie:` / `Set-Cookie:` / `Authorization:` header lines, to end of line;
  - known token formats with no label (Stripe-style `sk_/pk_/rk_live|test_`,
    `whsec_`, GitHub `gh?_`, Slack `xox?-`, AWS `AKIA…`, Supabase `sb_secret_` /
    `sbp_`, Meta `EAA…`, Telegram bot tokens), JWTs, `Bearer …`/`Basic …`;
  - emails, card-like and phone-like digit runs, 40+ char opaque secrets;
  - street addresses (`#12, St. 271`, `Road 2004`, Khmer `ផ្ទះលេខ` / `ផ្លូវ` +
    number) and Cambodian place names after `Sangkat` / `Khan` / `Phum` /
    `Krong` or Khmer `សង្កាត់` / `ខណ្ឌ` / `ភូមិ` / `ឃុំ` / `ក្រុង` / `ស្រុក`.
  UUIDs, request IDs, rule IDs and ISO timestamps are protected; prose such as
  "street food" is not redacted (a street keyword must be followed by a number).
- Strings are truncated (500 chars); nesting, arrays and cycles are bounded.

Free-text address detection is best-effort (heuristic), which is why customer
content keys are redacted wholesale rather than relying on value patterns.

**No raw console path remains on the server.** `src/lib/error-capture.ts`
(imported first by `src/server.ts`) wraps `console.error` / `console.warn`: an
Error argument becomes a scrubbed `{errorClass, errorCode, statusCode,
errorMessage, stack}` description — never the raw message, full stack or cause
chain; objects go through `redact()`, strings through `scrubString()`. This
covers h3's internal logging, framework code and the SSR error component. The
former raw call sites (auth/order/payment best-effort audit, mandatory audit,
sign-out audit, `VITE_APP_URL` misconfiguration) now use `reportServerError` /
`serverLog`.

Never logged by design: passwords, auth/recovery tokens, cookies, raw customer PII,
payment secrets, provider secrets, message contents. Prefer IDs and codes.

## 3. Request / correlation IDs

- `src/server/observability/request-id.ts` — `req_` + 20 hex chars from the
  platform CSPRNG (80 bits). Encodes nothing: no timestamp, tenant, member, email
  or sequence. **Never an authentication or authorization input.**
- `src/server/observability/server-fn-boundary.ts` is installed **globally** as
  TanStack Start function middleware (`src/start.ts`), so every `createServerFn`
  call runs inside it with no per-handler opt-in. It opens an `AsyncLocalStorage`
  context (`requestId`, `operation` = server-function name, `domain` = API file),
  so any log line written during the call carries the same ID.
- Nested server-function calls on the server (e.g. `getSessionFn()` inside
  another handler) reuse the outer context: one failure → one log line → one ID.
- `src/server.ts` opens the same `AsyncLocalStorage` context per **HTTP
  request** (fresh `requestId` + a per-request error-capture slot). A server
  function inside it keeps that request ID. The error h3 swallows into a
  generic 500 is recorded in **this request's** slot only and reported under
  this request's ID (`ssr.swallowed_error`); there is no process-global
  "last error" — concurrent failures cannot be cross-attributed (tested with two
  overlapping requests).

**Correlation path for "Order failed":** UI error message carries
`[ref:req_…]` → `server_fn.unexpected_error` log line with the same `requestId`,
`domain: "orders"`, `operation: "createOrderFn"`, `errorClass`, `errorCode` →
the scrubbed error message and stack frames in that line.

## 4. Safe error UX

| Error kind | What the browser receives |
|---|---|
| **APSA public domain error** — created by APSA code through `src/server/public-domain-error.ts` (`publicError()`, `PublicDomainError`, or a domain error class that marks itself: `ForbiddenError`, `UnauthorizedError`, `TeamError`, `ConversationError`, `RateLimitedError`, `RateLimitUnavailableError`) | **Unchanged message and status.** Every UI classifier depends on these messages: permission denied, invalid lifecycle transition, idempotency conflict, payment conflict, audit unavailable, validation/domain errors stay specific. |
| Validation (a real `ZodError` instance) | Unchanged (describes the caller's own input). A look-alike with `name = "ZodError"` is not trusted. |
| TanStack `redirect` / `notFound` / `Response` | Unchanged. |
| **Anything else — including any error that merely carries a numeric `statusCode` / `status` / `code`** (PostgREST/SQL text, supabase-js, h3/fetch/provider errors, bugs) | `"Something went wrong on the server. Please try again. [ref:req_…]"` — no stack, SQL, table/constraint names, secret names. Classified as the generic "server error" kind by every existing UI classifier (tested). |
| Rate-limit refusal | `"rate_limited: Too many requests. Try again in N seconds."` (429). Names no rule, bucket or identity. |
| Audit store unavailable (`auditLogRequired`) | Now a public 503 with a fixed message (no DB text); the inventory UI still shows its "audit blocked" copy. |
| Durable limiter unavailable for refund / reversal / correction | Public, retryable 503 `rate_limit_unavailable`: "This action is temporarily unavailable and was not performed. Please try again in a moment." Nothing was mutated. |

**Provenance, not shape.** A public error is recognised by membership in a
registry that only `src/server/public-domain-error.ts` writes to — not by a
`statusCode` field. `new Error("duplicate key constraint customers_email_key for
victim@example.com")` with `statusCode = 409` is sanitized to the generic message
+ support reference (tested); copying a public error's fields onto another object
does not copy its provenance. The SSR request middleware (`src/start.ts`) applies
the same rule.

Auth: `signInFn` / `signUpFn` / `verifyEmailFn` no longer return provider/DB
text. `unexpected_error` carries an optional `reference` (the request ID), which
`sign-in.tsx` / `sign-up.tsx` show as "Support reference: …" (i18n, km + en).
New `rate_limited` codes have translated copy.

`src/lib/public-error.ts` gives the browser `supportReferenceOf(err)` and
`isRateLimitedError(err)`. **Not yet wired** into Lovable-owned screens (POS,
Order sheets, Payments) — those still show their existing generic copy on an
unexpected failure; showing the reference there is a small Lovable follow-up.

## 5. Rate limiting

### 5.1 Endpoint risk classification

| Endpoint | Exposure | Risk | Decision |
|---|---|---|---|
| `signInFn` | public | credential stuffing / password spraying | **RATE LIMITED** (identity + IP) |
| `signUpFn` | public | mass account creation, email cost | **RATE LIMITED** (identity + IP when trusted) |
| `requestPasswordResetFn` | public, anti-enumerating | email bombing, enumeration | **RATE LIMITED** (cooldown + hourly identity + IP), neutral answer preserved |
| `resendVerificationFn` | public / self | email bombing | **RATE LIMITED** (same as reset) |
| `verifyEmailFn` (token + email) | public | 6-digit OTP guessing | **RATE LIMITED** (identity + IP when trusted) |
| `beginPasswordRecoveryFn` | public | OTP guessing (token + email links), link replay | **RATE LIMITED** (email digest for code links, link-token digest for `token_hash` links, + IP when trusted) |
| `completePasswordRecoveryFn` | recovery cookie required | password-change flooding | **RATE LIMITED** (recovery-session digest + IP when trusted) |
| `createOrderFn` | authenticated, `orders.create` | high-volume abuse, stock reservation noise | **RATE LIMITED** (member + organization); idempotent replays exempt |
| `recordPaymentFn`, `verifyPaymentFn`, `attachPaymentEvidenceFn` | authenticated, `payments.*` | financial impact, audit volume | **RATE LIMITED** (member) |
| `refundPaymentFn`, `reversePaymentFn`, `correctPaymentFn` | authenticated, `payments.refund/reverse/override_status` | money moving back out, mandatory audit | **RATE LIMITED** (tighter member bucket + member bucket); **FAILS CLOSED** when the durable limiter is unavailable (§6) |
| Delivery transitions | authenticated, `deliveries.*` | no external side effect (no courier provider), state machine + permission + history in one RPC | **EXISTING DOMAIN CONTROLS SUFFICIENT FOR ALPHA** |
| Customer create/update | authenticated, `customers.*`, PII-gated (CORRECTION-002) | no financial effect, audited | **EXISTING DOMAIN CONTROLS SUFFICIENT FOR ALPHA** |
| Reads (lists, details) | authenticated, tenant-scoped, `limit ≤ 200` caps | load only | **EXISTING DOMAIN CONTROLS SUFFICIENT FOR ALPHA** |
| Future provider webhooks | public | forged/replayed events, floods | Primitive ready. **Signature verification + replay claim are the primary controls**; the per-provider IP bucket is secondary and skipped when the IP is unknown (§7) |
| `recordNavigationTimingFn` (perf telemetry) | public, unauthenticated by design, dedicated-staging only (ingest accepts only when `APSA_PERF_INSTRUMENTATION=true` AND `APSA_RUNTIME_ENV=staging`) | log spam, invocation flooding | **RATE LIMITED** (client IP when trusted + global backstop); a refused hit is dropped silently, one throttled `perf.navigation.rate_limited` line per instance per minute |

### 5.2 Values and rationale (`src/server/rate-limit/policies.ts`)

| Rule | Limit | Window | Scope | Why this value |
|---|---|---|---|---|
| `auth.sign_in.identity` | 10 | 15 min | normalized email digest | Many typo retries; stops spraying one account |
| `auth.sign_in.ip` | 50 | 15 min | client IP | A shared shop/NAT IP still fits |
| `auth.sign_up.identity` | 5 | 1 h | normalized email digest | Header-independent; every attempt counts, taken or free address alike |
| `auth.sign_up.ip` | 10 | 1 h | client IP (only when trusted) | A household or shop creating a few accounts |
| `auth.password_reset.cooldown` | 1 | 60 s | email digest | Same cooldown the screen shows (PR #76) |
| `auth.verification_resend.cooldown` | 1 | 60 s | email digest | Same |
| `auth.email.hourly` | 5 | 1 h | email digest | The cooldown cannot be walked all day |
| `auth.email.ip` | 20 | 1 h | client IP | Across addresses |
| `auth.otp_verify.identity` | 10 | 15 min | email digest | 6-digit codes are guessable |
| `auth.otp_verify.token` | 5 | 15 min | `token_hash` digest | Links with no email: bounds replay of one (unguessable) link |
| `auth.otp_verify.ip` | 30 | 15 min | client IP (only when trusted) | |
| `auth.recovery_complete.session` | 10 | 15 min | recovery refresh-token digest | Header-independent; one recovery session cannot affect another |
| `auth.recovery_complete.ip` | 10 | 15 min | client IP (only when trusted) | Recovery cookie is required anyway |
| `orders.create.member` | 60 | 60 s | organization + member | One order per second sustained; a busy POS runs ~1 per 10–20 s per cashier |
| `orders.create.organization` | 600 | 60 s | organization | Ten cashiers at the member ceiling |
| `payments.mutate.member` | 60 | 60 s | organization + member | Far above any real counter |
| `payments.reversal.member` | 20 | 60 s | organization + member | Refund/reverse/correct are rare and audited |
| `webhooks.ip` | 600 | 60 s | provider + client IP (only when trusted) | Secondary to signature + replay checks |
| `perf.telemetry.ip` | 300 | 60 s | client IP (only when trusted) | Diagnostics only; several testers behind one NAT never meet it (the browser caps a page load at 200 sends) |
| `perf.telemetry.global` | 3000 | 60 s | all sources | Header-independent backstop; refusal only drops diagnostic lines |

Every **auth** limit with an IP bucket also has an identity- or token-derived
bucket that never depends on a header. That is not true of webhooks: their IP
bucket is the only rate limit, and it is deliberately secondary — an unsigned
or replayed request is refused by signature / replay checks regardless.

Windows are anchored at the **first hit** and last `windowSeconds`; denied hits
count but never extend the window.

**QA note:** sign-in counts every attempt, successful ones included (that is what
keeps it neutral and race-free). Automated QA that signs one account in through
the app more than 10 times in 15 minutes will be refused with `rate_limited`;
use distinct QA identities or wait out the window. (`verify:staging` signs in
directly against Supabase Auth, not through `signInFn`, and is unaffected.)

### 5.3 Auth anti-enumeration is preserved

- Every attempt counts — not only failures — so a full bucket says nothing about
  whether the account exists. Sign-in for a known and an unknown address reach the
  limit **identically** (tested).
- Reset / public resend still answer `{ ok: true }` when throttled (tested for a
  known and an unknown address); a signed-in member resending to their own address
  still gets the honest `rate_limited`.
- Keys are **HMAC-SHA256 digests** of the normalized email (trim + lowercase),
  peppered with `RATE_LIMIT_KEY_SECRET` or a key derived from
  `SUPABASE_SERVICE_ROLE_KEY`. The raw email is never stored or logged; a digest
  cannot be confirmed by hashing a guessed address without server secrets.

### 5.4 Idempotency vs. rate limiting (orders)

They solve different problems and both remain:

- **Idempotency** (migration 044): same logical request → one order.
- **Rate limit**: one member / organization cannot flood APSA with unique requests.

When a bucket is full, `enforceOrderCreateLimit()` looks up the idempotency key:
if **this member** already created an order under it, the call is a replay and
is let through to `create_order_v2`, which returns the stored order. A merchant
whose response was lost can always recover their order, even at the limit
(tested, including a mutation test). Another member's key is not a bypass.

Payments: idempotency keys and the payment state machine remain the duplicate
protection. A payment retry refused by the limit succeeds once the 60-second
window ends; no payment is lost or duplicated by the refusal.

### 5.5 Backend: PostgreSQL (migration 045)

- `public.rate_limit_buckets` + `public.consume_rate_limit(key, rule, limit, window)`
  — one `INSERT … ON CONFLICT DO UPDATE` per hit, `SECURITY DEFINER`,
  service-role only, RLS enabled with no policies. The database clock is the time
  source. Opportunistic bounded pruning + `prune_rate_limit_buckets()`.
- Chosen because APSA already has exactly one durable store (Supabase Postgres),
  the service-role client is already server-side, and a new KV/Redis provider
  would be a new dependency requiring approval.
- Each limiter round-trip is bounded at 1.5 s.

## 6. Serverless / multi-instance safety

| Component | State lives in | Multiple instances | Cold start | Concurrent requests | Horizontal scale | Classification |
|---|---|---|---|---|---|---|
| Rate-limit counters | PostgreSQL row per bucket | ✅ shared | ✅ unaffected | ✅ row lock serializes one bucket; each hit counted once (tested, 25 concurrent hits) | ✅ | **Production-valid** |
| Rate-limit **fallback** (DB unreachable / 045 not applied) — auth, order creation, routine payments only | per-process `Map` | ❌ up to N × limit | ❌ resets | ✅ within one process | ❌ | **Degraded mode only** — logged `rate_limit.backend_degraded`; readiness FAILS while 045 is absent. **Never used for refund / reversal / correction** |
| Webhook replay receipts | PostgreSQL PK `(provider, event_id)` | ✅ first claim wins | ✅ | ✅ exactly one of N concurrent claims succeeds (tested) | ✅ | **Production-valid**; no memory fallback — an unreachable store must fail the webhook (provider retries) |
| Request context | `AsyncLocalStorage` per call chain | n/a (per request) | n/a | ✅ isolated per request | ✅ | **Correct by construction** |
| Error reporter registry, log sink | module scope, configuration only | ✅ (same config everywhere) | ✅ re-registered at start | ✅ | ✅ | **Configuration, not state** |
| "Missing env" log-once flag | module scope | logs once per instance | logs again | ✅ | ✅ | **Intentional** (per-instance diagnostic) |

**Backend-failure policy, per operation class**
(`src/server/rate-limit/policies.ts#BACKEND_FAILURE_POLICY`):

| Operation class | Durable limiter unavailable → | Why |
|---|---|---|
| Auth (sign-in, sign-up, auth emails, OTP/recovery) | per-instance memory fallback | A database blip must not lock merchants out; Supabase's provider limits remain behind it; anti-enumeration answers unchanged |
| Order creation | per-instance memory fallback | The POS must keep selling; idempotency (044) and authorization remain |
| Routine payments (record, verify, attach evidence) | per-instance memory fallback | Bounded by permission, idempotency and the payment state machine |
| **Refund, reversal, correction** | **FAIL CLOSED** — public retryable 503 `rate_limit_unavailable`, thrown right after the permission check, before any read, write, payment event or audit row; memory is never consulted | Money moving back out (or a financial record rewritten) must not be bounded only per instance, exactly when the database is struggling |
| Webhooks (future) | per-instance memory fallback | The IP bucket is secondary; signature and replay checks are primary |

Tested: with the durable store failing, refund / reversal / correction each
throw the 503, make zero repository calls and zero service-role (audit) calls,
and keep failing past the reversal limit (so no memory bucket is counting);
routine recording in the same outage still reaches the repository.

## 7. Webhook security foundation (no provider built)

`src/server/webhooks/security.ts` + `src/server/webhooks/receipts.ts`:

1. POST only → 2. rate limit per provider + IP (before any crypto) →
3. **raw body** read once as exact bytes, bounded (Content-Length and streaming) →
4. provider signature check using `verifyHmacSignature` / `verifySharedSecret`
   (constant-time) → 5. signed-timestamp tolerance (default ±300 s) →
6. event ID present and bounded → 7. **replay claim** (`claim_webhook_event`,
   first sight wins; a repeat is acknowledged, not processed; `release_webhook_event`
   after failed processing so the provider retry is processed).

Rejections are a generic `{"ok":false}` with the status only; the reason is
logged as a code. **No webhook route is exposed** — a provider phase adds one
route that supplies its signature/timestamp/event-ID readers and its secret.

**Status disclosure (accepted at this stage).** The primitive answers distinct
statuses — 405 (not POST), 429 (rate limited), 413 (body too large), 401 (bad
signature) and 400 (stale timestamp / missing event ID). These reveal only
which generic gate refused the request, never a secret, event or tenant, and
they are useful HTTP semantics for providers' retry logic (a 429/5xx is
retried, a 4xx is not). With no route exposed this is accepted as-is; the
provider phase reviews it against that provider's retry contract.

**Receipt retention.** `prune_webhook_event_receipts(retention_days = 30,
batch_size = 5000)` (migration 045) deletes, oldest first and at most one
bounded batch per call, receipts older than the retention period; it refuses a
retention under 7 days (receipts must outlive the ±300 s signature window and
provider retry schedules of up to ~3 days) and batches over 50 000. Younger
receipts — the active replay records — are never touched (tested against the
real SQL). Application hook: `PostgresWebhookReceiptStore.prune()`. No
scheduler is deployed by this PR: a maintenance job (Supabase cron or an
operator run) must call it repeatedly until it returns less than the batch
size, alongside `prune_rate_limit_buckets()`.

## 8. Health and readiness

| Question | How it is answered | Public? |
|---|---|---|
| Application built | CI: typecheck, lint, tests, build, migration safety, offline readiness | n/a |
| Server process up | `GET /api/health` → `200 {"status":"ok"}` — no DB, env, version, region | **Yes** (reveals nothing) |
| Required env present | server logs `server.env_missing` (names only) once per instance; `verify-readiness --check-app-env` | No |
| DB reachable | `bun run verify:readiness` (service role, staging only) | No |
| **Every migration applied, contiguously** (the proof) | `verify:readiness` §4: `apsa_migration_history()` (migration 045) returns the Supabase CLI ledger `supabase_migrations.schema_migrations`; `scripts/lib/migration-history.ts` requires **every** repository migration file's version to be recorded, none missing (behind / out of order), none unknown. No ledger (files run by hand in the SQL editor) = NOT READY. Object evidence from the PostgREST OpenAPI surface (`scripts/lib/migration-level.ts`) is a cross-check that can only veto — it cannot see ALTER-only migrations. `apsa_schema_level() = 45` is only a convenience marker that 045's own objects exist. Offline, `check:staging-readiness` prints EXPECTED vs HOSTED from `supabase/hosted-migrations.lock.json` | No |
| Critical RPCs exist | `verify:readiness`: every `.rpc("…")` in `src/server` + `src/api` must exist on the target | No |

Current offline answer (repository evidence):

```
EXPECTED: 045 (045_operability_rate_limits_webhooks.sql)
HOSTED:   008 (008_audit_logs.sql) — per supabase/hosted-migrations.lock.json
```

`verify:readiness` refuses to run without staging credentials and a production
URL witness (same gate as `verify:staging`), is read-only, and exits non-zero
unless **every** check passes. It has not been run against any hosted project.

**Why the Supabase CLI ledger, not an APSA ledger table.** The CLI writes one
row per migration file at the moment it applies that file, so a clean staging
rehearsal `001 → 045` via `supabase db push` produces a truthful, complete
history with no historical migration file edited and nothing back-filled by
045. An APSA-maintained table would either require editing 001–044 to
self-record, or 045 inserting rows for 001–044 it cannot prove ran. Proven
against PGlite: a CLI-style rehearsal of every file is READY; skipping the
ALTER-only `042` is NOT READY although every 045 object exists and
`apsa_schema_level()` answers 45.

Consequences to plan for:
- The staging rehearsal **must** apply migrations with the Supabase CLI (`supabase
  db push`), not the SQL editor, or readiness cannot pass.
- **Never** run `supabase migration repair --status applied` to make readiness
  pass: it writes ledger rows without running the file — fabricated history.
- Production's `001`–`008` were recorded by the lock file, not necessarily by the
  CLI ledger. Before any production readiness claim the owner must decide how
  that pre-existing history is evidenced; this PR does not decide it.

## 9. Environment variables introduced

| Name | Required | Purpose |
|---|---|---|
| `RATE_LIMIT_KEY_SECRET` | optional | Dedicated HMAC pepper for rate-limit keys; otherwise derived from `SUPABASE_SERVICE_ROLE_KEY`. Server-only. |
| `RATE_LIMIT_CLIENT_IP_HEADER` | **deployment requirement** for IP limits | The single forwarding header the deployment's proxy **overwrites** (e.g. `x-vercel-forwarded-for` on Vercel, `cf-connecting-ip` behind Cloudflare). **When unset, no forwarding header is trusted** — `x-forwarded-for`, `x-real-ip` and `cf-connecting-ip` are ignored, the client IP is "unknown", every IP bucket is skipped (never pooled), and the identity/token buckets carry auth protection alone. Set it only to a header the edge rewrites on every request; a header a client can send directly is spoofable. |
| `APSA_PERF_INSTRUMENTATION` | optional, **dedicated-staging only** | Server performance instrumentation (`perf.server_function` lines below, and `perf.navigation` ingest). The value must be exactly `true` (no `TRUE`, no padding), and it takes effect **only** when `APSA_RUNTIME_ENV=staging` is also set. OFF everywhere else, including local development and real production. Server-only — deliberately not `VITE_`-prefixed. No default (unset = OFF). `VERCEL_ENV` is not consulted. |
| `APSA_RUNTIME_ENV` | required for instrumentation, **dedicated staging project only** | Server-only runtime marker — deliberately not `VITE_`-prefixed. Set it to exactly `staging` on the dedicated staging project; leave it unset everywhere else. No default (unset = not staging). **Never set it to `staging` on the real production project.** Server performance instrumentation requires BOTH `APSA_PERF_INSTRUMENTATION=true` and `APSA_RUNTIME_ENV=staging`. |
| `VITE_APSA_PERF_NAV_TIMING` | optional, **staging/development builds only** | `true` enables client navigation timing in the browser console. Build-time and public by nature (it carries no secret). Default OFF. |

### Latency instrumentation (diagnostics only)

`src/server/observability/perf.ts` — dedicated-staging only: when BOTH
`APSA_PERF_INSTRUMENTATION=true` and `APSA_RUNTIME_ENV=staging` are set, the
server-function boundary writes ONE `perf.server_function` line per outermost
server-function call:

```json
{"event":"perf.server_function","requestId":"req_…","domain":"orders","operation":"listOrdersFn",
 "route":"orders.listOrdersFn","identityMs":210.4,"getUserMs":205.1,"activeOrgMs":88.2,
 "membershipMs":0.1,"authzMs":298.7,"queryMs":190.8,"totalMs":489.5,"outcome":"ok"}
```

| Field | Measures |
|---|---|
| `identityMs` | `getSessionFn` end to end (cookie read, `auth.getUser`, optional refresh) |
| `getUserMs` / `refreshMs` | Supabase `auth.getUser()` / `auth.refreshSession()` round trips |
| `guardMembershipsMs` | `/app` guard's memberships read (`checkAppGuardFn` only) |
| `activeOrgMs` | `resolveActiveOrganizationId`: ONE memberships read with role and permission keys embedded |
| `membershipMs` | `verifyActiveMembership` end to end. ≈0 when it reuses the context `activeOrgMs` just read in the same call (`src/server/auth/membership-prefetch.ts`) |
| `membershipContextMs` | `verifyActiveMembership`'s own single embedded read — present only when there was nothing to reuse (e.g. `forSlug`, `can`, a second verify in one call) |
| `authzMs` | sum of the top-level authorization phases above (sub-phases not double counted) |
| `queryMs` | `totalMs − authzMs`: domain queries plus handler module loading and serialization |
| `<phase>Count` | present only when a phase ran more than once in one call |

`membershipRowMs`, `rolesMs`, `rolePermissionsMs` and `permissionsMs` no longer
appear: those four sequential reads were collapsed into the one embedded read
above. `identityMs`, `getUserMs`, `activeOrgMs`, `membershipMs`, `authzMs`,
`queryMs` and `totalMs` keep their meaning, so before/after staging lines
compare directly.

Never logged: user or organization IDs, emails, phones, names, tokens, keys, SQL
or error text. OFF means no collector and `timePhase` returns the wrapped promise
itself. Tested in `src/tests/perf-instrumentation.test.ts` (+ `.runtime.ts`: the
whole auth chain returns identical results and errors with the flag on and off).

`src/lib/perf/navigation-timing.ts` — when built with `VITE_APSA_PERF_NAV_TIMING=true`,
each in-app navigation logs `[apsa.perf] {"event":"perf.navigation","from":"home","to":"orders",
"tracked":true,"navigateMs":…,"pendingMs":…,"loadedMs":…,"renderedMs":…,"contentMs":…}`
(milliseconds from the click) and keeps the last 50 in `window.__apsaPerfNav`. Screens
are coarse labels; IDs and search params are never recorded. `contentMs` is the first
frame after render with no `aria-busy="true"` / `.animate-pulse` skeleton on screen.

## 10. Classification

| Item | Status |
|---|---|
| Structured redacted logging, request IDs, global boundary, public error sanitization | **PRODUCTION-READY IN CODE** |
| Rate limiter (auth, orders, payments), webhook primitives | **PRODUCTION-READY IN CODE**, effective only once migration 045 is applied → **REQUIRES STAGING PROOF** |
| Contiguous migration-history proof | **PROVEN IN CODE AND AGAINST PGlite**; hosted result **REQUIRES STAGING** (CLI-applied rehearsal) |
| `verify:readiness` hosted results, backup/restore drill | **REQUIRES STAGING PROOF** |
| Webhook receipt pruning schedule | Function + hook built and tested; **no scheduler deployed** |
| External error-monitoring provider | **DEFERRED** (interface only; needs owner approval + credential) |
| Provider webhook route, provider signatures | **DEFERRED TO TELEGRAM PHASE** |
| Incident runbook, backup/restore plan | **DOCUMENTATION ONLY** |
