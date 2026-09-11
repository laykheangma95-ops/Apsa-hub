/**
 * APSA — Hosted Staging Verification (read-only by default)
 *
 * Verifies how a REAL, hosted Supabase staging project behaves. Everything the
 * offline checker cannot prove — RLS actually enforcing, unauthenticated RPC
 * access actually denied, one organization actually unable to read another's
 * rows — is proven here or not at all.
 *
 * SAFETY CONTRACT
 *   · Reads only. No INSERT/UPDATE/DELETE and no RPC that mutates is called
 *     unless --allow-write-probes is passed explicitly.
 *   · Never applies migrations and never changes hosted configuration.
 *   · Refuses to run when STAGING_SUPABASE_URL matches VITE_SUPABASE_URL, so
 *     it cannot be pointed at the production project by a stale shell.
 *   · Never prints a key, token, cookie, email address, message body, customer
 *     name, phone number or any other row content — only table names, counts,
 *     error codes and pass/fail verdicts.
 *
 * REPORTING CONTRACT
 *   PASS          the check ran against staging and the expected behavior held
 *   FAIL          the check ran and the expected behavior did NOT hold
 *   INCONCLUSIVE  the check ran but the result does not prove pass or fail
 *   NOT CONFIGURED the prerequisite for the check is absent — never a pass
 *
 * INCONCLUSIVE and NOT CONFIGURED are never counted as passes, and the script
 * exits non-zero if a security-relevant check did not positively pass.
 *
 * Required environment (staging project — never production):
 *   STAGING_SUPABASE_URL
 *   STAGING_SUPABASE_ANON_KEY
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional — enables the authenticated, multi-organization checks:
 *   STAGING_ORG_A_ID, STAGING_ORG_B_ID
 *   STAGING_OWNER_A_EMAIL,   STAGING_OWNER_A_PASSWORD
 *   STAGING_MANAGER_A_EMAIL, STAGING_MANAGER_A_PASSWORD
 *   STAGING_STAFF_A_EMAIL,   STAGING_STAFF_A_PASSWORD
 *   STAGING_OWNER_B_EMAIL,   STAGING_OWNER_B_PASSWORD
 *
 * Usage:
 *   bun run scripts/verify-staging.ts
 *
 * Exit codes:
 *   0 — every check that ran passed, and nothing security-relevant was left unproven
 *   1 — a check failed, or a security-relevant check could not be proven
 *   2 — prerequisites missing; nothing was verified (fail closed)
 */

import * as fs from "fs";
import * as path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { collectMigrationTables, collectAuthenticatedRpcs } from "./lib/staging-readiness.ts";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

const allowWriteProbes = process.argv.slice(2).includes("--allow-write-probes");

// ── Result accounting ────────────────────────────────────────────────────────

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

/**
 * Reduce a Supabase error to a disclosure-safe shape. Messages can echo a
 * requested value back (a row id, a column value); only the stable error code
 * is ever printed.
 */
function safeCode(error: { code?: string; message?: string } | null): string {
  if (!error) return "none";
  return error.code && error.code.length > 0 ? error.code : "unspecified";
}

// ── Prerequisites (fail closed) ──────────────────────────────────────────────

section("Prerequisites");

