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
 *   - overlapping connects of one bot: exactly one takes the lease, every
 *     other is refused connect_in_progress;
 *   - an older connect's abort racing a newer connect that took over its
 *     expired lease never disconnects the newer connect;
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
  expect(migrations.at(-1)).toBe("064_telegram_channel.sql");
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

  const op = crypto.randomUUID();
  const [row] = await svc(
    `select (connect_channel_account($1,$2,'TELEGRAM',$3,'bot','Bot',$4,1::smallint,$5,$6)).id as id`,
    [ORG, OWNER, BOT, CIPHER, HASH, op],
  );
  connectionId = String(row!["id"]);
  await svc("select finish_channel_connect($1,$2,$3)", [ORG, connectionId, op]);
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
      Array.from({ length: 8 }, (_, i) =>
        outcome(
          "select connect_channel_account($1,$2,'TELEGRAM',$3,'bot','Bot',$4,1::smallint,$5,$6)",
          [ORG, OWNER, bot, CIPHER, String(i).repeat(64).slice(0, 64), crypto.randomUUID()],
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o.includes("connect_in_progress"))).toHaveLength(7);
    const rows =
      await sql`select count(*)::int n from channel_connections where external_account_id = ${bot}`;
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("an older connect's abort racing a newer takeover never disconnects the newer connect", async () => {
    for (let round = 0; round < 10; round++) {
      const bot = `70000065${String(round).padStart(2, "0")}`;
      const opOld = crypto.randomUUID();
      const [old] = await svc(
        "select (connect_channel_account($1,$2,'TELEGRAM',$3,'bot','Bot',$4,1::smallint,$5,$6)).id as id",
        [ORG, OWNER, bot, CIPHER, "e".repeat(64), opOld],
      );
      await sql`update channel_connections set pending_connect_until = now() - interval '1 second' where id = ${old!["id"]}`;
      const opNew = crypto.randomUUID();
      const [, abort] = await Promise.all([
        svc(
          "select connect_channel_account($1,$2,'TELEGRAM',$3,'bot','Bot',$4,1::smallint,$5,$6)",
          [ORG, OWNER, bot, CIPHER, "f".repeat(64), opNew],
        ),
        svc("select abort_channel_connect($1,$2,$3,$4) as ok", [ORG, OWNER, old!["id"], opOld]),
      ]);
      const [row] =
        (await sql`select status, pending_connect_op, webhook_secret_hash from channel_connections where id = ${old!["id"]}`) as Row[];
      if (abort[0]!["ok"] === true) {
        // The abort won the row lock first: it disconnected the OLD connect,
        // and the newer connect then created a fresh live row for the bot.
        expect(row!["status"]).toBe("disconnected");
        const live =
          (await sql`select pending_connect_op from channel_connections where external_account_id = ${bot} and status <> 'disconnected'`) as Row[];
        expect(live).toHaveLength(1);
        expect(live[0]!["pending_connect_op"]).toBe(opNew);
      } else {
        // The newer connect won: it is live and still owns its lease.
        expect(row).toEqual({
          status: "connected",
          pending_connect_op: opNew,
          webhook_secret_hash: "f".repeat(64),
        });
      }
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
