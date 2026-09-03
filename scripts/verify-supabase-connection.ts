/**
 * APSA — Supabase Connection Verification Script
 *
 * Run this BEFORE applying migrations or running integration tests to confirm
 * that the Supabase credentials in the environment are valid and reachable.
 *
 * Usage:
 *   bun run scripts/verify-supabase-connection.ts
 *
 * Required env vars (set in .env.local — never commit):
 *   VITE_SUPABASE_URL            e.g. https://abcdefghij.supabase.co
 *   VITE_SUPABASE_ANON_KEY       anon / public key (safe for browser)
 *   SUPABASE_SERVICE_ROLE_KEY    service-role key (server-side only)
 *
 * Exit codes:
 *   0  — all checks passed
 *   1  — one or more checks failed (details printed to stderr)
 */

import { createClient } from "@supabase/supabase-js";

// ── Load env ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env["VITE_SUPABASE_URL"] ?? "";
const ANON_KEY = process.env["VITE_SUPABASE_ANON_KEY"] ?? "";
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, detail?: string) {
  console.log(`  ✓  ${label}${detail ? `  (${detail})` : ""}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ✗  ${label}${detail ? `\n       ${detail}` : ""}`);
  failed++;
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkEnvVars() {
  section("Environment variables");

  if (SUPABASE_URL && SUPABASE_URL.startsWith("https://")) {
    ok("VITE_SUPABASE_URL", SUPABASE_URL);
  } else {
    fail(
      "VITE_SUPABASE_URL",
      SUPABASE_URL
        ? `Value found but does not start with https://: "${SUPABASE_URL}"`
        : "Not set — copy .env.example to .env.local and fill in the Project URL",
    );
  }

  if (ANON_KEY && ANON_KEY.length > 20) {
    ok("VITE_SUPABASE_ANON_KEY", `${ANON_KEY.slice(0, 8)}… (length ${ANON_KEY.length})`);
  } else {
    fail(
      "VITE_SUPABASE_ANON_KEY",
      ANON_KEY ? "Value too short — verify you copied the correct key" : "Not set",
    );
  }

  if (SERVICE_ROLE_KEY && SERVICE_ROLE_KEY.length > 20) {
    ok(
      "SUPABASE_SERVICE_ROLE_KEY",
      `${SERVICE_ROLE_KEY.slice(0, 8)}… (length ${SERVICE_ROLE_KEY.length})`,
    );
    if (SERVICE_ROLE_KEY.startsWith("VITE_")) {
      fail(
        "SUPABASE_SERVICE_ROLE_KEY security check",
        "Key appears to be set with VITE_ prefix — service-role key must NOT have VITE_ prefix (it would be exposed to browsers)",
      );
    }
  } else {
    fail(
      "SUPABASE_SERVICE_ROLE_KEY",
      SERVICE_ROLE_KEY
        ? "Value too short — verify you copied the service_role key (not the anon key)"
        : "Not set — required for server-side operations",
    );
  }

  if (ANON_KEY === SERVICE_ROLE_KEY && ANON_KEY.length > 0) {
    fail(
      "Key distinctness",
      "ANON_KEY and SERVICE_ROLE_KEY are identical — they must be different keys",
    );
  } else if (ANON_KEY.length > 0 && SERVICE_ROLE_KEY.length > 0) {
    ok("Key distinctness", "anon key ≠ service-role key");
  }
}

async function checkAnonConnectivity() {
  section("Anon key connectivity (simulates browser client)");

  if (!SUPABASE_URL || !ANON_KEY) {
    fail("Skipped", "VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not set");
    return;
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY);

  // A simple auth.getSession() call reaches the Supabase API without requiring
  // any real session — it just verifies the URL and key are accepted.
  try {
    const { error } = await anon.auth.getSession();
    if (error) {
      fail("auth.getSession()", `Error: ${error.message}`);
    } else {
      ok("auth.getSession()", "Supabase API reachable with anon key");
    }
  } catch (e) {
    fail(
      "auth.getSession()",
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkServiceRoleConnectivity() {
  section("Service-role key connectivity (simulates server client)");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    fail("Skipped", "VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Query pg_tables via the REST API to verify service-role access to the DB.
  // If migrations are not yet applied, this still succeeds (empty result is fine).
  try {
    const { error } = await admin.from("profiles").select("id", { head: true, count: "exact" });

    if (error) {
      if (error.code === "42P01") {
        // Table does not exist — migrations not applied yet, but connectivity is fine.
        ok(
          "Service-role DB query",
          "Reached database (profiles table not found — apply migrations 001–008 first)",
        );
      } else {
        fail("Service-role DB query", `${error.code}: ${error.message}`);
      }
    } else {
      ok("Service-role DB query", "profiles table reachable");
    }
  } catch (e) {
    fail(
      "Service-role DB query",
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function checkMigrationsApplied() {
  section("Migration status (requires migrations applied)");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    fail("Skipped", "Service-role credentials not set");
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const expectedTables = [
    "profiles",
    "organizations",
    "roles",
    "permissions",
    "role_permissions",
    "workspaces",
    "locations",
    "memberships",
    "audit_logs",
  ];

  for (const table of expectedTables) {
    try {
      const { error } = await admin.from(table).select("*", { head: true, count: "exact" });
      if (error) {
        if (error.code === "42P01") {
          fail(`Table: ${table}`, "Not found — apply migrations 001–008");
        } else {
          fail(`Table: ${table}`, `${error.code}: ${error.message}`);
        }
      } else {
        ok(`Table: ${table}`, "exists");
      }
    } catch (e) {
      fail(`Table: ${table}`, e instanceof Error ? e.message : String(e));
    }
  }
}

async function checkSystemRolesSeed() {
  section("System role seed data (migration 003)");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    fail("Skipped", "Service-role credentials not set");
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data, error } = await admin
      .from("roles")
      .select("id, name, system_role")
      .is("organization_id", null)
      .order("name");

    if (error) {
      if (error.code === "42P01") {
        fail("System roles", "roles table not found — apply migration 003 first");
        return;
      }
      fail("System roles query", `${error.code}: ${error.message}`);
      return;
    }

    const systemRoles = (data ?? []) as Array<{ id: string; name: string; system_role: string }>;
    const expected = ["OWNER", "MANAGER", "CASHIER", "SALES", "CUSTOMER_SERVICE"];

    for (const key of expected) {
      const found = systemRoles.find((r) => r.system_role === key);
      if (found) {
        ok(`System role: ${key}`, `id=${found.id}`);
      } else {
        fail(`System role: ${key}`, "Not found — re-run migration 003 or check seed data");
      }
    }

    const permCount = await admin
      .from("permissions")
      .select("id", { head: true, count: "exact" });
    if (permCount.error) {
      fail("Permission count", permCount.error.message);
    } else {
      const count = permCount.count ?? 0;
      if (count >= 37) {
        ok("Permission keys", `${count} permissions seeded (expected ≥ 37)`);
      } else {
        fail(
          "Permission keys",
          `Only ${count} permissions found — expected ≥ 37. Re-run migration 003.`,
        );
      }
    }
  } catch (e) {
    fail("System roles check", e instanceof Error ? e.message : String(e));
  }
}

async function checkRlsEnabled() {
  section("Row Level Security enabled on all tables");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    fail("Skipped", "Service-role credentials not set");
    return;
  }

  // Use the service role to query pg_tables + pg_class RLS flag.
  // This requires a raw SQL query — not available via the REST API.
  // We verify RLS indirectly: anonymous client must get zero rows (blocked by RLS).

  const anon = createClient(SUPABASE_URL, ANON_KEY);

  // Without any session, an anon client should get 0 rows on all protected tables.
  // If RLS is disabled, it would return all rows — a security failure.
  const protectedTables = ["organizations", "memberships", "audit_logs", "workspaces", "locations"];

  for (const table of protectedTables) {
    try {
      const { data, error } = await anon.from(table).select("*");
      if (error) {
        if (error.code === "42P01") {
          fail(`RLS on ${table}`, "Table not found — apply migrations first");
        } else if (error.message.includes("JWT") || error.message.includes("anon")) {
          ok(`RLS on ${table}`, "Blocked for anon client (expected)");
        } else {
          fail(`RLS on ${table}`, `Unexpected error: ${error.message}`);
        }
      } else if (!data || data.length === 0) {
        ok(`RLS on ${table}`, "Returns 0 rows for anon client (RLS active)");
      } else {
        fail(
          `RLS on ${table}`,
          `WARNING: Anon client received ${data.length} rows — RLS may not be configured correctly`,
        );
      }
    } catch (e) {
      fail(`RLS on ${table}`, e instanceof Error ? e.message : String(e));
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║   APSA — Supabase Connection Verification                    ║");
console.log("╚══════════════════════════════════════════════════════════════╝");

await checkEnvVars();
await checkAnonConnectivity();
await checkServiceRoleConnectivity();
await checkMigrationsApplied();
await checkSystemRolesSeed();
await checkRlsEnabled();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log(`  Result: ${passed} passed, ${failed} failed`);
console.log("═".repeat(64));

if (failed === 0) {
  console.log("\n  ✓  All checks passed. Supabase is correctly configured.\n");
  process.exit(0);
} else {
  console.error(
    `\n  ✗  ${failed} check(s) failed. Resolve the issues above before running tests.\n`,
  );
  console.error("  See supabase/README.md for setup instructions.\n");
  process.exit(1);
}
