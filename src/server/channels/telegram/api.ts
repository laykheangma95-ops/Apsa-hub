/**
 * Telegram Bot API client — the only code that talks to api.telegram.org.
 *
 * Server-only. The bot token is part of every request URL, so:
 *   - no URL, request or raw provider response is ever logged or thrown;
 *   - failures surface as a TelegramApiError carrying a stable code only;
 *   - every call is bounded by a timeout.
 *
 * `fetch` is injectable so tests drive the real client against a fake.
 */

export const TELEGRAM_API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

/** Telegram's own limit for sendMessage text. */
export const TELEGRAM_MAX_TEXT = 4096;

export type TelegramErrorCode =
  | "invalid_token" //        401 — the token is wrong or revoked
  | "blocked_by_user" //     403 — the customer blocked the bot / never started it
  | "chat_not_found" //      400 — the chat no longer exists for this bot
  | "rate_limited" //        429
  | "provider_rejected" //   any other 4xx
  | "provider_unavailable"; // 5xx, network failure, timeout, malformed response

export class TelegramApiError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(`telegram_${code}`);
    this.name = "TelegramApiError";
  }
}

export interface TelegramBotIdentity {
  id: number;
  isBot: boolean;
  username: string | null;
  firstName: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Token shape from @BotFather: "<bot id>:<secret>". Checked before any network call. */
export const TELEGRAM_TOKEN_RE = /^[0-9]{5,20}:[A-Za-z0-9_-]{30,100}$/;

export class TelegramBotApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    if (!TELEGRAM_TOKEN_RE.test(token)) throw new TelegramApiError("invalid_token");
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TelegramApiError("provider_unavailable");
    }

    let payload: {
      ok?: boolean;
      result?: unknown;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new TelegramApiError("provider_unavailable");
    }
    if (payload.ok === true) return payload.result as T;

    const status = payload.error_code ?? response.status;
    const description = (payload.description ?? "").toLowerCase();
    if (status === 401 || status === 404) throw new TelegramApiError("invalid_token");
    if (status === 403) throw new TelegramApiError("blocked_by_user");
    if (status === 429) {
      throw new TelegramApiError("rate_limited", payload.parameters?.retry_after);
    }
    if (status === 400 && description.includes("chat not found")) {
      throw new TelegramApiError("chat_not_found");
    }
    if (status >= 500) throw new TelegramApiError("provider_unavailable");
    throw new TelegramApiError("provider_rejected");
  }

  async getMe(): Promise<TelegramBotIdentity> {
    const result = await this.call<{
      id?: unknown;
      is_bot?: unknown;
      username?: unknown;
      first_name?: unknown;
    }>("getMe", {});
    if (typeof result?.id !== "number" || typeof result.first_name !== "string") {
      throw new TelegramApiError("provider_unavailable");
    }
    return {
      id: result.id,
      isBot: result.is_bot === true,
      username: typeof result.username === "string" ? result.username : null,
      firstName: result.first_name,
    };
  }

  /**
   * Points the bot at APSA. Only private-chat messages are subscribed; the
   * secret is echoed by Telegram in X-Telegram-Bot-Api-Secret-Token.
   */
  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call<boolean>("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      max_connections: 40,
    });
  }

  async deleteWebhook(): Promise<void> {
    await this.call<boolean>("deleteWebhook", { drop_pending_updates: false });
  }

  /**
   * What Telegram holds NOW: the webhook URL ("" when none). Read-only. The
   * URL carries the connect's generation, so this is how APSA SEES which
   * connect Telegram is using (the secret itself is never returned).
   */
  async getWebhookInfo(): Promise<{ url: string }> {
    const result = await this.call<{ url?: unknown }>("getWebhookInfo", {});
    if (typeof result?.url !== "string") throw new TelegramApiError("provider_unavailable");
    return { url: result.url };
  }

  /** Plain text only — no parse_mode, so merchant text is never interpreted as markup. */
  async sendMessage(chatId: string, text: string): Promise<{ messageId: number }> {
    const result = await this.call<{ message_id?: unknown }>("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    });
    if (typeof result?.message_id !== "number") throw new TelegramApiError("provider_unavailable");
    return { messageId: result.message_id };
  }
}
