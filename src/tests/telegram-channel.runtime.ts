/**
 * Telegram provider, end to end, against the REAL migrated schema (every
 * migration through PGlite, behind the PostgREST substitute the Conversation
 * suite uses). Production service, repository and webhook handler run
 * unchanged; only api.telegram.org is faked. Spawned by
 * telegram-channel.test.ts.
 *
 * Journey: connect bot → Telegram delivers a customer message → it is in the
 * Inbox (with a Customer) → staff reply → Telegram receives it once → retries
 * never double-send → disconnect stops both directions.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { conversationPostgrest } from "./helpers/conversation-postgrest";
import { financialFixture } from "./helpers/payment-order-fixture";
import type { AuthorizationContext } from "../server/auth/authorization";

process.env["CHANNEL_CREDENTIAL_KEY"] = Buffer.alloc(32, 7).toString("base64");
process.env["VITE_APP_URL"] = "https://apsa.test";
delete process.env["CHANNEL_WEBHOOK_BASE_URL"];

const fixture = await financialFixture();
const db = fixture.db;
const transport = conversationPostgrest(db);
mock.module("../lib/supabase/server", () => ({ supabaseAdmin: transport }));

const { setPrimaryRateLimitStore } = await import("@/server/rate-limit/limiter");
const { MemoryRateLimitStore } = await import("@/server/rate-limit/store");
setPrimaryRateLimitStore(new MemoryRateLimitStore());

const service = await import("@/server/channels/service");
const conversations = await import("@/server/conversations/service");
const { handleTelegramWebhook } = await import("@/server/channels/telegram/webhook");
const { TelegramBotApi } = await import("@/server/channels/telegram/api");
const { decryptCredential, sha256Hex } = await import("@/server/channels/credentials");

const org = fixture.org;
const orgB = fixture.orgB;
const owner = fixture.actor;
const ownerB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const BOT_ID = 7123456789;
const TOKEN = `${BOT_ID}:AAH-test_token_value_0123456789abcdefXYZ`;

const ALL = [
  "integrations.read",
  "integrations.view_health",
  "integrations.connect",
  "integrations.disconnect",
  "messages.read",
  "messages.reply",
];

function ctx(userId: string, organizationId: string, permissions = ALL): AuthorizationContext {
  return new (class {
    userId = userId;
    organizationId = organizationId;
    can(key: string) {
      return permissions.includes(key);
    }
    require(key: string) {
      if (!permissions.includes(key)) throw new Error(`Missing permission: ${key}`);
    }
  })() as unknown as AuthorizationContext;
}

// ── Fake api.telegram.org ─────────────────────────────────────────────────────

interface Call {
  method: string;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
let nextFailure: { method: string; status: number; description: string } | null = null;
let webhookSecret = "";
let nextMessageId = 500;

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const method = url.slice(url.lastIndexOf("/") + 1);
  expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  calls.push({ method, body });
  if (nextFailure && nextFailure.method === method) {
    const failure = nextFailure;
    nextFailure = null;
    return Response.json(
      { ok: false, error_code: failure.status, description: failure.description },
      { status: failure.status },
    );
  }
  switch (method) {
    case "getMe":
      return Response.json({
        ok: true,
        result: { id: BOT_ID, is_bot: true, first_name: "Sokha Shop", username: "sokha_shop_bot" },
      });
    case "setWebhook":
      webhookSecret = String(body["secret_token"]);
      return Response.json({ ok: true, result: true });
    case "deleteWebhook":
      return Response.json({ ok: true, result: true });
    case "sendMessage":
      return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
  }
  return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
}
const api = (token: string) => new TelegramBotApi(token, fakeFetch);
const sent = () => calls.filter((c) => c.method === "sendMessage");

// ── Webhook delivery helper ───────────────────────────────────────────────────

let updateId = 1000;
function delivery(
  connectionId: string,
  message: Record<string, unknown>,
  { secret = webhookSecret, id = ++updateId } = {},
) {
  return new Request(`https://apsa.test/api/webhooks/telegram/${connectionId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify({ update_id: id, message }),
  });
}
function customerText(
  text: string,
  messageId: number,
  from = { id: 880001, first_name: "Sokha", username: "sokha_kh" },
) {
  return {
    message_id: messageId,
    date: 1_792_000_000,
    chat: { id: from.id, type: "private" },
    from: { ...from, is_bot: false },
    text,
  };
}

let connectionId: string;

beforeAll(async () => {
  await db.query("insert into auth.users(id,email) values($1,'owner-b@test.invalid')", [ownerB]);
  for (const [tenant, user] of [
    [org, owner],
    [orgB, ownerB],
  ]) {
    await db.query(
      `insert into memberships(organization_id,user_id,role_id,status)
       select $1,$2,id,'active' from roles where system_role='OWNER' and organization_id is null`,
      [tenant, user],
    );
  }
});
afterAll(async () => {
  await fixture.close();
});

describe("connect", () => {
  it("refuses a member without integrations.connect before any network call", async () => {
    await expect(
      service.connectTelegramBot(ctx(owner, org, ["integrations.read"]), TOKEN, api),
    ).rejects.toThrow("integrations.connect");
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed token before any network call", async () => {
    await expect(service.connectTelegramBot(ctx(owner, org), "not-a-token", api)).rejects.toThrow(
      "invalid_token",
    );
    expect(calls).toHaveLength(0);
  });

  it("maps a revoked token to invalid_token", async () => {
    nextFailure = { method: "getMe", status: 401, description: "Unauthorized" };
    await expect(service.connectTelegramBot(ctx(owner, org), TOKEN, api)).rejects.toThrow(
      "invalid_token",
    );
  });

  it("a refused webhook leaves no live connection", async () => {
    nextFailure = { method: "setWebhook", status: 400, description: "bad webhook" };
    await expect(service.connectTelegramBot(ctx(owner, org), TOKEN, api)).rejects.toThrow(
      "webhook_failed",
    );
    const live = await db.query("select 1 from channel_connections where status <> 'disconnected'");
    expect(live.rows).toHaveLength(0);
  });

  it("connects: token encrypted at rest, webhook registered with a secret only its digest is stored for", async () => {
    calls.length = 0;
    const summary = await service.connectTelegramBot(ctx(owner, org), `  ${TOKEN}  `, api);
    connectionId = summary.id;
    expect(summary).toMatchObject({
      provider: "TELEGRAM",
      handle: "sokha_shop_bot",
      displayName: "Sokha Shop",
      status: "connected",
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);

    const stored = (
      await db.query<{ credential_ciphertext: string; webhook_secret_hash: string }>(
        "select credential_ciphertext, webhook_secret_hash from channel_connections where id=$1",
        [connectionId],
      )
    ).rows[0]!;
    expect(stored.credential_ciphertext).not.toContain(TOKEN.split(":")[1]!);
    expect(await decryptCredential(stored.credential_ciphertext)).toBe(TOKEN);

    const setWebhook = calls.find((c) => c.method === "setWebhook")!;
    expect(setWebhook.body["url"]).toBe(`https://apsa.test/api/webhooks/telegram/${connectionId}`);
    expect(setWebhook.body["allowed_updates"]).toEqual(["message"]);
    expect(await sha256Hex(webhookSecret)).toBe(stored.webhook_secret_hash);
    expect(stored.webhook_secret_hash).not.toBe(webhookSecret);
  });

  it("another organization cannot take the same bot", async () => {
    await expect(service.connectTelegramBot(ctx(ownerB, orgB), TOKEN, api)).rejects.toThrow(
      "account_in_use",
    );
  });

  it("lists connections; health only with integrations.view_health", async () => {
    const [withHealth] = await service.listChannelConnections(ctx(owner, org));
    expect(withHealth?.health).toBeDefined();
    const [plain] = await service.listChannelConnections(ctx(owner, org, ["integrations.read"]));
    expect(plain?.health).toBeUndefined();
    expect(await service.listChannelConnections(ctx(ownerB, orgB))).toEqual([]);
  });
});

describe("webhook → Inbox", () => {
  it("rejects a wrong secret and an unknown connection identically (401)", async () => {
    const wrong = await handleTelegramWebhook(
      delivery(connectionId, customerText("hi", 1), { secret: "nope" }),
      { clientIp: null },
    );
    expect(wrong.status).toBe(401);
    const unknown = await handleTelegramWebhook(
      delivery(crypto.randomUUID(), customerText("hi", 1)),
      { clientIp: null },
    );
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  it("delivers a customer message into the Inbox with a Customer", async () => {
    const response = await handleTelegramWebhook(
      delivery(connectionId, customerText("Do you have size M?", 1)),
      { clientIp: null },
    );
    expect(response.status).toBe(200);

    const page = await conversations.listConversations(ctx(owner, org));
    expect(page.conversations).toHaveLength(1);
    const [thread] = page.conversations;
    expect(thread).toMatchObject({
      channel: "telegram",
      provider: "TELEGRAM",
      customerName: "Sokha",
      lastMessage: "Do you have size M?",
      unreadCount: 1,
      status: "needs_reply",
    });
    expect(thread!.customerId).not.toBe("");

    // Tenant isolation: organization B's Inbox is empty.
    expect((await conversations.listConversations(ctx(ownerB, orgB))).conversations).toEqual([]);
  });

  it("a redelivered update is acknowledged and stored once", async () => {
    const id = 77_777;
    const first = await handleTelegramWebhook(
      delivery(connectionId, customerText("Price?", 2), { id }),
      {
        clientIp: null,
      },
    );
    const again = await handleTelegramWebhook(
      delivery(connectionId, customerText("Price?", 2), { id }),
      {
        clientIp: null,
      },
    );
    expect([first.status, again.status]).toEqual([200, 200]);
    const count = await db.query<{ n: number }>(
      "select count(*)::int n from messages where provider_message_id='tg:2'",
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("acknowledges and ignores group chats, bot senders and malformed updates", async () => {
    const group = { ...customerText("hello group", 3), chat: { id: -100123, type: "supergroup" } };
    const bot = { ...customerText("beep", 4), from: { id: 9, is_bot: true, first_name: "Bot" } };
    for (const message of [group, bot, { nonsense: true }]) {
      const response = await handleTelegramWebhook(delivery(connectionId, message), {
        clientIp: null,
      });
      expect(response.status).toBe(200);
    }
    const count = await db.query<{ n: number }>(
      "select count(*)::int n from messages where provider_message_id in ('tg:3','tg:4')",
    );
    expect(count.rows[0]!.n).toBe(0);
  });

  it("stores a photo with its caption and bounded attachment metadata", async () => {
    const photo = {
      ...customerText("", 5),
      text: undefined,
      caption: "This one",
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "l", width: 1280, height: 1280, file_size: 1234 },
      ],
    };
    const response = await handleTelegramWebhook(delivery(connectionId, photo), { clientIp: null });
    expect(response.status).toBe(200);
    const stored = (
      await db.query<{ body: string; message_type: string; attachments: unknown }>(
        "select body, message_type, attachments from messages where provider_message_id='tg:5'",
      )
    ).rows[0]!;
    expect(stored).toEqual({
      body: "This one",
      message_type: "image",
      attachments: [{ kind: "photo", provider_file_id: "large", file_size: 1234 }],
    });
  });

  it("refuses non-POST before touching anything", async () => {
    const response = await handleTelegramWebhook(
      new Request(`https://apsa.test/api/webhooks/telegram/${connectionId}`),
      { clientIp: null },
    );
    expect(response.status).toBe(405);
  });
});

describe("reply", () => {
  let conversationId: string;
  const principal = () => ({ userId: owner, organizationId: org });

  beforeAll(async () => {
    conversationId = (await conversations.listConversations(ctx(owner, org))).conversations[0]!.id;
  });

  it("refuses a changed principal and a member without messages.reply, sending nothing", async () => {
    calls.length = 0;
    await expect(
      service.sendConversationReply(
        ctx(owner, org),
        {
          conversationId,
          clientMessageId: crypto.randomUUID(),
          body: "hi",
          expectedPrincipal: { userId: ownerB, organizationId: org },
        },
        api,
      ),
    ).rejects.toThrow();
    await expect(
      service.sendConversationReply(
        ctx(owner, org, ["messages.read"]),
        {
          conversationId,
          clientMessageId: crypto.randomUUID(),
          body: "hi",
          expectedPrincipal: principal(),
        },
        api,
      ),
    ).rejects.toThrow("messages.reply");
    // Another organization's member cannot reply into this thread.
    await expect(
      service.sendConversationReply(
        ctx(ownerB, orgB),
        {
          conversationId,
          clientMessageId: crypto.randomUUID(),
          body: "hi",
          expectedPrincipal: { userId: ownerB, organizationId: orgB },
        },
        api,
      ),
    ).rejects.toThrow("conversation_not_found");
    expect(sent()).toHaveLength(0);
  });

  it("sends once, as plain text to the customer's chat, and records it as sent", async () => {
    const key = crypto.randomUUID();
    const input = {
      conversationId,
      clientMessageId: key,
      body: "Yes! Size M is $12.",
      expectedPrincipal: principal(),
    };
    const result = await service.sendConversationReply(ctx(owner, org), input, api);
    expect(result.deliveryError).toBeUndefined();
    expect(result.message).toMatchObject({
      direction: "outbound",
      body: "Yes! Size M is $12.",
      state: "sent",
    });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.body).toMatchObject({ chat_id: "880001", text: "Yes! Size M is $12." });
    expect(sent()[0]!.body["parse_mode"]).toBeUndefined();

    // A retry of the same submission is never sent twice.
    const retry = await service.sendConversationReply(ctx(owner, org), input, api);
    expect(retry.message.id).toBe(result.message.id);
    expect(sent()).toHaveLength(1);

    const detail = await conversations.getConversationDetail(ctx(owner, org), conversationId);
    expect(detail.lastMessage).toBe("Yes! Size M is $12.");
    expect(detail.messages.at(-1)).toMatchObject({ direction: "outbound", state: "sent" });
  });

  it("a provider refusal is recorded as failed and the same submission can be retried", async () => {
    calls.length = 0;
    const key = crypto.randomUUID();
    const input = {
      conversationId,
      clientMessageId: key,
      body: "Are you there?",
      expectedPrincipal: principal(),
    };
    nextFailure = {
      method: "sendMessage",
      status: 403,
      description: "Forbidden: bot was blocked by the user",
    };
    const failed = await service.sendConversationReply(ctx(owner, org), input, api);
    expect(failed.deliveryError).toBe("blocked_by_user");
    expect(failed.message.state).toBe("failed");

    const retried = await service.sendConversationReply(ctx(owner, org), input, api);
    expect(retried.deliveryError).toBeUndefined();
    expect(retried.message).toMatchObject({ id: failed.message.id, state: "sent" });
    expect(sent()).toHaveLength(2);

    const health = await service.listChannelConnections(ctx(owner, org));
    expect(health[0]!.health!.lastErrorCode).toBe("blocked_by_user");
    expect(health[0]!.health!.lastOutboundAt).not.toBeNull();
  });
});

describe("disconnect", () => {
  it("unregisters the webhook, clears the credential, and stops both directions", async () => {
    calls.length = 0;
    const oldSecret = webhookSecret;
    await expect(
      service.disconnectChannel(ctx(owner, org, ["integrations.read"]), connectionId, api),
    ).rejects.toThrow("integrations.disconnect");

    const result = await service.disconnectChannel(ctx(owner, org), connectionId, api);
    expect(result.status).toBe("disconnected");
    expect(calls.map((c) => c.method)).toEqual(["deleteWebhook"]);

    const inbound = await handleTelegramWebhook(
      delivery(connectionId, customerText("hello?", 99), { secret: oldSecret }),
      { clientIp: null },
    );
    expect(inbound.status).toBe(401);

    const conversationId = (await conversations.listConversations(ctx(owner, org)))
      .conversations[0]!.id;
    await expect(
      service.sendConversationReply(
        ctx(owner, org),
        {
          conversationId,
          clientMessageId: crypto.randomUUID(),
          body: "still there?",
          expectedPrincipal: { userId: owner, organizationId: org },
        },
        api,
      ),
    ).rejects.toThrow("channel_unavailable");
    expect(await service.listChannelConnections(ctx(owner, org))).toEqual([]);
  });
});