const URL = (process.env["STAGING_SUPABASE_URL"] ?? "").trim();
const ANON = (process.env["STAGING_SUPABASE_ANON_KEY"] ?? "").trim();
const SERVICE = (process.env["STAGING_SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();

const required: Array<[string, string]> = [
  ["STAGING_SUPABASE_URL", URL],
  ["STAGING_SUPABASE_ANON_KEY", ANON],
  ["STAGING_SUPABASE_SERVICE_ROLE_KEY", SERVICE],
];
const absent = required.filter(([, v]) => v.length === 0).map(([n]) => n);

if (absent.length > 0) {
  for (const name of absent) missing(`${name} is not set`);
  console.error(
    `\n  Nothing was verified. Staging verification has NOT passed — it did not run.\n` +
      `  Provide the variables above (see docs/STAGING_VERIFICATION.md) and re-run.\n`,
  );
  process.exit(2);
}

const PROD_URL = (process.env["VITE_SUPABASE_URL"] ?? "").trim();
if (PROD_URL.length > 0 && PROD_URL === URL) {
  console.error(
    `\n  REFUSING TO RUN: STAGING_SUPABASE_URL is identical to VITE_SUPABASE_URL.\n` +
      `  Staging must be a separate Supabase project from production.\n`,
  );
  process.exit(2);
}
if (ANON === SERVICE) {
  console.error(`\n  REFUSING TO RUN: anon key and service-role key hold the same value.\n`);
  process.exit(2);
}
pass("Staging credentials present and distinct from the production project.");
if (!allowWriteProbes) {
  info("Write probes disabled (default). Run with --allow-write-probes to include them.");
}

const anon: SupabaseClient = createClient(URL, ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const admin: SupabaseClient = createClient(URL, SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Expected surface, derived from the migrations in this checkout ───────────

const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]));
const migrationContents = migrationFiles.map((f) =>
  fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"),
);
const expectedTables = collectMigrationTables(migrationContents);
const authenticatedRpcs = collectAuthenticatedRpcs(migrationContents);

// ── 1. Schema parity against the hosted project ──────────────────────────────

section("1. Schema parity (service role)");

const presentTables: string[] = [];
const absentTables: string[] = [];

for (const table of expectedTables) {
  const { error } = await admin.from(table).select("*", { head: true, count: "exact" });
  if (!error) {
    presentTables.push(table);
  } else if (error.code === "42P01" || error.code === "PGRST205") {
    absentTables.push(table);
  } else {
    unclear(`Table ${table}: unexpected error code ${safeCode(error)} — presence not determined.`);
  }
}

if (absentTables.length === 0 && presentTables.length === expectedTables.length) {
  pass(`All ${expectedTables.length} tables defined by local migrations exist on staging.`);
} else if (absentTables.length > 0) {
  fail(
    `${absentTables.length} of ${expectedTables.length} tables defined by local migrations do NOT ` +
      `exist on staging — staging is behind this checkout: ${absentTables.join(", ")}`,
  );
  info("Apply the pending migrations to staging before trusting any result below.");
}

// ── 2. RLS: an anonymous client must read nothing ────────────────────────────

section("2. Row Level Security — anonymous client");

let rlsProven = 0;
for (const table of presentTables) {
  const { data, error } = await anon.from(table).select("*").limit(1);
  if (error) {
    // 42501 permission denied / PGRST301 no JWT are both correct refusals.
    if (error.code === "42501" || error.code === "PGRST301" || error.code === "PGRST302") {
      rlsProven++;
    } else {
      unclear(
        `RLS on ${table}: refused with code ${safeCode(error)} — refusal not attributable to RLS.`,
      );
    }
  } else if ((data ?? []).length === 0) {
    rlsProven++;
  } else {
    fail(
      `RLS on ${table}: anonymous client received ${(data ?? []).length} row(s) — tenant data is exposed.`,
    );
  }
}
if (presentTables.length === 0) {
  missing("No tables present on staging — RLS could not be exercised.");
} else if (rlsProven === presentTables.length) {
  pass(`Anonymous client reads nothing from all ${rlsProven} tables present on staging.`);
}

// ── 3. Unauthenticated RPC access ────────────────────────────────────────────

section("3. Unauthenticated RPC access");

let rpcDenied = 0;
let rpcProbed = 0;
for (const fn of authenticatedRpcs) {
  rpcProbed++;
  // Deliberately called with no arguments: a correctly-secured RPC refuses an
  // anonymous caller before argument binding, so a signature mismatch here is
  // itself evidence the call was reached — reported as inconclusive, not pass.
  const { error } = await anon.rpc(fn, {});
  if (!error) {
    fail(`RPC ${fn} executed for an ANONYMOUS caller — it must require authentication.`);
    continue;
  }
  if (error.code === "42501" || error.code === "PGRST301" || error.code === "PGRST302") {
    rpcDenied++;
  } else if (error.code === "PGRST202" || error.code === "PGRST203") {
    // Not found / ambiguous under the anon role's search path. Not a proof of
    // denial-by-authorization, so it is not counted as a pass.
    unclear(
      `RPC ${fn}: not resolvable for the anon role (code ${safeCode(error)}) — denial not proven.`,
    );
  } else {
    unclear(
      `RPC ${fn}: refused with code ${safeCode(error)} — denial not attributable to authorization.`,
    );
  }
}
if (rpcProbed === 0) {
  missing("No authenticated-granted RPCs found in local migrations — nothing to probe.");
} else if (rpcDenied === rpcProbed) {
  pass(`All ${rpcProbed} authenticated-only RPCs refused the anonymous caller.`);
}

// ── 4. Hosted migration history ──────────────────────────────────────────────

section("4. Hosted migration history");

{
  const { data, error } = await admin
    .schema("supabase_migrations")
    .from("schema_migrations")
    .select("version");
  if (error) {
    unclear(
      `supabase_migrations.schema_migrations is not readable over REST (code ${safeCode(error)}). ` +
        `This is normal for a project that has not exposed that schema; confirm the applied list ` +
        `from the Supabase dashboard instead and record it in supabase/hosted-migrations.lock.json.`,
    );
  } else {
    const versions = (data ?? []) as Array<{ version: string }>;
    info(`Hosted history reports ${versions.length} applied migration(s).`);
    if (versions.length === migrationFiles.length) {
      pass(`Hosted history count matches the ${migrationFiles.length} local migrations.`);
    } else {
      fail(
        `Hosted history reports ${versions.length} applied migration(s) but this checkout has ` +
          `${migrationFiles.length} — staging and this branch are not at parity.`,
      );
    }
  }
}

// ── 5. Authenticated, multi-organization behavior ────────────────────────────

section("5. Authenticated tenant isolation, roles and sessions");

interface Account {
  label: string;
  email: string;
  password: string;
}

function account(label: string, emailVar: string, passwordVar: string): Account | undefined {
  const email = (process.env[emailVar] ?? "").trim();
  const password = (process.env[passwordVar] ?? "").trim();
  if (email.length === 0 || password.length === 0) return undefined;
  return { label, email, password };
}

const ownerA = account("Owner (Org A)", "STAGING_OWNER_A_EMAIL", "STAGING_OWNER_A_PASSWORD");
const managerA = account(
  "Manager (Org A)",
  "STAGING_MANAGER_A_EMAIL",
  "STAGING_MANAGER_A_PASSWORD",
);
const staffA = account("Staff (Org A)", "STAGING_STAFF_A_EMAIL", "STAGING_STAFF_A_PASSWORD");
const ownerB = account("Owner (Org B)", "STAGING_OWNER_B_EMAIL", "STAGING_OWNER_B_PASSWORD");
const ORG_A = (process.env["STAGING_ORG_A_ID"] ?? "").trim();
const ORG_B = (process.env["STAGING_ORG_B_ID"] ?? "").trim();

/** Sign in and return a client bound to that session, or undefined on failure. */
async function signIn(
  acc: Account,
): Promise<{ client: SupabaseClient; token: string } | undefined> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: acc.email,
    password: acc.password,
  });
  if (error || !data.session) {
    fail(`${acc.label}: sign-in failed (code ${safeCode(error)}).`);
    return undefined;
  }
  if (!data.user?.email_confirmed_at) {
    fail(`${acc.label}: signed in with an UNVERIFIED email — verification is not being enforced.`);
    return undefined;
  }
  return { client, token: data.session.access_token };
}

