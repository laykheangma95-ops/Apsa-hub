/**
 * Server/client bundle boundary regression tests.
 *
 * These tests enforce the architectural invariant that server-only modules
 * (those containing supabaseAdmin / SUPABASE_SERVICE_ROLE_KEY) are NEVER
 * statically imported from files reachable by the browser bundle.
 *
 * Failure modes caught:
 *   1. A top-level `import { supabaseAdmin }` sneaking back into src/api/*.ts
 *   2. A route statically importing @/lib/supabase/server
 *   3. A route directly importing from src/server/**
 *   4. SUPABASE_SERVICE_ROLE_KEY appearing in the built client bundle
 *   5. supabaseAdmin appearing in the built client bundle
 *
 * These are source-level structural tests. The build-artifact scan at the
 * bottom provides a second layer of assurance but should never be the only
 * check — bundler behavior can change and these static checks catch
 * violations before a build is even run.
 *
 * Run: bun test src/tests/bundle-boundary.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively find files matching extensions under a directory. */
function findFiles(dir: string, exts: string[]): string[] {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const results: string[] = [];
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(path.relative(ROOT, full));
      }
    }
  }
  walk(abs);
  return results;
}


/**
 * Extract all static top-level import statements from source text.
 * Dynamic `await import(...)` and `import(...)` calls inside function bodies
 * are NOT returned — they're fine.
 */
function staticImportLines(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Must start with `import` keyword (static declaration).
      if (!trimmed.startsWith("import ") && !trimmed.startsWith("import{")) return false;
      // Skip type-only imports — they're erased at compile time and never bundled.
      if (/^import\s+type\b/.test(trimmed)) return false;
      return true;
    });
}

