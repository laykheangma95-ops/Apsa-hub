# Telegram channel — setup, test and operation

First provider of the unified Inbox. Branch `claude/telegram-provider-v1`,
migration `064_telegram_channel.sql`.

## What it does

```
Customer ──message──▶ merchant's Telegram bot ──webhook──▶ POST /api/webhooks/telegram/<connection id>
                                                             │ secret check (sha256, constant time)
                                                             │ replay claim (webhook_event_receipts)
                                                             ▼
                                         ingest_telegram_inbound (one transaction)
                                         conversation · participant · Customer + TELEGRAM identity
                                         (first contact only) · message · reopen · health
                                                             ▼
                                                     APSA Inbox / Conversation
                                                             │ staff taps Send
                                                             ▼
                          sendConversationReplyFn → begin_outbound_message (idempotent claim)
                          → Telegram sendMessage (plain text) → complete_outbound_message
```

- **Connect** (Settings → Messaging channels → Telegram, Owner only): paste the
  @BotFather token. APSA validates it (`getMe`), encrypts it with
  `CHANNEL_CREDENTIAL_KEY` (AES-256-GCM), stores only the SHA-256 of a fresh
  webhook secret, and calls `setWebhook`. Audited (`integrations.connect`).
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
  submission carries a client UUID; a retry never sends twice. A provider
  refusal is stored as `failed` with a reason and may be retried. Saved replies
  and Smart Actions fill the composer; the merchant taps Send.
- **Disconnect** (Owner only): `deleteWebhook`, credential and secret digest
  cleared, audited. Past conversations stay.

## Permissions (PERMISSIONS_MATRIX.md §25)

| Key                                               | Owner                       | Manager                         | Others |
| ------------------------------------------------- | --------------------------- | ------------------------------- | ------ |
| `integrations.read`, `integrations.view_health`   | ✅                          | ✅                              | ❌     |
| `integrations.connect`, `integrations.disconnect` | ✅                          | ❌ (matrix ⚠️, not granted yet) | ❌     |
| Replying                                          | `messages.reply` (existing) |                                 |        |

## Environment

| Variable                   | Where       | Required                                                                                                       |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_CREDENTIAL_KEY`   | server only | Yes — `openssl rand -base64 32`. Changing it makes stored tokens unreadable (merchants must reconnect).        |
| `VITE_APP_URL`             | server      | Must be a public **https** origin (Telegram only delivers to https).                                           |
| `CHANNEL_WEBHOOK_BASE_URL` | server      | Optional override when `VITE_APP_URL` is behind deployment protection (Vercel Authentication blocks Telegram). |

## Test-deployment checklist

1. Apply migrations through `064` to the **staging** project
   (`supabase db push`; see docs/RELEASE_CHECKLIST.md §2). Without `045` and
   `064` the webhook answers 503/401 and connect fails.
2. Set `CHANNEL_CREDENTIAL_KEY` (and the Supabase variables) on the deployment.
3. Make sure `/api/webhooks/telegram/*` is publicly reachable: disable
   deployment protection for the test deployment, or set
   `CHANNEL_WEBHOOK_BASE_URL` to an origin that is.
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
- A Telegram retry after an APSA failure is processed (the replay claim is
  released on failure); duplicates are acknowledged and dropped.

## Known gaps (tracked)

- A send that times out _after_ Telegram accepted it is recorded `failed`; a
  manual retry could then deliver it twice. Telegram offers no idempotency key.
- A reply stuck in `sending` (server died mid-send) is never auto-retried.
- No media download / sending photos; no read receipts (Bot API has none).
- Manager `integrations.connect` (matrix ⚠️) is not granted.
- Receipt pruning still has no scheduler (docs/OPERABILITY.md).
