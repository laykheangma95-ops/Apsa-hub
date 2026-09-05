# Inbox / Conversation continuation review

Base: `95718a4a39625736dee961960df9d7a31f8fd569` (main).
Branch: `codex/inbox-conversation-production`.

This continuation builds on the merged Conversation foundation in migrations
031–033. Migrations 028–029 remain exclusively reserved for Claude/Sonnet's
Payment rebuild. This change adds only migrations 034–035. No hosted migrations
were applied, and no Payment-domain files or intent-engine files are in the diff.

## Architecture and behavior

- Routes call the browser-safe `src/api/inbox.ts` facade. Its production paths
  enter `src/api/conversations.ts`; server modules and the service-role client
  remain dynamically imported inside server handlers.
- The existing session/JWT validation and active database membership resolution
  provide user and organization context. Neither is accepted in API input.
- All reads require `messages.read`. Status and assignment commands retain the
  existing `messages.*` permission vocabulary and now use POST server functions.
- Inbox queries return bounded keyset pages ordered by activity and UUID. The UI
  exposes Load more; message detail exposes Load earlier. A cursor's anchor must
  belong to the same organization (and message anchors to the same conversation).
  Invalid anchors fail with `invalid_cursor`; changed activity anchors fail with
  `stale_state` instead of silently restarting a page.
- Inbox counts aggregate in SQL, avoiding the previous client-side aggregation
  of a potentially truncated database response. Search binds text as an SQL
  parameter and searches previews and customer display names only, eliminating
  both filter-expression interpolation and the phone-number inference path.
- Customer names are fetched in batches. Staff names are fetched only after
  resolving active organization memberships, and are returned without contact
  information. Detail reads only the customer display name; the existing
  Customer 360 API remains responsible for `customers.view_sensitive` authority.

## Read state

`conversation_read_markers` has a composite organization/conversation/user key,
a monotonic last-read sequence, and an update timestamp. There is no guessed
historical per-user read state; without a marker, inbound history is unread.

Every inserted message receives a sequence while holding its conversation row
lock. This uses arrival order, not the provider's timestamp. An old or delayed
provider message therefore remains unread. A read command supplies a displayed
message UUID, and SQL derives its sequence and applies `greatest(old, new)`.
Retries and out-of-order read requests cannot regress the marker, and messages
arriving after the displayed snapshot remain unread. Older message pages also
return a read-through marker so delayed messages beyond the first page can be
cleared once loaded. Each staff member's state is independent.

The original `conversations.unread_count` column remains for compatibility;
production reads replace it with the requesting user's derived count. The
Inbox unread filter and count use that derived value. Existing operational
status vocabulary is retained; production UI does not offer unread as an
operational status change.

## Identity, provider and message contracts

`conversation_participants` stores observed provider identity references with a
composite tenant-safe conversation FK. Resolution follows the conversation's
provider and the participant reference into existing `customer_identities`
(`provider_user_id`), then into the same organization's `customers` table.
There is no parallel Customer table, browser-supplied Customer write, weak-signal
matching, or automatic merge. Unresolved and ambiguous groups remain unlinked.
An identity linked later is reflected by the authoritative read projection.
Legacy stored Customer links remain supported when no participant references
exist.

`ensure_provider_conversation` and `ingest_conversation_message` are internal,
service-role-only adapter foundations; no provider/webhook endpoints are exposed.
Conversation references deduplicate within organization and provider. Message
references deduplicate within their conversation; retries return the original
row and conflicting reuse returns `stale_state`. Ingestion serializes against
the conversation row. Staff message attribution comes from the authorized
context. Body limits, direction/sender consistency, provider references, and
bounded attachment metadata are checked before persistence.

Existing inbound/outbound/system directions, delivery-state metadata, provider
timestamps and attachment metadata stay in the Conversation/Message domain.
The schema now accepts WhatsApp, TikTok and APSA Consumer as future provider
values, without claiming any corresponding integration exists. Unsupported UI
providers use a generic channel badge. The sole Order helper adjustment maps
that generic UI channel to the existing MANUAL source; no Order engine,
confirmation behavior, payment-state logic, or inventory code was changed.

## Assignment and database security

Assignments validate active same-organization membership before mutation, with
the existing database integrity trigger as a second check. Clearing another
staff member's assignment additionally requires `messages.assign`. A conditional
update rejects races with `stale_state` instead of clearing a newly changed
assignment.

Authenticated/anonymous/PUBLIC table access is revoked for Conversation and
Message data, closing the previous membership-only bypass of service permissions.
New participant/read-marker tables have RLS enabled and no browser policies or
grants. New RPCs are invoker functions executable only by service_role. Composite
FKs, provider uniqueness, and indexed message sequences protect tenant boundaries.
Repository failures are mapped to safe domain errors without raw PostgreSQL text.
Integrity triggers run on ownership-reference writes, allowing sequence backfill
for historical messages whose staff have since departed. A new composite
Message-to-Conversation FK prevents moving a conversation across tenants while
leaving its messages behind. A pre-migration departed-staff fixture verifies the
backfill, and an actual service_role test verifies the new RPC grants.

## Smart Actions, Order handoff and mock boundary

