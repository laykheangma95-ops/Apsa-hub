/**
 * Telegram provider — pure units: update parsing, credential protection, Bot
 * API error mapping, webhook URL rules, and the browser-side refusal copy.
 * The database and end-to-end halves are telegram-channel-sql.test.ts and
 * telegram-channel.test.ts.
 *
 * Run: bun test src/tests/telegram-provider-unit.test.ts
 */
import { describe, expect, it } from "bun:test";
import { parseTelegramUpdate, telegramUpdateId } from "@/server/channels/telegram/update";
import {
  decryptCredential,
  encryptCredential,
  generateWebhookSecret,
  readCredentialKey,
  sha256Hex,
} from "@/server/channels/credentials";
import { TelegramApiError, TelegramBotApi } from "@/server/channels/telegram/api";
import { telegramWebhookUrl } from "@/server/channels/service";
import { isTelegramWebhookRequest } from "@/server/channels/telegram/paths";
import { classifyReplyError, replyMayHaveBeenSent } from "@/lib/conversation/reply-errors";
import { classifyConnectError, looksLikeTelegramToken } from "@/lib/channels-view";

const TOKEN = "7123456789:AAH-test_token_value_0123456789abcdefXYZ";
const KEY = readCredentialKey(Buffer.alloc(32, 3).toString("base64"));

function privateText(extra: Record<string, unknown> = {}) {
  return {
    update_id: 10,
    message: {
      message_id: 42,
      date: 1_792_000_000,
      chat: { id: 555, type: "private" },
      from: { id: 555, is_bot: false, first_name: "Sokha", last_name: "Chan", username: "sokha" },
      text: "  សួស្តី  ",
      ...extra,
    },
  };
}

describe("parseTelegramUpdate", () => {
  it("maps a private text message to the provider-neutral shape", () => {
    expect(parseTelegramUpdate(privateText())).toEqual({
      kind: "message",
      chatId: "555",
      senderId: "555",
      senderName: "Sokha Chan",
      senderHandle: "sokha",
      messageRef: "tg:42",
      body: "សួស្តី",
      type: "text",
      occurredAt: new Date(1_792_000_000 * 1000).toISOString(),
      attachments: null,
    });
  });

  it("ignores groups, channels, bots, edits and garbage", () => {
    const group = privateText({ chat: { id: -1001, type: "supergroup" } });
    expect(parseTelegramUpdate(group)).toEqual({ kind: "ignored", reason: "not_private_chat" });
    const bot = privateText({ from: { id: 1, is_bot: true, first_name: "B" } });
    expect(parseTelegramUpdate(bot)).toEqual({ kind: "ignored", reason: "bot_sender" });
    expect(parseTelegramUpdate({ update_id: 1, edited_message: {} })).toEqual({
      kind: "ignored",
      reason: "not_a_message",
    });
    expect(parseTelegramUpdate("nope")).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parseTelegramUpdate(privateText({ text: undefined, poll: { id: "1" } }))).toEqual({
      kind: "ignored",
      reason: "unsupported_content",
    });
  });

  it("keeps a shared phone number as text (order-critical)", () => {
    const parsed = parseTelegramUpdate(
      privateText({ text: undefined, contact: { phone_number: "+85512345678", first_name: "S" } }),
    );
    expect(parsed).toMatchObject({ kind: "message", type: "text", body: "+85512345678" });
  });

  it("keeps the largest photo, the caption, and only bounded metadata", () => {
    const parsed = parseTelegramUpdate(
      privateText({
        text: undefined,
        caption: "this one",
        photo: [
          { file_id: "s", width: 1, height: 1 },
          { file_id: "L", width: 9, height: 9, file_size: 99, secret_field: "x" },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      type: "image",
      body: "this one",
      attachments: [{ kind: "photo", provider_file_id: "L", file_size: 99 }],
    });
    expect(JSON.stringify(parsed)).not.toContain("secret_field");
  });

  it("names a nameless sender null rather than guessing", () => {
    const parsed = parseTelegramUpdate(privateText({ from: { id: 555, is_bot: false } }));
    expect(parsed).toMatchObject({ senderName: null, senderHandle: null });
  });

  it("reads update_id only from a well-formed body", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(telegramUpdateId(encode({ update_id: 7 }))).toBe("7");
    expect(telegramUpdateId(encode({ update_id: "7" }))).toBeNull();
    expect(telegramUpdateId(encode({ update_id: -1 }))).toBeNull();
    expect(telegramUpdateId(new TextEncoder().encode("{"))).toBeNull();
  });
});

