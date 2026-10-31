/**
 * Migration 064's lifecycle guarantees under REAL concurrency, on native
 * PostgreSQL (APSA_TEST_PG_URL — PostgreSQL 17 in CI; any supported server
 * locally). PGlite is single-connection; these proofs need separate sessions
 * racing for the same rows and a backend that actually dies mid-transaction.
 *
 * Every call runs as service_role (SET LOCAL ROLE), the only caller 064
 * grants, so the grants the functions rely on (e.g. INSERT on
 * webhook_event_receipts from the SECURITY INVOKER ingest) are proven too.
 *
 *   - crash: a backend killed after ingesting but before COMMIT leaves neither
 *     message nor receipt; the retry is processed exactly once;
 *   - duplicate deliveries of one update racing on separate connections store
 *     one message and one receipt;
 *   - one Telegram-side operation per bot (064 §2): of overlapping connects
 *     — and of a connect racing a disconnect — exactly one takes the bot's
 *     lease; an in-doubt lease refuses every concurrent operation;
 *   - a superseded connect's settle racing a newer connect that took over
 *     its expired lease never disconnects or verifies the newer connect;
 *   - concurrent reconciliation runs (064 §2a) never claim the same row, and
 *     a run whose claim lapsed never records — old-first, new-first, racing;
 *   - identical reply submissions racing: exactly one is told to send;
 *   - a superseded attempt's late success racing the current attempt's
 *     completion: the reply ends 'sent' with both deliveries recorded,
 *     in every interleaving.
 *
 * Synthetic data only; the throwaway database is dropped afterwards.
 *
 * Run: APSA_TEST_PG_URL=postgres://user@host:port/postgres bun test ./src/tests/telegram-channel-native.runtime.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";

const ADMIN_URL = process.env["APSA_TEST_PG_URL"];
if (!ADMIN_URL) throw new Error("APSA_TEST_PG_URL is required for telegram-channel-native");

const ORG = "aaaaaaaa-0000-4000-8000-000000000064";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000164";
const BOT = "7000006400";
const HASH = "a".repeat(64);
const CIPHER = "v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb";

const dbName = `apsa_064_native_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: SQL;
let sql: SQL;
let dbUrl = "";
let serverVersion = "";
let connectionId = "";
let conversationId = "";

type Row = Record<string, unknown>;

/** One statement as service_role in its own transaction; the SQL error message on failure. */
async function svc(statement: string, params: unknown[] = []): Promise<Row[]> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE service_role");
    return (await tx.unsafe(statement, params as never[])) as Row[];
  })) as Row[];
}
async function outcome(statement: string, params: unknown[] = []): Promise<string> {
  try {
    await svc(statement, params);
    return "ok";
  } catch (error) {
    return String((error as Error).message);
  }
}

/** begin → write → settle 'verified' for `bot`; returns the connection id. */
async function connect(bot: string, hash: string): Promise<string> {
  const op = crypto.randomUUID();
  const generation = crypto.randomUUID();
  await svc("select begin_channel_operation($1,$2,'TELEGRAM',$3,'connect',$4,null)", [
    ORG,
    OWNER,
    bot,
    op,
  ]);
  const id = await writeConnect(bot, hash, op, generation);
  await svc("select settle_channel_operation($1,$2,$3,$4,$5,'verified')", [
    ORG,
    OWNER,
    op,
    id,
    generation,
  ]);
  return id;
}

/** connect_channel_account under `op`, for this org's live row of the bot or a fresh id. */
async function writeConnect(bot: string, hash: string, op: string, generation: string) {
  const live = (await sql`select id from channel_connections where external_account_id = ${bot}
    and organization_id = ${ORG} and status <> 'disconnected'`) as Row[];
  const id = live[0] ? String(live[0]["id"]) : crypto.randomUUID();
  await svc(
    "select connect_channel_account($1,$2,'TELEGRAM',$3,'bot','Bot',$4,1::smallint,$5,$6,$7,$8)",
    [ORG, OWNER, bot, CIPHER, hash, id, generation, op],
  );
  return id;
}

