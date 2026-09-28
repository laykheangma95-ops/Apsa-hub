/**
 * Operability — rate-limit core (src/server/rate-limit/*).
 *
 * Boundary behavior of the counter (below / at / above the limit, the exact
 * window edge), scope separation (member, organization, identity, IP), key
 * privacy (no raw email in any stored key), client-IP handling, and the
 * degraded fallback when the PostgreSQL store is unavailable.
 *
 * The SQL side of the same contract runs against the real migration in
 * operability-sql.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setLogSink } from "@/server/observability/logger";
import { RATE_LIMITS, type RateLimitRule } from "@/server/rate-limit/policies";
import { bucketKey, normalizeEmailForKey } from "@/server/rate-limit/keys";
import {
  MemoryRateLimitStore,
  PostgresRateLimitStore,
  type RateLimitStore,
} from "@/server/rate-limit/store";
import {
  checkRateLimits,
  enforceRateLimits,
  resetRateLimitFallbackStore,
  setPrimaryRateLimitStore,
} from "@/server/rate-limit/limiter";
import { RateLimitedError } from "@/server/rate-limit/errors";
import { clientIpFromHeaders, normalizeClientIp } from "@/server/rate-limit/client-ip";

const ROOT = process.cwd();
const rule = (limit: number, windowSeconds = 60): RateLimitRule => ({
  id: "test.rule",
  limit,
  windowSeconds,
});
const T0 = 1_700_000_000_000;

let restoreStore: () => void = () => {};
let logs: Array<Record<string, unknown>> = [];
let restoreLogs: () => void = () => {};

beforeEach(() => {
  restoreStore = setPrimaryRateLimitStore(new MemoryRateLimitStore());
  resetRateLimitFallbackStore();
  logs = [];
  restoreLogs = setLogSink((_level, line) => logs.push(JSON.parse(line)));
});

afterEach(() => {
  restoreStore();
  restoreLogs();
  resetRateLimitFallbackStore();
});

// ── Counter boundaries ───────────────────────────────────────────────────────

describe("fixed window anchored at the first hit", () => {
  it("allows just below and exactly at the limit, refuses just above", async () => {
    const store = new MemoryRateLimitStore();
    const r = rule(5);
    for (let i = 1; i <= 4; i++) expect((await store.hit("k", r, T0)).allowed).toBe(true); // below
    expect(await store.hit("k", r, T0 + 1)).toMatchObject({ allowed: true, count: 5 }); // at
    expect(await store.hit("k", r, T0 + 2)).toMatchObject({ allowed: false, count: 6 }); // above
  });

  it("reports how long until the window ends", async () => {
    const store = new MemoryRateLimitStore();
    const r = rule(1, 60);
    await store.hit("k", r, T0);
    expect((await store.hit("k", r, T0 + 15_000)).retryAfterSeconds).toBe(45);
  });

  it("starts a fresh window exactly at the boundary — not one millisecond before", async () => {
    const store = new MemoryRateLimitStore();
    const r = rule(1, 60);
    expect((await store.hit("k", r, T0)).allowed).toBe(true);
    expect((await store.hit("k", r, T0 + 59_999)).allowed).toBe(false);
    expect(await store.hit("k", r, T0 + 60_000)).toMatchObject({ allowed: true, count: 1 });
  });

  it("denied hits never extend the window", async () => {
    const store = new MemoryRateLimitStore();
    const r = rule(1, 60);
    await store.hit("k", r, T0);
    for (let s = 1; s < 60; s++) await store.hit("k", r, T0 + s * 1000);
    expect((await store.hit("k", r, T0 + 60_000)).allowed).toBe(true);
  });

  it("stays bounded in memory", async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 10_050; i++) await store.hit(`k${i}`, rule(1), T0);
    expect(store.size).toBeLessThanOrEqual(10_000);
  });
});

// ── Scope separation via the limiter ────────────────────────────────────────

describe("scopes stay separate", () => {
  const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
  const ORG_B = "bbbbbbbb-0000-4000-8000-000000000001";
  const USER_1 = "aaaaaaaa-0000-4000-8000-000000000002";
  const USER_2 = "aaaaaaaa-0000-4000-8000-000000000003";

  it("a full member bucket does not block another member or another organization", async () => {
    const r = rule(3);
    const hit = (org: string, user: string) =>
      checkRateLimits([{ rule: r, parts: [org, user] }], T0);
    for (let i = 0; i < 3; i++) expect((await hit(ORG_A, USER_1)).allowed).toBe(true);
    expect((await hit(ORG_A, USER_1)).allowed).toBe(false);
    expect((await hit(ORG_A, USER_2)).allowed).toBe(true);
    expect((await hit(ORG_B, USER_1)).allowed).toBe(true);
  });

  it("different rules never share a bucket for the same subject", async () => {
    const a: RateLimitRule = { id: "test.a", limit: 1, windowSeconds: 60 };
    const b: RateLimitRule = { id: "test.b", limit: 1, windowSeconds: 60 };
    expect((await checkRateLimits([{ rule: a, parts: ["x"] }], T0)).allowed).toBe(true);
    expect((await checkRateLimits([{ rule: b, parts: ["x"] }], T0)).allowed).toBe(true);
    expect((await checkRateLimits([{ rule: a, parts: ["x"] }], T0)).allowed).toBe(false);
  });

  it("a check with a missing part (unknown IP) is skipped, never pooled", async () => {
    const r = rule(1);
    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimits([{ rule: r, parts: [null] }], T0)).allowed).toBe(true);
      expect((await checkRateLimits([{ rule: r, parts: [""] }], T0)).allowed).toBe(true);
    }
  });

  it("stops at the first full bucket and names it (for logs only)", async () => {
    const tight = rule(1);
    await checkRateLimits([{ rule: tight, parts: ["s"] }], T0);
    const decision = await checkRateLimits(
      [
        { rule: tight, parts: ["s"] },
        { rule: { ...tight, id: "test.other" }, parts: ["s"] },
      ],
      T0,
    );
    expect(decision).toMatchObject({ allowed: false, blockedBy: "test.rule" });
    expect(logs.at(-1)).toMatchObject({ event: "rate_limit.exceeded", ruleId: "test.rule" });
  });

  it("enforceRateLimits throws a public 429 with retry guidance", async () => {
    const r = rule(1, 30);
    await enforceRateLimits([{ rule: r, parts: ["z"] }], T0);
    let thrown: unknown;
    try {
      await enforceRateLimits([{ rule: r, parts: ["z"] }], T0 + 10_000);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect((thrown as RateLimitedError).statusCode).toBe(429);
    expect((thrown as RateLimitedError).retryAfterSeconds).toBe(20);
  });
});

// ── Key privacy ─────────────────────────────────────────────────────────────

describe("bucket keys", () => {
  it("are 64-hex HMAC digests that never contain the raw email", async () => {
    const email = "Owner.A@Example.com";
    const key = await bucketKey("auth.sign_in.identity", [normalizeEmailForKey(email)]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("owner");
    expect(key).not.toContain("example");
  });

  it("normalize case and surrounding space, so variants share one bucket", async () => {
    const a = await bucketKey("r", [normalizeEmailForKey("  A@Example.COM ")]);
    const b = await bucketKey("r", [normalizeEmailForKey("a@example.com")]);
    expect(a).toBe(b);
  });

  it("differ per rule and per part boundary (no concatenation collisions)", async () => {
    expect(await bucketKey("r1", ["x"])).not.toBe(await bucketKey("r2", ["x"]));
    expect(await bucketKey("r", ["ab", "c"])).not.toBe(await bucketKey("r", ["a", "bc"]));
  });

  it("are peppered: a different server secret yields a different digest", async () => {
    const previous = process.env["RATE_LIMIT_KEY_SECRET"];
    process.env["RATE_LIMIT_KEY_SECRET"] = "pepper-one";
    const one = await bucketKey("r", ["a@example.com"]);
    process.env["RATE_LIMIT_KEY_SECRET"] = "pepper-two";
    const two = await bucketKey("r", ["a@example.com"]);
    if (previous === undefined) delete process.env["RATE_LIMIT_KEY_SECRET"];
    else process.env["RATE_LIMIT_KEY_SECRET"] = previous;
    expect(one).not.toBe(two);
  });

  it("the PostgreSQL store is sent only the digest and the rule — never the subject", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const store = new PostgresRateLimitStore({
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        return { data: { allowed: true, hit_count: 1, retry_after_seconds: 60 }, error: null };
      },
    });
    const restore = setPrimaryRateLimitStore(store);
    await checkRateLimits(
      [{ rule: RATE_LIMITS.signInIdentity, parts: [normalizeEmailForKey("secret@example.com")] }],
      T0,
    );
    restore();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("consume_rate_limit");
    expect(Object.keys(calls[0]!.args).sort()).toEqual([
      "p_bucket_key",
      "p_limit",
      "p_rule_id",
      "p_window_seconds",
    ]);
    expect(JSON.stringify(calls[0]!.args)).not.toContain("secret@example.com");
    expect(calls[0]!.args["p_bucket_key"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Degraded backend ────────────────────────────────────────────────────────

describe("degraded backend", () => {
  function failingStore(reason: "error" | "hang"): RateLimitStore {
    return new PostgresRateLimitStore(
      {
        rpc: (() =>
          reason === "error"
            ? Promise.resolve({ data: null, error: { code: "PGRST202", message: "no function" } })
            : new Promise(() => {})) as never,
      },
      50,
    );
  }

  it("falls back to the per-process store (still enforcing) and logs it without the subject", async () => {
    const restore = setPrimaryRateLimitStore(failingStore("error"));
    const r = rule(2);
    const parts = [normalizeEmailForKey("victim@example.com")];
    const first = await checkRateLimits([{ rule: r, parts }], T0);
    await checkRateLimits([{ rule: r, parts }], T0);
    const third = await checkRateLimits([{ rule: r, parts }], T0);
    restore();
    expect(first).toMatchObject({ allowed: true, degraded: true });
    expect(third).toMatchObject({ allowed: false, degraded: true });
    const joined = JSON.stringify(logs);
    expect(joined).not.toContain("victim@example.com");
    expect(logs.some((l) => l["event"] === "rate_limit.backend_degraded")).toBe(true);
  });

  it("a hanging database does not stall the request: it times out and degrades", async () => {
    const restore = setPrimaryRateLimitStore(failingStore("hang"));
    const started = Date.now();
    const decision = await checkRateLimits([{ rule: rule(5), parts: ["x"] }], T0);
    restore();
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the memory fallback is documented as NOT distributed", () => {
    const store = fs.readFileSync(path.join(ROOT, "src/server/rate-limit/store.ts"), "utf8");
    expect(store).toContain("NOT a distributed limiter");
    expect(store).toContain("N × limit");
  });
});

// ── Client IP ───────────────────────────────────────────────────────────────

describe("client IP for IP-scoped limits", () => {
  const headers =
    (values: Record<string, string>) =>
    (name: string): string | undefined =>
      values[name];

  it("trusts NO forwarding header when RATE_LIMIT_CLIENT_IP_HEADER is not configured", () => {
    const spoofable = headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-real-ip": "198.51.100.2",
      "x-forwarded-for": "198.51.100.1, 10.0.0.1",
    });
    // Unset and blank both mean "unknown": the IP bucket is skipped, never trusted.
    expect(clientIpFromHeaders(spoofable, undefined)).toBeNull();
    expect(clientIpFromHeaders(spoofable, "")).toBeNull();
    expect(clientIpFromHeaders(spoofable, "   ")).toBeNull();
    // Also through the environment default.
    const previous = process.env["RATE_LIMIT_CLIENT_IP_HEADER"];
    delete process.env["RATE_LIMIT_CLIENT_IP_HEADER"];
    try {
      expect(clientIpFromHeaders(spoofable)).toBeNull();
    } finally {
      if (previous !== undefined) process.env["RATE_LIMIT_CLIENT_IP_HEADER"] = previous;
    }
  });

  it("an unknown IP skips only the IP bucket: the identity bucket still enforces", async () => {
    const identity = rule(2);
    const ipRule = { ...rule(1000), id: "test.ip" };
    const checks = [
      { rule: identity, parts: [normalizeEmailForKey("victim@example.com")] },
      {
        rule: ipRule,
        parts: [clientIpFromHeaders(headers({ "x-forwarded-for": "1.2.3.4" }), undefined)],
      },
    ];
    expect((await checkRateLimits(checks, T0)).allowed).toBe(true);
    expect((await checkRateLimits(checks, T0)).allowed).toBe(true);
    expect((await checkRateLimits(checks, T0)).allowed).toBe(false);
  });

  it("reads the left-most forwarded hop only when x-forwarded-for is the configured header", () => {
    expect(
      clientIpFromHeaders(
        headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }),
        "x-forwarded-for",
      ),
    ).toBe("198.51.100.1");
  });

  it("uses ONLY the pinned header when the operator configures one (spoofed headers ignored)", () => {
    const get = headers({ "x-forwarded-for": "1.2.3.4", "x-vercel-forwarded-for": "203.0.113.9" });
    expect(clientIpFromHeaders(get, "x-vercel-forwarded-for")).toBe("203.0.113.9");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "1.2.3.4" }), "cf-connecting-ip")).toBe(
      null,
    );
  });

  it("keys IPv6 by /64 so rotating the host bits does not buy a fresh bucket", () => {
    expect(normalizeClientIp("2001:db8:85a3:1:aaaa::1")).toBe("2001:0db8:85a3:0001::/64");
    expect(normalizeClientIp("2001:db8:85a3:1:bbbb::2")).toBe("2001:0db8:85a3:0001::/64");
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("rejects values that are not IPs (no free-text bucket subjects)", () => {
    for (const bad of ["", "unknown", "999.1.1.1", "a@b.co", "1.2.3", "::gg"]) {
      expect({ bad, ip: normalizeClientIp(bad) }).toEqual({ bad, ip: null });
    }
  });
});

// ── Policy sanity ───────────────────────────────────────────────────────────

describe("policies", () => {
  it("every rule id is a valid SQL rule id and every value is within the RPC bounds", () => {
    for (const [name, r] of Object.entries(RATE_LIMITS)) {
      expect({ name, ok: /^[a-z0-9_.]{1,64}$/.test(r.id) }).toEqual({ name, ok: true });
      expect(r.limit).toBeGreaterThanOrEqual(1);
      expect(r.windowSeconds).toBeGreaterThanOrEqual(1);
      expect(r.windowSeconds).toBeLessThanOrEqual(86_400);
    }
    const ids = Object.values(RATE_LIMITS).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("allows normal human retries and a busy merchant", () => {
    expect(RATE_LIMITS.signInIdentity.limit).toBeGreaterThanOrEqual(5);
    expect(RATE_LIMITS.passwordResetCooldown.windowSeconds).toBe(60);
    // ≥ one order per second per cashier, ≥ ten cashiers per shop at that pace.
    expect(RATE_LIMITS.orderCreateMember.limit / RATE_LIMITS.orderCreateMember.windowSeconds).toBe(
      1,
    );
    expect(RATE_LIMITS.orderCreateOrganization.limit).toBeGreaterThanOrEqual(
      10 * RATE_LIMITS.orderCreateMember.limit,
    );
  });
});
