# Telegram channel — setup, test and operation

First provider of the unified Inbox. Branch `claude/telegram-provider-v1`,
migration `064_telegram_channel.sql`.

## What it does

```
Customer ──message──▶ merchant's Telegram bot ──webhook──▶ POST /api/webhooks/telegram/<connection id>/<generation>
                                                             │ secret check (sha256, constant time)
                                                             │ replay LOOKUP (webhook_event_receipts)
                                                             ▼
                                         ingest_telegram_inbound (one transaction)
                                         conversation · participant · Customer + TELEGRAM identity
                                         (first contact only) · message · reopen · health
                                         · replay receipt (commits with the message)
                                                             ▼
                                                     APSA Inbox / Conversation
                                                             │ staff taps Send
                                                             ▼
                          sendConversationReplyFn → begin_outbound_message (idempotent claim,
                          mints a sending attempt) → Telegram sendMessage (plain text)
                          → complete_outbound_message (bound to that attempt)
```

- **Connect** (Settings → Messaging channels → Telegram, Owner only): paste the
  @BotFather token. APSA validates it (`getMe`), encrypts it with
  `CHANNEL_CREDENTIAL_KEY` (AES-256-GCM), stores only the SHA-256 of the
  webhook secret, and calls `setWebhook`. Audited (`integrations.connect`).
  Each connect has a fresh **webhook generation**: it is part of the URL
  Telegram gets, and the secret is derived from connection id + generation
  with a subkey of `CHANNEL_CREDENTIAL_KEY` (never stored). The connection is
  reported **connected only after APSA has seen Telegram hold exactly that
  generation's URL** (`getWebhookInfo`). Three outcomes are never merged:
  _verified_ (URL seen) → connected; _acknowledged_ (`setWebhook` answered OK
  but `getWebhookInfo` failed) → not confirmed, re-checked at once by
  reconciliation; _unknown_ (no answer) → not confirmed, bot held in doubt.
  Connect and disconnect carry the initiating member + organization and are
  refused if the session changed.
