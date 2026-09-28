/**
 * Operability — health / readiness / migration-level evidence.
 *
 *   /api/health           public liveness; reveals nothing
 *   env-check             required server variables, by NAME only
 *   migration-level lib   EXPECTED vs HOSTED from observable footprints
 *   check-staging-readiness   prints EXPECTED/HOSTED from the lock file
 *   verify-readiness      refuses without staging credentials; never "ready" by default
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { HEALTH_PATH, healthResponse, isHealthRequest } from "@/lib/health";
import { missingServerEnv, REQUIRED_SERVER_ENV } from "@/server/observability/env-check";
import {
  collectCalledRpcs,
  collectMigrationFootprints,
  computeMigrationLevel,
  formatMigrationNumber,
  parseOpenApiSurface,
  type HostedSurface,
} from "../../scripts/lib/migration-level.ts";

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const files = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();
const contents = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
const footprints = collectMigrationFootprints(files, contents);

function surfaceUpTo(lastNumber: number): HostedSurface {
  const tables = new Set<string>();
  const functions = new Set<string>();
  for (const f of footprints) {
    if (f.number > lastNumber) continue;
    f.tables.forEach((t) => tables.add(t));
    f.functions.forEach((fn) => functions.add(fn));
  }
  return { tables, functions };
}

describe("public liveness endpoint", () => {
  it("answers GET/HEAD with {status: ok} and nothing else", async () => {
    const response = healthResponse("GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(healthResponse("HEAD").status).toBe(200);
    expect(healthResponse("POST").status).toBe(405);
  });

  it("matches only its own path", () => {
    expect(isHealthRequest(new Request(`https://apsa.test${HEALTH_PATH}`))).toBe(true);
    expect(isHealthRequest(new Request("https://apsa.test/api/health/x"))).toBe(false);
    expect(isHealthRequest(new Request("https://apsa.test/app"))).toBe(false);
  });

  it("touches no database, environment or version information", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/health.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.env|supabase|import\(|version|commit/i);
    const server = fs.readFileSync(path.join(ROOT, "src/server.ts"), "utf8");
    expect(server.indexOf("isHealthRequest(request)")).toBeLessThan(
      server.indexOf("const handler = await getServerEntry()"),
    );
  });
});

describe("required server environment", () => {
  it("reports missing names only — never values", () => {
    const env = { VITE_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "  " };
    expect(missingServerEnv(env, false)).toEqual([
      "VITE_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]);
    expect(missingServerEnv(env, true)).toContain("VITE_APP_URL");
    const all = Object.fromEntries(REQUIRED_SERVER_ENV.map((n) => [n, "set"]));
    expect(missingServerEnv({ ...all, VITE_APP_URL: "https://app.apsa.test" }, true)).toEqual([]);
  });
});

describe("migration level evidence", () => {
  it("expects the latest repository migration", () => {
    const report = computeMigrationLevel(footprints, surfaceUpTo(Number.POSITIVE_INFINITY));
    expect(report.expected?.file).toBe(files.at(-1));
    expect(report.atExpected).toBe(true);
    expect(report.firstMissing).toBeNull();
  });

  it("reports a hosted project at 008 honestly, naming the first missing object", () => {
    const report = computeMigrationLevel(footprints, surfaceUpTo(8));
    expect(formatMigrationNumber(report.hosted?.number)).toBe("008");
    expect(formatMigrationNumber(report.expected?.number)).toBe(files.at(-1)!.slice(0, 3));
    expect(report.atExpected).toBe(false);
    expect(report.firstMissing?.file).toBe("009_create_organization_rpc.sql");
  });

  it("detects out-of-order application", () => {
    const surface = surfaceUpTo(8);
    const late = footprints.find((f) => f.file.startsWith("045_"))!;
    const tables = new Set(surface.tables);
    late.tables.forEach((t) => tables.add(t));
    const report = computeMigrationLevel(footprints, { tables, functions: surface.functions });
    expect(report.presentBeyondGap).toContain(late.file);
  });

  it("knows migration 045's footprint (the operability witness)", () => {
    const f045 = footprints.find((f) => f.file.startsWith("045_"))!;
    expect(f045.tables.sort()).toEqual(["rate_limit_buckets", "webhook_event_receipts"]);
    expect(f045.functions.sort()).toEqual([
      "apsa_schema_level",
      "claim_webhook_event",
      "consume_rate_limit",
      "prune_rate_limit_buckets",
      "release_webhook_event",
    ]);
  });

  it("excludes trigger functions (PostgREST never exposes them)", () => {
    const all = footprints.flatMap((f) => f.functions);
    expect(all).not.toContain("guard_order_amounts_immutable");
  });

  it("reads the PostgREST OpenAPI surface", () => {
    const surface = parseOpenApiSurface({
      paths: { "/": {}, "/orders": {}, "/rpc/create_order_v2": {}, "/rpc/Weird-Name": {} },
    });
    expect([...surface.tables]).toEqual(["orders"]);
    expect([...surface.functions]).toEqual(["create_order_v2"]);
    expect(parseOpenApiSurface(null).tables.size).toBe(0);
  });

  it("every RPC the server calls is created by some migration", () => {
    const listFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? listFiles(full) : /\.tsx?$/.test(e.name) ? [full] : [];
      });
    const called = collectCalledRpcs(
      [...listFiles(path.join(ROOT, "src/server")), ...listFiles(path.join(ROOT, "src/api"))].map(
        (f) => fs.readFileSync(f, "utf8"),
      ),
    );
    const created = new Set(footprints.flatMap((f) => f.functions));
    expect(called.length).toBeGreaterThan(10);
    expect(called.filter((name) => !created.has(name))).toEqual([]);
    expect(called).toContain("consume_rate_limit");
    expect(called).toContain("create_order_v2");
  });
});

describe("readiness tooling", () => {
  it("offline check prints EXPECTED vs HOSTED from the lock file", () => {
    const run = spawnSync(process.execPath, ["run", "scripts/check-staging-readiness.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        STAGING_SUPABASE_URL: "",
        STAGING_SUPABASE_ANON_KEY: "",
        STAGING_SUPABASE_SERVICE_ROLE_KEY: "",
      },
    });
    expect(run.stdout).toMatch(/EXPECTED: \d{3} \(\d{3}_[a-z0-9_]+\.sql\)/);
    expect(run.stdout).toMatch(/HOSTED: {3}008 \(008_audit_logs\.sql\)/);
  });

  it("hosted readiness refuses to run (exit 2) without staging credentials — never a silent pass", () => {
    const run = spawnSync(process.execPath, ["run", "scripts/verify-readiness.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        STAGING_SUPABASE_URL: "",
        STAGING_SUPABASE_ANON_KEY: "",
        STAGING_SUPABASE_SERVICE_ROLE_KEY: "",
        PRODUCTION_SUPABASE_URL: "",
        VITE_SUPABASE_URL: "",
      },
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Readiness has NOT been verified");
  });

  it("hosted readiness is read-only by construction", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts/verify-readiness.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    const rpcCalls = [...code.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rpcCalls).toEqual(["apsa_schema_level"]);
    expect(code).toContain("evaluateProbeGate");
  });
});
