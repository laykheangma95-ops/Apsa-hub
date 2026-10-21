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
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
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
const { reconcileChannels, handleReconcileRequest, RECONCILE_ALERT_AFTER } =
  await import("@/server/channels/reconcile");
const { setLogSink } = await import("@/server/observability/logger");

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
/** Holds the next call of `method` until `release` resolves (a slow Telegram); several may be held. */
const holds: { method: string; release: Promise<void> }[] = [];
/**
 * What Telegram HOLDS — changed only when a request is APPLIED (a held request
 * applies when released; a refused one never does). webhookSecret mirrors it.
 */
let telegram: { url: string; secret: string } | null = null;
let webhookSecret = "";
let nextMessageId = 500;
/** The next call of this method loses its answer: the client sees a network failure; Telegram applies it only when land() runs. */
let loseAnswerOf: string | null = null;
const lateLandings: (() => void)[] = [];
/** The next N getWebhookInfo calls fail as a Telegram outage would (502). */
let getWebhookInfoFailures = 0;
function land() {
  for (const apply of lateLandings.splice(0)) apply();
}

function applyAtTelegram(method: string, body: Record<string, unknown>) {
  if (method === "setWebhook") {
    telegram = { url: String(body["url"]), secret: String(body["secret_token"]) };
    webhookSecret = telegram.secret;
  } else if (method === "deleteWebhook") {
    telegram = null;
  }
}

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const method = url.slice(url.lastIndexOf("/") + 1);
  expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  calls.push({ method, body });
  const hold = holds.findIndex((h) => h.method === method);
  if (hold >= 0) await holds.splice(hold, 1)[0]!.release;
  if (method === "getWebhookInfo" && getWebhookInfoFailures > 0) {
    getWebhookInfoFailures -= 1;
    return Response.json(
      { ok: false, error_code: 502, description: "Bad Gateway" },
      { status: 502 },
    );
  }
  if (loseAnswerOf === method) {
    loseAnswerOf = null;
    lateLandings.push(() => applyAtTelegram(method, body));
    throw new TypeError("network connection lost");
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
    case "deleteWebhook":
      applyAtTelegram(method, body);
      return Response.json({ ok: true, result: true });
    case "getWebhookInfo":
      return Response.json({ ok: true, result: { url: telegram?.url ?? "" } });
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
/**
 * Where Telegram would POST for this connection: the URL it holds when that is
 * this connection's (any letter case kept), otherwise an unknown generation.
 */
function urlFor(connectionId: string): string {
  const prefix = "https://apsa.test/api/webhooks/telegram/";
  if (telegram && telegram.url.startsWith(`${prefix}${connectionId.toLowerCase()}/`)) {
    return telegram.url.replace(connectionId.toLowerCase(), connectionId);
  }
  return `${prefix}${connectionId}/${crypto.randomUUID()}`;
}
function delivery(
  connectionId: string,
  message: Record<string, unknown>,
  { secret = webhookSecret, id = ++updateId } = {},
) {
  return new Request(urlFor(connectionId), {
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

// ── Provider agreement helpers (064 §2) ──────────────────────────────────────

/** APSA and Telegram agree: Telegram's URL is the row's current generation and its secret the stored digest's. */
async function expectAgreement(id: string) {
  const row = (
    await db.query<{ status: string; webhook_generation: string; webhook_secret_hash: string }>(
      "select status, webhook_generation, webhook_secret_hash from channel_connections where id=$1",
      [id],
    )
  ).rows[0]!;
  expect(row.status).toBe("connected");
  expect(telegram?.url).toBe(
    `https://apsa.test/api/webhooks/telegram/${id}/${row.webhook_generation}`,
  );
  expect(await sha256Hex(telegram!.secret)).toBe(row.webhook_secret_hash);
  // And a delivery on what Telegram holds passes verification (a group-chat
  // update: verified, acknowledged, deliberately not stored). A wrong secret
  // on the same URL is refused — the negative control.
  const group = {
    ...customerText("agreement check", 70_000 + ++updateId),
    chat: { id: -100777, type: "supergroup" },
  };
  expect((await handleTelegramWebhook(delivery(id, group), { clientIp: null })).status).toBe(200);
  const forged = await handleTelegramWebhook(delivery(id, group, { secret: "not-the-secret" }), {
    clientIp: null,
  });
  expect(forged.status).toBe(401);
}

async function leases(): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int n from channel_bot_operations"))
    .rows[0]!.n;
}

/** Stand in for an operation stalling past its 120 s lease (or its in-doubt window). */
function expireBotLeases() {
  return db.query("update channel_bot_operations set expires_at = now() - interval '1 second'");
}

async function untilCalled(method: string, count = 1) {
  while (calls.filter((c) => c.method === method).length < count) await Bun.sleep(1);
}

async function liveRow(): Promise<{ id: string; status: string; last_error_code: string | null }> {
  return (
    await db.query<{ id: string; status: string; last_error_code: string | null }>(
      "select id, status, last_error_code from channel_connections where status <> 'disconnected'",
    )
  ).rows[0]!;
}

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
    const generation = (
      await db.query<{ webhook_generation: string }>(
        "select webhook_generation from channel_connections where id=$1",
        [connectionId],
      )
    ).rows[0]!.webhook_generation;
    expect(setWebhook.body["url"]).toBe(
      `https://apsa.test/api/webhooks/telegram/${connectionId}/${generation}`,
    );
    // Reported connected only after Telegram was SEEN holding exactly that URL.
    expect(calls.map((c) => c.method)).toEqual(["getMe", "setWebhook", "getWebhookInfo"]);
    expect(telegram?.url).toBe(setWebhook.body["url"]);
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
    holds.push({ method: "setWebhook", release: slow.promise });
    const first = connectAs(ctx(owner, org), TOKEN);
    // Wait until the first connect is parked inside setWebhook.
    while (!calls.some((c) => c.method === "setWebhook")) await Bun.sleep(1);
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("connect_in_progress");
    expect(calls.filter((c) => c.method === "setWebhook")).toHaveLength(1);
    slow.resolve();
    const done = await first;
    expect(done.status).toBe("connected");
    // Telegram holds exactly the generation and secret the database verifies against.
    await expectAgreement(done.id);
    expect(await leases()).toBe(0);
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

describe("provider races: expired connect (064 §2)", () => {
  // Many connects in a row: give each case its own rate-limit budget.
  beforeEach(() => void setPrimaryRateLimitStore(new MemoryRateLimitStore()));

  it("A's delayed setWebhook lands AFTER B's verified connect: A repairs Telegram to B's generation", async () => {
    calls.length = 0;
    const slowA = deferred();
    holds.push({ method: "setWebhook", release: slowA.promise });
    const a = connectAs(ctx(owner, org), TOKEN);
    await untilCalled("setWebhook");
    // A stalls past its lease; B takes the bot and is verified.
    await expireBotLeases();
    const b = await connectAs(ctx(owner, org), TOKEN);
    expect(b.status).toBe("connected");
    // A's request now reaches Telegram last: Telegram holds A's URL and secret...
    slowA.resolve();
    await expect(a).rejects.toThrow("connect_superseded");
    // ...and A, seeing it was superseded, re-pointed Telegram at B's generation.
    await expectAgreement(b.id);
    expect(await leases()).toBe(0);
    connectionId = b.id;
  });

  it("A's delayed setWebhook lands BEFORE B's (B still at Telegram): B lands last and verifies; A defers", async () => {
    calls.length = 0;
    const slowA = deferred();
    const slowB = deferred();
    holds.push({ method: "setWebhook", release: slowA.promise });
    const a = connectAs(ctx(owner, org), TOKEN);
    await untilCalled("setWebhook");
    await expireBotLeases();
    holds.push({ method: "setWebhook", release: slowB.promise });
    const b = connectAs(ctx(owner, org), TOKEN);
    await untilCalled("setWebhook", 2);
    slowA.resolve();
    await expect(a).rejects.toThrow("connect_superseded");
    // B still holds the bot: A did not touch Telegram again.
    expect(calls.filter((c) => c.method === "setWebhook")).toHaveLength(2);
    expect((await liveRow()).status).toBe("error");
    slowB.resolve();
    const done = await b;
    expect(done.status).toBe("connected");
    await expectAgreement(done.id);
  });

  it("a lost setWebhook answer is 'not confirmed': in doubt, never 'connected', the bot blocked until the window passes", async () => {
    calls.length = 0;
    loseAnswerOf = "setWebhook";
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("webhook_unverified");
    expect(await liveRow()).toMatchObject({
      status: "error",
      last_error_code: "webhook_unverified",
    });
    const [listed] = await service.listChannelConnections(ctx(owner, org));
    expect(listed?.status).toBe("error");
    // While the outcome is unknown, neither a reconnect nor a disconnect may run.
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("connect_in_progress");
    await expect(disconnectAs(ctx(owner, org), (await liveRow()).id)).rejects.toThrow(
      "connect_in_progress",
    );
    // The lost request lands late — inside the window, before anyone else acts.
    land();
    await expireBotLeases();
    const b = await connectAs(ctx(owner, org), TOKEN);
    expect(b.status).toBe("connected");
    await expectAgreement(b.id);
  });

  it("a lost answer whose request DID apply is seen by getWebhookInfo and verified, not left in doubt", async () => {
    calls.length = 0;
    loseAnswerOf = "setWebhook";
    const read = deferred();
    holds.push({ method: "getWebhookInfo", release: read.promise });
    const connecting = connectAs(ctx(owner, org), TOKEN);
    await untilCalled("getWebhookInfo");
    land(); // applied at Telegram before the follow-up read is answered
    read.resolve();
    const done = await connecting;
    expect(done.status).toBe("connected");
    await expectAgreement(done.id);
    expect(await leases()).toBe(0);
  });
});

describe("provider races: delayed disconnect (064 §2)", () => {
  // Many connects in a row: give each case its own rate-limit budget.
  beforeEach(() => void setPrimaryRateLimitStore(new MemoryRateLimitStore()));

  it("while A's deleteWebhook is at Telegram, B's reconnect is refused; afterwards B connects and both agree", async () => {
    calls.length = 0;
    const id = (await liveRow()).id;
    const slowA = deferred();
    holds.push({ method: "deleteWebhook", release: slowA.promise });
    const a = disconnectAs(ctx(owner, org), id);
    await untilCalled("deleteWebhook");
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("connect_in_progress");
    slowA.resolve();
    expect((await a).status).toBe("disconnected");
    expect(telegram).toBeNull();
    const b = await connectAs(ctx(owner, org), TOKEN);
    expect(b.id).not.toBe(id);
    await expectAgreement(b.id);
  });

  it("A's delayed deleteWebhook lands AFTER B's verified reconnect: B's row and Telegram webhook are restored, untouched", async () => {
    calls.length = 0;
    const id = (await liveRow()).id;
    const slowA = deferred();
    holds.push({ method: "deleteWebhook", release: slowA.promise });
    const a = disconnectAs(ctx(owner, org), id);
    await untilCalled("deleteWebhook");
    await expireBotLeases();
    const b = await connectAs(ctx(owner, org), TOKEN);
    const before = (
      await db.query<{ credential_ciphertext: string; webhook_secret_hash: string }>(
        "select credential_ciphertext, webhook_secret_hash from channel_connections where id=$1",
        [b.id],
      )
    ).rows[0]!;
    // A's request reaches Telegram last and removes the webhook...
    slowA.resolve();
    expect((await a).status).toBe("disconnected");
    // ...A saw it was superseded and restored B's generation; B's row untouched.
    const after = (
      await db.query<{ credential_ciphertext: string; webhook_secret_hash: string }>(
        "select credential_ciphertext, webhook_secret_hash from channel_connections where id=$1",
        [b.id],
      )
    ).rows[0]!;
    expect(after).toEqual(before);
    await expectAgreement(b.id);
  });

  it("A's delayed deleteWebhook lands BEFORE B's setWebhook (B still at Telegram): B lands last and verifies", async () => {
    calls.length = 0;
    const id = (await liveRow()).id;
    const slowA = deferred();
    const slowB = deferred();
    holds.push({ method: "deleteWebhook", release: slowA.promise });
    const a = disconnectAs(ctx(owner, org), id);
    await untilCalled("deleteWebhook");
    await expireBotLeases();
    holds.push({ method: "setWebhook", release: slowB.promise });
    const b = connectAs(ctx(owner, org), TOKEN);
    await untilCalled("setWebhook");
    slowA.resolve();
    expect((await a).status).toBe("disconnected");
    slowB.resolve();
    const done = await b;
    await expectAgreement(done.id);
  });

  it("a lost deleteWebhook answer keeps the bot in doubt: no reconnect until the window passes", async () => {
    calls.length = 0;
    const id = (await liveRow()).id;
    loseAnswerOf = "deleteWebhook";
    const gone = await disconnectAs(ctx(owner, org), id);
    expect(gone.status).toBe("disconnected");
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("connect_in_progress");
    land(); // the delete lands late, inside the window
    expect(telegram).toBeNull();
    await expireBotLeases();
    const b = await connectAs(ctx(owner, org), TOKEN);
    await expectAgreement(b.id);
    connectionId = b.id;
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
    const response = await handleTelegramWebhook(new Request(urlFor(connectionId)), {
      clientIp: null,
    });
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
    holds.push({ method: "sendMessage", release: slow.promise });
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
    expect(calls.map((c) => c.method)).toEqual(["deleteWebhook", "getWebhookInfo"]);
    expect(telegram).toBeNull();

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

describe("stale webhook generation (064 §2 rule 5)", () => {
  // Many connects in a row: give each case its own rate-limit budget.
  beforeEach(() => void setPrimaryRateLimitStore(new MemoryRateLimitStore()));

  it("a verified delivery on an older generation is stored and flags the mismatch; the current one clears it", async () => {
    // Runs last: the bot was disconnected by the journey; connect it twice.
    connectionId = (await connectAs(ctx(owner, org), TOKEN)).id;
    const older = { ...telegram! };
    await connectAs(ctx(owner, org), TOKEN);
    const current = { ...telegram! };
    expect(current.url).not.toBe(older.url);
    // Telegram somehow still holds the older generation.
    telegram = older;
    webhookSecret = older.secret;
    const stale = await handleTelegramWebhook(
      delivery(connectionId, customerText("old generation", 90_001), { id: 90_001 }),
      { clientIp: null },
    );
    expect(stale.status).toBe(200);
    expect(
      (await db.query("select 1 from messages where provider_message_id='tg:90001'")).rows,
    ).toHaveLength(1);
    expect(await liveRow()).toMatchObject({ status: "error", last_error_code: "webhook_mismatch" });
    // Negative control: a forged secret on the old generation is refused.
    const forged = await handleTelegramWebhook(
      delivery(connectionId, customerText("forged", 90_002), { id: 90_002, secret: "nope" }),
      { clientIp: null },
    );
    expect(forged.status).toBe(401);
    // Back on the current generation: a verified delivery confirms it.
    telegram = current;
    webhookSecret = current.secret;
    const confirmed = await handleTelegramWebhook(
      delivery(connectionId, customerText("current generation", 90_003), { id: 90_003 }),
      { clientIp: null },
    );
    expect(confirmed.status).toBe(200);
    await expectAgreement(connectionId);
  });
});

describe("reconciliation, independent of customer traffic (064 §2a)", () => {
  beforeEach(() => void setPrimaryRateLimitStore(new MemoryRateLimitStore()));

  /** Make the live connection due now, as the schedule eventually would. */
  function makeDue() {
    return db.query(
      "update channel_connections set next_reconcile_at = now() where status <> 'disconnected'",
    );
  }
  async function row() {
    return (
      await db.query<{
        id: string;
        status: string;
        last_error_code: string | null;
        reconcile_failures: number;
        mismatch_since: string | null;
        last_verified_at: string | null;
        due_in_s: number;
      }>(
        `select id, status, last_error_code, reconcile_failures, mismatch_since, last_verified_at,
           extract(epoch from next_reconcile_at - now())::int as due_in_s
         from channel_connections where status <> 'disconnected'`,
      )
    ).rows[0]!;
  }
  const run = () => reconcileChannels({ api });

  it("setWebhook acknowledged but getWebhookInfo failing is NEVER 'connected'; reconciliation then sees it", async () => {
    calls.length = 0;
    getWebhookInfoFailures = 1;
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("webhook_unverified");
    const pending = await row();
    expect(pending).toMatchObject({ status: "error", last_error_code: "webhook_unverified" });
    // The outcome is KNOWN (Telegram answered OK): the bot is not held in doubt...
    expect(await leases()).toBe(0);
    // ...and it is checked again at once.
    expect(pending.due_in_s).toBeLessThanOrEqual(0);
    const report = await run();
    expect(report).toMatchObject({ checked: 1, healthy: 1, repaired: 0, failed: 0 });
    await expectAgreement(pending.id);
    connectionId = pending.id;
  });

  it("a setWebhook applied AFTER lease expiry and a newer connect, with no messages: detected and repaired", async () => {
    calls.length = 0;
    loseAnswerOf = "setWebhook";
    await expect(connectAs(ctx(owner, org), TOKEN)).rejects.toThrow("webhook_unverified");
    await expireBotLeases();
    const newer = await connectAs(ctx(owner, org), TOKEN);
    await expectAgreement(newer.id);
    // The old request lands at Telegram long after: Telegram now holds the OLD generation.
    land();
    const db1 = await row();
    expect(telegram!.url).not.toContain(`/${newer.id}/${await liveGeneration()}`);
    expect(db1.status).toBe("connected"); // APSA cannot know yet — nothing arrived
    await makeDue();
    const report = await run();
    expect(report).toMatchObject({ checked: 1, repaired: 1 });
    await expectAgreement(newer.id);
  });

  it("a deleteWebhook applied AFTER lease expiry and a newer connect: silence, then detected and repaired", async () => {
    calls.length = 0;
    const id = (await liveRow()).id;
    loseAnswerOf = "deleteWebhook";
    await disconnectAs(ctx(owner, org), id);
    await expireBotLeases();
    const newer = await connectAs(ctx(owner, org), TOKEN);
    await expectAgreement(newer.id);
    land(); // the old delete lands: Telegram has NO webhook — the bot is silent
    expect(telegram).toBeNull();
    // Silence: Telegram has nowhere to deliver, so no delivery can reveal it.
    expect((await row()).status).toBe("connected");
    await makeDue();
    const report = await run();
    expect(report).toMatchObject({ checked: 1, repaired: 1 });
    await expectAgreement(newer.id);
    connectionId = newer.id;
  });

  it("with no reconciler running, a connection ages to 'not confirmed' after 60 minutes at read time", async () => {
    await db.query(
      "update channel_connections set last_verified_at = now() - interval '61 minutes', next_reconcile_at = now() + interval '1 hour' where status <> 'disconnected'",
    );
    const [listed] = await service.listChannelConnections(ctx(owner, org));
    expect(listed).toMatchObject({
      status: "error",
      health: { lastErrorCode: "webhook_unverified" },
    });
    // Negative control: a fresh observation reads 'connected'.
    await makeDue();
    await run();
    const [fresh] = await service.listChannelConnections(ctx(owner, org));
    expect(fresh?.status).toBe("connected");
  });

  it("repeated failed observations back off, expose 'not confirmed', and alert the operator", async () => {
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      getWebhookInfoFailures = 100;
      const dues: number[] = [];
      for (let i = 1; i <= RECONCILE_ALERT_AFTER; i++) {
        await makeDue();
        const report = await run();
        expect(report).toMatchObject({ checked: 1, failed: 1 });
        const r = await row();
        expect(r.reconcile_failures).toBe(i);
        dues.push(r.due_in_s);
        // Verified recently: still connected — one failed check is not a mismatch.
        expect(r.status).toBe("connected");
        expect(report.alerts).toBe(i >= RECONCILE_ALERT_AFTER ? 1 : 0);
      }
      // Backoff: ~1, ~2, ~4 minutes.
      expect(dues[0]!).toBeGreaterThan(50);
      expect(dues[1]!).toBeGreaterThan(dues[0]!);
      expect(dues[2]!).toBeGreaterThan(dues[1]!);
      expect(lines.some((l) => l.includes('"event":"channels.telegram.reconcile_alert"'))).toBe(
        true,
      );
      expect(lines.join("\n")).not.toContain(TOKEN);
      // Unobserved for over 60 minutes: the row itself says not confirmed.
      await db.query(
        "update channel_connections set last_verified_at = now() - interval '61 minutes' where status <> 'disconnected'",
      );
      await makeDue();
      await run();
      expect(await row()).toMatchObject({ status: "error", last_error_code: "webhook_unverified" });
    } finally {
      restore();
      getWebhookInfoFailures = 0;
    }
    // Telegram reachable again: healthy, counters cleared.
    await makeDue();
    await run();
    expect(await row()).toMatchObject({ status: "connected", reconcile_failures: 0 });
  });

  it("a missing webhook that cannot be repaired is shown as missing, with since-when", async () => {
    telegram = null; // the webhook is gone...
    nextFailure = { method: "setWebhook", status: 400, description: "Bad Request" }; // ...and repair is refused
    await makeDue();
    const report = await run();
    expect(report).toMatchObject({ checked: 1, failed: 1 });
    const r = await row();
    expect(r).toMatchObject({ status: "error", last_error_code: "webhook_missing" });
    expect(r.mismatch_since).not.toBeNull();
    const [listed] = await service.listChannelConnections(ctx(owner, org));
    expect(listed?.status).toBe("error");
    expect(listed?.health?.mismatchSince).not.toBeNull();
    // The next run repairs it.
    await makeDue();
    expect(await run()).toMatchObject({ repaired: 1 });
    await expectAgreement(r.id);
    expect((await row()).mismatch_since).toBeNull();
  });

  it("never writes to Telegram while a member's operation holds the bot", async () => {
    calls.length = 0;
    telegram = null;
    const slow = deferred();
    holds.push({ method: "setWebhook", release: slow.promise });
    const member = connectAs(ctx(owner, org), TOKEN);
    await untilCalled("setWebhook");
    await makeDue();
    const report = await run();
    expect(report.busy + report.healthy + report.failed).toBe(1);
    expect(calls.filter((c) => c.method === "setWebhook")).toHaveLength(1); // only the member's
    slow.resolve();
    const done = await member;
    await expectAgreement(done.id);
  });

  it("the scheduler entry: off without CRON_SECRET, generic 401 for a wrong one, counts only when right", async () => {
    const url = "https://apsa.test/api/internal/channels/reconcile";
    const off = await handleReconcileRequest(new Request(url), { env: {}, api });
    expect(off.status).toBe(503);
    const env = { CRON_SECRET: "s3cret-for-tests-only" };
    for (const auth of [undefined, "Bearer wrong", "s3cret-for-tests-only"]) {
      const res = await handleReconcileRequest(
        new Request(url, auth ? { headers: { authorization: auth } } : {}),
        { env, api },
      );
      expect(res.status).toBe(401);
    }
    expect(
      (await handleReconcileRequest(new Request(url, { method: "PUT" }), { env, api })).status,
    ).toBe(405);
    await makeDue();
    const ok = await handleReconcileRequest(
      new Request(url, { headers: { authorization: "Bearer s3cret-for-tests-only" } }),
      { env, api },
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(
      ["alerts", "busy", "checked", "failed", "healthy", "ok", "repaired"].sort(),
    );
  });
});

async function liveGeneration(): Promise<string> {
  return (
    await db.query<{ webhook_generation: string }>(
      "select webhook_generation from channel_connections where status <> 'disconnected'",
    )
  ).rows[0]!.webhook_generation;
}