- **What "Connected" means.** Telegram was _seen_ holding this bot's webhook
  **URL** within the last 60 minutes (Settings shows "Last confirmed with
  Telegram"). Older than that — reconciliation stopped or Telegram
  unreachable — the connection reads "not confirmed", decided at read time. It
  never means Telegram promised delivery.
- **What is and is not observed.** `getWebhookInfo` returns the webhook URL
  only; the Bot API never returns or confirms the secret token Telegram
  holds. "Verified" therefore means _the URL_ matched. Secret consistency is
  not observed from Telegram: it follows from APSA's invariant — the secret is
  derived from (connection id, generation, `CHANNEL_CREDENTIAL_KEY`), so one
  generation URL always carries one secret while the key is unchanged — and
  every repair first checks that the derived secret still matches the stored
  digest. After a key change it sends nothing and marks the connection
  `webhook_key_changed` (merchant: contact support), instead of re-sending the same
  URL with a new secret that `getWebhookInfo` would call verified while every
  delivery is refused.
- **One Telegram-side operation per bot** (migration 064 §2). Connect,
  disconnect and repair each take the bot's operation lease
  (`channel_bot_operations`, 120 s; Telegram writes only in its first 30 s,
  each with a 10 s timeout). The lease is released only when Telegram's
  answer is known — applied, or refused (4xx, never applied). With no answer
  (timeout, network error, 5xx) the outcome is unknown: the lease stays **in
  doubt for 5 minutes**, nothing else may touch the bot, and the connect is
  reported `webhook_unverified` ("not confirmed"), never connected. An
  overlapping operation is refused `connect_in_progress`. An operation that
  learns it was superseded after its own request may have landed re-checks
  Telegram under a fresh lease and points it back at what APSA stores (the
  live connection's generation, or no webhook). This makes overlap unlikely;
  it cannot prevent a request Telegram applies arbitrarily late — Telegram
  offers no such guarantee. That is what reconciliation is for.
- **One bot, one business.** A bot live in one organization is refused to any
  other (`account_in_use`). Reconnecting in the same organization rotates the
  token and secret in place.
- **Inbound:** private chats only. Groups, bot senders, edits and unsupported
  content are acknowledged (200) and ignored. Text, photos, video, voice,
  documents, stickers, shared contacts (phone kept as text) and locations are
  stored. Media files are _labelled_, not downloaded (file ids are kept in
  `attachments` for a later download feature).
- **Customer on first contact:** a Customer and its exact TELEGRAM identity are
  created together. No name/phone matching, no merging.
- **Replies:** plain text, ≤ 4096 chars, from the Conversation composer. Each
  submission carries a client UUID; a replay of a reply that is `sending` or
  `sent` never sends again. A provider refusal is stored as `failed` with a
  reason and may be retried. Each send claim is a separate **attempt**; a late
  Telegram answer is recorded against the attempt that sent it (a late success
  marks the reply `sent` unless a newer attempt is still in flight; a late
  failure of a superseded attempt changes nothing). A timeout, a lost
  connection or the 2-minute `send_stuck` sweep is shown as **delivery not
  confirmed** — never "not delivered" — because none of them proves the
  customer did not receive it. Saved replies and Smart Actions fill the
  composer; the merchant taps Send.
- **Inbound replay:** the webhook only _looks up_ a committed receipt; the
  receipt is written by `ingest_telegram_inbound` in the same transaction as
  the message. A crash before that commit leaves no receipt, so Telegram's
  retry is processed; a retry after it is acknowledged as a duplicate.
- **Disconnect** (Owner only), under the bot's lease: credential, secret digest
  and generation cleared first (audited), then `deleteWebhook` — so a
  reconnect cannot start while that request could still land. Past
  conversations stay.

## Permissions (PERMISSIONS_MATRIX.md §25)

| Key                                               | Owner                       | Manager                         | Others |
| ------------------------------------------------- | --------------------------- | ------------------------------- | ------ |
| `integrations.read`, `integrations.view_health`   | ✅                          | ✅                              | ❌     |
| `integrations.connect`, `integrations.disconnect` | ✅                          | ❌ (matrix ⚠️, not granted yet) | ❌     |
| Replying                                          | `messages.reply` (existing) |                                 |        |

## Environment

| Variable                   | Where       | Required                                                                                                                                                                                          |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_CREDENTIAL_KEY`   | server only | Yes — `openssl rand -base64 32`. Changing it makes stored tokens unreadable: restore the old key (connections recover on their next check); merchants reconnect only if it is irrecoverably lost. |
| `VITE_APP_URL`             | server      | Must be a public **https** origin (Telegram only delivers to https).                                                                                                                              |
| `CHANNEL_WEBHOOK_BASE_URL` | server      | Optional public https origin for the webhook URL. It must be an origin that is public **by design**; never point it at, or create it by, weakening deployment protection.                         |
| `CRON_SECRET`              | server only | Needed for reconciliation: the scheduler's bearer secret for `/api/internal/channels/reconcile`. Unset = reconciliation off.                                                                      |

## Test-deployment checklist

1. **Migrations are not part of this branch's test steps.** Migration `064`
   (and the `045` receipts it depends on) reach a database only through the
   separately approved staging migration rehearsal (docs/RELEASE_CHECKLIST.md
   §2, APSA_BUILD_STATUS.md), after the target's applied migrations have been
   inspected. Do not `supabase db push` a range blindly. Without `045` and
   `064` the webhook answers 503/401 and connect fails.
2. Set `CHANNEL_CREDENTIAL_KEY` (and the Supabase variables) on the deployment.
3. Telegram must reach `/api/webhooks/telegram/*` over public https. **Do not
   disable or bypass deployment protection** to achieve this. Until an approved
   ingress exists (see _Webhook ingress — proposal_ below), test only against
   a deployment whose origin is public by design, or stop at step 2.
4. In Telegram, create a **test** bot with @BotFather.
5. Sign in as the Owner → Settings → Messaging channels → Telegram → paste the
   token → _Connect Telegram_.
6. From a personal Telegram account, message the bot. Within seconds it is in
   the Inbox with a new Customer.
7. Reply from the Conversation. It arrives in Telegram; the bubble shows ✓.
8. Block the bot from the personal account and reply again: the bubble shows ✕
   and "customer has blocked your bot". Unblock, tap Send again: delivered once.
9. Check logs: `channels.telegram.ingested`, no token, no message text.
10. Disconnect. Messages to the bot no longer arrive; replying shows
    "channel is no longer connected".

Verify Telegram's view at any time (from a trusted machine, never paste the
token anywhere shared): `https://api.telegram.org/bot<token>/getWebhookInfo`.

## Reconciliation (operator)

A request APSA sent may still be applied by Telegram arbitrarily late — e.g.
a timed-out `deleteWebhook` after a newer connect, which silences the bot with
no customer message arriving to reveal it. Every live connection is therefore
re-checked on a schedule, independent of traffic (migration 064 §2a,
`src/server/channels/reconcile.ts`).

| Aspect         | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry          | `GET` or `POST /api/internal/channels/reconcile`, `Authorization: Bearer $CRON_SECRET`. No `CRON_SECRET` → 503 (off). Wrong credential → generic 401. Answers counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Schedule       | Every **5 minutes** (Vercel Cron or any HTTPS scheduler). **Not configured by this PR**: an operator step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ownership      | None needed. `claim_channel_reconcile_batch` gives each due row to one run (`FOR UPDATE SKIP LOCKED`) with a **unique claim id** valid for 2 minutes. Overlapping runs never share a row; a run that dies hands its rows back when its claim lapses; a restart simply resumes with what is due. **Fence:** `record_channel_reconcile` records only under the claim that still owns the row — a slow run whose claim lapsed or was replaced records no health, failure, backoff or mismatch. Telegram writes only under the bot's `repair` operation lease, never alongside a member's connect/disconnect.        |
| Per connection | One `getWebhookInfo`. Right URL → healthy, next check in **15 min**. Missing / wrong → repair (`setWebhook` + `getWebhookInfo`) under the lease. Bot busy → retry in 1 min. Failure → retry after 1, 2, 4 … **60 min** (capped).                                                                                                                                                                                                                                                                                                                                                                                 |
| Rate limits    | ≤ 25 connections per run, no new connection after 45 s, ≤ 3 Telegram calls per connection per run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Merchant view  | Missing / wrong webhook → _Needs attention_ with an explanation and since-when; not seen for 60 min → _not confirmed_. A stored token that cannot be decrypted (`credential_unreadable` — an APSA key-configuration fault, not Telegram) is shown **at once**, says checking again won't fix it and asks the merchant to contact support; reconnect only if support asks.                                                                                                                                                                                                                                        |
| Operator alert | From the 3rd consecutive failed check, each run logs `channels.telegram.reconcile_alert` (error level; connection id, failure count, kind, since-when — never a token, key or secret). A `credential_unreadable` result alerts on the **first** check, with the action: restore the `CHANNEL_CREDENTIAL_KEY` the token was encrypted with (the row recovers on its next check); only if that key is irrecoverably lost, have the merchant reconnect. Nothing is sent to Telegram and no stored generation, digest or ciphertext changes meanwhile. Every run logs `channels.telegram.reconcile_run` with counts. |

**Timing: a conditional target, not a bound.** About **20 minutes**
(15-minute check interval + 5-minute schedule) is the target for an
_eligible_ connection — not backing off, bot not held by another operation —
when the scheduler runs, the next run has capacity for it, and Telegram's
calls succeed. There is **no fixed worst-case bound**:

- **Backlog.** A run checks at most 25 connections (fewer when Telegram is
  slow and the 45 s run budget ends). 250 connections due at once need 10 runs
  — the last is first checked about 45 minutes later — and with 250 live
  connections each is re-checked only about every 50 minutes, not 15
  (`backlogRuns`, `steadyStateCheckIntervalMs`; tested against the SQL).
- **Backoff.** After _k_ consecutive failures the next check is 1, 2, 4 … up
  to 60 minutes away. When an outage ends, the first check that can succeed
  may be up to 60 minutes + one schedule interval (≈ 65 minutes) later — and
  then still subject to backlog (`reconcileBackoffMs`; tested against the
  SQL).
- **Outages.** While Telegram or the database is unreachable nothing is
  repaired at all.
- **Contention.** A bot held by another operation is retried every minute for
  as long as that lasts (an in-doubt lease lasts 5 minutes).
- **Stopped scheduling.** Nothing runs; connections only age to "not
  confirmed" after 60 minutes.

Late provider writes are **detected and repaired when the above allow — not
prevented**. Telegram's Bot API documentation states that updates are kept
on Telegram's side until received, for at most 24 hours, so messages sent
during a gap shorter than that should be delivered once the webhook is
restored; a longer gap can lose them.

**Not covered.** If no scheduler runs, nothing is repaired automatically (the
connection still ages to "not confirmed" after 60 minutes). If Telegram stays
unreachable, the connection reads "not confirmed" and alerts continue, but
nothing can be repaired. A disconnected bot holds no credential, so a late
`setWebhook` for it cannot be removed (its deliveries are refused 401).

## Operations

- Logs: `channels.telegram.*` and `webhook.*` events. Payloads are never logged.
- Health: Settings shows last customer message and last confirmation by
  Telegram; `channel_connections` holds `last_inbound_at`, `last_outbound_at`,
  `last_error_code`, `last_verified_at`, `reconcile_failures`,
  `reconcile_error`, `mismatch_since`.
- A Telegram retry after an APSA failure or crash is processed (the receipt
  commits only with the message); duplicates are acknowledged and dropped.

## Known gaps (tracked)

- A send that times out _after_ Telegram accepted it is recorded `failed`
  (shown as "delivery not confirmed"); a manual retry could then deliver it
  twice. Telegram offers no idempotency key. If the late answer arrives, the
  ledger records the delivery (`delivered_refs`), but the duplicate in the
  customer's chat cannot be undone.
- A reply stuck in `sending` (server died mid-send) is never auto-retried.
- Late provider writes are detected and repaired, not prevented. Between the
  write landing and the next successful reconciliation check the bot can be
  silent or pointed at an older generation — about 20 minutes as a target,
  with no fixed worst case (see Reconciliation → Timing). Repair relies on
  the scheduler being configured.
- The secret Telegram holds is never observed (the Bot API does not return
  it); consistency rests on APSA's derivation invariant and the digest check
  before every repair.
- During a re-connect (rotation), deliveries for the previous generation are
  verified against that generation's derived secret and stored, not refused.
- No media download / sending photos; no read receipts (Bot API has none).
- Manager `integrations.connect` (matrix ⚠️) is not granted.
- Receipt pruning still has no scheduler (docs/OPERABILITY.md).

## Webhook ingress — proposal (not implemented)

Telegram cannot authenticate to Vercel Deployment Protection, so a protected
deployment cannot receive webhooks. This repair deliberately builds and
configures **nothing** for that; the design below is for separate review.

- **Do not** disable protection, add a protection-bypass secret to the bot's
  URL, or expose a preview deployment publicly. A bypass token in a URL is a
  credential handed to a third party and logged by it.
- **Proposed:** a dedicated, minimal ingress origin (its own project or a
  path-scoped public route on the production origin) that is public by design
  and serves _only_ `POST /api/webhooks/telegram/<uuid>/<uuid>`. Everything else on it
  answers 404. It keeps the existing secret-header check, rate limit, body
  bound and atomic receipt, and holds no session cookies.
- Optional hardening to evaluate: Telegram's published source ranges as a
  coarse allow-list (defence in depth only — the secret remains the
  authority), per-connection rate limits, and alerting on sustained 401s.
- Decision needed from the owner: which origin, who operates it, and how it is
  reviewed before any bot is pointed at it.
