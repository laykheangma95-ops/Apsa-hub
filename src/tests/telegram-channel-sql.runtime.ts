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
 *   - bot operation lease (064 §2): one Telegram-side operation per bot —
 *     an overlapping connect OR disconnect is refused connect_in_progress;
 *     a connection is 'connected' only when settled 'verified' for its own
 *     webhook generation; a superseded operation can neither verify nor
 *     disconnect the newer connect; an unknown outcome keeps the bot in
 *     doubt (5 min) and the connection 'webhook_unverified'; a disconnect is
 *     bound to its own lease and connection; observe_channel_webhook confirms
 *     the current generation and flags an older one as a mismatch;
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
import {
  RECONCILE_BATCH_LIMIT,
  RECONCILE_CHECK_INTERVAL_MS,
  RECONCILE_CLAIM_MS,
  RECONCILE_RUN_INTERVAL_MS,
  backlogRuns,
  reconcileBackoffMs,
  steadyStateCheckIntervalMs,
} from "../server/channels/reconcile-timing";

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

function begin(
  tenant: string,
  actor: string,
  kind: "connect" | "disconnect" | "repair",
  bot: string,
  operation: string,
  connection: string | null = null,
) {
  return db.query("select begin_channel_operation($1,$2,'TELEGRAM',$3,$4,$5,$6)", [
    tenant,
    actor,
    bot,
    kind,
    operation,
    connection,
  ]);
}

/** The connection id a connect derives its secret for: the tenant's live row of the bot, or a fresh id. */
async function connectionIdFor(tenant: string, bot: string): Promise<string> {
  const live = await db.query<{ id: string }>(
    "select id from channel_connections where external_account_id=$1 and organization_id=$2 and status <> 'disconnected'",
    [bot, tenant],
  );
  return live.rows[0]?.id ?? crypto.randomUUID();
}

async function startConnect(
  tenant: string,
  actor: string,
  bot = BOT,
  hash = HASH,
  operation: string = crypto.randomUUID(),
  generation: string = crypto.randomUUID(),
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
    await connectionIdFor(tenant, bot),
    generation,
    operation,
  ]);
}

function settle(
  tenant: string,
  actor: string,
  operation: string,
  connection: unknown,
  generation: unknown,
  outcome: "verified" | "refused" | "unknown" | "done",
) {
  return call("settle_channel_operation", [
    tenant,
    actor,
    operation,
    connection,
    generation,
    outcome,
  ]) as Promise<{ held: boolean; current: boolean; connection: Row | null }>;
}

async function stored(id: unknown): Promise<Row> {
  return (await db.query<Row>("select * from channel_connections where id=$1", [id])).rows[0]!;
}

/** A whole successful connect: lease → write → Telegram SEEN holding it → settle 'verified'. */
async function connect(tenant: string, actor: string, bot = BOT, hash = HASH): Promise<Row> {
  const operation = crypto.randomUUID();
  const generation = crypto.randomUUID();
  await begin(tenant, actor, "connect", bot, operation);
  const row = await startConnect(tenant, actor, bot, hash, operation, generation);
  await settle(tenant, actor, operation, row.id, generation, "verified");
  return stored(row.id);
}

/** A whole disconnect: lease → clear the row → (deleteWebhook answered) → settle 'done'. */
async function disconnect(tenant: string, actor: string, id: unknown): Promise<Row> {
  const operation = crypto.randomUUID();
  const bot = (await stored(id)).external_account_id as string;
  await begin(tenant, actor, "disconnect", bot, operation, id as string);
  const row = await call("disconnect_channel_account", [tenant, actor, id, operation]);
  await settle(tenant, actor, operation, null, null, "done");
  return row;
}