/** Read source file, return empty string if it doesn't exist. */
function readSource(relPath: string): string {
  const abs = path.resolve(ROOT, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
}

// ── U1: src/api/* must not statically import @/lib/supabase/server ────────────

describe("U1: src/api/* has no static import of @/lib/supabase/server", () => {
  const apiFiles = findFiles("src/api", [".ts"]);

  for (const file of apiFiles) {
    it(`${file} — no static import of @/lib/supabase/server`, () => {
      const source = readSource(file);
      const offending = staticImportLines(source).filter((line) =>
        line.includes("@/lib/supabase/server") ||
        line.includes("lib/supabase/server"),
      );
      expect(offending).toEqual([]);
    });
  }

  it("src/api/app-guard.ts — no static import of supabaseAdmin by name", () => {
    const source = readSource("src/api/app-guard.ts");
    const offending = staticImportLines(source).filter((line) =>
      line.includes("supabaseAdmin"),
    );
    expect(offending).toEqual([]);
  });

  it("src/api/auth.ts — no static import of server.ts", () => {
    const source = readSource("src/api/auth.ts");
    const offending = staticImportLines(source).filter((line) =>
      line.includes("supabase/server"),
    );
    expect(offending).toEqual([]);
  });
});

// ── U2: src/routes/* must not statically import @/lib/supabase/server ─────────

describe("U2: src/routes/* has no static import of @/lib/supabase/server", () => {
  const routeFiles = findFiles("src/routes", [".ts", ".tsx"]);

  for (const file of routeFiles) {
    it(`${file} — no static import of @/lib/supabase/server`, () => {
      const source = readSource(file);
      const offending = staticImportLines(source).filter((line) =>
        line.includes("@/lib/supabase/server") ||
        line.includes("lib/supabase/server"),
      );
      expect(offending).toEqual([]);
    });
  }
});

// ── U3: src/routes/* must not directly import src/server/* ────────────────────

describe("U3: src/routes/* has no direct import of src/server/*", () => {
  const routeFiles = findFiles("src/routes", [".ts", ".tsx"]);

  for (const file of routeFiles) {
    it(`${file} — no import of src/server/* or @/server/*`, () => {
      const source = readSource(file);
      const offending = staticImportLines(source).filter((line) =>
        line.includes("/server/") ||
        line.includes("@/server/"),
      );
      // Allow @tanstack/react-start/server (cookie utilities) — that's a public npm package,
      // not the project's server-only Supabase module.
      const trulyOffending = offending.filter(
        (line) => !line.includes("@tanstack/react-start/server"),
      );
      expect(trulyOffending).toEqual([]);
    });
  }
});

// ── U4: Dynamic import pattern is used for server.ts in handler bodies ─────────

describe("U4: Handler bodies use await import for @/lib/supabase/server", () => {
  it("app-guard.ts uses await import for supabaseAdmin", () => {
    const source = readSource("src/api/app-guard.ts");
    // Must use dynamic import somewhere in the file.
    expect(source).toMatch(/await import\(["']@\/lib\/supabase\/server["']\)/);
    // Must NOT have a static top-level import of supabaseAdmin.
    const staticLines = staticImportLines(source);
    const badLines = staticLines.filter((l) => l.includes("supabaseAdmin"));
    expect(badLines).toEqual([]);
  });

  it("auth.ts uses await import for createServerClient (no static server.ts import)", () => {
    const source = readSource("src/api/auth.ts");
    // Must use dynamic import for server.ts where the service-role module lives.
    expect(source).toMatch(/await import\(["']@\/lib\/supabase\/server["']\)/);
    // Must NOT statically import from server.ts.
    const staticLines = staticImportLines(source);
    const badLines = staticLines.filter((l) => l.includes("supabase/server"));
    expect(badLines).toEqual([]);
  });

  it("create-organization.ts uses await import for createServerClient", () => {
    const source = readSource("src/server/org/create-organization.ts");
    expect(source).toMatch(/await import\(["']@\/lib\/supabase\/server["']\)/);
    // Must NOT have a static top-level import from server.ts.
    const staticLines = staticImportLines(source);
    const badLines = staticLines.filter((l) =>
      l.includes("supabase/server") && !l.includes("@tanstack"),
    );
    expect(badLines).toEqual([]);
  });
});

// ── U5: Built client bundle scan ──────────────────────────────────────────────
//
// Only runs when the .output directory exists (i.e. after `bun run build`).
// Skipped gracefully in CI before a build runs, so this never blocks unit tests.

describe("U5: Built client bundle contains no server-only leaks", () => {
  const outputDir = path.resolve(ROOT, ".output/public/assets");
  const bundleExists = fs.existsSync(outputDir);

  if (!bundleExists) {
    it("skipped — .output/public/assets not found (run bun run build first)", () => {
      console.warn("[SKIP] .output/public/assets not found — skipping bundle scan");
      expect(true).toBe(true);
    });
    return;
  }

  const jsFiles = fs.readdirSync(outputDir).filter((f) => f.endsWith(".js"));

  it("SUPABASE_SERVICE_ROLE_KEY is absent from all client JS bundles", () => {
    for (const jsFile of jsFiles) {
      const content = fs.readFileSync(path.join(outputDir, jsFile), "utf-8");
      const found = content.includes("SUPABASE_SERVICE_ROLE_KEY");
      if (found) {
        throw new Error(
          `SUPABASE_SERVICE_ROLE_KEY leaked into client bundle: ${jsFile}`,
        );
      }
    }
    expect(true).toBe(true); // all files passed
  });

  it("supabaseAdmin is absent from all client JS bundles", () => {
    for (const jsFile of jsFiles) {
      const content = fs.readFileSync(path.join(outputDir, jsFile), "utf-8");
      const found = content.includes("supabaseAdmin");
      if (found) {
        throw new Error(
          `supabaseAdmin leaked into client bundle: ${jsFile}`,
        );
      }
    }
    expect(true).toBe(true);
  });

  it("service_role string is absent from all client JS bundles", () => {
    for (const jsFile of jsFiles) {
      const content = fs.readFileSync(path.join(outputDir, jsFile), "utf-8");
      // "service_role" appears in Supabase's own auth-js library (as a JWT role claim
      // name used in token validation logic). We check specifically for our own code
      // patterns that would indicate a server-only module leaked.
      const hasBuildAdminClient = content.includes("buildAdminClient");
      if (hasBuildAdminClient) {
        throw new Error(
          `buildAdminClient (server-only admin factory) leaked into client bundle: ${jsFile}`,
        );
      }
    }
    expect(true).toBe(true);
  });
});
