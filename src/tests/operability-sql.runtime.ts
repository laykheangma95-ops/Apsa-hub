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
 *   - apsa_schema_level() answers 45;
 *   - the application's PostgresRateLimitStore drives the real function
 *     end-to-end through an rpc() adapter.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { financialFixture } from "./helpers/payment-order-fixture";
import { PostgresRateLimitStore } from "@/server/rate-limit/store";
import { PostgresWebhookReceiptStore } from "@/server/webhooks/receipts";
import { bucketKey } from "@/server/rate-limit/keys";

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
});
