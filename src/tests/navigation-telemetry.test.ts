/**
 * Navigation telemetry bridge (src/lib/perf/navigation-telemetry.ts,
 * src/server/observability/navigation-telemetry.ts, src/api/perf-telemetry.ts,
 * and the transport in src/lib/perf/navigation-timing.ts) — gates, allowlist,
 * bounds, privacy, and non-blocking delivery.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  KNOWN_SCREENS,
  MAX_PAYLOAD_CHARS,
  MAX_TIMING_MS,
  navigationTelemetrySchema,
  parseNavigationTelemetry,
  toTelemetryPayload,
  type NavigationTelemetry,
} from "@/lib/perf/navigation-telemetry";
import {
  installNavigationTiming,
  screenOf,
  type NavigationTimingRecord,
  type NavTelemetryTransport,
  type RouterLike,
} from "@/lib/perf/navigation-timing";
import {
  NAVIGATION_LOG_EVENT,
  NAVIGATION_RATE_LIMITED_EVENT,
  ingestNavigationTelemetry,
  resetNavigationTelemetryRateLimitLog,
  type NavigationTelemetryIngestOptions,
} from "@/server/observability/navigation-telemetry";
import { setLogSink } from "@/server/observability/logger";
import { runWithRequestContext } from "@/server/observability/request-context";
import { clientIpFromHeaders } from "@/server/rate-limit/client-ip";
import { resetRateLimitFallbackStore, setPrimaryRateLimitStore } from "@/server/rate-limit/limiter";
import { RATE_LIMITS } from "@/server/rate-limit/policies";
import { MemoryRateLimitStore, type RateLimitStore } from "@/server/rate-limit/store";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const ON = { APSA_PERF_INSTRUMENTATION: "true" };

const VALID = {
  from: "home",
  to: "orders",
  tracked: true,
  navigateMs: 120,
  pendingMs: 310,
  loadedMs: 920,
  renderedMs: 980,
  contentMs: 1120,
  viewport: 390,
  locale: "km",
  clientTs: 1_790_000_000_000,
} as const;

function captureLines() {
  const lines: Array<Record<string, unknown>> = [];
  const restore = setLogSink((_level, line) => lines.push(JSON.parse(line)));
  return { lines, restore };
}

// Every test gets a fresh in-process limiter backend (never PostgreSQL).
let restoreStore: () => void = () => {};
beforeEach(() => {
  restoreStore = setPrimaryRateLimitStore(new MemoryRateLimitStore());
  resetRateLimitFallbackStore();
  resetNavigationTelemetryRateLimitLog();
});
afterEach(() => restoreStore());

const NO_IP = { clientIp: async () => null } satisfies NavigationTelemetryIngestOptions;

async function ingest(
  input: unknown,
  env: Record<string, string | undefined> = ON,
  options: NavigationTelemetryIngestOptions = NO_IP,
) {
  const { lines, restore } = captureLines();
  try {
    const logged = await ingestNavigationTelemetry(input, env, options);
    return { logged, lines };
  } finally {
    restore();
  }
}

describe("server gate", () => {
  it("logs nothing when APSA_PERF_INSTRUMENTATION is unset, empty or false", async () => {
    for (const env of [
      {},
      { APSA_PERF_INSTRUMENTATION: "" },
      { APSA_PERF_INSTRUMENTATION: "false" },
    ]) {
      const { logged, lines } = await ingest(VALID, env);
      expect(logged).toBe(false);
      expect(lines).toEqual([]);
    }
  });

  it("is OFF in this test process's default environment", async () => {
    const { logged, lines } = await ingest(VALID, process.env);
    expect(logged).toBe(false);
    expect(lines).toEqual([]);
  });

  it("refuses on a Vercel production deployment even with the flag set", async () => {
    const { logged, lines } = await ingest(VALID, { ...ON, VERCEL_ENV: "production" });
    expect(logged).toBe(false);
    expect(lines).toEqual([]);
  });

  it("logs on preview/staging when the flag is set", async () => {
    expect((await ingest(VALID, { ...ON, VERCEL_ENV: "preview" })).logged).toBe(true);
  });

  it("the API handler goes through the gated ingest and returns nothing", () => {
    const source = read("src/api/perf-telemetry.ts");
    expect(source).toMatch(
      /await import\(\s*"@\/server\/observability\/navigation-telemetry"\s*\)/,
    );
    expect(source).toContain("Promise<void>");
    expect(source).toContain("await ingestNavigationTelemetry(data)");
    expect(source).not.toMatch(/^\s*import\s(?!type\b).*@\/server\//m);
    expect(source).not.toMatch(/getSessionFn|supabase|organization_id/i);
  });
});

describe("server log line", () => {
  it("a valid payload logs exactly the safe fields", async () => {
    const { logged, lines } = await ingest(VALID);
    expect(logged).toBe(true);
    expect(lines).toHaveLength(1);
    const { ts, ...line } = lines[0]!;
    expect(typeof ts).toBe("string");
    expect(line).toEqual({
      level: "info",
      event: "perf.navigation",
      from: "home",
      to: "orders",
      tracked: true,
      navigateMs: 120,
      pendingMs: 310,
      loadedMs: 920,
      renderedMs: 980,
      readyMs: 1120,
      viewport: 390,
      locale: "km",
      clientTs: 1_790_000_000_000,
    });
    expect(NAVIGATION_LOG_EVENT).toBe("perf.navigation");
  });

  it("no field is masked by the redacting logger", async () => {
    const { lines } = await ingest(VALID);
    expect(JSON.stringify(lines[0])).not.toContain("[REDACTED]");
  });

  it("inside a server-function context only the request ID and fn name are added", async () => {
    const { lines, restore } = captureLines();
    try {
      await runWithRequestContext(
        {
          requestId: "req_test",
          serverFnBoundary: true,
          operation: "recordNavigationTimingFn",
          domain: "perf-telemetry",
        },
        () => ingestNavigationTelemetry(VALID, ON, NO_IP),
      );
    } finally {
      restore();
    }
    const keys = Object.keys(lines[0]!).sort();
    expect(keys).toEqual(
      [
        "ts",
        "level",
        "event",
        "requestId",
        "domain",
        "operation",
        "from",
        "to",
        "tracked",
        "navigateMs",
        "pendingMs",
        "loadedMs",
        "renderedMs",
        "readyMs",
        "viewport",
        "locale",
        "clientTs",
      ].sort(),
    );
  });

  it("a minimal payload logs only what it carries", async () => {
    const { lines } = await ingest({ from: "orders", to: "pos", tracked: false });
    const { ts: _ts, ...line } = lines[0]!;
    expect(line).toEqual({
      level: "info",
      event: "perf.navigation",
      from: "orders",
      to: "pos",
      tracked: false,
    });
  });

  it("an invalid payload is dropped silently: no log line, no error", async () => {
    const { logged, lines } = await ingest({ ...VALID, navigateMs: -1 });
    expect(logged).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("abuse limiter", () => {
  const NOW = 1_790_000_000_000;
  const fromIp = (ip: string | null, nowMs = NOW): NavigationTelemetryIngestOptions => ({
    clientIp: async () => ip,
    nowMs,
  });

  function countingStore(): RateLimitStore & { hits: string[] } {
    const inner = new MemoryRateLimitStore();
    const hits: string[] = [];
    return {
      name: "memory",
      hits,
      hit: (key, rule, nowMs) => {
        hits.push(rule.id);
        return inner.hit(key, rule, nowMs);
      },
    } as RateLimitStore & { hits: string[] };
  }

  it("is generous: a full page load of navigations from one IP is all logged", async () => {
    let logged = 0;
    for (let i = 0; i < 200; i++) {
      if ((await ingest(VALID, ON, fromIp("203.0.113.7"))).logged) logged += 1;
    }
    expect(logged).toBe(200);
    expect(RATE_LIMITS.perfTelemetryIp.limit).toBeGreaterThanOrEqual(200);
    expect(RATE_LIMITS.perfTelemetryIp.windowSeconds).toBe(60);
  });

  it("drops excessive traffic from one IP silently; other sources are unaffected", async () => {
    const limit = RATE_LIMITS.perfTelemetryIp.limit;
    for (let i = 0; i < limit; i++) await ingest(VALID, ON, fromIp("203.0.113.7"));
    const refused = await ingest(VALID, ON, fromIp("203.0.113.7"));
    expect(refused.logged).toBe(false);
    expect(refused.lines.map((l) => l.event)).not.toContain(NAVIGATION_LOG_EVENT);
    expect((await ingest(VALID, ON, fromIp("198.51.100.9"))).logged).toBe(true);
    // The window resets.
    expect((await ingest(VALID, ON, fromIp("203.0.113.7", NOW + 61_000))).logged).toBe(true);
  });

  it("the global backstop bounds traffic when no client IP is trusted", async () => {
    const limit = RATE_LIMITS.perfTelemetryGlobal.limit;
    for (let i = 0; i < limit; i++) await ingest(VALID, ON, fromIp(null));
    expect((await ingest(VALID, ON, fromIp(null))).logged).toBe(false);
    expect((await ingest(VALID, ON, fromIp("198.51.100.9"))).logged).toBe(false);
  });

  it("invalid payloads count too, so a flood of junk is bounded", async () => {
    const store = countingStore();
    const restore = setPrimaryRateLimitStore(store);
    try {
      await ingest({ junk: "x".repeat(10_000) }, ON, fromIp("203.0.113.7"));
      expect(store.hits).toEqual(["perf.telemetry.ip", "perf.telemetry.global"]);
    } finally {
      restore();
    }
  });

  it("refusals log one throttled summary line with no IP, payload or per-request warning", async () => {
    const limit = RATE_LIMITS.perfTelemetryIp.limit;
    const { lines, restore } = captureLines();
    try {
      for (let i = 0; i < limit + 50; i++) {
        await ingestNavigationTelemetry(VALID, ON, fromIp("203.0.113.7"));
      }
    } finally {
      restore();
    }
    const warnings = lines.filter((l) => l.level === "warn");
    expect(warnings).toHaveLength(1);
    const { ts: _ts, ...summary } = warnings[0]!;
    expect(summary).toEqual({
      level: "warn",
      event: NAVIGATION_RATE_LIMITED_EVENT,
      ruleId: "perf.telemetry.ip",
    });
    expect(lines.some((l) => l.event === "rate_limit.exceeded")).toBe(false);
    const text = JSON.stringify(lines.filter((l) => l.event !== NAVIGATION_LOG_EVENT));
    expect(text).not.toContain("203.0.113");
    expect(text).not.toContain("orders");
  });

  it("is not consulted while telemetry is OFF or on production", async () => {
    const store = countingStore();
    const restore = setPrimaryRateLimitStore(store);
    try {
      await ingest(VALID, {}, fromIp("203.0.113.7"));
      await ingest(VALID, { ...ON, VERCEL_ENV: "production" }, fromIp("203.0.113.7"));
      expect(store.hits).toEqual([]);
    } finally {
      restore();
    }
  });

  it("fails safe: a limiter or IP lookup failure drops the record, never rejects", async () => {
    const failing = await ingest(VALID, ON, {
      clientIp: async () => {
        throw new Error("boom");
      },
    });
    expect(failing).toEqual({ logged: false, lines: [] });
  });

  it("a durable-backend outage degrades to the in-process limiter, not to unlimited", async () => {
    const restore = setPrimaryRateLimitStore({
      name: "postgres",
      hit: async () => {
        throw new Error("db down");
      },
    } as RateLimitStore);
    try {
      const limit = RATE_LIMITS.perfTelemetryIp.limit;
      for (let i = 0; i < limit; i++) await ingest(VALID, ON, fromIp("203.0.113.7"));
      expect((await ingest(VALID, ON, fromIp("203.0.113.7"))).logged).toBe(false);
    } finally {
      restore();
    }
  });

  it("keys by the trusted request source only — forwarded headers are ignored by default", () => {
    const headers: Record<string, string> = {
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
    };
    expect(clientIpFromHeaders((name) => headers[name], undefined)).toBeNull();
    const source = read("src/server/observability/navigation-telemetry.ts");
    expect(source).toContain("currentClientIp");
    expect(source).not.toMatch(/getRequestHeader|x-forwarded-for|x-real-ip|cf-connecting-ip/i);
  });

  it("adds no session, auth, organization or database dependency", () => {
    for (const file of [
      "src/server/observability/navigation-telemetry.ts",
      "src/api/perf-telemetry.ts",
    ]) {
      const source = read(file);
      expect({ file, match: source.match(/^import .*$/gm)?.join("\n") ?? "" }).not.toMatchObject({
        match: expect.stringMatching(/session|auth|supabase|organization|membership|tenant/i),
      });
      expect(source).not.toMatch(/getSessionFn|requireSession|organization_id|\.from\(/);
    }
  });
});

describe("allowlist schema", () => {
  const rejects = (input: unknown) => expect(parseNavigationTelemetry(input)).toBeNull();

  it("rejects unknown fields (strict allowlist, not a denylist)", () => {
    rejects({ ...VALID, extra: 1 });
    rejects({ ...VALID, event: "perf.navigation" });
    rejects({ ...VALID, contentTimedOut: true });
    rejects({ ...VALID, meta: { a: 1 } });
  });

  it.each([
    ["email", "owner@example.com"],
    ["phone", "+85512345678"],
    // A JWT-shaped value, assembled at runtime so no credential-shaped literal
    // is committed (secret scanning): base64url('{"alg":"HS256"}') + ".e30.x".
    ["token", `${btoa('{"alg":"HS256"}')}.e30.x`],
    ["accessToken", "abc"],
    ["cookie", "sb-access-token=abc"],
    ["userId", "7d1c3a4e-0000-4000-8000-000000000001"],
    ["orgId", "7d1c3a4e-0000-4000-8000-000000000002"],
    ["organization_id", "7d1c3a4e-0000-4000-8000-000000000002"],
    ["customerName", "Sok Dara"],
    ["orderId", "7d1c3a4e-0000-4000-8000-000000000003"],
    ["url", "https://apsa.app/app/orders/7d1c3a4e?tab=items"],
    ["path", "/app/orders/7d1c3a4e"],
    ["search", "?q=dara"],
    ["query", "q=dara"],
    ["userAgent", "Mozilla/5.0"],
    ["ip", "203.0.113.7"],
    ["headers", { authorization: "Bearer x" }],
    ["error", "TypeError: boom"],
  ])("rejects a PII-like field: %s", (key, value) => {
    rejects({ ...VALID, [key]: value });
  });

  it("rejects identifiers, raw paths and query strings as screen labels", () => {
    rejects({ ...VALID, to: "orders/7d1c3a4e-0000-4000-8000-000000000003" });
    rejects({ ...VALID, to: "7d1c3a4e-0000-4000-8000-000000000003" });
    rejects({ ...VALID, to: "/app/orders" });
    rejects({ ...VALID, to: "orders?tab=items" });
    rejects({ ...VALID, from: "https://apsa.app/app" });
    rejects({ ...VALID, from: "owner@example.com" });
    rejects({ ...VALID, from: "" });
    rejects({ ...VALID, from: 1 });
  });

  it("rejects negative timings", () => {
    for (const field of ["navigateMs", "pendingMs", "loadedMs", "renderedMs", "contentMs"]) {
      rejects({ ...VALID, [field]: -0.1 });
    }
  });

  it("rejects NaN, Infinity and non-numbers", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, "120", null, true, {}]) {
      rejects({ ...VALID, navigateMs: bad });
    }
  });

  it("clamps excessive timings to MAX_TIMING_MS and rounds to whole ms", () => {
    expect(parseNavigationTelemetry({ ...VALID, loadedMs: 10 ** 12 })?.loadedMs).toBe(
      MAX_TIMING_MS,
    );
    expect(parseNavigationTelemetry({ ...VALID, loadedMs: MAX_TIMING_MS + 1 })?.loadedMs).toBe(
      MAX_TIMING_MS,
    );
    expect(parseNavigationTelemetry({ ...VALID, loadedMs: 920.46 })?.loadedMs).toBe(920);
  });

  it("bounds metadata", () => {
    rejects({ ...VALID, viewport: 0 });
    rejects({ ...VALID, viewport: 10_001 });
    rejects({ ...VALID, viewport: 390.5 });
    rejects({ ...VALID, locale: "fr" });
    rejects({ ...VALID, locale: "km-KH" });
    rejects({ ...VALID, clientTs: -1 });
    rejects({ ...VALID, clientTs: 1.5 });
    rejects({ ...VALID, tracked: "true" });
  });

  it("rejects non-object bodies", () => {
    for (const bad of [null, undefined, "x", 1, [], [VALID]]) rejects(bad);
  });

  it("bounds the payload size", () => {
    rejects({ ...VALID, to: "x".repeat(MAX_PAYLOAD_CHARS) });
    // A full valid record is well under the ceiling.
    expect(JSON.stringify(VALID).length).toBeLessThan(MAX_PAYLOAD_CHARS);
    const cyclic: Record<string, unknown> = { ...VALID };
    cyclic["self"] = cyclic;
    rejects(cyclic);
  });

  it("has exactly the documented keys", () => {
    expect(Object.keys(navigationTelemetrySchema.shape).sort()).toEqual(
      [
        "from",
        "to",
        "tracked",
        "navigateMs",
        "pendingMs",
        "loadedMs",
        "renderedMs",
        "contentMs",
        "viewport",
        "locale",
        "clientTs",
      ].sort(),
    );
  });

  it("covers every /app route screen, and nothing that looks like an identifier", () => {
    const routes = fs.readdirSync(path.join(ROOT, "src/routes")).filter((f) => /\.tsx$/.test(f));
    for (const file of routes) {
      if (file === "__root.tsx") continue;
      // app.orders.$id.tsx → /app/orders/x ; app.index.tsx → /app ; sign-in.tsx → /sign-in
      const segments = file
        .replace(/\.tsx$/, "")
        .split(".")
        .filter((s) => s !== "index")
        .map((s) => (s.startsWith("$") ? "x" : s));
      const label = screenOf(`/${segments.join("/")}`);
      expect(KNOWN_SCREENS).toContain(label);
    }
    for (const label of KNOWN_SCREENS) expect(label).toMatch(/^[a-z][a-z-]*(\.[a-z-]+)?$/);
  });
});

describe("client payload builder", () => {
  const record: NavigationTimingRecord = {
    event: "perf.navigation",
    from: "home",
    to: "orders",
    tracked: true,
    navigateMs: 120.4,
    pendingMs: 310,
    loadedMs: 920,
    renderedMs: 980,
    contentMs: 1120,
    contentTimedOut: true,
  };

  it("copies only allowlisted fields, never `event` or `contentTimedOut`", () => {
    const payload = toTelemetryPayload(record, { viewport: 393, locale: "km", clientTs: 1.5e12 });
    expect(payload).toEqual({
      from: "home",
      to: "orders",
      tracked: true,
      navigateMs: 120,
      pendingMs: 310,
      loadedMs: 920,
      renderedMs: 980,
      contentMs: 1120,
      viewport: 390,
      locale: "km",
      clientTs: 1.5e12,
    });
  });

  it("maps an unknown screen label to 'other' instead of sending it", () => {
    const payload = toTelemetryPayload({ ...record, to: "7d1c3a4e-0000-4000-8000-000000000003" });
    expect(payload?.to).toBe("other");
  });

  it("drops negative/NaN/Infinity timings and coarsens locale", () => {
    const payload = toTelemetryPayload(
      { ...record, navigateMs: -5, pendingMs: Number.NaN, loadedMs: Infinity },
      { locale: "en-US" },
    );
    expect(payload).not.toHaveProperty("navigateMs");
    expect(payload).not.toHaveProperty("pendingMs");
    expect(payload).not.toHaveProperty("loadedMs");
    expect(payload?.locale).toBe("en");
    expect(toTelemetryPayload(record, { locale: "fr" })).not.toHaveProperty("locale");
  });

  it("ignores extra properties smuggled onto the record", () => {
    const smuggled = { ...record, email: "owner@example.com", userId: "u1", url: "/app/orders/1" };
    const payload = toTelemetryPayload(smuggled);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("userId");
    expect(text).not.toContain("/app/orders/1");
  });

  it("every payload it builds passes the server schema", () => {
    const payload = toTelemetryPayload(record, {
      viewport: 1440,
      locale: "km",
      clientTs: Date.now(),
    });
    expect(parseNavigationTelemetry(payload)).toEqual(payload);
  });
});

describe("client transport (real installer)", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    flag: process.env.VITE_APSA_PERF_NAV_TIMING,
    info: console.info,
  };

  afterEach(() => {
    g.window = saved.window;
    g.document = saved.document;
    console.info = saved.info;
    if (saved.flag === undefined) delete process.env.VITE_APSA_PERF_NAV_TIMING;
    else process.env.VITE_APSA_PERF_NAV_TIMING = saved.flag;
  });

  function setup(flag: string | undefined, send: NavTelemetryTransport["send"]) {
    if (flag === undefined) delete process.env.VITE_APSA_PERF_NAV_TIMING;
    else process.env.VITE_APSA_PERF_NAV_TIMING = flag;
    const win: Record<string, unknown> = {
      requestAnimationFrame: (cb: () => void) => cb(),
      innerWidth: 390,
      location: { href: "https://apsa.app/app/orders/7d1c3a4e?q=dara" },
    };
    g.window = win;
    g.document = {
      addEventListener() {},
      querySelector: () => null,
      documentElement: { lang: "km" },
      cookie: "sb-access-token=secret",
    };
    console.info = () => {};
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const router: RouterLike = {
      subscribe(type, fn) {
        (handlers[type] ??= []).push(fn as (e: unknown) => void);
        return () => {};
      },
    };
    const scheduled: Array<() => void> = [];
    const sent: NavigationTelemetry[] = [];
    installNavigationTiming(router, {
      send: (payload) => {
        sent.push(payload);
        return send(payload);
      },
      schedule: (cb) => scheduled.push(cb),
    });
    const navigate = (from: string, to: string) => {
      const event = {
        fromLocation: { pathname: from },
        toLocation: { pathname: to },
        pathChanged: true,
      };
      for (const type of ["onBeforeNavigate", "onBeforeLoad", "onLoad", "onRendered"]) {
        for (const fn of handlers[type] ?? []) fn(event);
      }
    };
    const flush = () => {
      while (scheduled.length) scheduled.shift()!();
    };
    return { win, navigate, scheduled, sent, flush };
  }

  it("sends nothing when the client flag is off", () => {
    const { navigate, scheduled, sent, flush } = setup(undefined, () => {});
    for (let i = 0; i < 5; i++) navigate("/app", "/app/orders");
    flush();
    expect(scheduled).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("sends nothing for flag values other than exactly 'true'", () => {
    for (const flag of ["", "false", "1", "TRUE"]) {
      const { navigate, flush, sent } = setup(flag, () => {});
      navigate("/app", "/app/orders");
      flush();
      expect(sent).toEqual([]);
    }
  });

  it("sends exactly one allowlisted payload per completed navigation, never inline", () => {
    const { win, navigate, scheduled, sent, flush } = setup("true", () => {});
    navigate("/app", "/app/orders/7d1c3a4e-0000-4000-8000-000000000003?tab=items");
    // Nothing is sent on the navigation's own call stack.
    expect(sent).toEqual([]);
    expect(scheduled).toHaveLength(1);
    // The ring buffer is filled synchronously, exactly as before.
    expect((win.__apsaPerfNav as unknown[]).length).toBe(1);
    flush();
    expect(sent).toHaveLength(1);
    const payload = sent[0]!;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "clientTs",
        "from",
        "loadedMs",
        "navigateMs",
        "pendingMs",
        "renderedMs",
        "contentMs",
        "to",
        "tracked",
        "viewport",
        "locale",
      ].sort(),
    );
    expect(payload).toMatchObject({
      from: "home",
      to: "orders.detail",
      tracked: false,
      viewport: 390,
      locale: "km",
    });
    const text = JSON.stringify(payload);
    for (const secret of [
      "7d1c3a4e",
      "tab=items",
      "dara",
      "sb-access-token",
      "secret",
      "apsa.app",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a network failure never reaches navigation", async () => {
    const { win, navigate, flush, sent } = setup("true", () =>
      Promise.reject(new Error("offline")),
    );
    for (let i = 0; i < 3; i++) navigate("/app", "/app/orders");
    expect(() => flush()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(3);
    expect((win.__apsaPerfNav as unknown[]).length).toBe(3);
  });

  it("a rate-limited (dropped or 429) send never reaches navigation and is not retried", async () => {
    let calls = 0;
    const { win, navigate, flush, scheduled } = setup("true", () => {
      calls += 1;
      // The server drops a limited record and resolves; a 429 from any other
      // layer rejects. Alternate both.
      return calls % 2 ? Promise.resolve(undefined) : Promise.reject(new Error("429"));
    });
    for (let i = 0; i < 4; i++) navigate("/app", "/app/orders");
    expect(() => flush()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(4);
    expect(scheduled).toEqual([]);
    expect((win.__apsaPerfNav as unknown[]).length).toBe(4);
  });

  it("a synchronous transport throw never reaches navigation", () => {
    const { win, navigate, flush } = setup("true", () => {
      throw new Error("boom");
    });
    for (let i = 0; i < 3; i++) navigate("/app", "/app/orders");
    expect(() => flush()).not.toThrow();
    expect((win.__apsaPerfNav as unknown[]).length).toBe(3);
  });

  it("does not retry a failed send", async () => {
    let calls = 0;
    const { navigate, flush, scheduled } = setup("true", () => {
      calls += 1;
      return Promise.reject(new Error("offline"));
    });
    navigate("/app", "/app/orders");
    flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(scheduled).toEqual([]);
  });

  it("caps sends per page load while the 50-record buffer keeps rolling", () => {
    const { win, navigate, flush, sent } = setup("true", () => {});
    for (let i = 0; i < 250; i++) navigate(`/app/s${i}`, `/app/s${i + 1}`);
    flush();
    expect(sent).toHaveLength(200);
    expect((win.__apsaPerfNav as unknown[]).length).toBe(50);
  });

  it("the default transport posts through the server function, lazily imported", () => {
    const source = read("src/lib/perf/navigation-timing.ts");
    expect(source).toContain('await import("@/api/perf-telemetry")');
    expect(source).toContain("setTimeout(cb, 0)");
    expect(source).not.toMatch(
      /localStorage|sessionStorage|document\.cookie|location\.(href|search|pathname)|userAgent/,
    );
  });
});
