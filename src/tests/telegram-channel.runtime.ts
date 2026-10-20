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
/** Holds the next call of `method` until `release` resolves (a slow Telegram). */
let gate: { method: string; release: Promise<void> } | null = null;
let webhookSecret = "";
let nextMessageId = 500;

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const method = url.slice(url.lastIndexOf("/") + 1);
  expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  calls.push({ method, body });
  if (gate && gate.method === method) {
    const held = gate;
    gate = null;
    await held.release;
  }
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** The principal a context was started as — the normal, matching case. */
function principalOf(c: AuthorizationContext) {
  return { userId: c.userId, organizationId: c.organizationId };
}
function connectAs(c: AuthorizationContext, token: string, factory = api) {
  return service.connectTelegramBot(c, token, principalOf(c), factory);
}
function disconnectAs(c: AuthorizationContext, id: string, factory = api) {
  return service.disconnectChannel(c, id, principalOf(c), factory);
}
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
    await expect(connectAs(ctx(owner, org, ["integrations.read"]), TOKEN, api)).rejects.toThrow(
      "integrations.connect",
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed token before any network call", async () => {
    await expect(connectAs(ctx(owner, org), "not-a-token", api)).rejects.toThrow("invalid_token");
    expect(calls).toHaveLength(0);
  });

  it("maps a revoked token to invalid_token", async () => {
    nextFailure = { method: "getMe", status: 401, description: "Unauthorized" };
    await expect(connectAs(ctx(owner, org), TOKEN, api)).rejects.toThrow("invalid_token");
  });

  it("a refused webhook leaves no live connection", async () => {
    nextFailure = { method: "setWebhook", status: 400, description: "bad webhook" };
    await expect(connectAs(ctx(owner, org), TOKEN, api)).rejects.toThrow("webhook_failed");
    const live = await db.query("select 1 from channel_connections where status <> 'disconnected'");
    expect(live.rows).toHaveLength(0);
  });

  it("connects: token encrypted at rest, webhook registered with a secret only its digest is stored for", async () => {
    calls.length = 0;
    const summary = await connectAs(ctx(owner, org), `  ${TOKEN}  `, api);
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

  it("refuses a changed initiating principal before any network call or write", async () => {
    calls.length = 0;
    for (const expected of [
      { userId: ownerB, organizationId: org },
      { userId: owner, organizationId: orgB },
    ]) {
      await expect(
        service.connectTelegramBot(ctx(owner, org), TOKEN, expected, api),
      ).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
    // Positive control: the matching principal proceeds (proved by the connect above).
  });

  it("serializes overlapping connects: the second is refused while the first is at Telegram", async () => {
    calls.length = 0;
    const slow = deferred();
    gate = { method: "setWebhook", release: slow.promise };
    const first = connectAs(ctx(owner, org), TOKEN);
    // Wait until the first connect is parked inside setWebhook.
    while (!calls.some((c) => c.method === "setWebhook")) await Bun.sleep(1);
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("connect_in_progress");
    expect(calls.filter((c) => c.method === "setWebhook")).toHaveLength(1);
    slow.resolve();
    const done = await first;
    expect(done.status).toBe("connected");
    const stored = (
      await db.query<{ webhook_secret_hash: string; pending_connect_op: string | null }>(
        "select webhook_secret_hash, pending_connect_op from channel_connections where id=$1",
        [done.id],
      )
    ).rows[0]!;
    // Telegram holds exactly the secret the database verifies against.
    expect(await sha256Hex(webhookSecret)).toBe(stored.webhook_secret_hash);
    expect(stored.pending_connect_op).toBeNull();
  });

  it("an older connect that fails after its lease was taken over leaves the newer connection live", async () => {
    calls.length = 0;
    const slow = deferred();
    gate = { method: "setWebhook", release: slow.promise };
    const older = connectAs(ctx(owner, org), TOKEN);
    while (!calls.some((c) => c.method === "setWebhook")) await Bun.sleep(1);
    // The older server stalls past its lease; a newer connect takes over.
    await db.query(
      "update channel_connections set pending_connect_until = now() - interval '1 second' where status <> 'disconnected'",
    );
    const newer = await connectAs(ctx(owner, org), TOKEN);
    const newerSecret = webhookSecret;
    // The older setWebhook now fails: its cleanup must not disconnect the newer connect.
    nextFailure = { method: "setWebhook", status: 400, description: "bad webhook" };
    slow.resolve();
    await expect(older).rejects.toThrow("webhook_failed");
    const row = (
      await db.query<{ status: string; webhook_secret_hash: string }>(
        "select status, webhook_secret_hash from channel_connections where id=$1",
        [newer.id],
      )
    ).rows[0]!;
    expect(row.status).toBe("connected");
    expect(row.webhook_secret_hash).toBe(await sha256Hex(newerSecret));
    webhookSecret = newerSecret;
  });

  it("an older connect whose setWebhook SUCCEEDS after takeover reports connect_superseded and changes nothing", async () => {
    calls.length = 0;
    const slow = deferred();
    gate = { method: "setWebhook", release: slow.promise };
    const older = connectAs(ctx(owner, org), TOKEN);
    while (!calls.some((c) => c.method === "setWebhook")) await Bun.sleep(1);
    await db.query(
      "update channel_connections set pending_connect_until = now() - interval '1 second' where status <> 'disconnected'",
    );
    const newer = await connectAs(ctx(owner, org), TOKEN);
    const before = (
      await db.query<{ webhook_secret_hash: string }>(
        "select webhook_secret_hash from channel_connections where id=$1",
        [newer.id],
      )
    ).rows[0]!;
    slow.resolve();
    await expect(older).rejects.toThrow("connect_superseded");
    const after = (
      await db.query<{ status: string; webhook_secret_hash: string }>(
        "select status, webhook_secret_hash from channel_connections where id=$1",
        [newer.id],
      )
    ).rows[0]!;
    expect(after).toEqual({ status: "connected", webhook_secret_hash: before.webhook_secret_hash });
    // Re-point Telegram at the live secret for the rest of the journey (the
    // residual risk this case documents: a superseded setWebhook that lands
    // last must be repaired by reconnecting).
    await connectAs(ctx(owner, org), TOKEN);
  });

  it("another organization cannot take the same bot", async () => {
    await expect(connectAs(ctx(ownerB, orgB), TOKEN, api)).rejects.toThrow("account_in_use");
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

  it("a crash after verification loses nothing: Telegram's retry of the update is processed", async () => {
    const id = 88_001;
    // 1) The process dies between verification and ingestion: the request
    //    never completes (a never-settling promise stands in for the kill).
    const abandoned = handleTelegramWebhook(
      delivery(connectionId, customerText("Still in stock?", 30), { id }),
      { clientIp: null, beforeIngest: () => new Promise<void>(() => undefined) },
    );
    void abandoned;
    await Bun.sleep(20);
    const receipt = await db.query(
      "select 1 from webhook_event_receipts where provider='telegram' and event_id=$1",
      [`${connectionId}:${id}`],
    );
    expect(receipt.rows).toHaveLength(0);

    // 2) An ingestion that throws (database dropped mid-write) — 500, no receipt.
    const failed = await handleTelegramWebhook(
      delivery(connectionId, customerText("Still in stock?", 30), { id }),
      {
        clientIp: null,
        beforeIngest: () => {
          throw new Error("connection reset");
        },
      },
    );
    expect(failed.status).toBe(500);

    // 3) Telegram retries: processed, stored exactly once, receipt now committed.
    const retried = await handleTelegramWebhook(
      delivery(connectionId, customerText("Still in stock?", 30), { id }),
      { clientIp: null },
    );
    expect(retried.status).toBe(200);
    const rows = await db.query<{ n: number }>(
      "select count(*)::int n from messages where provider_message_id='tg:30'",
    );
    expect(rows.rows[0]!.n).toBe(1);
    const committed = await db.query(
      "select 1 from webhook_event_receipts where provider='telegram' and event_id=$1",
      [`${connectionId}:${id}`],
    );
    expect(committed.rows).toHaveLength(1);

    // 4) A further replay is a duplicate: acknowledged, nothing new stored,
    //    and ingestion is not even attempted.
    let reached = false;
    const replay = await handleTelegramWebhook(
      delivery(connectionId, customerText("Still in stock?", 30), { id }),
      { clientIp: null, beforeIngest: () => void (reached = true) },
    );
    expect(replay.status).toBe(200);
    expect(reached).toBe(false);
  });

  it("an upper-case connection id in the URL maps to the same receipt", async () => {
    const id = 88_002;
    const upper = await handleTelegramWebhook(
      delivery(connectionId.toUpperCase(), customerText("Case?", 31), { id }),
      { clientIp: null },
    );
    expect(upper.status).toBe(200);
    let reached = false;
    const lower = await handleTelegramWebhook(
      delivery(connectionId, customerText("Case?", 31), { id }),
      { clientIp: null, beforeIngest: () => void (reached = true) },
    );
    expect(lower.status).toBe(200);
    expect(reached).toBe(false);
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

describe("reply attempts across a sweep and a retry", () => {
  let conversationId: string;
  const principal = () => ({ userId: owner, organizationId: org });

  beforeAll(async () => {
    conversationId = (await conversations.listConversations(ctx(owner, org))).conversations[0]!.id;
  });

  async function stuckThenRetry(body: string, retryOutcome: "ok" | "blocked") {
    calls.length = 0;
    const input = {
      conversationId,
      clientMessageId: crypto.randomUUID(),
      body,
      expectedPrincipal: principal(),
    };
    // Attempt A: Telegram hangs.
    const slow = deferred();
    gate = { method: "sendMessage", release: slow.promise };
    const attemptA = service.sendConversationReply(ctx(owner, org), input, api);
    while (sent().length < 1) await Bun.sleep(1);
    // Over 2 minutes later the reply is swept, and the merchant retries (B).
    await db.query(
      `update messages set metadata = metadata || jsonb_build_object('sending_since', now() - interval '3 minutes')
       where provider_message_id = $1`,
      [`apsa:${input.clientMessageId}`],
    );
    if (retryOutcome === "blocked") {
      nextFailure = {
        method: "sendMessage",
        status: 403,
        description: "Forbidden: bot was blocked by the user",
      };
    }
    const attemptB = await service.sendConversationReply(ctx(owner, org), input, api);
    return { attemptA, attemptB, release: slow.resolve };
  }

  it("B sent first, then A's late success: still sent once in the ledger, duplicate recorded", async () => {
    const r = await stuckThenRetry("late success after retry", "ok");
    expect(r.attemptB.message.state).toBe("sent");
    r.release();
    const a = await r.attemptA;
    expect(a.message.state).toBe("sent");
    expect(a.deliveryError).toBeUndefined();
    const row = (
      await db.query<{ state: string; metadata: { delivered_refs: string[] } }>(
        "select state, metadata from messages where id=$1",
        [a.message.id],
      )
    ).rows[0]!;
    expect(row.state).toBe("sent");
    expect(row.metadata.delivered_refs).toHaveLength(2);
  });

  it("B refused first, then A's late success: becomes sent — the customer has it", async () => {
    const r = await stuckThenRetry("late success after refused retry", "blocked");
    expect(r.attemptB.message.state).toBe("failed");
    expect(r.attemptB.deliveryError).toBe("blocked_by_user");
    r.release();
    const a = await r.attemptA;
    expect(a.message.state).toBe("sent");
    expect(a.deliveryError).toBeUndefined();
  });

  it("A's late failure after B succeeded changes nothing", async () => {
    const r = await stuckThenRetry("late failure after retry", "ok");
    nextFailure = { method: "sendMessage", status: 500, description: "Internal Server Error" };
    r.release();
    const a = await r.attemptA;
    expect(a.message.state).toBe("sent");
    expect(a.deliveryError).toBeUndefined();
  });
});

describe("disconnect", () => {
  it("unregisters the webhook, clears the credential, and stops both directions", async () => {
    calls.length = 0;
    const oldSecret = webhookSecret;
    await expect(
      disconnectAs(ctx(owner, org, ["integrations.read"]), connectionId, api),
    ).rejects.toThrow("integrations.disconnect");

    await expect(
      service.disconnectChannel(
        ctx(owner, org),
        connectionId,
        { userId: owner, organizationId: orgB },
        api,
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const result = await disconnectAs(ctx(owner, org), connectionId, api);
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
