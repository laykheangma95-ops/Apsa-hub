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
  generation's URL** (`getWebhookInfo`); until then it shows _Needs
  attention_. Connect and disconnect carry the initiating member +
  organization and are refused if the session changed.
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
  live connection's generation, or no webhook).
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

| Variable                   | Where       | Required                                                                                                                                                                  |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_CREDENTIAL_KEY`   | server only | Yes — `openssl rand -base64 32`. Changing it makes stored tokens unreadable (merchants must reconnect).                                                                   |
| `VITE_APP_URL`             | server      | Must be a public **https** origin (Telegram only delivers to https).                                                                                                      |
| `CHANNEL_WEBHOOK_BASE_URL` | server      | Optional public https origin for the webhook URL. It must be an origin that is public **by design**; never point it at, or create it by, weakening deployment protection. |

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

## Operations

- Logs: `channels.telegram.*` and `webhook.*` events. Payloads are never logged.
- Health: Settings shows last customer message; `channel_connections` holds
  `last_inbound_at`, `last_outbound_at`, `last_error_code`.
- A Telegram retry after an APSA failure or crash is processed (the receipt
  commits only with the message); duplicates are acknowledged and dropped.

## Known gaps (tracked)

- A send that times out _after_ Telegram accepted it is recorded `failed`
  (shown as "delivery not confirmed"); a manual retry could then deliver it
  twice. Telegram offers no idempotency key. If the late answer arrives, the
  ledger records the delivery (`delivered_refs`), but the duplicate in the
  customer's chat cannot be undone.
- A reply stuck in `sending` (server died mid-send) is never auto-retried.
- Provider timing assumption: Telegram applies a request within 80 s of APSA
  sending it, or never. Beyond that, a `setWebhook` landing late is still
  _detected_ — a delivery carrying an older generation's valid secret is
  stored and flags the connection `webhook_mismatch` — but a `deleteWebhook`
  landing late after a newer verified connect silences the bot with nothing
  arriving to reveal it until the merchant reconnects.
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
