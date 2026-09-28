/**
 * Migration 045 against the REAL migrated schema (all migrations, in order,
 * through PGlite). Spawned by operability-sql.test.ts.
 *
 * Proves the database half of the rate-limit and webhook contracts:
 *   - consume_rate_limit counts below / at / above the limit, reports retry
 *     time, resets at the window edge, keeps buckets separate;
 *   - concurrent hits are each counted exactly once;
 *   - inputs are validated (a raw email can never be stored as a key);
 *   - anon / authenticated can neither execute the functions nor touch the
 *     tables; service_role can;
 *   - claim/release_webhook_event give first-sight-wins replay protection;
 *   - apsa_schema_level() answers 45 (a convenience marker only);
 *   - apsa_migration_history() reports the Supabase CLI ledger truthfully: a
 *     clean CLI-style rehearsal 001 → 045 is READY; a skipped earlier
 *     migration, a partial rehearsal or no ledger at all is NOT READY;
 *   - prune_webhook_event_receipts removes only receipts past retention, in
 *     bounded batches, and refuses an unsafe retention;
 *   - the application's PostgresRateLimitStore drives the real function
 *     end-to-end through an rpc() adapter.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { financialFixture } from "./helpers/payment-order-fixture";
import { PostgresRateLimitStore } from "@/server/rate-limit/store";
import { PostgresWebhookReceiptStore } from "@/server/webhooks/receipts";
import { bucketKey } from "@/server/rate-limit/keys";
import { PGlite as PGliteCtor } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import {
  evaluateMigrationHistory,
  repositoryMigrationVersions,
} from "../../scripts/lib/migration-history.ts";

let fixture: Awaited<ReturnType<typeof financialFixture>>;
let db: PGlite;

beforeAll(async () => {
  fixture = await financialFixture();
  db = fixture.db;
});
afterAll(async () => {
  await fixture.close();
});

const key = (n: number) => n.toString(16).padStart(64, "0");

async function hit(bucket: string, limit: number, windowSeconds = 60, rule = "test.rule") {
  const result = await db.query<{
    r: { allowed: boolean; hit_count: number; retry_after_seconds: number };
  }>("select consume_rate_limit($1, $2, $3, $4) as r", [bucket, rule, limit, windowSeconds]);
  return result.rows[0]!.r;
}

/** An rpc() adapter with supabase-js's shape, calling by named notation. */
function rpcAdapter() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      const params = names.map((name, i) => `${name} => $${i + 1}`).join(", ");
      try {
        const result = await db.query<{ r: unknown }>(
          `select ${fn}(${params}) as r`,
          names.map((name) => args[name]),
        );
        return { data: result.rows[0]!.r, error: null };
      } catch (error) {
        return { data: null, error: { code: (error as { code?: string }).code ?? "XX000" } };
      }
    },
  };
}

