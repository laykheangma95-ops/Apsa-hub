/**
 * Migration 064 against the REAL migrated schema (every migration, in order,
 * through PGlite). Spawned by telegram-channel-sql.test.ts.
 *
 * Proves the database half of the Telegram provider:
 *   - connect: membership re-checked, audited in the same transaction without
 *     the credential, one live bot per APSA (another organization is refused
 *     account_in_use), re-connect in the same organization rotates in place;
 *   - disconnect clears the credential and secret digest, is audited, and
 *     frees the bot for another organization;
 *   - ingest_telegram_inbound derives the organization from the connection,
 *     creates exactly one Customer + TELEGRAM identity on first contact (also
 *     under concurrency), reuses it afterwards, is idempotent per message,
 *     refuses a conflicting replay, refuses a disconnected connection, and
 *     reopens a parked thread;
 *   - connect lease: an overlapping connect of the same bot is refused
 *     connect_in_progress; only the operation holding the lease may finish
 *     or abort it, so an older failed connect never disconnects a newer one;
 *   - the webhook replay receipt commits WITH the message (a rolled-back
 *     ingest leaves no receipt, so a retry is processed);
 *   - begin/complete_outbound_message: exactly one caller is told to send,
 *     a sent reply is never sent again, a failed one may be retried once per
 *     failure, completion is bound to its sending attempt (late success /
 *     failure after a sweep and a retry, in both orders), a reused key with a
 *     different body is stale_state, tenant and channel are enforced;
 *   - browser roles can neither read the table nor execute the functions;
 *   - the integrations.* vocabulary reaches Owner/Manager as PERMISSIONS_MATRIX
 *     §25 says, and never Cashier/Sales/Customer Service.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { financialFixture } from "./helpers/payment-order-fixture";

let fixture: Awaited<ReturnType<typeof financialFixture>>;
let db: PGlite;
let org: string;
let orgB: string;
let owner: string;
const ownerB = "bbbbbbbb-0000-4000-8000-0000000000b1";
const outsider = "cccccccc-0000-4000-8000-0000000000c1";

const BOT = "7000000001";
const HASH = "a".repeat(64);
const CIPHER = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb";

beforeAll(async () => {
  fixture = await financialFixture();
  db = fixture.db;
  org = fixture.org;
  orgB = fixture.orgB;
  owner = fixture.actor;
  await db.query(
    "insert into auth.users(id,email) values($1,'owner-b@test.invalid'),($2,'outsider@test.invalid')",
    [ownerB, outsider],
  );
  await db.query(
    `insert into memberships(organization_id,user_id,role_id,status)
     select $1,$2,id,'active' from roles where system_role='OWNER' and organization_id is null`,
    [org, owner],
  );
  await db.query(
    `insert into memberships(organization_id,user_id,role_id,status)
     select $1,$2,id,'active' from roles where system_role='OWNER' and organization_id is null`,
    [orgB, ownerB],
  );
});
afterAll(async () => {
  await fixture.close();
});

type Row = Record<string, unknown>;

async function call(fn: string, args: unknown[]): Promise<Row> {
  const params = args.map((_, i) => `$${i + 1}`).join(",");
  const result = await db.query<{ r: Row }>(`select to_jsonb(${fn}(${params})) as r`, args);
  return result.rows[0]!.r;
}

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as Error).message);
  }
  return "no error";
}

function startConnect(
  tenant: string,
  actor: string,
  bot = BOT,
  hash = HASH,
  operation: string = crypto.randomUUID(),
) {
  return call("connect_channel_account", [
    tenant,
    actor,
    "TELEGRAM",
    bot,
    "apsa_test_bot",
    "APSA Test Bot",
    CIPHER,
    1,
    hash,
    operation,
  ]);
}

/** A whole successful connect: take the lease, then finish it (setWebhook succeeded). */
async function connect(tenant: string, actor: string, bot = BOT, hash = HASH) {
  const operation = crypto.randomUUID();
  const row = await startConnect(tenant, actor, bot, hash, operation);
  return call("finish_channel_connect", [tenant, row.id, operation]);
}