describe("credential protection", () => {
  it("round-trips, never contains the token, and uses a fresh IV each time", async () => {
    const a = await encryptCredential(TOKEN, KEY);
    const b = await encryptCredential(TOKEN, KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain(TOKEN.split(":")[1]!);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await decryptCredential(a, KEY)).toBe(TOKEN);
  });

  it("refuses a tampered ciphertext and a different key", async () => {
    const sealed = await encryptCredential(TOKEN, KEY);
    const [v, iv, body] = sealed.split(".");
    const flipped = `${v}.${iv}.${body!.slice(0, -2)}${body!.endsWith("A") ? "B" : "A"}${body!.slice(-1)}`;
    await expect(decryptCredential(flipped, KEY)).rejects.toThrow("could not be decrypted");
    const other = readCredentialKey(Buffer.alloc(32, 4).toString("base64"));
    await expect(decryptCredential(sealed, other)).rejects.toThrow("could not be decrypted");
  });

  it("refuses a missing or wrong-length key", () => {
    expect(() => readCredentialKey(undefined)).toThrow("CHANNEL_CREDENTIAL_KEY");
    expect(() => readCredentialKey(Buffer.alloc(16).toString("base64"))).toThrow(
      "CHANNEL_CREDENTIAL_KEY",
    );
  });

  it("webhook secrets fit Telegram's alphabet and are unique; digests are hex", async () => {
    const one = generateWebhookSecret();
    expect(one).toMatch(/^[A-Za-z0-9_-]{40,256}$/);
    expect(generateWebhookSecret()).not.toBe(one);
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("TelegramBotApi", () => {
  function apiAnswering(status: number, payload: unknown) {
    const seen: string[] = [];
    const api = new TelegramBotApi(TOKEN, async (url) => {
      seen.push(url);
      return Response.json(payload, { status });
    });
    return { api, seen };
  }

  it("refuses a malformed token before any request", () => {
    expect(() => new TelegramBotApi("123:short")).toThrow(TelegramApiError);
  });

  it("maps provider failures to stable codes that never carry the token", async () => {
    const cases: [number, string, string][] = [
      [401, "Unauthorized", "invalid_token"],
      [403, "Forbidden: bot was blocked by the user", "blocked_by_user"],
      [400, "Bad Request: chat not found", "chat_not_found"],
      [429, "Too Many Requests: retry after 3", "rate_limited"],
      [400, "Bad Request: message is too long", "provider_rejected"],
      [502, "Bad Gateway", "provider_unavailable"],
    ];
    for (const [status, description, code] of cases) {
      const { api } = apiAnswering(status, { ok: false, error_code: status, description });
      const error = await api.sendMessage("1", "x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TelegramApiError);
      expect((error as TelegramApiError).code).toBe(code);
      expect(String((error as Error).message)).not.toContain(TOKEN);
    }
  });

  it("a network failure is provider_unavailable", async () => {
    const api = new TelegramBotApi(TOKEN, async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const error = (await api.getMe().catch((e: unknown) => e)) as TelegramApiError;
    expect(error.code).toBe("provider_unavailable");
    expect(error.message).not.toContain(TOKEN);
  });

  it("sends plain text with no parse mode", async () => {
    let body: Record<string, unknown> = {};
    const api = new TelegramBotApi(TOKEN, async (_url, init) => {
      body = JSON.parse(String(init.body));
      return Response.json({ ok: true, result: { message_id: 9 } });
    });
    expect(await api.sendMessage("555", "<b>hi</b>")).toEqual({ messageId: 9 });
    expect(body).toMatchObject({ chat_id: "555", text: "<b>hi</b>" });
    expect(body["parse_mode"]).toBeUndefined();
  });
});

describe("webhook URL and route", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("uses the canonical https origin, or the explicit override", () => {
    expect(telegramWebhookUrl(id, { VITE_APP_URL: "https://app.apsa.com/" })).toBe(
      `https://app.apsa.com/api/webhooks/telegram/${id}`,
    );
    expect(
      telegramWebhookUrl(id, {
        VITE_APP_URL: "https://app.apsa.com",
        CHANNEL_WEBHOOK_BASE_URL: "https://staging.apsa.com",
      }),
    ).toBe(`https://staging.apsa.com/api/webhooks/telegram/${id}`);
  });

  it("refuses an origin Telegram cannot reach", () => {
    for (const base of ["", "http://app.apsa.com", "https://localhost:3000", "https://10.0.0.1"]) {
      expect(() => telegramWebhookUrl(id, { VITE_APP_URL: base })).toThrow(
        "webhook_url_unavailable",
      );
    }
  });

  it("the server entry matches only the Telegram webhook prefix", () => {
    expect(
      isTelegramWebhookRequest(new Request(`https://x.test/api/webhooks/telegram/${id}`)),
    ).toBe(true);
    expect(isTelegramWebhookRequest(new Request("https://x.test/api/webhooks/meta/1"))).toBe(false);
    expect(isTelegramWebhookRequest(new Request("https://x.test/app/inbox"))).toBe(false);
  });
});

describe("browser refusal copy", () => {
  it("classifies reply outcomes from the wire message", () => {
    expect(classifyReplyError("blocked_by_user")).toBe("blocked_by_user");
    expect(classifyReplyError("provider_unavailable")).toBe("generic");
    expect(classifyReplyError(new Error("channel_unavailable"))).toBe("channel_unavailable");
    expect(
      classifyReplyError(new Error("rate_limited: Too many requests. Try again in 5 seconds.")),
    ).toBe("rate_limited");
    expect(
      classifyReplyError(
        new Error("The signed-in member or organization changed before this request was sent"),
      ),
    ).toBe("principal_changed");
    expect(classifyReplyError(new Error("Something went wrong on the server."))).toBe("generic");
  });

  it("flags only failures that may have reached Telegram anyway", () => {
    expect(classifyReplyError("send_stuck")).toBe("send_stuck");
    expect(replyMayHaveBeenSent("send_stuck")).toBe(true);
    expect(replyMayHaveBeenSent("provider_unavailable")).toBe(true);
    expect(replyMayHaveBeenSent("unknown")).toBe(true);
    expect(replyMayHaveBeenSent("blocked_by_user")).toBe(false);
    expect(replyMayHaveBeenSent("channel_unavailable")).toBe(false);
    expect(replyMayHaveBeenSent(undefined)).toBe(false);
  });

  it("classifies connect refusals and pre-checks the token shape", () => {
    expect(classifyConnectError(new Error("account_in_use"))).toBe("account_in_use");
    expect(classifyConnectError(new Error("Missing permission: integrations.connect"))).toBe(
      "generic",
    );
    expect(looksLikeTelegramToken(` ${TOKEN} `)).toBe(true);
    expect(looksLikeTelegramToken("hello")).toBe(false);
  });
});