function ingest(update: string, messageId: number, body = "hello") {
  return svc(
    `select (ingest_telegram_inbound($1,'555001','555001','Sokha','sokha',$2,$3,'text','2026-10-20T03:00:00Z',null,$4)).id as id`,
    [connectionId, `tg:${messageId}`, body, update],
  );
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  dbUrl = url.toString();
  sql = new SQL({ url: dbUrl, max: 12 });
  serverVersion = ((await sql`select current_setting('server_version') as v`)[0] as { v: string })
    .v;
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `);
  const migrations = readdirSync("supabase/migrations")
    .filter((n) => /^\d+.*\.sql$/.test(n))
    .sort();
  // Every migration through 064 (and any later one) is applied; 064 must be among them.
  expect(migrations).toContain("064_telegram_channel.sql");
  for (const name of migrations) {
    try {
      await sql.unsafe(readFileSync(`supabase/migrations/${name}`, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${name}: ${String(error)}`);
    }
  }
  await sql`insert into auth.users(id,email) values(${OWNER},'owner064@test.invalid')`;
  await sql`insert into organizations(id,legal_name,display_name,slug,created_by)
    values(${ORG},'T','T','tg-064',${OWNER})`;
  await sql`insert into memberships(organization_id,user_id,role_id,status)
    select ${ORG},${OWNER},id,'active' from roles where system_role='OWNER' and organization_id is null`;

  connectionId = await connect(BOT, HASH);
  const [first] = await svc(
    `select (ingest_telegram_inbound($1,'555001','555001','Sokha','sokha','tg:1','hi','text',now(),null,'1')).conversation_id as conversation_id`,
    [connectionId],
  );
  conversationId = String(first!["conversation_id"]);
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.close();
});