/** Stand in for time passing: every live lease on `bot` lapses. */
function expireLeases(bot: string) {
  return db.query(
    "update channel_bot_operations set expires_at = now() - interval '1 second' where external_account_id=$1",
    [bot],
  );
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
    const gone = await disconnect(org, owner, other.id);
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
      await errorOf(
        call("disconnect_channel_account", [orgB, ownerB, connectionId, crypto.randomUUID()]),
      ),
    ).toContain("connection_not_found");
    expect(
      await errorOf(begin(orgB, ownerB, "disconnect", BOT, crypto.randomUUID(), connectionId)),
    ).toContain("connection_not_found");
    // The freed bot can now be connected elsewhere.
    const taken = await connect(orgB, ownerB, "7000000002");
    expect(taken.organization_id).toBe(orgB);
  });
});

describe("bot operation lease (064 §2)", () => {
  const LEASE_BOT = "7000000077";

  it("an overlapping connect is refused while the first holds the bot; it is not 'connected' before Telegram is seen", async () => {
    const opA = crypto.randomUUID();
    const genA = crypto.randomUUID();
    await begin(org, owner, "connect", LEASE_BOT, opA);
    const a = await startConnect(org, owner, LEASE_BOT, "c".repeat(64), opA, genA);
    expect(a).toMatchObject({ status: "error", last_error_code: "webhook_pending" });
    expect(await errorOf(begin(org, owner, "connect", LEASE_BOT, crypto.randomUUID()))).toContain(
      "connect_in_progress",
    );
    // A connect write without its own lease is refused too.
    expect(
      await errorOf(startConnect(org, owner, LEASE_BOT, "d".repeat(64), crypto.randomUUID())),
    ).toContain("connect_superseded");
    expect(await stored(a.id)).toMatchObject({ webhook_secret_hash: "c".repeat(64) });

    const done = await settle(org, owner, opA, a.id, genA, "verified");
    expect(done).toMatchObject({ held: true, current: true });
    expect(done.connection).toMatchObject({ status: "connected", last_error_code: null });
    expect(JSON.stringify(done.connection)).not.toContain(CIPHER);
    expect(JSON.stringify(done.connection)).not.toContain("c".repeat(64));
    // Released: the next connect rotates in place with a new generation.
    const b = await connect(org, owner, LEASE_BOT, "d".repeat(64));
    expect(b.id).toBe(a.id);
    expect(b.webhook_generation).not.toBe(genA);
    expect(Number(b.connect_generation)).toBe(Number(a.connect_generation) + 1);
  });

  it("a superseded (expired) connect can neither verify nor disconnect the newer connect", async () => {
    const opOld = crypto.randomUUID();
    const genOld = crypto.randomUUID();
    await begin(org, owner, "connect", LEASE_BOT, opOld);
    const old = await startConnect(org, owner, LEASE_BOT, "e".repeat(64), opOld, genOld);
    await expireLeases(LEASE_BOT);
    const opNew = crypto.randomUUID();
    const genNew = crypto.randomUUID();
    await begin(org, owner, "connect", LEASE_BOT, opNew);
    await startConnect(org, owner, LEASE_BOT, "f".repeat(64), opNew, genNew);

    for (const outcome of ["refused", "verified", "unknown"] as const) {
      const late = await settle(org, owner, opOld, old.id, genOld, outcome);
      expect(late).toMatchObject({ held: false, current: false });
    }
    expect(await stored(old.id)).toMatchObject({
      status: "error",
      last_error_code: "webhook_pending",
      webhook_secret_hash: "f".repeat(64),
      webhook_generation: genNew,
    });
    // Even the holder cannot verify a generation the row no longer carries.
    const wrongGen = await call("settle_channel_operation", [
      org,
      owner,
      opNew,
      old.id,
      genOld,
      "unknown",
    ]);
    expect(wrongGen).toMatchObject({ held: true, current: false });
    await expireLeases(LEASE_BOT);
    const opFinal = crypto.randomUUID();
    await begin(org, owner, "connect", LEASE_BOT, opFinal);
    await settle(org, owner, opFinal, null, null, "done");
  });

  it("the holder's refused connect disconnects its own row, audited; negative controls change nothing", async () => {
    const bot = "7000000078";
    const op = crypto.randomUUID();
    const gen = crypto.randomUUID();
    await begin(org, owner, "connect", bot, op);
    const row = await startConnect(org, owner, bot, "1".repeat(64), op, gen);
    expect(await settle(orgB, ownerB, op, row.id, gen, "refused")).toMatchObject({ held: false });
    expect(await errorOf(settle(org, outsider, op, row.id, gen, "refused"))).toContain(
      "permission_denied",
    );
    expect(await settle(org, owner, crypto.randomUUID(), row.id, gen, "refused")).toMatchObject({
      held: false,
    });
    expect((await stored(row.id)).status).toBe("error");

    const failed = await settle(org, owner, op, row.id, gen, "refused");
    expect(failed).toMatchObject({ held: true, current: true });
    expect(await stored(row.id)).toMatchObject({
      status: "disconnected",
      webhook_secret_hash: null,
    });
    const audit = await db.query<{ after_json: Row }>(
      "select after_json from audit_logs where resource_id=$1 and action='integrations.disconnect'",
      [row.id],
    );
    expect(audit.rows[0]!.after_json).toMatchObject({ reason: "connect_failed" });
  });

  it("an unknown outcome keeps the bot in doubt and the connection unverified", async () => {
    const bot = "7000000081";
    const op = crypto.randomUUID();
    const gen = crypto.randomUUID();
    await begin(org, owner, "connect", bot, op);
    const row = await startConnect(org, owner, bot, "4".repeat(64), op, gen);
    await settle(org, owner, op, row.id, gen, "unknown");
    expect(await stored(row.id)).toMatchObject({
      status: "error",
      last_error_code: "webhook_unverified",
    });
    const lease = await db.query<{ in_doubt: boolean; left: number }>(
      "select in_doubt, extract(epoch from expires_at - now())::int as left from channel_bot_operations where operation_id=$1",
      [op],
    );
    expect(lease.rows[0]!.in_doubt).toBe(true);
    expect(lease.rows[0]!.left).toBeGreaterThan(240);
    // Neither a reconnect nor a disconnect may touch the bot meanwhile.
    expect(await errorOf(begin(org, owner, "connect", bot, crypto.randomUUID()))).toContain(
      "connect_in_progress",
    );
    expect(
      await errorOf(begin(org, owner, "disconnect", bot, crypto.randomUUID(), row.id as string)),
    ).toContain("connect_in_progress");
    // After the window, the next connect proceeds (and must verify for itself).
    await expireLeases(bot);
    const next = await connect(org, owner, bot, "5".repeat(64));
    expect(next).toMatchObject({ id: row.id, status: "connected" });
  });

  it("a disconnect holds the bot until its deleteWebhook is settled; it is bound to its own connection", async () => {
    const bot = "7000000082";
    const row = await connect(org, owner, bot, "6".repeat(64));
    const op = crypto.randomUUID();
    // Without its lease (or with a lease for another connection) nothing is cleared.
    expect(await errorOf(call("disconnect_channel_account", [org, owner, row.id, op]))).toContain(
      "connect_superseded",
    );
    await begin(org, owner, "disconnect", bot, op, row.id as string);
    const gone = await call("disconnect_channel_account", [org, owner, row.id, op]);
    expect(gone).toMatchObject({ status: "disconnected", webhook_generation: null });
    // deleteWebhook still in flight: a reconnect must wait.
    expect(await errorOf(begin(org, owner, "connect", bot, crypto.randomUUID()))).toContain(
      "connect_in_progress",
    );
    // Its answer never came: in doubt.
    await settle(org, owner, op, null, null, "unknown");
    expect(await errorOf(begin(org, owner, "connect", bot, crypto.randomUUID()))).toContain(
      "connect_in_progress",
    );
    await expireLeases(bot);
    const again = await connect(org, owner, bot, "7".repeat(64));
    expect(again.id).not.toBe(row.id);
    expect(again.status).toBe("connected");
    // The old disconnect, answering late, cannot touch the new row.
    expect(await settle(org, owner, op, null, null, "done")).toMatchObject({ held: false });
    expect(await errorOf(call("disconnect_channel_account", [org, owner, again.id, op]))).toContain(
      "connect_superseded",
    );
    expect((await stored(again.id)).status).toBe("connected");
  });

  it("observe_channel_webhook: the current generation confirms, an older one flags a mismatch", async () => {
    const bot = "7000000083";
    const op = crypto.randomUUID();
    const gen = crypto.randomUUID();
    await begin(org, owner, "connect", bot, op);
    const row = await startConnect(org, owner, bot, "8".repeat(64), op, gen);
    // While the operation is in flight, evidence changes nothing.
    await db.query("select observe_channel_webhook($1,$2)", [row.id, gen]);
    expect((await stored(row.id)).last_error_code).toBe("webhook_pending");
    await settle(org, owner, op, row.id, gen, "unknown");
    await expireLeases(bot);
    // A delivery on the current generation proves Telegram holds it.
    await db.query("select observe_channel_webhook($1,$2)", [row.id, gen]);
    expect(await stored(row.id)).toMatchObject({ status: "connected", last_error_code: null });
    // A verified delivery on an OLDER generation proves Telegram disagrees.
    await db.query("select observe_channel_webhook($1,$2)", [row.id, crypto.randomUUID()]);
    expect(await stored(row.id)).toMatchObject({
      status: "error",
      last_error_code: "webhook_mismatch",
    });
    // An ordinary inbound message does not clear it.
    await call("ingest_telegram_inbound", [
      row.id,
      "640099",
      "640099",
      "Obs",
      "obs",
      "tg:880099",
      "hi",
      "text",
      "2026-10-20T03:00:00Z",
      null,
      "880099",
    ]);
    expect((await stored(row.id)).last_error_code).toBe("webhook_mismatch");
    await db.query("select observe_channel_webhook($1,$2)", [row.id, gen]);
    expect((await stored(row.id)).status).toBe("connected");
  });

  it("settle is tenant-bound", async () => {
    const bot = "7000000080";
    const op = crypto.randomUUID();
    const gen = crypto.randomUUID();
    await begin(org, owner, "connect", bot, op);
    const row = await startConnect(org, owner, bot, "3".repeat(64), op, gen);
    expect(await settle(orgB, ownerB, op, row.id, gen, "verified")).toMatchObject({
      held: false,
    });
    expect((await stored(row.id)).status).toBe("error");
    await settle(org, owner, op, row.id, gen, "verified");
    expect((await stored(row.id)).status).toBe("connected");
  });
});