function inbound(
  connection: string,
  messageId: number,
  body: string,
  {
    chat = "555001",
    sender = "555001",
    name = "Sokha",
    handle = "sokha",
    update = String(messageId),
  } = {},
) {
  return call("ingest_telegram_inbound", [
    connection,
    chat,
    sender,
    name,
    handle,
    `tg:${messageId}`,
    body,
    "text",
    "2026-10-20T03:00:00Z",
    null,
    update,
  ]);
}

describe("connect / disconnect", () => {
  let connectionId: string;

  it("connects a bot, audited without the credential", async () => {
    const row = await connect(org, owner);
    connectionId = row.id as string;
    expect(row).toMatchObject({
      organization_id: org,
      status: "connected",
      external_account_id: BOT,
    });
    const audit = await db.query<{ action: string; after_json: Row }>(
      "select action, after_json from audit_logs where resource_id=$1",
      [connectionId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.action).toBe("integrations.connect");
    const serialized = JSON.stringify(audit.rows[0]!.after_json);
    expect(serialized).not.toContain(CIPHER);
    expect(serialized).not.toContain(HASH);
  });

  it("refuses a caller who is not an active member", async () => {
    expect(await errorOf(connect(org, outsider, "7000000099"))).toContain("permission_denied");
  });

  it("refuses the same live bot for another organization", async () => {
    expect(await errorOf(connect(orgB, ownerB))).toContain("account_in_use");
  });

  it("re-connecting in the same organization rotates in place", async () => {
    const rotated = await connect(org, owner, BOT, "b".repeat(64));
    expect(rotated.id).toBe(connectionId);
    expect(rotated.webhook_secret_hash).toBe("b".repeat(64));
    const count = await db.query<{ n: number }>(
      "select count(*)::int n from channel_connections where external_account_id=$1",
      [BOT],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  it("disconnect clears the credential, is audited, and frees the bot", async () => {
    const other = await connect(org, owner, "7000000002");
    const gone = await call("disconnect_channel_account", [org, owner, other.id]);
    expect(gone).toMatchObject({
      status: "disconnected",
      credential_ciphertext: null,
      webhook_secret_hash: null,
    });
    const audit = await db.query(
      "select 1 from audit_logs where resource_id=$1 and action='integrations.disconnect'",
      [other.id],
    );
    expect(audit.rows).toHaveLength(1);
    // Another organization's id is never found.
    expect(
      await errorOf(call("disconnect_channel_account", [orgB, ownerB, connectionId])),
    ).toContain("connection_not_found");
    // The freed bot can now be connected elsewhere.
    const taken = await connect(orgB, ownerB, "7000000002");
    expect(taken.organization_id).toBe(orgB);
  });
});

describe("connect lease", () => {
  const LEASE_BOT = "7000000077";

  async function live(id: unknown): Promise<Row> {
    const r = await db.query<Row>(
      "select status, webhook_secret_hash, pending_connect_op, connect_generation from channel_connections where id=$1",
      [id],
    );
    return r.rows[0]!;
  }

  it("an overlapping connect of the same bot is refused while the first holds the lease", async () => {
    const opA = crypto.randomUUID();
    const a = await startConnect(org, owner, LEASE_BOT, "c".repeat(64), opA);
    expect(await errorOf(startConnect(org, owner, LEASE_BOT, "d".repeat(64)))).toContain(
      "connect_in_progress",
    );
    // The refused overlap changed nothing.
    expect(await live(a.id)).toMatchObject({
      webhook_secret_hash: "c".repeat(64),
      pending_connect_op: opA,
    });
    // Once A finishes, a new connect may rotate.
    await call("finish_channel_connect", [org, a.id, opA]);
    const b = await connect(org, owner, LEASE_BOT, "d".repeat(64));
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ webhook_secret_hash: "d".repeat(64), pending_connect_op: null });
    expect(Number(b.connect_generation)).toBe(Number(a.connect_generation) + 1);
  });

  it("an older connect whose lease expired and was taken over can neither abort nor finish the newer one", async () => {
    const opOld = crypto.randomUUID();
    const old = await startConnect(org, owner, LEASE_BOT, "e".repeat(64), opOld);
    // The older operation's server stalls past its lease.
    await db.query(
      "update channel_connections set pending_connect_until = now() - interval '1 second' where id=$1",
      [old.id],
    );
    const opNew = crypto.randomUUID();
    await startConnect(org, owner, LEASE_BOT, "f".repeat(64), opNew);

    // The older setWebhook then fails: its cleanup must not disconnect the newer connect.
    const aborted = await db.query<{ ok: boolean }>(
      "select abort_channel_connect($1,$2,$3,$4) ok",
      [org, owner, old.id, opOld],
    );
    expect(aborted.rows[0]!.ok).toBe(false);
    expect(await live(old.id)).toMatchObject({
      status: "connected",
      webhook_secret_hash: "f".repeat(64),
      pending_connect_op: opNew,
    });
    // Nor may it claim success for the newer secret.
    expect(await errorOf(call("finish_channel_connect", [org, old.id, opOld]))).toContain(
      "connect_superseded",
    );
    // The newer operation still owns it.
    const finished = await call("finish_channel_connect", [org, old.id, opNew]);
    expect(finished).toMatchObject({ status: "connected", pending_connect_op: null });
  });

  it("the operation holding the lease aborts its own failed connect, audited", async () => {
    const op = crypto.randomUUID();
    const row = await startConnect(org, owner, "7000000078", "1".repeat(64), op);
    // Negative controls: another org, another actor, another operation.
    expect(
      (
        await db.query<{ ok: boolean }>("select abort_channel_connect($1,$2,$3,$4) ok", [
          orgB,
          ownerB,
          row.id,
          op,
        ])
      ).rows[0]!.ok,
    ).toBe(false);
    expect(
      await errorOf(
        db.query("select abort_channel_connect($1,$2,$3,$4)", [org, outsider, row.id, op]),
      ),
    ).toContain("permission_denied");
    expect(
      (
        await db.query<{ ok: boolean }>("select abort_channel_connect($1,$2,$3,$4) ok", [
          org,
          owner,
          row.id,
          crypto.randomUUID(),
        ])
      ).rows[0]!.ok,
    ).toBe(false);
    expect((await live(row.id)).status).toBe("connected");

    const ok = await db.query<{ ok: boolean }>("select abort_channel_connect($1,$2,$3,$4) ok", [
      org,
      owner,
      row.id,
      op,
    ]);
    expect(ok.rows[0]!.ok).toBe(true);
    expect(await live(row.id)).toMatchObject({ status: "disconnected", webhook_secret_hash: null });
    const audit = await db.query<{ after_json: Row }>(
      "select after_json from audit_logs where resource_id=$1 and action='integrations.disconnect'",
      [row.id],
    );
    expect(audit.rows[0]!.after_json).toMatchObject({ reason: "connect_failed" });
  });

  it("a member's disconnect during a pending connect wins: the connect can no longer finish", async () => {
    const op = crypto.randomUUID();
    const row = await startConnect(org, owner, "7000000079", "2".repeat(64), op);
    await call("disconnect_channel_account", [org, owner, row.id]);
    expect(await errorOf(call("finish_channel_connect", [org, row.id, op]))).toContain(
      "connect_superseded",
    );
    expect(
      (
        await db.query<{ ok: boolean }>("select abort_channel_connect($1,$2,$3,$4) ok", [
          org,
          owner,
          row.id,
          op,
        ])
      ).rows[0]!.ok,
    ).toBe(false);
  });

  it("finish is tenant-bound", async () => {
    const op = crypto.randomUUID();
    const row = await startConnect(org, owner, "7000000080", "3".repeat(64), op);
    expect(await errorOf(call("finish_channel_connect", [orgB, row.id, op]))).toContain(
      "connect_superseded",
    );
    await call("finish_channel_connect", [org, row.id, op]);
  });
});

describe("ingest_telegram_inbound", () => {
  let connectionId: string;

  beforeAll(async () => {
    const row = await db.query<{ id: string }>(
      "select id from channel_connections where external_account_id=$1",
      [BOT],
    );
    connectionId = row.rows[0]!.id;
  });

  it("first contact creates one Customer + exact TELEGRAM identity in the connection's org", async () => {
    const message = await inbound(connectionId, 1, "តើមានទំហំ M ទេ?");
    expect(message).toMatchObject({
      organization_id: org,
      direction: "inbound",
      sender_type: "customer",
    });
    const conversation = await db.query<Row>(
      "select * from conversation_inbox_rows($1,$2) where id=$3",
      [org, owner, message.conversation_id],
    );
    const row = conversation.rows[0]!;
    expect(row.provider).toBe("TELEGRAM");
    expect(row.provider_conversation_id).toBe(`tg:${BOT}:555001`);
    expect(row.customer_id).toBeTruthy();
    const customer = await db.query<Row>(
      "select c.display_name, i.provider_user_id, i.handle from customers c join customer_identities i on i.customer_id=c.id where c.id=$1",
      [row.customer_id],
    );
    expect(customer.rows).toEqual([
      { display_name: "Sokha", provider_user_id: "555001", handle: "sokha" },
    ]);
  });

  it("a redelivered update returns the same row; a conflicting one is stale_state", async () => {
    const again = await inbound(connectionId, 1, "តើមានទំហំ M ទេ?");
    const count = await db.query<{ n: number }>(
      "select count(*)::int n from messages where conversation_id=$1",
      [again.conversation_id],
    );
    expect(count.rows[0]!.n).toBe(1);
    // The same update id is the same update: its replay returns the stored row.
    const replay = await inbound(connectionId, 1, "edited");
    expect(replay.id).toBe(again.id);
    expect(replay.body).toBe("តើមានទំហំ M ទេ?");
    // A DIFFERENT update carrying the same message with other content is refused.
    expect(await errorOf(inbound(connectionId, 1, "edited", { update: "100001" }))).toContain(
      "stale_state",
    );
  });

  it("records the webhook replay receipt in the same transaction as the message", async () => {
    await inbound(connectionId, 40, "receipt check", { update: "9040" });
    const receipt = await db.query(
      "select 1 from webhook_event_receipts where provider='telegram' and event_id=$1",
      [`${connectionId}:9040`],
    );
    expect(receipt.rows).toHaveLength(1);

    // A rolled-back ingest (the process dies before COMMIT) leaves neither the
    // message nor the receipt, so Telegram's retry is processed.
    await db.exec("begin");
    await inbound(connectionId, 41, "lost?", { update: "9041" });
    await db.exec("rollback");
    const none = await db.query(
      "select 1 from webhook_event_receipts where provider='telegram' and event_id=$1",
      [`${connectionId}:9041`],
    );
    expect(none.rows).toHaveLength(0);
    const retried = await inbound(connectionId, 41, "lost?", { update: "9041" });
    expect(retried.body).toBe("lost?");
    // A refused ingest commits no receipt either.
    expect(
      await errorOf(inbound(connectionId, 42, "x", { chat: "abc", update: "9042" })),
    ).toContain("invalid_reference");
    const refused = await db.query(
      "select 1 from webhook_event_receipts where provider='telegram' and event_id=$1",
      [`${connectionId}:9042`],
    );
    expect(refused.rows).toHaveLength(0);
    expect(await errorOf(inbound(connectionId, 43, "x", { update: "not-a-number" }))).toContain(
      "invalid_reference",
    );
  });

  it("the next message reuses the Customer and the conversation", async () => {
    const second = await inbound(connectionId, 2, "Price?");
    const first = await db.query<{ conversation_id: string }>(
      "select conversation_id from messages where provider_message_id='tg:1'",
    );
    expect(second.conversation_id).toBe(first.rows[0]!.conversation_id);
    const customers = await db.query<{ n: number }>(
      "select count(*)::int n from customer_identities where provider='TELEGRAM' and provider_user_id='555001'",
    );
    expect(customers.rows[0]!.n).toBe(1);
  });

  it("concurrent first messages from a new sender create exactly one Customer", async () => {
    const who = { chat: "555002", sender: "555002", name: "Dara", handle: "" };
    await Promise.all([
      inbound(connectionId, 10, "hi", who),
      inbound(connectionId, 11, "hello", who),
      inbound(connectionId, 12, "anyone?", who),
    ]);
    const rows = await db.query<{ n: number }>(
      "select count(*)::int n from customers c join customer_identities i on i.customer_id=c.id where i.provider_user_id='555002'",
    );
    expect(rows.rows[0]!.n).toBe(1);
    const orphans = await db.query<{ n: number }>(
      "select count(*)::int n from customers c where c.display_name='Dara' and not exists (select 1 from customer_identities i where i.customer_id=c.id)",
    );
    expect(orphans.rows[0]!.n).toBe(0);
  });

  it("a customer writing again reopens a closed thread", async () => {
    const m = await inbound(connectionId, 3, "still there?");
    await db.query("update conversations set status='closed' where id=$1", [m.conversation_id]);
    await inbound(connectionId, 4, "hello?");
    const status = await db.query<{ status: string }>(
      "select status from conversations where id=$1",
      [m.conversation_id],
    );
    expect(status.rows[0]!.status).toBe("needs_reply");
  });

  it("refuses malformed references and a disconnected or unknown connection", async () => {
    expect(await errorOf(inbound(connectionId, 5, "x", { chat: "abc" }))).toContain(
      "invalid_reference",
    );
    expect(await errorOf(inbound(crypto.randomUUID(), 6, "x"))).toContain("connection_not_found");
    const dead = await db.query<{ id: string }>(
      "select id from channel_connections where status='disconnected' limit 1",
    );
    expect(await errorOf(inbound(dead.rows[0]!.id, 7, "x"))).toContain("connection_not_found");
  });
});

describe("begin / complete_outbound_message", () => {
  let conversationId: string;
  let connectionId: string;

  beforeAll(async () => {
    const row = await db.query<{ id: string; c: string }>(
      `select cv.id, cc.id c from conversations cv join channel_connections cc
       on cc.external_account_id=$1 where cv.provider_conversation_id=$2`,
      [BOT, `tg:${BOT}:555001`],
    );
    conversationId = row.rows[0]!.id;
    connectionId = row.rows[0]!.c;
  });

  async function begin(key: string, body = "Yes, size M is in stock", tenant = org, actor = owner) {
    const result = await db.query<{ r: Row }>(
      "select begin_outbound_message($1,$2,$3,$4,$5) as r",
      [tenant, conversationId, actor, key, body],
    );
    return result.rows[0]!.r as {
      message: Row;
      should_send: boolean;
      attempt: string | null;
      connection_id: string;
      chat_id: string;
    };
  }

  function complete(
    messageId: unknown,
    attempt: string | null,
    outcome: { sent: true; ref: string } | { sent: false; error: string },
  ) {
    return call("complete_outbound_message", [
      org,
      messageId,
      connectionId,
      attempt,
      outcome.sent,
      outcome.sent ? outcome.ref : null,
      outcome.sent ? null : outcome.error,
    ]);
  }

  /** Age a reply past the 2-minute sweep and run the sweep. */
  async function sweep(messageId: unknown) {
    await db.query(
      `update messages set metadata = metadata || jsonb_build_object('sending_since', now() - interval '3 minutes') where id = $1`,
      [messageId],
    );
    await db.query("select fail_stuck_outbound_messages($1,$2)", [org, conversationId]);
  }

  async function stored(messageId: unknown): Promise<Row> {
    const r = await db.query<Row>("select state, metadata from messages where id=$1", [messageId]);
    return r.rows[0]!;
  }

  it("exactly one caller is told to send; the reply is recorded as staff-attributed", async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all([begin(key), begin(key), begin(key)]);
    expect(results.filter((r) => r.should_send)).toHaveLength(1);
    const first = results[0]!;
    expect(first.chat_id).toBe("555001");
    expect(first.connection_id).toBe(connectionId);
    expect(first.message).toMatchObject({
      direction: "outbound",
      sender_type: "staff",
      sender_user_id: owner,
      state: "sending",
      provider_message_id: `apsa:${key}`,
    });
  });

  it("a sent reply is never sent again; a failed one may be retried", async () => {
    const key = crypto.randomUUID();
    const started = await begin(key);
    expect(started.should_send).toBe(true);
    expect(started.attempt).toMatch(/^[0-9a-f-]{36}$/);
    await complete(started.message.id, started.attempt, { sent: false, error: "provider_timeout" });
    const retry = await begin(key);
    expect(retry.should_send).toBe(true);
    expect(retry.attempt).not.toBe(started.attempt);
    const sent = await complete(started.message.id, retry.attempt, { sent: true, ref: "991" });
    expect(sent).toMatchObject({ state: "sent" });
    expect((sent.metadata as Row).telegram_message_id).toBe("991");
    const replay = await begin(key);
    expect(replay.should_send).toBe(false);
    expect(replay.attempt).toBeNull();
    // Negative controls: an attempt this message never issued, and a missing
    // attempt, are refused — a completion cannot be forged or misdirected.
    expect(
      await errorOf(complete(started.message.id, crypto.randomUUID(), { sent: true, ref: "992" })),
    ).toContain("stale_state");
    expect(await errorOf(complete(started.message.id, null, { sent: true, ref: "992" }))).toContain(
      "invalid_reference",
    );
    // Another reply's attempt cannot complete this one.
    const other = await begin(crypto.randomUUID(), "another reply");
    expect(
      await errorOf(complete(started.message.id, other.attempt, { sent: true, ref: "992" })),
    ).toContain("stale_state");
    const health = await db.query<Row>(
      "select last_outbound_at, last_error_code from channel_connections where id=$1",
      [connectionId],
    );
    expect(health.rows[0]!.last_outbound_at).toBeTruthy();
    expect(health.rows[0]!.last_error_code).toBe("provider_timeout");
  });

  it("a reply stuck in 'sending' over 2 minutes is failed as send_stuck and may be retried", async () => {
    const fresh = await begin(crypto.randomUUID(), "still sending");
    const key = crypto.randomUUID();
    const stuck = await begin(key, "stuck reply");
    expect(stuck.message.metadata as Row).toHaveProperty("sending_since");
    await db.query(
      `update messages set metadata = metadata || jsonb_build_object('sending_since', now() - interval '3 minutes') where id = $1`,
      [stuck.message.id],
    );
    const swept = await db.query<{ n: number }>("select fail_stuck_outbound_messages($1,$2) as n", [
      org,
      conversationId,
    ]);
    expect(swept.rows[0]!.n).toBe(1);
    const rows = await db.query<Row>(
      "select id, state, metadata from messages where id = any($1)",
      [[stuck.message.id, fresh.message.id]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(stuck.message.id)).toMatchObject({ state: "failed" });
    expect((byId.get(stuck.message.id)!.metadata as Row).send_error).toBe("send_stuck");
    expect(byId.get(fresh.message.id)).toMatchObject({ state: "sending" });
    // Another tenant cannot sweep this conversation.
    const other = await db.query<{ n: number }>("select fail_stuck_outbound_messages($1,$2) as n", [
      orgB,
      conversationId,
    ]);
    expect(other.rows[0]!.n).toBe(0);

    // The retry button re-sends under the same key; send_error is cleared.
    const retry = await begin(key, "stuck reply");
    expect(retry.should_send).toBe(true);
    expect(retry.message).toMatchObject({ state: "sending" });
    expect(retry.message.metadata as Row).not.toHaveProperty("send_error");
  });

  it("a send that finishes after it was marked send_stuck still records the truth", async () => {
    const stuck = await begin(crypto.randomUUID(), "late reply");
    await sweep(stuck.message.id);
    const late = await complete(stuck.message.id, stuck.attempt, { sent: true, ref: "993" });
    expect(late).toMatchObject({ state: "sent" });
  });

  describe("attempt binding after a sweep and a retry", () => {
    /** Attempt A swept as send_stuck, then retried as attempt B (now 'sending'). */
    async function sweptAndRetried(body: string) {
      const key = crypto.randomUUID();
      const a = await begin(key, body);
      await sweep(a.message.id);
      const b = await begin(key, body);
      expect(b.should_send).toBe(true);
      expect(b.attempt).not.toBe(a.attempt);
      return { id: a.message.id, a: a.attempt, b: b.attempt };
    }

    it("late A success, then B success: sent, both deliveries recorded", async () => {
      const r = await sweptAndRetried("order 1");
      const mid = await complete(r.id, r.a, { sent: true, ref: "1001" });
      // B is still in flight: A's success is remembered, B decides.
      expect(mid).toMatchObject({ state: "sending" });
      const done = await complete(r.id, r.b, { sent: true, ref: "1002" });
      expect(done).toMatchObject({ state: "sent" });
      expect((done.metadata as Row).delivered_refs).toEqual(["1001", "1002"]);
    });

    it("late A success, then B failure: still sent — A reached the customer", async () => {
      const r = await sweptAndRetried("order 2");
      await complete(r.id, r.a, { sent: true, ref: "1011" });
      const done = await complete(r.id, r.b, { sent: false, error: "blocked_by_user" });
      expect(done).toMatchObject({ state: "sent" });
      expect((done.metadata as Row).telegram_message_id).toBe("1011");
      expect(done.metadata as Row).not.toHaveProperty("send_error");
    });

    it("late A failure, then B success: A's failure changes nothing", async () => {
      const r = await sweptAndRetried("order 3");
      const mid = await complete(r.id, r.a, { sent: false, error: "provider_unavailable" });
      expect(mid).toMatchObject({ state: "sending" });
      expect(mid.metadata as Row).not.toHaveProperty("send_error");
      const done = await complete(r.id, r.b, { sent: true, ref: "1021" });
      expect(done).toMatchObject({ state: "sent" });
    });

    it("late A failure, then B failure: failed with B's reason", async () => {
      const r = await sweptAndRetried("order 4");
      await complete(r.id, r.a, { sent: false, error: "provider_unavailable" });
      const done = await complete(r.id, r.b, { sent: false, error: "blocked_by_user" });
      expect(done).toMatchObject({ state: "failed" });
      expect((done.metadata as Row).send_error).toBe("blocked_by_user");
    });

    it("B success, then late A success: sent stays, the duplicate is recorded", async () => {
      const r = await sweptAndRetried("order 5");
      await complete(r.id, r.b, { sent: true, ref: "1041" });
      const late = await complete(r.id, r.a, { sent: true, ref: "1040" });
      expect(late).toMatchObject({ state: "sent" });
      expect((late.metadata as Row).telegram_message_id).toBe("1041");
      expect((late.metadata as Row).delivered_refs).toEqual(["1041", "1040"]);
    });

    it("B success, then late A failure: sent stays", async () => {
      const r = await sweptAndRetried("order 6");
      await complete(r.id, r.b, { sent: true, ref: "1051" });
      const late = await complete(r.id, r.a, { sent: false, error: "provider_unavailable" });
      expect(late).toMatchObject({ state: "sent" });
      expect(late.metadata as Row).not.toHaveProperty("send_error");
    });

    it("B failure, then late A success: becomes sent — the customer has it", async () => {
      const r = await sweptAndRetried("order 7");
      await complete(r.id, r.b, { sent: false, error: "provider_unavailable" });
      const late = await complete(r.id, r.a, { sent: true, ref: "1060" });
      expect(late).toMatchObject({ state: "sent" });
      expect((late.metadata as Row).telegram_message_id).toBe("1060");
    });

    it("B failure, then late A failure: B's failure stands", async () => {
      const r = await sweptAndRetried("order 8");
      await complete(r.id, r.b, { sent: false, error: "blocked_by_user" });
      const late = await complete(r.id, r.a, { sent: false, error: "provider_unavailable" });
      expect(late).toMatchObject({ state: "failed" });
      expect((late.metadata as Row).send_error).toBe("blocked_by_user");
    });

    it("a sweep of B after A's late success records sent, not send_stuck", async () => {
      const r = await sweptAndRetried("order 9");
      await complete(r.id, r.a, { sent: true, ref: "1080" });
      await sweep(r.id);
      expect(await stored(r.id)).toMatchObject({ state: "sent" });
    });
  });

  it("the same key with a different body is stale_state", async () => {
    const key = crypto.randomUUID();
    await begin(key, "first");
    expect(await errorOf(begin(key, "second"))).toContain("stale_state");
  });

  it("tenant, membership and channel are enforced", async () => {
    expect(await errorOf(begin(crypto.randomUUID(), "x", orgB, ownerB))).toContain(
      "conversation_not_found",
    );
    expect(await errorOf(begin(crypto.randomUUID(), "x", org, outsider))).toContain(
      "permission_denied",
    );
    expect(await errorOf(begin(crypto.randomUUID(), "   "))).toContain("invalid_reference");
    const fb = await db.query<{ id: string }>(
      "insert into conversations(organization_id,provider,provider_conversation_id) values($1,'FACEBOOK','fb-1') returning id",
      [org],
    );
    expect(
      await errorOf(
        db.query("select begin_outbound_message($1,$2,$3,$4,'x')", [
          org,
          fb.rows[0]!.id,
          owner,
          crypto.randomUUID(),
        ]),
      ),
    ).toContain("channel_unavailable");
  });
});

describe("browser roles", () => {
  it("cannot read channel_connections or execute any 064 function", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      try {
        expect(await errorOf(db.query("select * from channel_connections"))).toContain(
          "permission denied",
        );
        expect(
          await errorOf(
            db.query(
              "select ingest_telegram_inbound($1,'1','1','a','a','tg:1','x','text',now(),null,'1')",
              [crypto.randomUUID()],
            ),
          ),
        ).toContain("permission denied");
        expect(
          await errorOf(
            db.query("select begin_outbound_message($1,$1,$1,$1,'x')", [crypto.randomUUID()]),
          ),
        ).toContain("permission denied");
        expect(
          await errorOf(
            db.query("select fail_stuck_outbound_messages($1,$1)", [crypto.randomUUID()]),
          ),
        ).toContain("permission denied");
        expect(
          await errorOf(db.query("select finish_channel_connect($1,$1,$1)", [crypto.randomUUID()])),
        ).toContain("permission denied");
        expect(
          await errorOf(
            db.query("select abort_channel_connect($1,$1,$1,$1)", [crypto.randomUUID()]),
          ),
        ).toContain("permission denied");
      } finally {
        await db.exec("reset role");
      }
    }
  });

  it("service_role can read connections but never delete them", async () => {
    await db.exec("set role service_role");
    try {
      const rows = await db.query("select id from channel_connections");
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(await errorOf(db.query("delete from channel_connections"))).toContain(
        "permission denied",
      );
    } finally {
      await db.exec("reset role");
    }
  });
});

describe("integrations.* vocabulary", () => {
  it("matches PERMISSIONS_MATRIX §25 for the system roles", async () => {
    const rows = await db.query<{ system_role: string; key: string }>(
      `select r.system_role, p.key from role_permissions rp
       join roles r on r.id=rp.role_id and r.organization_id is null
       join permissions p on p.id=rp.permission_id where p.key like 'integrations.%'
       order by r.system_role::text, p.key`,
    );
    expect(rows.rows).toEqual([
      { system_role: "MANAGER", key: "integrations.read" },
      { system_role: "MANAGER", key: "integrations.view_health" },
      { system_role: "OWNER", key: "integrations.connect" },
      { system_role: "OWNER", key: "integrations.disconnect" },
      { system_role: "OWNER", key: "integrations.read" },
      { system_role: "OWNER", key: "integrations.view_health" },
    ]);
  });
});