Real message summaries preserve `body`, `direction`, and `at` for the existing
`buildSmartActionSuggestion`. `src/lib/intent/**` is unchanged, including Khmer,
mixed-language and romanized Khmer detection. Both production Prepare Order
entry points use the existing draft/confirm workflow. Conversation content is
not copied into Orders; only the existing source reference and Customer link
are used.

Production UUIDs use server APIs. Mock/non-UUID conversation paths stay in the
existing demo domain; write and pagination wrappers reject mock IDs before
importing a server function. Production replies no longer appear falsely as
locally sent messages: the UI preserves draft text and explains that sending
requires a connected channel. Demo sending is unchanged.

## Existing main blockers — do not deploy this as a completed production flow

1. **Migration 030 fails on a fresh database.** It creates an eight-argument
   `create_order_v1` overload but leaves the seven-argument function in place.
   Its signature-less `COMMENT ON FUNCTION public.create_order_v1` fails with
   `function name "public.create_order_v1" is not unique`.
2. **The new eight-argument Order overload has PUBLIC execute by default.**
   Local PostgreSQL confirms that `authenticated` can execute this SECURITY
   DEFINER function. The revocation on the earlier signature does not secure
   the new signature. This needs an Order-domain migration/security repair
   before the production Order handoff is safe. Neither historical migration
   030 nor Order RPC/security logic was modified in this Conversation PR.
3. **Clean-main gates already fail:** the isolated auth-hardening test times
   out at its 5-second limit, and repository lint reports existing errors.

The local SQL fixture executes the real migrations except reserved Payment
migrations and initially skips 030. A separate diagnostic reproduces 030's
failure and unsafe privilege. It then omits only the failing COMMENT in its
disposable database to test the unchanged Order function body. Under that
explicit prerequisite, the real UUID Conversation → Customer → Smart Action →
Draft → Confirm handoff passes: draft leaves stock at 10, confirmation changes
it to 8, draft/confirmation leave the Order unpaid, and draft creates no delivery.
This is **not** a claim that migration 030 or hosted production is ready.

## Verification

All database execution uses disposable local PGlite; no hosted database or
provider credentials are required. The SQL-backed transport fixture runs the
actual service and repository queries but does not replace an HTTP/PostgREST or
authenticated browser end-to-end test. Existing live Supabase tests skip without
credentials.

| Gate | Result |
| --- | --- |
| New local SQL/service/repository runtime | 29 passed, 0 failed |
| Focused Conversation, Inbox, Smart Actions, Khmer, Customer, Order, tenant and bundle regressions | 715 passed, 0 failed |
| Typecheck | Passed |
| Changed TypeScript file lint | Passed, no warnings |
| Production build | Passed |
| Full suite after build | 1,056 passed; 1 pre-existing auth-hardening timeout |
| Clean-main full suite | 1,051 passed; same auth-hardening timeout |
| Repository lint | 401 errors, 12 warnings, all outside changed files |
| Clean-main repository lint | 402 errors, 12 warnings |
| Clean-main typecheck and production build | Passed |
| Hosted migrations | NOT APPLIED |

Clean-main comparison uses the same dependency runtime and LF source content at the base
commit; initial CRLF-only lint/structural failures were separated from actual
source failures. Changed-file lint is checked independently of existing lint debt.

Commands:

```text
bun test ./src/tests/conversation-production.runtime.ts
bun test src/tests/conversation-domain.test.ts src/tests/conversation-production.test.ts src/tests/conversation-smart-actions.test.ts src/tests/khmer-intent.test.ts src/tests/customer-domain.test.ts src/tests/order-domain.test.ts src/tests/order-ui-integration.test.ts src/tests/order-inventory-integration.test.ts src/tests/tenant-isolation.test.ts src/tests/bundle-boundary.test.ts
bun run typecheck
bun run lint
bun run build
bun test src/tests/
```

The new SQL/runtime suite covers per-user and delayed read markers, idempotent
ingestion, provider metadata, foreign Conversation/Message/Customer/provider
references, foreign assignment targets, browser database privileges, service
permission gates, cursor validation, message pagination, search privacy,
CustomerIdentity resolution, assignment protection and the conditional Order
handoff. Additional wrapper tests ensure non-UUID IDs never reach server functions.

## Changed files

- `supabase/migrations/034_conversation_read_identity.sql`
- `supabase/migrations/035_conversation_ingestion.sql`
- `src/server/conversations/{repository,service,types,errors}.ts`
- `src/api/{conversations,inbox}.ts`
- `src/lib/api/index.ts`, `src/lib/orders.ts`, `src/types/index.ts`
- `src/routes/app.inbox.tsx`, `src/routes/app.inbox.$id.tsx`
- `src/design-system/ChannelBadge.tsx`, `src/design-system/ConversationRow.tsx`
- `src/locales/en.json`, `src/locales/km.json`
- `src/tests/conversation-domain.test.ts`
- `src/tests/conversation-production.test.ts`, `src/tests/conversation-production.runtime.ts`
- `src/tests/helpers/conversation-postgrest.ts`
- `package.json`, `bun.lock`, `package-lock.json` (local PostgreSQL test dependency)
- This review report.

Hosted migrations: **NOT APPLIED**.
PAYMENT DOMAIN FILE OVERLAP: **NONE**.
READY FOR MERGE REVIEW: **NO — draft PR; existing Order migration/security and gate blockers above**.
