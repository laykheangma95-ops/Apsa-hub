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
  `cookie`, `authorization`, `key`, `otp`, `session`, `signature`, `email`,
  `phone`, `address`, `card`, `body`, `content`, `text`, `note`, `name`, … is
  replaced with `[REDACTED]`. Known-safe identifiers (`organizationId`, `userId`,
  `requestId`, `orderId`, …) are allow-listed.
- **Value-based:** JWTs, `Bearer …`, emails, card-like and phone-like digit runs,
  `token=`/`apikey=` query parameters and 40+ char opaque secrets are scrubbed from
  every remaining string. UUIDs and ISO timestamps are protected.
- Strings are truncated (500 chars); nesting, arrays and cycles are bounded.

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

**Correlation path for "Order failed":** UI error message carries
`[ref:req_…]` → `server_fn.unexpected_error` log line with the same `requestId`,
`domain: "orders"`, `operation: "createOrderFn"`, `errorClass`, `errorCode` →
the scrubbed error message and stack frames in that line.

## 4. Safe error UX

| Error kind | What the browser receives |
|---|---|
| Domain error (numeric `statusCode`: 400/401/403/404/409/410/429/503, service-authored message) | **Unchanged.** Every UI classifier (`classifyOrderError`, `classifyPaymentError`, …) depends on these messages. Permission, invalid transition, idempotency conflict, payment conflict stay specific. |
| Validation (`ZodError`) | Unchanged (describes the caller's own input). |
| TanStack `redirect` / `notFound` / `Response` | Unchanged. |
| **Anything else** (PostgREST/SQL text, provider errors, bugs) | `"Something went wrong on the server. Please try again. [ref:req_…]"` — no stack, SQL, table/constraint names, secret names. Classified as the generic "server error" kind by every existing UI classifier (tested). |
| Rate-limit refusal | `"rate_limited: Too many requests. Try again in N seconds."` (429). Names no rule, bucket or identity. |
| Audit store unavailable (`auditLogRequired`) | Now a public 503 with a fixed message (no DB text); the inventory UI still shows its "audit blocked" copy. |

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
| `signUpFn` | public | mass account creation, email cost | **RATE LIMITED** (IP) |
| `requestPasswordResetFn` | public, anti-enumerating | email bombing, enumeration | **RATE LIMITED** (cooldown + hourly identity + IP), neutral answer preserved |
| `resendVerificationFn` | public / self | email bombing | **RATE LIMITED** (same as reset) |
| `verifyEmailFn` (token + email) | public | 6-digit OTP guessing | **RATE LIMITED** (identity + IP) |
| `beginPasswordRecoveryFn` | public | OTP guessing (token + email links) | **RATE LIMITED** (identity when present + IP) |
| `completePasswordRecoveryFn` | recovery cookie required | password-change flooding | **RATE LIMITED** (IP) |
| `createOrderFn` | authenticated, `orders.create` | high-volume abuse, stock reservation noise | **RATE LIMITED** (member + organization); idempotent replays exempt |
| `recordPaymentFn`, `verifyPaymentFn`, `attachPaymentEvidenceFn` | authenticated, `payments.*` | financial impact, audit volume | **RATE LIMITED** (member) |
| `refundPaymentFn`, `reversePaymentFn`, `correctPaymentFn` | authenticated, `payments.refund/reverse/override_status` | money moving back out, mandatory audit | **RATE LIMITED** (tighter member bucket + member bucket) |
| Delivery transitions | authenticated, `deliveries.*` | no external side effect (no courier provider), state machine + permission + history in one RPC | **EXISTING DOMAIN CONTROLS SUFFICIENT FOR ALPHA** |
| Customer create/update | authenticated, `customers.*`, PII-gated (CORRECTION-002) | no financial effect, audited | **EXISTING DOMAIN CONTROLS SUFFICIENT FOR ALPHA** |
| Reads (lists, details) | authenticated, tenant-scoped, `limit ≤ 200` caps | load only | **EXISTING DOMAIN CONTROLS SUFFICIENT FOR ALPHA** |
| Future provider webhooks | public | forged/replayed events, floods | Primitive ready: **RATE LIMITED** per provider + IP before signature work (§7) |

### 5.2 Values and rationale (`src/server/rate-limit/policies.ts`)

| Rule | Limit | Window | Scope | Why this value |
|---|---|---|---|---|
| `auth.sign_in.identity` | 10 | 15 min | normalized email digest | Many typo retries; stops spraying one account |
| `auth.sign_in.ip` | 50 | 15 min | client IP | A shared shop/NAT IP still fits |
| `auth.sign_up.ip` | 10 | 1 h | client IP | A household or shop creating a few accounts |
| `auth.password_reset.cooldown` | 1 | 60 s | email digest | Same cooldown the screen shows (PR #76) |
| `auth.verification_resend.cooldown` | 1 | 60 s | email digest | Same |
| `auth.email.hourly` | 5 | 1 h | email digest | The cooldown cannot be walked all day |
| `auth.email.ip` | 20 | 1 h | client IP | Across addresses |
| `auth.otp_verify.identity` | 10 | 15 min | email digest | 6-digit codes are guessable |
| `auth.otp_verify.ip` | 30 | 15 min | client IP | |
| `auth.recovery_complete.ip` | 10 | 15 min | client IP | Recovery cookie is required anyway |
| `orders.create.member` | 60 | 60 s | organization + member | One order per second sustained; a busy POS runs ~1 per 10–20 s per cashier |
| `orders.create.organization` | 600 | 60 s | organization | Ten cashiers at the member ceiling |
| `payments.mutate.member` | 60 | 60 s | organization + member | Far above any real counter |
| `payments.reversal.member` | 20 | 60 s | organization + member | Refund/reverse/correct are rare and audited |
| `webhooks.ip` | 600 | 60 s | provider + client IP | Provider bursts fit; floods do not |

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
| Rate-limit **fallback** (DB unreachable / 045 not applied) | per-process `Map` | ❌ up to N × limit | ❌ resets | ✅ within one process | ❌ | **Degraded mode only** — logged `rate_limit.backend_degraded`; readiness FAILS while 045 is absent |
| Webhook replay receipts | PostgreSQL PK `(provider, event_id)` | ✅ first claim wins | ✅ | ✅ exactly one of N concurrent claims succeeds (tested) | ✅ | **Production-valid**; no memory fallback — an unreachable store must fail the webhook (provider retries) |
| Request context | `AsyncLocalStorage` per call chain | n/a (per request) | n/a | ✅ isolated per request | ✅ | **Correct by construction** |
| Error reporter registry, log sink | module scope, configuration only | ✅ (same config everywhere) | ✅ re-registered at start | ✅ | ✅ | **Configuration, not state** |
| "Missing env" log-once flag | module scope | logs once per instance | logs again | ✅ | ✅ | **Intentional** (per-instance diagnostic) |

**Fail-open decision (documented, deliberate):** if the limiter's database call
fails, the hit falls back to the per-process store rather than refusing the
request. A database blip must not lock merchants out of sign-in or the POS; every
protected action still has its own authorization, idempotency, state machine and
(for auth) Supabase's provider-side limits behind it. **No production-critical
protection relies solely on process memory.**

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

## 8. Health and readiness

| Question | How it is answered | Public? |
|---|---|---|
| Application built | CI: typecheck, lint, tests, build, migration safety, offline readiness | n/a |
| Server process up | `GET /api/health` → `200 {"status":"ok"}` — no DB, env, version, region | **Yes** (reveals nothing) |
| Required env present | server logs `server.env_missing` (names only) once per instance; `verify-readiness --check-app-env` | No |
| DB reachable | `bun run verify:readiness` (service role, staging only) | No |
| Expected migration level | `verify:readiness`: **EXPECTED vs HOSTED** from the PostgREST OpenAPI surface (`scripts/lib/migration-level.ts`); `check:staging-readiness`: EXPECTED vs HOSTED from `supabase/hosted-migrations.lock.json` | No |
| Critical RPCs exist | `verify:readiness`: every `.rpc("…")` in `src/server` + `src/api` must exist on the target | No |
| Operability schema | `verify:readiness`: `apsa_schema_level()` = 45 | No |

Current offline answer (repository evidence):

```
EXPECTED: 045 (045_operability_rate_limits_webhooks.sql)
HOSTED:   008 (008_audit_logs.sql) — per supabase/hosted-migrations.lock.json
```

`verify:readiness` refuses to run without staging credentials and a production
URL witness (same gate as `verify:staging`), is read-only, and exits non-zero
unless **every** check passes. It has not been run against any hosted project.

## 9. Environment variables introduced

| Name | Required | Purpose |
|---|---|---|
| `RATE_LIMIT_KEY_SECRET` | optional | Dedicated HMAC pepper for rate-limit keys; otherwise derived from `SUPABASE_SERVICE_ROLE_KEY`. Server-only. |
| `RATE_LIMIT_CLIENT_IP_HEADER` | optional | The single forwarding header the deployment's proxy guarantees (e.g. `x-vercel-forwarded-for`, `cf-connecting-ip`). Without it: `cf-connecting-ip` → `x-real-ip` → left-most `x-forwarded-for`. IP limits are always secondary to identity limits. |

## 10. Classification

| Item | Status |
|---|---|
| Structured redacted logging, request IDs, global boundary, public error sanitization | **PRODUCTION-READY IN CODE** |
| Rate limiter (auth, orders, payments), webhook primitives | **PRODUCTION-READY IN CODE**, effective only once migration 045 is applied → **REQUIRES STAGING PROOF** |
| `verify:readiness` hosted results, backup/restore drill | **REQUIRES STAGING PROOF** |
| External error-monitoring provider | **DEFERRED** (interface only; needs owner approval + credential) |
| Provider webhook route, provider signatures | **DEFERRED TO TELEGRAM PHASE** |
| Incident runbook, backup/restore plan | **DOCUMENTATION ONLY** |