describe("consume_rate_limit", () => {
  it("below / at / above the limit", async () => {
    const bucket = key(1);
    expect(await hit(bucket, 3)).toMatchObject({ allowed: true, hit_count: 1 });
    expect(await hit(bucket, 3)).toMatchObject({ allowed: true, hit_count: 2 });
    expect(await hit(bucket, 3)).toMatchObject({ allowed: true, hit_count: 3 });
    const over = await hit(bucket, 3);
    expect(over).toMatchObject({ allowed: false, hit_count: 4 });
    expect(over.retry_after_seconds).toBeGreaterThanOrEqual(1);
    expect(over.retry_after_seconds).toBeLessThanOrEqual(60);
  });

  it("a new window starts once the old one has ended", async () => {
    const bucket = key(2);
    await hit(bucket, 1);
    expect((await hit(bucket, 1)).allowed).toBe(false);
    // Age the window instead of sleeping: the database clock is the authority.
    await db.query(
      "update rate_limit_buckets set window_started_at = now() - interval '61 seconds', expires_at = now() - interval '1 second' where bucket_key = $1",
      [bucket],
    );
    expect(await hit(bucket, 1)).toMatchObject({ allowed: true, hit_count: 1 });
  });

  it("buckets are independent", async () => {
    await hit(key(3), 1);
    expect((await hit(key(3), 1)).allowed).toBe(false);
    expect((await hit(key(4), 1)).allowed).toBe(true);
  });

  it("concurrent hits are each counted exactly once", async () => {
    const bucket = key(5);
    const results = await Promise.all(Array.from({ length: 25 }, () => hit(bucket, 10)));
    const counts = results.map((r) => r.hit_count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("validates every input — a raw email can never become a stored key", async () => {
    for (const [bucket, rule, limit, windowSeconds] of [
      ["owner@example.com", "test.rule", 1, 60],
      ["ab".repeat(32).toUpperCase(), "test.rule", 1, 60],
      [key(6), "Bad Rule!", 1, 60],
      [key(6), "test.rule", 0, 60],
      [key(6), "test.rule", 1, 0],
      [key(6), "test.rule", 1, 90_000],
    ] as const) {
      await expect(
        db.query("select consume_rate_limit($1,$2,$3,$4)", [bucket, rule, limit, windowSeconds]),
      ).rejects.toThrow(/consume_rate_limit: invalid/);
    }
    const stored = await db.query<{ n: number }>(
      "select count(*)::int as n from rate_limit_buckets where bucket_key !~ '^[0-9a-f]{64}$'",
    );
    expect(stored.rows[0]!.n).toBe(0);
  });

  it("prune removes only long-expired buckets", async () => {
    await hit(key(7), 5);
    await db.query(
      "update rate_limit_buckets set window_started_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' where bucket_key = $1",
      [key(7)],
    );
    await hit(key(8), 5);
    const pruned = await db.query<{ n: number }>("select prune_rate_limit_buckets() as n");
    expect(pruned.rows[0]!.n).toBeGreaterThanOrEqual(1);
    const left = await db.query<{ k: string }>(
      "select bucket_key as k from rate_limit_buckets where bucket_key in ($1, $2)",
      [key(7), key(8)],
    );
    expect(left.rows.map((r) => r.k)).toEqual([key(8)]);
  });
});

describe("access model", () => {
  async function asRole<T>(role: string, work: () => Promise<T>): Promise<T> {
    await db.exec(`set role ${role}`);
    try {
      return await work();
    } finally {
      await db.exec("reset role");
    }
  }

  for (const role of ["anon", "authenticated"]) {
    it(`${role} cannot execute the functions or touch the tables`, async () => {
      for (const sql of [
        `select consume_rate_limit('${key(9)}','test.rule',1,60)`,
        "select prune_rate_limit_buckets()",
        "select claim_webhook_event('telegram','1')",
        "select release_webhook_event('telegram','1')",
        "select apsa_schema_level()",
        "select apsa_migration_history()",
        "select prune_webhook_event_receipts()",
        "select * from rate_limit_buckets",
        "select * from webhook_event_receipts",
        `insert into rate_limit_buckets values ('${key(9)}','x',1,now(),now()+interval '1 minute')`,
      ]) {
        await expect(asRole(role, () => db.query(sql))).rejects.toThrow(/permission denied/);
      }
    });
  }

  it("service_role can use them", async () => {
    const r = await asRole("service_role", () =>
      db.query<{ r: { allowed: boolean } }>(
        `select consume_rate_limit('${key(10)}','test.rule',1,60) as r`,
      ),
    );
    expect(r.rows[0]!.r.allowed).toBe(true);
  });

  it("RLS is enabled on both tables", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('rate_limit_buckets','webhook_event_receipts') order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "rate_limit_buckets", relrowsecurity: true },
      { relname: "webhook_event_receipts", relrowsecurity: true },
    ]);
  });
});

describe("webhook receipts", () => {
  it("first sight wins; repeats are refused; a release re-opens the event", async () => {
    const q = (sql: string) => db.query<{ r: boolean }>(sql).then((x) => x.rows[0]!.r);
    expect(await q("select claim_webhook_event('telegram','evt-1') as r")).toBe(true);
    expect(await q("select claim_webhook_event('telegram','evt-1') as r")).toBe(false);
    expect(await q("select claim_webhook_event('meta','evt-1') as r")).toBe(true);
    expect(await q("select release_webhook_event('telegram','evt-1') as r")).toBe(true);
    expect(await q("select claim_webhook_event('telegram','evt-1') as r")).toBe(true);
  });

  it("concurrent deliveries of one event: exactly one claim succeeds", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.query<{ r: boolean }>("select claim_webhook_event('telegram','evt-race') as r"),
      ),
    );
    expect(results.filter((x) => x.rows[0]!.r)).toHaveLength(1);
  });

  it("rejects malformed provider ids and oversized event ids", async () => {
    await expect(db.query("select claim_webhook_event('Tele Gram','1')")).rejects.toThrow(
      /invalid provider/,
    );
    await expect(
      db.query("select claim_webhook_event('telegram', $1)", ["x".repeat(201)]),
    ).rejects.toThrow(/invalid event id/);
  });
});

