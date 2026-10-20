/**
 * POST /api/webhooks/telegram/<connection id> — Telegram → APSA Inbox.
 *
 * Dispatched from src/server.ts before the application router (like
 * /api/health): no session, no cookies, no server-function CSRF — the only
 * credential is the per-connection secret Telegram echoes in
 * X-Telegram-Bot-Api-Secret-Token.
 *
 * Runs on the shared webhook boundary (src/server/webhooks/security.ts), in
 * its order: method → rate limit → bounded raw body → signature → event id →
 * replay claim. Telegram does not sign a timestamp, so there is no tolerance
 * check; replay is bounded by the receipt store instead.
 *
 *   signature  sha256(header secret) compared in constant time with the
 *              connection's stored digest. Unknown, disconnected and
 *              wrong-secret requests are the same generic 401.
 *   event id   "<connection id>:<update_id>" — update_id is unique per bot.
 *   tenant     the organization is the connection row's, taken in SQL
 *              (ingest_telegram_inbound). Nothing in the payload selects it.
 *
 * Outcomes:
 *   200  processed, duplicate, or deliberately ignored (group chat, bot
 *        sender, unsupported content) — Telegram must not retry these.
 *   401/405/413/429/400  the shared generic rejection.
 *   500/503  ingestion or receipt store failed; the claim is released so
 *        Telegram's own retry is processed, never lost as a "duplicate".
 *
 * Payload bodies are never logged (API_AND_EVENTS.md §68).
 *
 * Server-only.
 */
import { serverLog } from "@/server/observability/logger";
import { clientIpFromHeaders } from "@/server/rate-limit/client-ip";
import {
  timingSafeEqual,
  verifyWebhookRequest,
  webhookRejection,
} from "@/server/webhooks/security";
import { PostgresWebhookReceiptStore, type WebhookReceiptStore } from "@/server/webhooks/receipts";
import { sha256Hex } from "../credentials";
import { ChannelError } from "../errors";
import * as repo from "../repository";
import { TELEGRAM_WEBHOOK_PATH_PREFIX } from "./paths";
import { parseTelegramUpdate, telegramUpdateId } from "./update";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Telegram updates are small; a photo update is a few KB. */
const MAX_BODY_BYTES = 64 * 1024;

function acknowledged(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Errors that a Telegram retry cannot fix: acknowledge, log, move on. */
const PERMANENT: ReadonlySet<string> = new Set([
  "invalid_reference",
  "stale_state",
  "connection_not_found",
]);

export interface TelegramWebhookOptions {
  receipts?: WebhookReceiptStore;
  clientIp?: string | null;
  nowMs?: number;
}

export async function handleTelegramWebhook(
  request: Request,
  options: TelegramWebhookOptions = {},
): Promise<Response> {
  const connectionId = new URL(request.url).pathname.slice(TELEGRAM_WEBHOOK_PATH_PREFIX.length);
  if (!UUID_RE.test(connectionId)) return webhookRejection(404);

  const receipts = options.receipts ?? new PostgresWebhookReceiptStore();
  let verification;
  try {
    verification = await verifyWebhookRequest(
      request,
      {
        provider: "telegram",
        maxBodyBytes: MAX_BODY_BYTES,
        async verifySignature(_rawBody, headers) {
          const provided = headers.get(TELEGRAM_SECRET_HEADER);
          if (!provided || provided.length > 256) return false;
          const connection = await repo.findLiveCredential(connectionId);
          if (!connection) return false;
          return timingSafeEqual(await sha256Hex(provided), connection.webhook_secret_hash);
        },
        eventId(rawBody) {
          const updateId = telegramUpdateId(rawBody);
          return updateId ? `${connectionId}:${updateId}` : null;
        },
      },
      {
        receipts,
        clientIp:
          options.clientIp !== undefined
            ? options.clientIp
            : clientIpFromHeaders((name) => request.headers.get(name)),
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      },
    );
  } catch (error) {
    // Connection lookup or receipt store unavailable: Telegram retries.
    serverLog.error("channels.telegram.webhook_unavailable", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return webhookRejection(503);
  }

  if (!verification.ok) return webhookRejection(verification.status);
  if (verification.duplicate) return acknowledged();

  let update: unknown;
  try {
    update = JSON.parse(new TextDecoder().decode(verification.rawBody));
  } catch {
    serverLog.warn("channels.telegram.ignored", { reason: "malformed" });
    return acknowledged();
  }
  const parsed = parseTelegramUpdate(update);
  if (parsed.kind === "ignored") {
    serverLog.info("channels.telegram.ignored", { reason: parsed.reason });
    return acknowledged();
  }

  try {
    await repo.ingestTelegramInbound(connectionId, parsed);
    serverLog.info("channels.telegram.ingested", { connectionId, type: parsed.type });
    return acknowledged();
  } catch (error) {
    const code = error instanceof ChannelError ? error.code : "unknown";
    if (PERMANENT.has(code)) {
      serverLog.warn("channels.telegram.ingest_refused", { connectionId, code });
      return acknowledged();
    }
    serverLog.error("channels.telegram.ingest_failed", { connectionId, code });
    await receipts.release("telegram", verification.eventId).catch(() => undefined);
    return webhookRejection(500);
  }
}
