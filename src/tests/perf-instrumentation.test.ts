/**
 * Perf instrumentation (src/server/observability/perf.ts,
 * src/lib/perf/navigation-timing.ts) — gate, pass-through, redaction.
 *
 * The auth-chain equivalence checks (same results, same errors, same cookie
 * effects with the flag on and off) run in an isolated child process — see
 * perf-instrumentation.runtime.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  PERF_FLAG,
  PERF_PHASES,
  buildPerfFields,
  createPerfCollector,
  isPerfInstrumentationEnabled,
  timePhase,
  type PerfPhase,
} from "@/server/observability/perf";
import { runWithRequestContext } from "@/server/observability/request-context";
import { buildLogRecord, setLogSink } from "@/server/observability/logger";
import { REDACTED } from "@/server/observability/redact";
import { runServerFnBoundary } from "@/server/observability/server-fn-boundary";
import { ForbiddenError } from "@/server/auth/authorization";
import {
  attachNavigationTiming,
  isNavTimingEnabled,
  isTrackedNavigation,
  screenOf,
  type NavigationTimingRecord,
  type RouterLike,
} from "@/lib/perf/navigation-timing";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function captureLines() {
  const lines: string[] = [];
  const restore = setLogSink((_level, line) => lines.push(line));
  return { lines, restore };
}
const perfLines = (lines: string[]) =>
  lines.filter((l) => (JSON.parse(l) as { event: string }).event === "perf.server_function");

afterEach(() => {
  delete process.env[PERF_FLAG];
});

describe("server gate", () => {
  it("is OFF by default and only ON for an explicit true", () => {
    expect(isPerfInstrumentationEnabled({})).toBe(false);
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "" })).toBe(false);
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "false" })).toBe(false);
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "1" })).toBe(false);
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "yes" })).toBe(false);
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "true" })).toBe(true);
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "TRUE" })).toBe(true);
  });

  it("stays OFF on a Vercel production deployment even when the flag is set", () => {
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "true", VERCEL_ENV: "production" })).toBe(
      false,
    );
    expect(isPerfInstrumentationEnabled({ [PERF_FLAG]: "true", VERCEL_ENV: "preview" })).toBe(true);
  });

  it("is OFF in this test process's default environment", () => {
    delete process.env[PERF_FLAG];
    expect(isPerfInstrumentationEnabled()).toBe(false);
  });

  it("is a server-only flag: never VITE_-prefixed, never read by browser code", () => {
    expect(PERF_FLAG).toBe("APSA_PERF_INSTRUMENTATION");
    expect(PERF_FLAG.startsWith("VITE_")).toBe(false);
    expect(read("src/lib/perf/navigation-timing.ts")).not.toContain("APSA_PERF_INSTRUMENTATION=");
    expect(read("src/lib/perf/navigation-timing.ts")).not.toContain("process.env");
  });

  it("is never statically imported by a browser-bundled file", () => {
    const clientDirs = ["src/api", "src/routes", "src/lib", "src/components", "src/hooks"];
    for (const dir of clientDirs) {
      const walk = (d: string): string[] =>
        fs
          .readdirSync(path.join(ROOT, d), { withFileTypes: true })
          .flatMap((e) =>
            e.isDirectory()
              ? walk(path.join(d, e.name))
              : /\.(ts|tsx)$/.test(e.name)
                ? [path.join(d, e.name)]
                : [],
          );
      for (const file of walk(dir)) {
        const staticImports = read(file)
          .split("\n")
          .filter((l) => /^\s*import\s(?!type\b)/.test(l) && l.includes("observability/perf"));
        expect(staticImports, file).toEqual([]);
      }
    }
  });
});

describe("timePhase", () => {
  it("returns the very same promise when no collector is active (instrumentation off)", async () => {
    const promise = Promise.resolve({ value: 42 });
    expect(timePhase("authz.roles", () => promise)).toBe(promise);
    // Also inside a request context that has no collector.
    await runWithRequestContext({ requestId: "req_00000000000000000000" }, async () => {
      expect(timePhase("authz.roles", () => promise)).toBe(promise);
    });
  });

  it("preserves the exact return value when a collector is active", async () => {
    const collector = createPerfCollector();
    const value = { rows: [1, 2, 3] };
    const result = await runWithRequestContext(
      { requestId: "req_00000000000000000000", perf: collector },
      () => timePhase("authz.permissions", async () => value),
    );
    expect(result).toBe(value);
    expect(collector.phases.get("authz.permissions")?.count).toBe(1);
  });

  it("rethrows the exact same error object and still records the phase", async () => {
    const collector = createPerfCollector();
    const error = new ForbiddenError("Missing permission: orders.view");
    let caught: unknown;
    try {
      await runWithRequestContext({ requestId: "req_00000000000000000000", perf: collector }, () =>
        timePhase("authz.verifyMembership", async () => {
          throw error;
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(error);
    expect(collector.phases.get("authz.verifyMembership")?.count).toBe(1);
  });

  it("accumulates repeated phases with a count", async () => {
    const collector = createPerfCollector();
    await runWithRequestContext(
      { requestId: "req_00000000000000000000", perf: collector },
      async () => {
        await timePhase("session.total", async () => null);
        await timePhase("session.total", async () => null);
      },
    );
    const fields = buildPerfFields(collector, "ok");
    expect(fields["identityCount"]).toBe(2);
  });
});

describe("perf log fields", () => {
  it("every field survives redaction and none carries an identifier", () => {
    const collector = createPerfCollector();
    for (const phase of Object.keys(PERF_PHASES) as PerfPhase[]) {
      collector.phases.set(phase, { ms: 12.345, count: 2 });
    }
    const fields = buildPerfFields(collector, "ok", collector.startedAt + 500);
    const record = buildLogRecord("info", "perf.server_function", {
      route: "orders.listOrdersFn",
      ...fields,
    });
    for (const [key, value] of Object.entries(record)) {
      expect(value, key).not.toBe(REDACTED);
    }
    for (const key of Object.keys(fields)) {
      expect(key).toMatch(/^[a-zA-Z]+(Ms|Count)$|^outcome$/);
    }
    expect(record).not.toHaveProperty("userId");
    expect(record).not.toHaveProperty("organizationId");
    expect(fields["totalMs"]).toBe(500);
    // Only top-level phases add up to authorization; sub-phases are nested.
    expect(fields["authzMs"]).toBeCloseTo(12.345 * 4, 0);
    expect(fields["queryMs"]).toBeCloseTo(500 - 12.345 * 4, 0);
  });
});

describe("server-function boundary", () => {
  const META = { name: "listOrdersFn", filename: "src/api/orders.ts" };

  it("OFF: no perf line, same value", async () => {
    const { lines, restore } = captureLines();
    const value = { ok: true };
    try {
      expect(await runServerFnBoundary(META, async () => value)).toBe(value);
    } finally {
      restore();
    }
    expect(perfLines(lines)).toEqual([]);
  });

  it("ON: one perf line, same value", async () => {
    process.env[PERF_FLAG] = "true";
    const { lines, restore } = captureLines();
    const value = { ok: true };
    try {
      expect(await runServerFnBoundary(META, async () => value)).toBe(value);
    } finally {
      restore();
    }
    const perf = perfLines(lines);
    expect(perf).toHaveLength(1);
    const record = JSON.parse(perf[0]!) as Record<string, unknown>;
    expect(record["route"]).toBe("orders.listOrdersFn");
    expect(record["outcome"]).toBe("ok");
    expect(String(record["requestId"])).toMatch(/^req_[0-9a-f]{20}$/);
  });

  it("ON: a public domain error propagates as the same object", async () => {
    process.env[PERF_FLAG] = "true";
    const error = new ForbiddenError("No active organization membership");
    const { lines, restore } = captureLines();
    let caught: unknown;
    try {
      await runServerFnBoundary(META, async () => {
        throw error;
      });
    } catch (e) {
      caught = e;
    } finally {
      restore();
    }
    expect(caught).toBe(error);
    const record = JSON.parse(perfLines(lines)[0]!) as Record<string, unknown>;
    expect(record["outcome"]).toBe("error");
  });

  it("ON and OFF sanitize an unexpected error identically, with no raw text in the perf line", async () => {
    const secret = 'duplicate key value violates "customers_email_key" (a@b.co) SELECT *';
    const attempt = async () => {
      const { lines, restore } = captureLines();
      try {
        await runServerFnBoundary(META, async () => {
          throw new Error(secret);
        });
        return { message: "", name: "", lines };
      } catch (e) {
        const err = e as Error;
        return {
          name: err.name,
          message: err.message.replace(/req_[0-9a-f]{20}/g, "req_X"),
          lines,
        };
      } finally {
        restore();
      }
    };
    const off = await attempt();
    process.env[PERF_FLAG] = "true";
    const on = await attempt();
    expect(on.name).toBe(off.name);
    expect(on.message).toBe(off.message);
    expect(on.message).not.toContain("violates");
    const perf = perfLines(on.lines);
    expect(perf).toHaveLength(1);
    for (const fragment of ["violates", "a@b.co", "SELECT", "customers_email_key"]) {
      expect(perf[0]).not.toContain(fragment);
    }
  });

  it("nested server-function calls produce one perf line for the outer call", async () => {
    process.env[PERF_FLAG] = "true";
    const { lines, restore } = captureLines();
    try {
      await runServerFnBoundary(META, () =>
        runServerFnBoundary({ name: "getSessionFn", filename: "src/api/auth.ts" }, async () =>
          timePhase("session.total", async () => null),
        ),
      );
    } finally {
      restore();
    }
    const perf = perfLines(lines);
    expect(perf).toHaveLength(1);
    const record = JSON.parse(perf[0]!) as Record<string, unknown>;
    expect(record["route"]).toBe("orders.listOrdersFn");
    expect(typeof record["identityMs"]).toBe("number");
  });
});

describe("auth-chain equivalence (isolated runtime)", () => {
  it("runs perf-instrumentation.runtime.ts in a child process", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/perf-instrumentation.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});

// ── Client navigation timing ─────────────────────────────────────────────────

describe("navigation timing", () => {
  it("is OFF by default", () => {
    expect(isNavTimingEnabled(undefined)).toBe(false);
    expect(isNavTimingEnabled({})).toBe(false);
    expect(isNavTimingEnabled({ VITE_APSA_PERF_NAV_TIMING: "false" })).toBe(false);
    expect(isNavTimingEnabled({ VITE_APSA_PERF_NAV_TIMING: true })).toBe(false);
    expect(isNavTimingEnabled({ VITE_APSA_PERF_NAV_TIMING: "true" })).toBe(true);
  });

  it("labels screens without IDs or search params", () => {
    expect(screenOf("/app")).toBe("home");
    expect(screenOf("/app/")).toBe("home");
    expect(screenOf("/app/orders")).toBe("orders");
    expect(screenOf("/app/orders/3f1c2a9e-1111-2222-3333-444444444444")).toBe("orders.detail");
    expect(screenOf("/app/customers?q=Sok%20Dara&phone=012345678")).toBe("customers");
    expect(screenOf("/sign-in")).toBe("public.sign-in");
    expect(screenOf("")).toBe("public.root");
  });

  it("marks the requested journeys as tracked", () => {
    for (const [from, to] of [
      ["home", "orders"],
      ["orders", "pos"],
      ["pos", "customers"],
      ["customers", "products"],
      ["products", "inventory"],
      ["home", "payments"],
      ["home", "deliveries"],
    ] as const) {
      expect(isTrackedNavigation(from, to)).toBe(true);
    }
    expect(isTrackedNavigation("orders", "home")).toBe(false);
  });

  it("records click → navigate → pending → loaded → rendered → content", () => {
    type Handler = (event: {
      fromLocation?: { pathname: string };
      toLocation: { pathname: string };
      pathChanged: boolean;
    }) => void;
    const handlers: Record<string, Handler[]> = {};
    const router: RouterLike = {
      subscribe: (type, fn) => {
        (handlers[type] ??= []).push(fn);
        return () => undefined;
      },
    };
    let clock = 0;
    let click: () => void = () => undefined;
    const frames: Array<() => void> = [];
    let loading = true;
    const emitted: NavigationTimingRecord[] = [];
    attachNavigationTiming(router, {
      now: () => clock,
      requestFrame: (cb) => frames.push(cb),
      isLoadingVisible: () => loading,
      onClick: (cb) => (click = cb),
      emit: (r) => emitted.push(r),
    });
    const fire = (type: string) =>
      handlers[type]!.forEach((h) =>
        h({
          fromLocation: { pathname: "/app" },
          toLocation: { pathname: "/app/orders" },
          pathChanged: true,
        }),
      );

    clock = 100;
    click();
    clock = 105;
    fire("onBeforeNavigate");
    clock = 110;
    fire("onBeforeLoad");
    clock = 600;
    fire("onLoad");
    clock = 650;
    fire("onRendered");
    clock = 700;
    frames.shift()!(); // still skeleton
    loading = false;
    clock = 900;
    frames.shift()!();

    expect(emitted).toEqual([
      {
        event: "perf.navigation",
        from: "home",
        to: "orders",
        tracked: true,
        navigateMs: 5,
        pendingMs: 10,
        loadedMs: 500,
        renderedMs: 550,
        contentMs: 800,
      },
    ]);
  });

  it("is wired into the router only through the gated installer", () => {
    const router = read("src/router.tsx");
    expect(router).toContain("installNavigationTiming(router)");
    const source = read("src/lib/perf/navigation-timing.ts");
    expect(source).toContain("isNavTimingEnabled(import.meta.env");
    expect(source).toContain('typeof window === "undefined"');
  });
});