describe("webhook receipt retention", () => {
  const ageReceipt = (provider: string, eventId: string, days: number) =>
    db.query(
      `update webhook_event_receipts set received_at = now() - make_interval(days => $3)
        where provider = $1 and event_id = $2`,
      [provider, eventId, days],
    );
  const present = async (provider: string, eventId: string) =>
    (
      await db.query("select 1 from webhook_event_receipts where provider = $1 and event_id = $2", [
        provider,
        eventId,
      ])
    ).rows.length === 1;
  const prune = async (args = "") =>
    (await db.query<{ n: number }>(`select prune_webhook_event_receipts(${args}) as n`)).rows[0]!.n;

  it("prunes receipts past the 30-day default retention and keeps active replay records", async () => {
    await db.query("delete from webhook_event_receipts");
    for (const id of ["old-1", "old-2", "edge-29d", "fresh"]) {
      await db.query("select claim_webhook_event('telegram', $1)", [id]);
    }
    await ageReceipt("telegram", "old-1", 45);
    await ageReceipt("telegram", "old-2", 31);
    await ageReceipt("telegram", "edge-29d", 29);
    expect(await prune()).toBe(2);
    expect(await present("telegram", "old-1")).toBe(false);
    expect(await present("telegram", "old-2")).toBe(false);
    expect(await present("telegram", "edge-29d")).toBe(true);
    expect(await present("telegram", "fresh")).toBe(true);
    // A kept receipt still refuses its replay.
    const replay = await db.query<{ r: boolean }>(
      "select claim_webhook_event('telegram','edge-29d') as r",
    );
    expect(replay.rows[0]!.r).toBe(false);
  });

  it("is bounded per call and oldest-first", async () => {
    await db.query("delete from webhook_event_receipts");
    for (let i = 0; i < 5; i++) {
      await db.query("select claim_webhook_event('meta', $1)", [`b-${i}`]);
      await ageReceipt("meta", `b-${i}`, 40 + i);
    }
    expect(await prune("30, 2")).toBe(2);
    expect(await present("meta", "b-4")).toBe(false);
    expect(await present("meta", "b-3")).toBe(false);
    expect(await present("meta", "b-0")).toBe(true);
    expect(await prune("30, 50000")).toBe(3);
    expect(await prune()).toBe(0);
  });

  it("refuses a retention short enough to drop live replay records, or an unbounded batch", async () => {
    await expect(prune("6")).rejects.toThrow(/retention must be 7\.\.3650 days/);
    await expect(prune("null")).rejects.toThrow(/retention/);
    await expect(prune("30, 0")).rejects.toThrow(/batch size/);
    await expect(prune("30, 50001")).rejects.toThrow(/batch size/);
  });
});

