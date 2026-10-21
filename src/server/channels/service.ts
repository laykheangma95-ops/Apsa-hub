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
  deriveWebhookSecret,
  encryptCredential,
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
    /** When Telegram was last SEEN holding this connection's webhook. */
    lastVerifiedAt: string | null;
    /** Since when Telegram has been seen holding no / the wrong webhook. */
    mismatchSince: string | null;
  };
}

/*
 * 'connected' means Telegram was SEEN holding this connection's webhook
 * within this window (migration 064 §2a). Older than that — the reconciler
 * is not running, or cannot reach Telegram — it is shown as not confirmed,
 * decided here at read time so a stopped reconciler is visible too.
 */
export const VERIFICATION_FRESH_MS = 60 * 60 * 1000;

function summarize(
  row: repo.ChannelConnectionRow,
  withHealth: boolean,
  nowMs: number = Date.now(),
): ChannelConnectionSummary {
  const stale =
    row.status === "connected" &&
    (!row.last_verified_at ||
      nowMs - new Date(row.last_verified_at).getTime() > VERIFICATION_FRESH_MS);
  const summary: ChannelConnectionSummary = {
    id: row.id,
    provider: row.provider,
    handle: row.account_handle,
    displayName: row.account_display_name,
    status: stale ? "error" : row.status,
    connectedAt: row.connected_at,
  };
  if (withHealth) {
    summary.health = {
      lastInboundAt: row.last_inbound_at,
      lastOutboundAt: row.last_outbound_at,
      lastErrorCode: stale ? "webhook_unverified" : row.last_error_code,
      lastErrorAt: row.last_error_at,
      lastVerifiedAt: row.last_verified_at,
      mismatchSince: row.mismatch_since,
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
  generation: string,
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
  return `${origin.origin}${TELEGRAM_WEBHOOK_PATH_PREFIX}${connectionId}/${generation}`;
}

export async function openCredential(ciphertext: string): Promise<string> {
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

// ── Provider operations (migration 064 §2) ─────────────────────────────────

/*
 * Every Telegram-side change of a bot runs under that bot's operation lease
 * (120 s). A request may only be STARTED inside this window from the moment
 * the lease was taken; with the client's 10 s timeout every request this
 * operation sends has an answer — or is declared unknown — at least 80 s
 * before the lease could lapse, and an unknown one keeps the lease in doubt
 * for 5 minutes more. That ordering, not any check after Telegram answers, is
 * what keeps an older request from landing after a newer operation.
 */
export const PROVIDER_WRITE_WINDOW_MS = 30_000;

export interface ProviderOperationOptions {
  /** Clock for the write window; tests advance it. */
  nowMs?: () => number;
}

type Outcome = repo.ProviderOutcome;

/** Telegram answered "no" (any 4xx) → not applied. No answer → unknown. */
function outcomeOf(error: unknown): Outcome {
  return error instanceof TelegramApiError && error.code !== "provider_unavailable"
    ? "refused"
    : "unknown";
}

/**
 * setWebhook, then SEE it. Three outcomes are never merged:
 *   'verified'      getWebhookInfo shows exactly `url` (this generation's
 *                   URL — the API never returns the secret; its match
 *                   follows from the derivation invariant, not observation);
 *   'acknowledged'  setWebhook answered OK but getWebhookInfo could not be
 *                   read — applied, NOT seen: never reported connected;
 *   'unknown'       no answer to setWebhook, or another URL seen.
 * (Exported for tests.)
 */
export async function pointWebhook(
  bot: TelegramBotApi,
  url: string,
  secret: string,
  startedAt: number,
  nowMs: () => number,
): Promise<Outcome> {
  if (nowMs() - startedAt > PROVIDER_WRITE_WINDOW_MS) return "refused"; // never sent
  let sent: Outcome = "verified";
  try {
    await bot.setWebhook(url, secret);
  } catch (error) {
    sent = outcomeOf(error);
    if (sent === "refused") return sent;
  }
  try {
    return (await bot.getWebhookInfo()).url === url ? "verified" : "unknown";
  } catch {
    return sent === "verified" ? "acknowledged" : "unknown";
  }
}

/** deleteWebhook, then SEE no webhook — with the same three outcomes. */
async function removeWebhook(
  bot: TelegramBotApi,
  startedAt: number,
  nowMs: () => number,
): Promise<Outcome> {
  if (nowMs() - startedAt > PROVIDER_WRITE_WINDOW_MS) return "refused"; // never sent
  let sent: Outcome = "verified";
  try {
    await bot.deleteWebhook();
  } catch (error) {
    sent = outcomeOf(error);
    if (sent === "refused") return sent;
  }
  try {
    return (await bot.getWebhookInfo()).url === "" ? "verified" : "unknown";
  } catch {
    return sent === "verified" ? "acknowledged" : "unknown";
  }
}

/**
 * Rule 4: a superseded operation whose own Telegram request may have been
 * applied AFTER a newer one re-checks Telegram under a fresh lease and points
 * it back at what APSA stores — the bot's live connection's current
 * generation, or no webhook at all. Skipped (not needed) while any other
 * operation holds the bot: that operation verifies Telegram itself.
 */
/** Who a repair runs as: a member (their late operation) or the server's reconciler (actor null). */
export interface RepairPrincipal {
  organizationId: string;
  actorUserId: string | null;
}

export async function reconcileBot(
  principal: RepairPrincipal,
  bot: TelegramBotApi,
  externalAccountId: string,
  nowMs: () => number,
): Promise<Outcome | "busy"> {
  const operationId = crypto.randomUUID();
  try {
    await repo.beginOperation({
      organizationId: principal.organizationId,
      actorUserId: principal.actorUserId,
      externalAccountId,
      kind: "repair",
      operationId,
    });
  } catch (error) {
    serverLog.info("channels.telegram.reconcile_deferred", {
      code: error instanceof ChannelError ? error.code : "unknown",
    });
    return "busy";
  }
  const startedAt = nowMs();
  let connectionId: string | null = null;
  let generation: string | null = null;
  let outcome: Outcome = "unknown";
  try {
    const live = await repo.findLiveConnectionForBot(externalAccountId);
    if (live) {
      connectionId = live.id;
      generation = live.webhook_generation;
      const secret = await deriveWebhookSecret(live.id, live.webhook_generation);
      // getWebhookInfo shows the URL, never the secret, so a repair that sent
      // this generation's URL with a DIFFERENT secret would be "verified"
      // while every delivery is refused. The secret is derived from
      // (connection, generation, CHANNEL_CREDENTIAL_KEY); if the key changed
      // since connect it no longer matches the stored digest — send nothing.
      if ((await sha256Hex(secret)) !== live.webhook_secret_hash) {
        serverLog.error("channels.telegram.webhook_key_changed", { connectionId: live.id });
        outcome = "stale_key";
      } else {
        outcome = await pointWebhook(
          bot,
          telegramWebhookUrl(live.id, live.webhook_generation),
          secret,
          startedAt,
          nowMs,
        );
      }
    } else {
      outcome = await removeWebhook(bot, startedAt, nowMs);
      if (outcome === "verified" || outcome === "acknowledged") outcome = "done";
    }
  } finally {
    await repo
      .settleOperation({
        organizationId: principal.organizationId,
        actorUserId: principal.actorUserId,
        operationId,
        connectionId,
        generation,
        outcome,
      })
      .catch(() => undefined);
    serverLog.warn("channels.telegram.reconciled", { outcome });
  }
  return outcome;
}

// ── Connect ───────────────────────────────────────────────────────────────────

export async function connectTelegramBot(
  ctx: AuthorizationContext,
  rawToken: string,
  expectedPrincipal: ExpectedPrincipal,
  api: TelegramApiFactory = defaultApi,
  options: ProviderOperationOptions = {},
): Promise<ChannelConnectionSummary> {
  const nowMs = options.nowMs ?? Date.now;
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
  const externalAccountId = String(identity.id);

  // Fail before any write when this deployment has no public webhook origin.
  telegramWebhookUrl(crypto.randomUUID(), crypto.randomUUID());

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

  // The bot's operation lease, held until Telegram's answer is KNOWN.
  const operationId = crypto.randomUUID();
  await repo.beginOperation({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    externalAccountId,
    kind: "connect",
    operationId,
  });
  const startedAt = nowMs();

  // This connect's generation: part of the URL Telegram gets, and of the
  // derived secret. Bound to the row id the secret is derived for.
  const generation = crypto.randomUUID();
  let row: repo.ChannelConnectionRow;
  let secret: string;
  try {
    const live = await repo.findLiveConnectionForBot(externalAccountId);
    const connectionId =
      live && live.organization_id === ctx.organizationId ? live.id : crypto.randomUUID();
    try {
      secret = await deriveWebhookSecret(connectionId, generation);
    } catch (error) {
      if (error instanceof ChannelCredentialKeyError)
        throw new ChannelError("credential_unavailable");
      throw error;
    }
    row = await repo.connectAccount({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      externalAccountId,
      handle: identity.username,
      displayName: identity.firstName.slice(0, 128) || null,
      ciphertext,
      keyVersion: CREDENTIAL_KEY_VERSION,
      secretHash: await sha256Hex(secret),
      connectionId,
      generation,
      operationId,
    });
  } catch (error) {
    // Nothing reached Telegram: give the lease back.
    await repo
      .settleOperation({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        operationId,
        connectionId: null,
        generation: null,
        outcome: "done",
      })
      .catch(() => undefined);
    throw error;
  }

  const outcome = await pointWebhook(
    bot,
    telegramWebhookUrl(row.id, generation),
    secret,
    startedAt,
    nowMs,
  );
  const settled = await repo.settleOperation({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    operationId,
    connectionId: row.id,
    generation,
    outcome,
  });

  if (!settled.held) {
    // Superseded while Telegram was answering (this operation's lease lapsed
    // and another operation took the bot). If this request was applied it may
    // have landed after that operation's: make Telegram match APSA again.
    serverLog.warn("channels.telegram.connect_superseded", { connectionId: row.id, outcome });
    if (outcome !== "refused") {
      await reconcileBot(
        { organizationId: ctx.organizationId, actorUserId: ctx.userId },
        bot,
        externalAccountId,
        nowMs,
      );
    }
    throw new ChannelError("connect_superseded");
  }
  if (outcome === "unknown" || outcome === "acknowledged") {
    // unknown: maybe applied, maybe later — the bot stays in doubt.
    // acknowledged: applied, but not SEEN — reconciliation checks at once.
    // Either way the connection is NOT reported connected.
    serverLog.warn("channels.telegram.connect_unverified", { connectionId: row.id, outcome });
    throw new ChannelError("webhook_unverified");
  }
  if (outcome === "refused" || !settled.current || !settled.connection) {
    serverLog.warn("channels.telegram.set_webhook_failed", { connectionId: row.id });
    throw new ChannelError(settled.current ? "webhook_failed" : "connect_superseded");
  }

  serverLog.info("channels.telegram.connected", { connectionId: row.id });
  return summarize(settled.connection, ctx.can("integrations.view_health"));
}

// ── Disconnect ────────────────────────────────────────────────────────────────

export async function disconnectChannel(
  ctx: AuthorizationContext,
  connectionId: string,
  expectedPrincipal: ExpectedPrincipal,
  api: TelegramApiFactory = defaultApi,
  options: ProviderOperationOptions = {},
): Promise<ChannelConnectionSummary> {
  const nowMs = options.nowMs ?? Date.now;
  assertExpectedPrincipal(ctx, expectedPrincipal);
  ctx.require("integrations.disconnect");
  const live = await repo.findLiveCredential(connectionId, ctx.organizationId);
  if (!live) {
    const row = await repo.findConnection(connectionId, ctx.organizationId);
    if (!row) throw new ChannelError("connection_not_found");
    return summarize(row, ctx.can("integrations.view_health"));
  }

  // Read the token before the row forgets it; a token that cannot be opened
  // still disconnects (every delivery is refused once the digest is gone).
  let bot: TelegramBotApi | null = null;
  try {
    bot = api(await openCredential(live.credential_ciphertext));
  } catch {
    bot = null;
  }

  const operationId = crypto.randomUUID();
  await repo.beginOperation({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    externalAccountId: live.external_account_id,
    kind: "disconnect",
    operationId,
    connectionId,
  });
  const startedAt = nowMs();

  // Database first: from here APSA refuses every delivery for this connection.
  let row: repo.ChannelConnectionRow;
  try {
    row = await repo.disconnectAccount(ctx.organizationId, ctx.userId, connectionId, operationId);
  } catch (error) {
    await repo
      .settleOperation({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        operationId,
        connectionId: null,
        generation: null,
        outcome: "done",
      })
      .catch(() => undefined);
    throw error;
  }

  // Then Telegram, still under the lease: a reconnect of this bot cannot start
  // until this request's outcome is known (or its in-doubt window has passed).
  const outcome = bot ? await removeWebhook(bot, startedAt, nowMs) : "refused";
  if (outcome !== "verified") {
    serverLog.warn("channels.telegram.delete_webhook_unconfirmed", { outcome });
  }
  const settled = await repo.settleOperation({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    operationId,
    connectionId: null,
    generation: null,
    outcome: outcome === "unknown" ? "unknown" : "done",
  });
  if (!settled.held && bot && outcome !== "refused") {
    // This deleteWebhook may have landed after a newer connect of the bot.
    await reconcileBot(
      { organizationId: ctx.organizationId, actorUserId: ctx.userId },
      bot,
      live.external_account_id,
      nowMs,
    );
  }
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
