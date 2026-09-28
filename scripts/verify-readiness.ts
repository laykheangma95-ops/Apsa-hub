/**
 * APSA — Readiness verification (read-only; staging only)
 *
 * Separates two claims that are easy to conflate:
 *
 *   APPLICATION BUILT   — typecheck, tests and `vite build` pass. Proven by CI.
 *   READY TO SERVE REAL MERCHANTS — the deployed server boots, its database is
 *     reachable, the database has reached the migration level THIS checkout
 *     expects, and every RPC the application calls exists. Proven here, or
 *     not at all.
 *
 * Checks (each reports PASS / FAIL / INCONCLUSIVE / NOT CONFIGURED; only PASS
 * counts):
 *   1. Server boots          GET <--app-url>/api/health → 200 {"status":"ok"}
 *   2. Required environment  names only, from the shell this runs in (e.g. a
 *                            pulled deployment env) — values never read out
 *   3. Database reachable    service-role HEAD count on organizations
 *   4. Migration level       EXPECTED (this checkout) vs HOSTED (evidence from
 *                            the PostgREST OpenAPI surface) — see
 *                            scripts/lib/migration-level.ts
 *   5. Critical RPCs         every `.rpc("…")` the server code calls exists
 *   6. Operability schema    apsa_schema_level() (migration 045, STABLE,
 *                            read-only) answers 45
 *
 * SAFETY CONTRACT
 *   · Read-only: one OpenAPI GET, one HEAD count, one call to a STABLE
 *     constant function, one GET of /api/health. Nothing is written, no
 *     migration is applied, no configuration is changed.
 *   · Staging only: the same production-witness gate as verify-staging.ts —
 *     the run refuses unless a production URL is supplied AND differs from the
 *     staging URL.
 *   · Never prints a key, token, URL credential or row content.
 *
 * Environment:
 *   STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY                (required)
 *   PRODUCTION_SUPABASE_URL or VITE_SUPABASE_URL     (required safety witness)
 *   STAGING_REQUEST_TIMEOUT_MS                        (optional, default 15000)
 *
 * Usage:
 *   bun run scripts/verify-readiness.ts --app-url=https://<staging-deployment>
 *   bun run scripts/verify-readiness.ts --check-app-env   # also check this shell's app env names
 *
 * Exit codes:
 *   0 — READY: every check passed
 *   1 — NOT READY: a check failed or could not be proven
 *   2 — refused / prerequisites missing: nothing was verified
 */

import * as fs from "fs";
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { evaluateProbeGate, readTimeoutMs } from "./lib/staging-readiness.ts";
import {
  collectCalledRpcs,
  collectMigrationFootprints,
  computeMigrationLevel,
  formatMigrationNumber,
  parseOpenApiSurface,
} from "./lib/migration-level.ts";
import { OPTIONAL_SERVER_ENV, missingServerEnv } from "../src/server/observability/env-check.ts";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const args = process.argv.slice(2);
const appUrlArg = args.find((a) => a.startsWith("--app-url="))?.slice("--app-url=".length);
const checkAppEnv = args.includes("--check-app-env");

let passed = 0;
let failed = 0;
let inconclusive = 0;
let unconfigured = 0;

const pass = (m: string) => {
  console.log(`  PASS            ${m}`);
  passed++;
};
const fail = (m: string) => {
  console.error(`  FAIL            ${m}`);
  failed++;
};
const unclear = (m: string) => {
  console.log(`  INCONCLUSIVE    ${m}`);
  inconclusive++;
};
const missing = (m: string) => {
  console.log(`  NOT CONFIGURED  ${m}`);
  unconfigured++;
};
const info = (m: string) => console.log(`  ·               ${m}`);
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

console.log("APSA — readiness verification (read-only)");

// ── Safety gate ──────────────────────────────────────────────────────────────

section("Prerequisites and safety gate");

const URL_ = (process.env["STAGING_SUPABASE_URL"] ?? "").trim();
const ANON = (process.env["STAGING_SUPABASE_ANON_KEY"] ?? "").trim();
const SERVICE = (process.env["STAGING_SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();
const PRODUCTION_WITNESS =
  (process.env["PRODUCTION_SUPABASE_URL"] ?? "").trim() ||
  (process.env["VITE_SUPABASE_URL"] ?? "").trim();

const gate = evaluateProbeGate({
  stagingUrl: URL_,
  productionUrlWitness: PRODUCTION_WITNESS,
  anonKey: ANON,
  serviceKey: SERVICE,
});

if (!gate.allowed) {
  for (const message of gate.messages) console.error(`  REFUSED         ${message}`);
  console.error(
    "\n  REFUSING TO RUN — no hosted request was made. Readiness has NOT been verified.\n" +
      `  Codes: ${gate.refusals.join(", ")}\n`,
  );
  process.exit(2);
}
pass("Safety gate cleared: staging target is distinct from the production witness.");

const REQUEST_TIMEOUT_MS = readTimeoutMs(process.env, "STAGING_REQUEST_TIMEOUT_MS", 15_000);

async function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const admin = createClient(URL_, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: boundedFetch },
});

// ── 1. Server boots ──────────────────────────────────────────────────────────

section("1. Server boots (public liveness)");

if (!appUrlArg) {
  missing("--app-url not given — the deployed server was not checked.");
} else {
  try {
    const target = new URL("/api/health", appUrlArg);
    const response = await boundedFetch(target, { method: "GET" });
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    if (response.status === 200 && body?.status === "ok") {
      pass(`GET ${target.origin}/api/health → 200 {"status":"ok"}`);
    } else {
      fail(`GET ${target.origin}/api/health → ${response.status} (expected 200 {"status":"ok"})`);
    }
  } catch (error) {
    unclear(
      `Deployed server did not answer /api/health (${error instanceof Error ? error.name : "error"}).`,
    );
  }
}