describe("reconciliation state (064 §2a)", () => {
  const RBOT = "7000000090";

  /** Claim the row as a run would, then record under that claim. */
  async function claim(id: unknown): Promise<string> {
    return (
      await db.query<{ c: string }>(
        `update channel_connections set reconcile_claim = gen_random_uuid(),
           reconcile_claimed_until = now() + interval '2 minutes' where id = $1
         returning reconcile_claim c`,
        [id],
      )
    ).rows[0]!.c;
  }
  async function record(id: unknown, generation: unknown, result: string) {
    return call("record_channel_reconcile", [
      id,
      generation,
      await claim(id),
      result,
    ]) as Promise<Row>;
  }
  async function dueIn(id: unknown): Promise<number> {
    return (
      await db.query<{ s: number }>(
        "select extract(epoch from next_reconcile_at - now())::int s from channel_connections where id=$1",
        [id],
      )
    ).rows[0]!.s;
  }

  it("'acknowledged' is known but not seen: lease released, not connected, due at once", async () => {
    const op = crypto.randomUUID();
    const gen = crypto.randomUUID();
    await begin(org, owner, "connect", RBOT, op);
    const row = await startConnect(org, owner, RBOT, "9".repeat(64), op, gen);
    const settled = await settle(org, owner, op, row.id, gen, "acknowledged");
    expect(settled).toMatchObject({ held: true, current: true });
    expect(await stored(row.id)).toMatchObject({
      status: "error",
      last_error_code: "webhook_unverified",
      last_verified_at: null,
    });
    expect(await dueIn(row.id)).toBeLessThanOrEqual(0);
    const leases = await db.query("select 1 from channel_bot_operations where operation_id=$1", [
      op,
    ]);
    expect(leases.rows).toHaveLength(0);
    // 'verified' stamps the observation and schedules the next check.
    await connect(org, owner, RBOT, "9".repeat(64));
    const verified = await stored(row.id);
    expect(verified.status).toBe("connected");
    expect(verified.last_verified_at).not.toBeNull();
    expect(await dueIn(row.id)).toBeGreaterThan(14 * 60);
  });

  it("a NULL actor (the server's reconciler) may take and settle only a 'repair' lease", async () => {
    for (const kind of ["connect", "disconnect"] as const) {
      expect(
        await errorOf(begin(org, null as unknown as string, kind, RBOT, crypto.randomUUID())),
      ).toContain("permission_denied");
    }
    const op = crypto.randomUUID();
    await begin(org, null as unknown as string, "repair", RBOT, op);
    await settle(org, null as unknown as string, op, null, null, "done");
    // Negative control: a member's lease cannot be settled by a NULL actor.
    const memberOp = crypto.randomUUID();
    await begin(org, owner, "connect", RBOT, memberOp);
    expect(
      await errorOf(settle(org, null as unknown as string, memberOp, null, null, "done")),
    ).toContain("permission_denied");
    await settle(org, owner, memberOp, null, null, "done");
  });

  it("claim hands each due live row to one run and pushes it 2 minutes out", async () => {
    const live = await db.query<{ id: string }>(
      "update channel_connections set next_reconcile_at = now() - interval '1 second' where status <> 'disconnected' returning id",
    );
    const first = await db.query<{ id: string; credential_ciphertext: string }>(
      "select * from claim_channel_reconcile_batch(100)",
    );
    expect(first.rows.map((r) => r.id).sort()).toEqual(live.rows.map((r) => r.id).sort());
    expect(first.rows[0]!.credential_ciphertext).toBe(CIPHER); // server-side: it must read the token
    const second = await db.query("select * from claim_channel_reconcile_batch(100)");
    expect(second.rows).toHaveLength(0);
    for (const r of first.rows) {
      const due = await dueIn(r.id);
      expect(due).toBeGreaterThan(100);
      expect(due).toBeLessThanOrEqual(120);
    }
    expect(await errorOf(db.query("select * from claim_channel_reconcile_batch(0)"))).toContain(
      "invalid_reference",
    );
  });

  it("record: failures back off and expose state; healthy clears; a stale generation is not recorded", async () => {
    const row = await stored(
      (
        await db.query<{ id: string }>(
          "select id from channel_connections where external_account_id=$1 and status <> 'disconnected'",
          [RBOT],
        )
      ).rows[0]!.id,
    );
    const gen = row.webhook_generation;
    expect(await record(row.id, crypto.randomUUID(), "healthy")).toEqual({
      recorded: false,
      reason: "generation",
    });

    const one = await record(row.id, gen, "unobservable");
    expect(one).toMatchObject({ recorded: true, status: "connected", reconcile_failures: 1 });
    expect(await dueIn(row.id)).toBeGreaterThan(50);
    const two = await record(row.id, gen, "unobservable");
    expect(two.reconcile_failures).toBe(2);
    expect(await dueIn(row.id)).toBeGreaterThan(110);

    const missing = await record(row.id, gen, "missing");
    expect(missing).toMatchObject({ status: "error", last_error_code: "webhook_missing" });
    expect(missing.mismatch_since).not.toBeNull();
    const since = missing.mismatch_since;
    expect((await record(row.id, gen, "mismatch")).mismatch_since).toBe(since);

    // Backoff caps at 60 minutes.
    for (let i = 0; i < 6; i++) await record(row.id, gen, "unobservable");
    expect(await dueIn(row.id)).toBeLessThanOrEqual(3600);
    expect(await dueIn(row.id)).toBeGreaterThan(3500);

    const healthy = await record(row.id, gen, "repaired");
    expect(healthy).toMatchObject({
      status: "connected",
      last_error_code: null,
      reconcile_failures: 0,
      mismatch_since: null,
    });

    // Unobserved for over an hour: the row says not confirmed.
    await db.query(
      "update channel_connections set last_verified_at = now() - interval '61 minutes' where id=$1",
      [row.id],
    );
    expect(await record(row.id, gen, "unobservable")).toMatchObject({
      status: "error",
      last_error_code: "webhook_unverified",
    });

    // Busy: retried in a minute, nothing else changes; a live lease freezes status.
    const before = await stored(row.id);
    expect(await record(row.id, gen, "busy")).toMatchObject({
      reconcile_failures: before.reconcile_failures,
    });
    expect(await dueIn(row.id)).toBeLessThanOrEqual(60);
    const op = crypto.randomUUID();
    await begin(org, owner, "repair", RBOT, op);
    expect((await record(row.id, gen, "healthy")).status).toBe("error");
    await settle(org, owner, op, null, null, "done");
    expect((await record(row.id, gen, "healthy")).status).toBe("connected");
  });
});

