/**
 * Channel service — connecting a merchant's Telegram bot and replying through it.
 *
 * Every function takes a server-derived AuthorizationContext (session member +
 * active membership organization) and checks its permission before any I/O.
 * The organization is never accepted from the browser; the bot token is
 * accepted once, validated against Telegram, encrypted, and never returned.
 *
 * Server-only.
 */
import type { AuthorizationContext } from "@/server/auth/authorization";
import { assertExpectedPrincipal, type ExpectedPrincipal } from "@/server/auth/expected-principal";
import { enforceRateLimits } from "@/server/rate-limit/limiter";
import { BACKEND_FAILURE_POLICY, RATE_LIMITS } from "@/server/rate-limit/policies";
import { serverLog } from "@/server/observability/logger";
import { toMessageSummary, type ConversationMessageSummary } from "@/server/conversations/service";
import {
  ChannelCredentialDecryptError,
  ChannelCredentialKeyError,
  CREDENTIAL_KEY_VERSION,
  decryptCredential,
  encryptCredential,
  generateWebhookSecret,
  sha256Hex,
} from "./credentials";
import { ChannelError } from "./errors";
import * as repo from "./repository";
import {
  TELEGRAM_MAX_TEXT,
  TELEGRAM_TOKEN_RE,
  TelegramApiError,
  TelegramBotApi,
} from "./telegram/api";
import { TELEGRAM_WEBHOOK_PATH_PREFIX } from "./telegram/paths";

export type TelegramApiFactory = (token: string) => TelegramBotApi;
const defaultApi: TelegramApiFactory = (token) => new TelegramBotApi(token);

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface ChannelConnectionSummary {
  id: string;
  provider: "TELEGRAM";
  handle: string | null;
  displayName: string | null;
  status: repo.ChannelConnectionStatus;
  connectedAt: string;
  /** Health: present only for members with integrations.view_health. */
  health?: {
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
  };
}

function summarize(row: repo.ChannelConnectionRow, withHealth: boolean): ChannelConnectionSummary {
  const summary: ChannelConnectionSummary = {
    id: row.id,
    provider: row.provider,
    handle: row.account_handle,
    displayName: row.account_display_name,
    status: row.status,
    connectedAt: row.connected_at,
  };
  if (withHealth) {
    summary.health = {
      lastInboundAt: row.last_inbound_at,
      lastOutboundAt: row.last_outbound_at,
      lastErrorCode: row.last_error_code,
      lastErrorAt: row.last_error_at,
    };
  }
  return summary;
}

// ── Webhook URL ───────────────────────────────────────────────────────────────

/**
 * Telegram only delivers to public HTTPS. CHANNEL_WEBHOOK_BASE_URL wins when
 * set (a test deployment whose canonical VITE_APP_URL sits behind deployment
 * protection); otherwise the canonical VITE_APP_URL. Never a request Host.
 */
export function telegramWebhookUrl(
  connectionId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const base = (env["CHANNEL_WEBHOOK_BASE_URL"] || env["VITE_APP_URL"] || "").trim();
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    throw new ChannelError("webhook_url_unavailable");
  }
  if (
    origin.protocol !== "https:" ||
    origin.hostname === "localhost" ||
    origin.hostname.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|0\.)/.test(origin.hostname)
  ) {
    throw new ChannelError("webhook_url_unavailable");
  }
  return `${origin.origin}${TELEGRAM_WEBHOOK_PATH_PREFIX}${connectionId}`;
}