describe("migration history proof (Supabase CLI ledger)", () => {
  const files = readdirSync("supabase/migrations")
    .filter((n) => /^\d+_.*\.sql$/.test(n))
    .sort();
  const expected = repositoryMigrationVersions(files);
  const LEDGER_DDL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (
      version text PRIMARY KEY, statements text[], name text
    );`;

  async function base(): Promise<PGlite> {
    const fresh = new PGliteCtor();
    await fresh.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    `);
    return fresh;
  }

  /** What `supabase db push` does: run each file, then record its version. */
  async function cliRehearsal(skip: readonly string[] = [], stopAfter?: string) {
    const fresh = await base();
    await fresh.exec(LEDGER_DDL);
    for (const file of files) {
      const version = file.slice(0, file.indexOf("_"));
      if (skip.includes(version)) continue;
      await fresh.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
      await fresh.query(
        "insert into supabase_migrations.schema_migrations(version, name) values ($1, $2)",
        [version, file.slice(file.indexOf("_") + 1, -4)],
      );
      if (version === stopAfter) break;
    }
    return fresh;
  }

  async function historyOf(target: PGlite) {
    await target.exec("set role service_role");
    try {
      return (await target.query<{ h: unknown }>("select apsa_migration_history() as h")).rows[0]!
        .h;
    } finally {
      await target.exec("reset role");
    }
  }

  it("clean CLI rehearsal 001 → latest: every version recorded contiguously → READY", async () => {
    const fresh = await cliRehearsal();
    try {
      const history = await historyOf(fresh);
      expect(history).toEqual({ available: true, versions: expected });
      const report = evaluateMigrationHistory(expected, history);
      expect(report).toMatchObject({ ready: true, contiguousThrough: expected.at(-1) });
      // The convenience marker agrees but is not what proved it.
      const level = await fresh.query<{ l: number }>("select apsa_schema_level() as l");
      expect(level.rows[0]!.l).toBe(45);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it("an earlier ALTER-only migration skipped: 045 objects and schema level present, but NOT READY", async () => {
    // 042_team_permissions only seeds grants (no table/RPC); 043+ still apply.
    const skipped = "042";
    expect(files.some((f) => f.startsWith(`${skipped}_`))).toBe(true);
    const fresh = await cliRehearsal([skipped]);
    try {
      const level = await fresh.query<{ l: number }>("select apsa_schema_level() as l");
      expect(level.rows[0]!.l).toBe(45); // the old "ready" signal
      const report = evaluateMigrationHistory(expected, await historyOf(fresh));
      expect(report.ready).toBe(false);
      expect(report.reasons).toEqual(["out_of_order"]);
      expect(report.missing).toEqual([skipped]);
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it("the fixture database (files run with no migration tool) has no ledger → NOT READY", async () => {
    await db.exec("set role service_role");
    let history: unknown;
    try {
      history = (await db.query<{ h: unknown }>("select apsa_migration_history() as h")).rows[0]!.h;
    } finally {
      await db.exec("reset role");
    }
    expect(history).toEqual({ available: false, versions: [] });
    expect(evaluateMigrationHistory(expected, history)).toMatchObject({
      ready: false,
      reasons: ["history_unavailable"],
    });
  });

  it("a ledger that is behind the checkout is NOT READY", async () => {
    await db.exec(LEDGER_DDL);
    try {
      for (const v of expected.slice(0, 8)) {
        await db.query("insert into supabase_migrations.schema_migrations(version) values ($1)", [
          v,
        ]);
      }
      await db.exec("set role service_role");
      const history = (await db.query<{ h: unknown }>("select apsa_migration_history() as h"))
        .rows[0]!.h;
      await db.exec("reset role");
      expect(evaluateMigrationHistory(expected, history)).toMatchObject({
        ready: false,
        reasons: ["behind"],
        contiguousThrough: "008",
      });
    } finally {
      await db.exec("reset role");
      await db.exec("DROP SCHEMA supabase_migrations CASCADE");
    }
  });
});

describe("schema level witness", () => {
  it("apsa_schema_level() is 45", async () => {
    const r = await db.query<{ l: number }>("select apsa_schema_level() as l");
    expect(r.rows[0]!.l).toBe(45);
  });
});

describe("application stores against the real SQL", () => {
  it("PostgresRateLimitStore enforces through consume_rate_limit", async () => {
    const store = new PostgresRateLimitStore(rpcAdapter());
    const rule = { id: "orders.create.member", limit: 2, windowSeconds: 60 };
    const bucket = await bucketKey(rule.id, ["org", "user"]);
    expect(await store.hit(bucket, rule)).toMatchObject({ allowed: true, count: 1 });
    expect(await store.hit(bucket, rule)).toMatchObject({ allowed: true, count: 2 });
    expect(await store.hit(bucket, rule)).toMatchObject({ allowed: false, count: 3 });
  });

  it("PostgresWebhookReceiptStore claims and releases through the real functions", async () => {
    const store = new PostgresWebhookReceiptStore(rpcAdapter());
    expect(await store.claim("telegram", "evt-store")).toBe(true);
    expect(await store.claim("telegram", "evt-store")).toBe(false);
    await store.release("telegram", "evt-store");
    expect(await store.claim("telegram", "evt-store")).toBe(true);
  });

  it("PostgresWebhookReceiptStore.prune drives the real bounded retention function", async () => {
    const store = new PostgresWebhookReceiptStore(rpcAdapter());
    await store.claim("telegram", "evt-prune-old");
    await store.claim("telegram", "evt-prune-new");
    await db.query(
      "update webhook_event_receipts set received_at = now() - interval '60 days' where event_id = 'evt-prune-old'",
    );
    expect(await store.prune()).toBe(1);
    expect(await store.claim("telegram", "evt-prune-new")).toBe(false);
    await expect(store.prune(1)).rejects.toThrow(/webhook receipt store unavailable/);
  });
});