// ── 2. Required environment (names only) ─────────────────────────────────────

section("2. Required server environment (names only)");

if (!checkAppEnv) {
  missing(
    "--check-app-env not given. Pull the deployment's environment into this shell " +
      "(e.g. `vercel env pull`) and re-run with --check-app-env to verify it.",
  );
} else {
  const absent = missingServerEnv(process.env, true);
  if (absent.length === 0) pass("Every required server variable is set.");
  else fail(`Required server variable(s) not set: ${absent.join(", ")}`);
  const optionalAbsent = OPTIONAL_SERVER_ENV.filter((name) => !process.env[name]);
  if (optionalAbsent.length > 0) info(`Optional, not set: ${optionalAbsent.join(", ")}`);
}

// ── 3. Database reachable ────────────────────────────────────────────────────

section("3. Database reachable (service role)");

try {
  const { error } = await admin.from("organizations").select("id", { head: true, count: "exact" });
  if (!error) pass("organizations is reachable with the service role.");
  else fail(`organizations read failed (code ${error.code ?? "unknown"}).`);
} catch (error) {
  fail(`Database request did not complete (${error instanceof Error ? error.name : "error"}).`);
}

// ── 4. Migration level ───────────────────────────────────────────────────────

section("4. Migration level — EXPECTED vs HOSTED");

const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]));
const footprints = collectMigrationFootprints(
  migrationFiles,
  migrationFiles.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")),
);

let hostedFunctions: ReadonlySet<string> | null = null;
try {
  const response = await boundedFetch(`${URL_.replace(/\/+$/, "")}/rest/v1/`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!response.ok) {
    unclear(
      `PostgREST OpenAPI surface not readable (HTTP ${response.status}) — hosted level not determined.`,
    );
  } else {
    const surface = parseOpenApiSurface(await response.json());
    hostedFunctions = surface.functions;
    const report = computeMigrationLevel(footprints, surface);
    console.log(
      `\n  EXPECTED: ${formatMigrationNumber(report.expected?.number)} (${report.expected?.file ?? "none"})`,
    );
    console.log(
      `  HOSTED:   ${formatMigrationNumber(report.hosted?.number)} (${report.hosted?.file ?? "no migration footprint present"})\n`,
    );
    if (report.atExpected) {
      pass("Hosted database has reached the migration level this checkout expects.");
    } else {
      fail(
        "Hosted database is BEHIND this checkout" +
          (report.firstMissing
            ? ` — first missing: ${report.firstMissing.kind} ${report.firstMissing.name} ` +
              `(${report.firstMissing.file}).`
            : "."),
      );
      info(
        "Nothing is applied by this tool. Apply pending migrations only through the approved rehearsal.",
      );
    }
    if (report.presentBeyondGap.length > 0) {
      fail(
        `Objects from migrations after the first gap are present — applied out of order: ` +
          report.presentBeyondGap.join(", "),
      );
    }
    if (report.unobservable.length > 0) {
      info(
        `${report.unobservable.length} ALTER-only migration(s) have no observable footprint and are ` +
          `not proven by this check: ${report.unobservable.join(", ")}`,
      );
    }
  }
} catch (error) {
  unclear(`OpenAPI request did not complete (${error instanceof Error ? error.name : "error"}).`);
}

// ── 5. Critical RPCs ─────────────────────────────────────────────────────────

section("5. Critical RPCs called by the application");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const calledRpcs = collectCalledRpcs(
  [path.join(ROOT, "src/server"), path.join(ROOT, "src/api")]
    .flatMap(listSourceFiles)
    .map((file) => fs.readFileSync(file, "utf8")),
);

if (!hostedFunctions) {
  unclear(`Hosted RPC surface unknown — ${calledRpcs.length} called RPC(s) not verified.`);
} else {
  const absent = calledRpcs.filter((name) => !hostedFunctions!.has(name));
  if (absent.length === 0)
    pass(`All ${calledRpcs.length} RPCs the server calls exist on the target.`);
  else
    fail(
      `${absent.length} of ${calledRpcs.length} RPCs the server calls are MISSING: ${absent.join(", ")}`,
    );
}

// ── 6. Operability schema witness ────────────────────────────────────────────

section("6. Operability schema (migration 045)");

try {
  const { data, error } = await admin.rpc("apsa_schema_level");
  if (!error && data === 45)
    pass("apsa_schema_level() = 45 — rate-limit and webhook stores exist.");
  else if (error)
    fail(
      `apsa_schema_level() unavailable (code ${error.code ?? "unknown"}) — migration 045 not applied.`,
    );
  else fail(`apsa_schema_level() returned an unexpected value.`);
} catch (error) {
  unclear(
    `apsa_schema_level() request did not complete (${error instanceof Error ? error.name : "error"}).`,
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log(
  `  ${passed} pass, ${failed} fail, ${inconclusive} inconclusive, ${unconfigured} not configured.`,
);
console.log("═".repeat(64));

if (failed === 0 && inconclusive === 0 && unconfigured === 0) {
  console.log("\n  READY — every readiness check passed against this target.\n");
  process.exit(0);
}
console.error(
  "\n  NOT READY — application may be BUILT, but it is not proven ready to serve real merchants.\n",
);
process.exit(1);