describe("reconciliation fence and timing (064 §2a)", () => {
  const FBOT = "7000000091";
  let id: string;
  let gen: string;

  beforeAll(async () => {
    const row = await connect(org, owner, FBOT, "a".repeat(64));
    id = row.id as string;
    gen = row.webhook_generation as string;
  });

  async function claimBatchFor(target: string): Promise<string> {
    await db.query(
      "update channel_connections set next_reconcile_at = now() - interval '1 second' where id=$1",
      [target],
    );
    const rows = await db.query<{ id: string; reconcile_claim: string }>(
      "select id, reconcile_claim from claim_channel_reconcile_batch(100)",
    );
    return rows.rows.find((r) => r.id === target)!.reconcile_claim;
  }
  function recordAs(claimId: string | null, result: string) {
    return call("record_channel_reconcile", [id, gen, claimId, result]);
  }
  async function snapshot() {
    return (
      await db.query<Row>(
        "select status, last_error_code, reconcile_failures, mismatch_since, last_verified_at, next_reconcile_at, reconcile_claim from channel_connections where id=$1",
        [id],
      )
    ).rows[0]!;
  }

  it("each claim is unique and expires after the claim window", async () => {
    const c1 = await claimBatchFor(id);
    const left = await db.query<{ s: number }>(
      "select extract(epoch from reconcile_claimed_until - now())::int s from channel_connections where id=$1",
      [id],
    );
    expect(left.rows[0]!.s * 1000).toBeLessThanOrEqual(RECONCILE_CLAIM_MS);
    expect(left.rows[0]!.s * 1000).toBeGreaterThan(RECONCILE_CLAIM_MS - 5000);
    await db.query(
      "update channel_connections set reconcile_claimed_until = now() - interval '1 second' where id=$1",
      [id],
    );
    const c2 = await claimBatchFor(id);
    expect(c2).not.toBe(c1);
    await recordAs(c2, "healthy");
  });

  for (const result of ["healthy", "unobservable", "missing", "busy", "stale_key"]) {
    it(`a lapsed or replaced claim records nothing ('${result}')`, async () => {
      const old = await claimBatchFor(id);
      // The old run stalls past its claim; a new run claims the row.
      await db.query(
        "update channel_connections set reconcile_claimed_until = now() - interval '1 second' where id=$1",
        [id],
      );
      const before = await snapshot();
      expect(await recordAs(old, result)).toEqual({ recorded: false, reason: "claim" });
      const fresh = await claimBatchFor(id);
      expect(await recordAs(old, result)).toEqual({ recorded: false, reason: "claim" });
      expect(await recordAs(null, result)).toEqual({ recorded: false, reason: "claim" });
      const after = await snapshot();
      for (const k of [
        "status",
        "last_error_code",
        "reconcile_failures",
        "mismatch_since",
        "last_verified_at",
      ]) {
        expect(after[k]).toEqual(before[k]);
      }
      // The owning claim records, once.
      expect((await recordAs(fresh, "healthy")).recorded).toBe(true);
      expect(await recordAs(fresh, "healthy")).toEqual({ recorded: false, reason: "claim" });
    });
  }

  it("stale_key: the connection says the key changed and must be reconnected", async () => {
    const c = await claimBatchFor(id);
    expect(await recordAs(c, "stale_key")).toMatchObject({
      recorded: true,
      status: "error",
      last_error_code: "webhook_key_changed",
    });
    await recordAs(await claimBatchFor(id), "healthy");
  });

  it("backlog: 250 due connections need backlogRuns(250) = 10 full runs (≈50 min), not ~20 min", async () => {
    // 250 more live connections, all due at once.
    await db.query(
      `insert into channel_connections (organization_id, provider, external_account_id, status,
         credential_ciphertext, credential_key_version, webhook_secret_hash, webhook_generation,
         next_reconcile_at)
       select $1, 'TELEGRAM', (8100000000 + g)::text, 'connected', $2, 1, repeat('b', 64),
         gen_random_uuid(), now() - interval '1 second'
       from generate_series(1, 250) g`,
      [org, CIPHER],
    );
    await db.query(
      "update channel_connections set next_reconcile_at = now() + interval '1 day' where external_account_id not like '81%'",
    );
    let runs = 0;
    let claimed = 0;
    for (;;) {
      const batch = await db.query(
        `select id from claim_channel_reconcile_batch(${RECONCILE_BATCH_LIMIT})`,
      );
      if (batch.rows.length === 0) break;
      expect(batch.rows.length).toBeLessThanOrEqual(RECONCILE_BATCH_LIMIT);
      runs += 1;
      claimed += batch.rows.length;
    }
    expect(claimed).toBe(250);
    expect(runs).toBe(backlogRuns(250));
    expect(runs).toBe(10);
    // The last connection is first checked after (runs − 1) further runs.
    expect((runs - 1) * RECONCILE_RUN_INTERVAL_MS).toBe(45 * 60 * 1000);
    // And 250 live connections cannot all be re-checked every 15 minutes.
    expect(steadyStateCheckIntervalMs(250)).toBe(50 * 60 * 1000);
    expect(steadyStateCheckIntervalMs(250)).toBeGreaterThan(RECONCILE_CHECK_INTERVAL_MS);
    expect(steadyStateCheckIntervalMs(75)).toBe(RECONCILE_CHECK_INTERVAL_MS);
    await db.query("delete from channel_connections where external_account_id like '81%'");
  });

  it("outage: the SQL backoff equals reconcileBackoffMs — 1, 2, 4 … 60 min — so recovery can lag an outage by up to 60 min + a run", async () => {
    await db.query("update channel_connections set reconcile_failures = 0 where id=$1", [id]);
    const observed: number[] = [];
    for (let k = 0; k < 9; k++) {
      await recordAs(await claimBatchFor(id), "unobservable");
      const d = await db.query<{ s: number }>(
        "select extract(epoch from next_reconcile_at - now())::int s from channel_connections where id=$1",
        [id],
      );
      observed.push(d.rows[0]!.s);
    }
    const expected = Array.from({ length: 9 }, (_, k) => reconcileBackoffMs(k) / 1000);
    expect(expected).toEqual([60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
    observed.forEach((s, k) => {
      expect(s).toBeLessThanOrEqual(expected[k]!);
      expect(s).toBeGreaterThan(expected[k]! - 5);
    });
    // Telegram comes back right after the 9th failure: the first check that
    // can succeed is up to the capped backoff plus one schedule interval away.
    expect(reconcileBackoffMs(9) + RECONCILE_RUN_INTERVAL_MS).toBe(65 * 60 * 1000);
    await recordAs(await claimBatchFor(id), "healthy");
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
        for (const statement of [
          "select begin_channel_operation($1,$1,'TELEGRAM','1','connect',$1,null)",
          "select settle_channel_operation($1,$1,$1,null,null,'done')",
          "select disconnect_channel_account($1,$1,$1,$1)",
          "select observe_channel_webhook($1,$1)",
          "select * from claim_channel_reconcile_batch(1)",
          "select record_channel_reconcile($1,$1,$1,'healthy')",
          "select * from channel_bot_operations",
        ]) {
          const params = statement.includes("$1") ? [crypto.randomUUID()] : [];
          expect(await errorOf(db.query(statement, params))).toContain("permission denied");
        }
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