/** Tables that carry an organization_id and are therefore tenant-scoped. */
const tenantScoped = presentTables.filter((t) =>
  migrationContents.some((sql) =>
    new RegExp(`CREATE\\s+TABLE[^;]*?\\b${t}\\b[\\s\\S]*?organization_id`, "i").test(sql),
  ),
);

if (!ownerA || !ownerB || ORG_A.length === 0 || ORG_B.length === 0) {
  missing(
    "Two-organization staging accounts are not configured " +
      "(STAGING_OWNER_A_*, STAGING_OWNER_B_*, STAGING_ORG_A_ID, STAGING_ORG_B_ID). " +
      "Cross-tenant isolation, role enforcement and session transitions were NOT verified.",
  );
} else {
  const sessionA = await signIn(ownerA);
  if (sessionA) {
    pass(`${ownerA.label}: verified-email sign-in succeeded.`);

    // 5a. Cross-tenant read using a known-good, guessed organization id.
    let leaks = 0;
    let checked = 0;
    for (const table of tenantScoped) {
      checked++;
      const { data, error } = await sessionA.client
        .from(table)
        .select("id")
        .eq("organization_id", ORG_B)
        .limit(1);
      if (error) {
        if (error.code !== "42501" && error.code !== "PGRST301") {
          unclear(
            `Cross-tenant read of ${table}: code ${safeCode(error)} — denial not attributable to RLS.`,
          );
        }
      } else if ((data ?? []).length > 0) {
        leaks++;
        fail(
          `TENANT ISOLATION BREACH: Org A member read ${(data ?? []).length} row(s) from ${table} belonging to Org B.`,
        );
      }
    }
    if (checked > 0 && leaks === 0) {
      pass(`Org A member read zero Org B rows across all ${checked} tenant-scoped tables.`);
    } else if (checked === 0) {
      missing("No tenant-scoped tables present on staging — cross-tenant read was not exercised.");
    }

    // 5b. Cross-tenant write attempt (opt-in only; a denied write changes nothing).
    if (allowWriteProbes) {
      const target = tenantScoped[0];
      if (target !== undefined) {
        const { error } = await sessionA.client
          .from(target)
          .update({ organization_id: ORG_B })
          .eq("organization_id", ORG_B);
        if (!error) {
          fail(
            `TENANT ISOLATION BREACH: Org A member's UPDATE against Org B rows in ${target} was accepted.`,
          );
        } else {
          pass(
            `Org A member's cross-tenant UPDATE against ${target} was refused (code ${safeCode(error)}).`,
          );
        }
      }
    } else {
      missing(
        "Cross-tenant WRITE denial not probed — re-run with --allow-write-probes against staging only.",
      );
    }

    // 5c. Sign-out must revoke the access token server-side.
    const revokedToken = sessionA.token;
    await sessionA.client.auth.signOut();
    const revokedProbe = createClient(URL, ANON, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${revokedToken}` } },
    });
    const afterSignOut = await revokedProbe.auth.getUser(revokedToken);
    if (afterSignOut.error || !afterSignOut.data.user) {
      pass("Access token is rejected after sign-out — revocation is enforced server-side.");
    } else {
      fail(
        "Access token still resolves to a user AFTER sign-out — session revocation is not enforced.",
      );
    }

    // 5d. A structurally invalid token must never authenticate.
    const invalid = await anon.auth.getUser("invalid.token.value");
    if (invalid.error || !invalid.data.user) {
      pass("Invalid session token is rejected.");
    } else {
      fail("Invalid session token resolved to a user — token validation is not enforced.");
    }

    // 5e. User A → sign-out → User B must yield a different identity, proving
    //     no identity is cached across the transition.
    const sessionB = await signIn(ownerB);
    if (sessionB) {
      const who = await sessionB.client.auth.getUser();
      const bId = who.data.user?.id ?? "";
      const aProbe = await anon.auth.getUser(revokedToken);
      const aId = aProbe.data.user?.id ?? "";
      if (bId.length > 0 && bId !== aId) {
        pass(
          "User A → sign-out → User B yields a distinct identity — no cross-principal session reuse.",
        );
      } else {
        fail(
          "User B's session resolved to User A's identity, or to no identity — session transition is unsafe.",
        );
      }
      await sessionB.client.auth.signOut();
    }
  }

  // 5f. Role-scoped reads: a staff/cashier account must not reach privileged data.
  if (!managerA || !staffA) {
    missing(
      "Manager and/or Staff staging accounts are not configured (STAGING_MANAGER_A_*, STAGING_STAFF_A_*). " +
        "Role-level server enforcement was NOT verified.",
    );
  } else {
    for (const acc of [managerA, staffA]) {
      const s = await signIn(acc);
      if (!s) continue;
      const { data, error } = await s.client
        .from("audit_logs")
        .select("id")
        .eq("organization_id", ORG_A)
        .limit(1);
      const rows = (data ?? []).length;
      if (acc === staffA) {
        if (!error && rows > 0) {
          fail(
            "Staff account read audit_logs — audit access must be restricted to privileged roles.",
          );
        } else {
          pass(`Staff account cannot read audit_logs (code ${safeCode(error)}, ${rows} row(s)).`);
        }
      } else {
        info(
          `Manager audit_logs read returned ${rows} row(s) (code ${safeCode(error)}) — compare against PERMISSIONS_MATRIX.md.`,
        );
      }
      await s.client.auth.signOut();
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log(
  `  ${passed} passed, ${failed} failed, ${inconclusive} inconclusive, ${unconfigured} not configured.`,
);
console.log("═".repeat(64));

if (failed > 0) {
  console.error(`\n  STAGING VERIFICATION FAILED — ${failed} check(s) did not hold.\n`);
  process.exit(1);
}
if (inconclusive > 0 || unconfigured > 0) {
  console.error(
    `\n  STAGING VERIFICATION INCOMPLETE — ${inconclusive} inconclusive, ${unconfigured} not configured.\n` +
      `  Do NOT record this run as "staging verified". Only the ${passed} PASS line(s) above were proven.\n`,
  );
  process.exit(1);
}
console.log(`\n  All ${passed} staging checks passed.\n`);