async function openCredential(ciphertext: string): Promise<string> {
  try {
    return await decryptCredential(ciphertext);
  } catch (error) {
    if (
      error instanceof ChannelCredentialKeyError ||
      error instanceof ChannelCredentialDecryptError
    ) {
      serverLog.error("channels.credential_unavailable", { reason: error.name });
      throw new ChannelError("credential_unavailable");
    }
    throw error;
  }
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listChannelConnections(
  ctx: AuthorizationContext,
): Promise<ChannelConnectionSummary[]> {
  ctx.require("integrations.read");
  const withHealth = ctx.can("integrations.view_health");
  const rows = await repo.listLiveConnections(ctx.organizationId);
  return rows.map((row) => summarize(row, withHealth));
}

// ── Connect ───────────────────────────────────────────────────────────────────

export async function connectTelegramBot(
  ctx: AuthorizationContext,
  rawToken: string,
  expectedPrincipal: ExpectedPrincipal,
  api: TelegramApiFactory = defaultApi,
): Promise<ChannelConnectionSummary> {
  // The connection is attributed to (and audited as) the member who pasted the
  // token: refuse before anything else if the session changed under the form.
  assertExpectedPrincipal(ctx, expectedPrincipal);
  ctx.require("integrations.connect");
  const token = rawToken.trim();
  if (!TELEGRAM_TOKEN_RE.test(token)) throw new ChannelError("invalid_token");

  await enforceRateLimits(
    [{ rule: RATE_LIMITS.integrationConnectMember, parts: [ctx.organizationId, ctx.userId] }],
    undefined,
    { onBackendFailure: BACKEND_FAILURE_POLICY.integrationConnect },
  );

  const bot = api(token);
  let identity;
  try {
    identity = await bot.getMe();
  } catch (error) {
    if (error instanceof TelegramApiError && error.code === "invalid_token") {
      throw new ChannelError("invalid_token");
    }
    throw new ChannelError("provider_unavailable");
  }
  if (!identity.isBot) throw new ChannelError("not_a_bot");
  // The token's own prefix is the bot id; a mismatch means a forged/mixed token.
  if (token.split(":")[0] !== String(identity.id)) throw new ChannelError("invalid_token");

  let ciphertext: string;
  try {
    ciphertext = await encryptCredential(token);
  } catch (error) {
    if (error instanceof ChannelCredentialKeyError) {
      serverLog.error("channels.credential_key_missing", {});
      throw new ChannelError("credential_unavailable");
    }
    throw error;
  }
  const secret = generateWebhookSecret();
  // This operation's identity: the connect lease it takes is the only thing
  // that lets it finish or undo this connect later (migration 064 §2).
  const operationId = crypto.randomUUID();

  const row = await repo.connectAccount({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    externalAccountId: String(identity.id),
    handle: identity.username,
    displayName: identity.firstName.slice(0, 128) || null,
    ciphertext,
    keyVersion: CREDENTIAL_KEY_VERSION,
    secretHash: await sha256Hex(secret),
    operationId,
  });

  // The row now holds the NEW secret's digest, so Telegram must be pointed at
  // it. If that fails the connection cannot receive anything: disconnect it
  // (audited) rather than leave a row that silently drops every message —
  // but only while this operation still holds the connect lease. A newer
  // connect (after this one's lease expired) or a member's disconnect owns the
  // row now, and an older operation's cleanup must not touch it.
  try {
    await bot.setWebhook(telegramWebhookUrl(row.id), secret);
  } catch (error) {
    const aborted = await repo
      .abortConnect(ctx.organizationId, ctx.userId, row.id, operationId)
      .catch(() => false);
    if (!aborted)
      serverLog.warn("channels.telegram.connect_abort_skipped", { connectionId: row.id });
    if (error instanceof ChannelError) throw error;
    serverLog.warn("channels.telegram.set_webhook_failed", {
      code: error instanceof TelegramApiError ? error.code : "unknown",
    });
    throw new ChannelError("webhook_failed");
  }

  let finished: repo.ChannelConnectionRow;
  try {
    finished = await repo.finishConnect(ctx.organizationId, row.id, operationId);
  } catch (error) {
    // Superseded while Telegram was answering: the newer operation (or the
    // disconnect) decides what the bot points at. Report, never undo.
    serverLog.warn("channels.telegram.connect_superseded", { connectionId: row.id });
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("connect_superseded");
  }

  serverLog.info("channels.telegram.connected", { connectionId: row.id });
  return summarize(finished, ctx.can("integrations.view_health"));
}

// ── Disconnect ────────────────────────────────────────────────────────────────

export async function disconnectChannel(
  ctx: AuthorizationContext,
  connectionId: string,
  expectedPrincipal: ExpectedPrincipal,
  api: TelegramApiFactory = defaultApi,
): Promise<ChannelConnectionSummary> {
  assertExpectedPrincipal(ctx, expectedPrincipal);
  ctx.require("integrations.disconnect");
  const live = await repo.findLiveCredential(connectionId, ctx.organizationId);
  if (live) {
    // Best effort: stop Telegram delivering. Without this the webhook still
    // stops working — the cleared secret digest refuses every delivery.
    try {
      const token = await openCredential(live.credential_ciphertext);
      await api(token).deleteWebhook();
    } catch (error) {
      serverLog.warn("channels.telegram.delete_webhook_failed", {
        code:
          error instanceof TelegramApiError || error instanceof ChannelError
            ? error.code
            : "unknown",
      });
    }
  }
  const row = await repo.disconnectAccount(ctx.organizationId, ctx.userId, connectionId);
  return summarize(row, ctx.can("integrations.view_health"));
}

// ── Reply ─────────────────────────────────────────────────────────────────────

export interface SendReplyInput {
  conversationId: string;
  /** Client-generated UUID for this submission; a retry MUST reuse it. */
  clientMessageId: string;
  body: string;
  expectedPrincipal: ExpectedPrincipal;
}

export interface SendReplyResult {
  message: ConversationMessageSummary;
  /**
   * Present when the stored reply is 'failed' after this call; the SAME
   * clientMessageId may be retried. For a timeout or 'send_stuck' this does
   * not mean the customer did not receive it — only that delivery is
   * unconfirmed.
   */
  deliveryError?: string;
}

export async function sendConversationReply(
  ctx: AuthorizationContext,
  input: SendReplyInput,
  api: TelegramApiFactory = defaultApi,
): Promise<SendReplyResult> {
  // The reply is attributed to the member who typed it — refuse before
  // anything else if the session changed under the composer.
  assertExpectedPrincipal(ctx, input.expectedPrincipal);
  ctx.require("messages.reply");
  ctx.require("messages.read");

  const body = input.body.trim();
  if (!body || body.length > TELEGRAM_MAX_TEXT) throw new ChannelError("invalid_reference");

  await enforceRateLimits(
    [
      { rule: RATE_LIMITS.messageReplyMember, parts: [ctx.organizationId, ctx.userId] },
      { rule: RATE_LIMITS.messageReplyOrganization, parts: [ctx.organizationId] },
    ],
    undefined,
    { onBackendFailure: BACKEND_FAILURE_POLICY.messageReply },
  );

  const claim = await repo.beginOutboundMessage({
    organizationId: ctx.organizationId,
    conversationId: input.conversationId,
    actorUserId: ctx.userId,
    clientMessageId: input.clientMessageId,
    body,
  });
  // Someone (this submission's earlier attempt, or a concurrent duplicate)
  // already sent or is sending it: report what is stored, send nothing.
  if (!claim.should_send || !claim.attempt) return { message: toMessageSummary(claim.message) };

  let providerRef: string | undefined;
  let errorCode: string | undefined;
  try {
    const credential = await repo.findLiveCredential(claim.connection_id, ctx.organizationId);
    if (!credential) throw new ChannelError("channel_unavailable");
    const token = await openCredential(credential.credential_ciphertext);
    const sent = await api(token).sendMessage(claim.chat_id, body);
    providerRef = String(sent.messageId);
  } catch (error) {
    errorCode =
      error instanceof TelegramApiError || error instanceof ChannelError ? error.code : "unknown";
    serverLog.warn("channels.telegram.send_failed", { code: errorCode });
  }

  const completed = await repo.completeOutboundMessage({
    organizationId: ctx.organizationId,
    messageId: claim.message.id,
    connectionId: claim.connection_id,
    // Bound to THIS attempt: a late answer after a sweep and a retry is
    // recorded against the attempt that sent it, never the newer one.
    attempt: claim.attempt,
    sent: providerRef !== undefined,
    ...(providerRef !== undefined ? { providerRef } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  });

  // Report what is stored, not what this attempt saw: a superseded attempt
  // does not decide the reply's state.
  const result: SendReplyResult = { message: toMessageSummary(completed) };
  const storedError =
    completed.state === "failed"
      ? (completed.metadata as { send_error?: unknown } | null)?.send_error
      : undefined;
  if (typeof storedError === "string") result.deliveryError = storedError;
  return result;
}