describe("migration 064 on native PostgreSQL", () => {
  it("runs on a real server", () => {
    console.info(`[telegram-channel-native] server_version=${serverVersion}`);
    expect(Number.parseInt(serverVersion, 10)).toBeGreaterThanOrEqual(15);
  });

  it("a backend killed before COMMIT leaves no message and no receipt; the retry is processed once", async () => {
    // A separate single-connection client stands in for the crashing worker.
    const worker = new SQL({ url: dbUrl, max: 1 });
    const [{ pid }] = (await worker`select pg_backend_pid() as pid`) as { pid: number }[];
    await worker.unsafe("BEGIN");
    await worker.unsafe("SET LOCAL ROLE service_role");
    await worker.unsafe(
      `select ingest_telegram_inbound($1,'555001','555001','Sokha','sokha','tg:500','crash','text',now(),null,'9500')`,
      [connectionId] as never[],
    );
    // The process dies here: the backend is terminated mid-transaction.
    await sql`select pg_terminate_backend(${pid})`;
    await worker.close().catch(() => undefined);

    const receipts =
      await sql`select 1 from webhook_event_receipts where event_id = ${`${connectionId}:9500`}`;
    expect(receipts.length).toBe(0);
    const lost = await sql`select 1 from messages where provider_message_id = 'tg:500'`;
    expect(lost.length).toBe(0);

    await ingest("9500", 500, "crash");
    const stored =
      await sql`select count(*)::int n from messages where provider_message_id = 'tg:500'`;
    expect((stored[0] as { n: number }).n).toBe(1);
    const committed =
      await sql`select 1 from webhook_event_receipts where event_id = ${`${connectionId}:9500`}`;
    expect(committed.length).toBe(1);
  });

  it("duplicate deliveries of one update racing on separate connections store one message, one receipt", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ingest("9600", 600, "race")));
    const ids = new Set(results.map((rows) => rows[0]!["id"]));
    expect(ids.size).toBe(1);
    const stored =
      await sql`select count(*)::int n from messages where provider_message_id = 'tg:600'`;
    expect((stored[0] as { n: number }).n).toBe(1);
    const receipts =
      await sql`select count(*)::int n from webhook_event_receipts where event_id = ${`${connectionId}:9600`}`;
    expect((receipts[0] as { n: number }).n).toBe(1);
  });

  it("racing copies of one update with different clocks still resolve to the stored message", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc(
          `select (ingest_telegram_inbound($1,'555001','555001','Sokha','sokha','tg:601','race','text',clock_timestamp(),null,'9601')).id as id`,
          [connectionId],
        ),
      ),
    );
    expect(new Set(results.map((rows) => rows[0]!["id"])).size).toBe(1);
  });

  it("overlapping connects of one bot: exactly one takes the lease", async () => {
    const bot = "7000006401";
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        outcome("select begin_channel_operation($1,$2,'TELEGRAM',$3,'connect',$4,null)", [
          ORG,
          OWNER,
          bot,
          crypto.randomUUID(),
        ]),
      ),
    );
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o.includes("connect_in_progress"))).toHaveLength(7);
    const leases =
      await sql`select count(*)::int n from channel_bot_operations where external_account_id = ${bot}`;
    expect((leases[0] as { n: number }).n).toBe(1);
  });

  it("a connect racing a disconnect of the same bot: exactly one holds it", async () => {
    for (let round = 0; round < 10; round++) {
      const bot = `70000066${String(round).padStart(2, "0")}`;
      const id = await connect(bot, "c".repeat(64));
      const [connectTry, disconnectTry] = await Promise.all([
        outcome("select begin_channel_operation($1,$2,'TELEGRAM',$3,'connect',$4,null)", [
          ORG,
          OWNER,
          bot,
          crypto.randomUUID(),
        ]),
        outcome("select begin_channel_operation($1,$2,'TELEGRAM',$3,'disconnect',$4,$5)", [
          ORG,
          OWNER,
          bot,
          crypto.randomUUID(),
          id,
        ]),
      ]);
      expect([connectTry, disconnectTry].filter((o) => o === "ok")).toHaveLength(1);
      expect(
        [connectTry, disconnectTry].filter((o) => o.includes("connect_in_progress")),
      ).toHaveLength(1);
    }
  });

  it("an in-doubt lease refuses every concurrent operation on the bot", async () => {
    const bot = "7000006402";
    const id = await connect(bot, "d".repeat(64));
    const op = crypto.randomUUID();
    await svc("select begin_channel_operation($1,$2,'TELEGRAM',$3,'disconnect',$4,$5)", [
      ORG,
      OWNER,
      bot,
      op,
      id,
    ]);
    await svc("select disconnect_channel_account($1,$2,$3,$4)", [ORG, OWNER, id, op]);
    await svc("select settle_channel_operation($1,$2,$3,null,null,'unknown')", [ORG, OWNER, op]);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        outcome("select begin_channel_operation($1,$2,'TELEGRAM',$3,$4,$5,null)", [
          ORG,
          OWNER,
          bot,
          i % 2 === 0 ? "connect" : "repair",
          crypto.randomUUID(),
        ]),
      ),
    );
    expect(outcomes.every((o) => o.includes("connect_in_progress"))).toBe(true);
  });

  it("a superseded connect's settle racing a newer takeover never disconnects or verifies the newer connect", async () => {
    for (let round = 0; round < 10; round++) {
      const bot = `70000065${String(round).padStart(2, "0")}`;
      const opOld = crypto.randomUUID();
      const genOld = crypto.randomUUID();
      await svc("select begin_channel_operation($1,$2,'TELEGRAM',$3,'connect',$4,null)", [
        ORG,
        OWNER,
        bot,
        opOld,
      ]);
      const oldId = await writeConnect(bot, "e".repeat(64), opOld, genOld);
      await sql`update channel_bot_operations set expires_at = now() - interval '1 second' where operation_id = ${opOld}`;
      const opNew = crypto.randomUUID();
      const genNew = crypto.randomUUID();
      const takeover = (async () => {
        await svc("select begin_channel_operation($1,$2,'TELEGRAM',$3,'connect',$4,null)", [
          ORG,
          OWNER,
          bot,
          opNew,
        ]);
        return writeConnect(bot, "f".repeat(64), opNew, genNew);
      })();
      const [newId, late] = await Promise.all([
        takeover,
        svc(`select settle_channel_operation($1,$2,$3,$4,$5,$6) as r`, [
          ORG,
          OWNER,
          opOld,
          oldId,
          genOld,
          round % 2 === 0 ? "refused" : "verified",
        ]),
      ]);
      const live = (await sql`select id, status, webhook_generation, webhook_secret_hash
        from channel_connections where external_account_id = ${bot} and status <> 'disconnected'`) as Row[];
      // Whatever the interleaving: exactly one live row, carrying the NEWER
      // generation, not yet 'connected' (the newer operation has not verified).
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: newId,
        status: "error",
        webhook_generation: genNew,
        webhook_secret_hash: "f".repeat(64),
      });
      const r = late[0]!["r"] as { held: boolean };
      // A refused old attempt that still held the bot disconnected only ITS row.
      if (r.held && round % 2 === 0) expect(newId).not.toBe(oldId);
    }
  });

  it("concurrent reconciliation runs never claim the same connection (SKIP LOCKED)", async () => {
    for (let i = 0; i < 6; i++)
      await connect(`70000067${String(i).padStart(2, "0")}`, "b".repeat(64));
    for (let round = 0; round < 5; round++) {
      await sql`update channel_connections set next_reconcile_at = now() - interval '1 second' where status <> 'disconnected'`;
      const due = (
        await sql`select count(*)::int n from channel_connections where status <> 'disconnected'`
      )[0] as { n: number };
      const claims = await Promise.all(
        Array.from({ length: 4 }, () => svc("select id from claim_channel_reconcile_batch(3)")),
      );
      const ids = claims.flat().map((r) => String(r["id"]));
      // Disjoint: no row went to two runs.
      expect(new Set(ids).size).toBe(ids.length);
      // Nothing due was skipped for good: everything claimed or still due.
      const stillDue = (
        await sql`select count(*)::int n from channel_connections
        where status <> 'disconnected' and next_reconcile_at <= now()`
      )[0] as { n: number };
      expect(ids.length + stillDue.n).toBe(due.n);
    }
  });

  it("reconciliation fence: an old worker whose claim lapsed never records, in either completion order", async () => {
    const bot = "7000006800";
    const id = await connect(bot, "c".repeat(64));
    const gen = String(
      ((await sql`select webhook_generation from channel_connections where id = ${id}`)[0] as Row)[
        "webhook_generation"
      ],
    );
    async function claimRow(): Promise<string> {
      await sql`update channel_connections set next_reconcile_at = now() - interval '1 second' where id = ${id}`;
      const rows = await svc("select id, reconcile_claim from claim_channel_reconcile_batch(100)");
      return String(rows.find((r) => String(r["id"]) === id)!["reconcile_claim"]);
    }
    async function lapse() {
      await sql`update channel_connections set reconcile_claimed_until = now() - interval '1 second' where id = ${id}`;
    }
    const record = (claim: string, result: string) =>
      svc("select record_channel_reconcile($1,$2,$3,$4) as r", [id, gen, claim, result]).then(
        (rows) => rows[0]!["r"] as { recorded: boolean; reason?: string },
      );
    async function state() {
      return (
        await sql`select status, last_error_code, reconcile_failures, mismatch_since
        from channel_connections where id = ${id}`
      )[0] as Row;
    }

    // Order 1: old worker completes FIRST (after its claim lapsed), then the new one.
    const old1 = await claimRow();
    await lapse();
    const new1 = await claimRow();
    const before1 = await state();
    expect(await record(old1, "missing")).toEqual({ recorded: false, reason: "claim" });
    expect(await state()).toEqual(before1);
    expect((await record(new1, "healthy")).recorded).toBe(true);
    expect(await state()).toMatchObject({ status: "connected", reconcile_failures: 0 });

    // Order 2: new worker completes FIRST, then the old one.
    const old2 = await claimRow();
    await lapse();
    const new2 = await claimRow();
    expect((await record(new2, "healthy")).recorded).toBe(true);
    const before2 = await state();
    expect(await record(old2, "unobservable")).toEqual({ recorded: false, reason: "claim" });
    expect(await state()).toEqual(before2);

    // Both at once, on separate sessions: only the owning claim records.
    for (let round = 0; round < 10; round++) {
      const old = await claimRow();
      await lapse();
      const fresh = await claimRow();
      const [a, b] = await Promise.all([record(old, "mismatch"), record(fresh, "healthy")]);
      expect(a).toEqual({ recorded: false, reason: "claim" });
      expect(b.recorded).toBe(true);
      expect(await state()).toMatchObject({
        status: "connected",
        last_error_code: null,
        reconcile_failures: 0,
        mismatch_since: null,
      });
    }
  });

  it("identical reply submissions racing: exactly one is told to send", async () => {
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc("select begin_outbound_message($1,$2,$3,$4,'In stock') as r", [
          ORG,
          conversationId,
          OWNER,
          key,
        ]),
      ),
    );
    const claims = results.map((rows) => rows[0]!["r"] as Row);
    expect(claims.filter((c) => c["should_send"] === true)).toHaveLength(1);
    expect(new Set(claims.map((c) => (c["message"] as Row)["id"])).size).toBe(1);
  });

  it("a superseded attempt's late success racing the current attempt's completion ends 'sent', both recorded", async () => {
    for (const currentOutcome of ["sent", "failed"] as const) {
      for (let round = 0; round < 5; round++) {
        const key = crypto.randomUUID();
        const [a] = await svc("select begin_outbound_message($1,$2,$3,$4,$5) as r", [
          ORG,
          conversationId,
          OWNER,
          key,
          `race ${currentOutcome} ${round}`,
        ]);
        const claimA = a!["r"] as Row;
        const messageId = (claimA["message"] as Row)["id"];
        await sql`update messages set metadata = metadata || jsonb_build_object('sending_since', now() - interval '3 minutes') where id = ${messageId}`;
        const [b] = await svc("select begin_outbound_message($1,$2,$3,$4,$5) as r", [
          ORG,
          conversationId,
          OWNER,
          key,
          `race ${currentOutcome} ${round}`,
        ]);
        const claimB = b!["r"] as Row;
        expect(claimB["should_send"]).toBe(true);
        const complete = (
          attempt: unknown,
          sent: boolean,
          ref: string | null,
          error: string | null,
        ) =>
          svc("select (complete_outbound_message($1,$2,$3,$4,$5,$6,$7)).state as state", [
            ORG,
            messageId,
            connectionId,
            attempt,
            sent,
            ref,
            error,
          ]);
        await Promise.all([
          complete(claimA["attempt"], true, String(7000 + round), null),
          currentOutcome === "sent"
            ? complete(claimB["attempt"], true, String(8000 + round), null)
            : complete(claimB["attempt"], false, null, "blocked_by_user"),
        ]);
        const [final] =
          (await sql`select state, metadata from messages where id = ${messageId}`) as Row[];
        // A reached the customer in every interleaving, so the reply is 'sent'.
        expect(final!["state"]).toBe("sent");
        const refs = (final!["metadata"] as { delivered_refs: string[] }).delivered_refs;
        expect(refs).toContain(String(7000 + round));
        if (currentOutcome === "sent") expect(refs).toContain(String(8000 + round));
      }
    }
  });
});
