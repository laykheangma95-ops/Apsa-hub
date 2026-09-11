/**
 * APSA — Hosted Staging Verification (read-only by default)
 *
 * Verifies how a REAL, hosted Supabase staging project behaves. Everything the
 * offline checker cannot prove — RLS actually enforcing, unauthenticated RPC
 * access actually denied, one organization actually unable to read another's
 * rows — is proven here or not at all.
 *
 * SAFETY CONTRACT
 *   · No INSERT/UPDATE/DELETE is issued unless --allow-write-probes is passed.
 *   · In default mode, only RPCs this checkout can statically prove to be
 *     read-only (declared STABLE/IMMUTABLE with no write statement in the body)
 *     are invoked. An RPC that is mutating, or whose definition cannot be
 *     parsed, is NOT called — it is reported INCONCLUSIVE.
 *
 *     This is the honest form of the guarantee. The script cannot promise that
 *     "no mutating RPC can ever execute" in general, because whether a function
 *     runs for an anonymous caller is decided by the hosted project's grants,
 *     not by this file. What it can guarantee, and does, is that it never asks
 *     a function to run unless that function is provably read-only. If a
 *     mutating RPC has been wrongly granted to `anon`, the danger is the grant;
 *     this tool simply refuses to be the thing that pulls the trigger.
 *   · Never applies migrations and never changes hosted configuration.
 *   · Refuses to run at all unless a production URL witness is present and
 *     proves the target is NOT the production project. See evaluateProbeGate().
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
 * WHAT COUNTS AS PROOF
 *   Only an explicit authorization refusal (42501, PGRST301, PGRST302) proves a
 *   denial. A zero-row read proves RLS only when the service role can see rows
 *   in that same table — on an EMPTY table, a protected and an unprotected read
 *   are indistinguishable, so an empty table is always INCONCLUSIVE. No canary
 *   row is ever inserted to manufacture a result.
 *
 * Required environment (staging project — never production):
 *   STAGING_SUPABASE_URL
 *   STAGING_SUPABASE_ANON_KEY
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY
 *
 * Required safety witness — the run refuses without it:
 *   VITE_SUPABASE_URL or PRODUCTION_SUPABASE_URL
 *
 * Optional — enables the authenticated, multi-organization checks:
 *   STAGING_ORG_A_ID, STAGING_ORG_B_ID   (must be two different organizations)
 *   STAGING_OWNER_A_EMAIL,   STAGING_OWNER_A_PASSWORD
 *   STAGING_MANAGER_A_EMAIL, STAGING_MANAGER_A_PASSWORD
 *   STAGING_STAFF_A_EMAIL,   STAGING_STAFF_A_PASSWORD
 *   STAGING_OWNER_B_EMAIL,   STAGING_OWNER_B_PASSWORD
 *
 * Optional — bounded execution (milliseconds):
 *   STAGING_REQUEST_TIMEOUT_MS  default 15000  per hosted request
 *   STAGING_GLOBAL_TIMEOUT_MS   default 300000 for the whole run
 *
 * Usage:
 *   bun run scripts/verify-staging.ts
 *
 * Exit codes:
 *   0 — every check that ran passed, and nothing security-relevant was left unproven
 *   1 — a check failed, or a security-relevant check could not be proven
 *   2 — prerequisites missing or the safety gate refused; nothing was verified
 */

import * as fs from "fs";
import * as path from "path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  collectMigrationTables,
  collectAuthenticatedRpcs,
  collectRpcSignatures,
  collectTriggerProtectedTables,
  selectWriteProbeTarget,
  rpcDummyArgs,
  evaluateProbeGate,
  classifyRlsObservation,
  classifyWriteProbe,
  classifyRpcProbe,
  isAuthorizationDenial,
  describeKeyRole,
  createDeadline,
  readTimeoutMs,
  withTimeout,
  type RpcSignature,
} from "./lib/staging-readiness.ts";

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
function safeCode(error: { code?: string | null; message?: string } | null | undefined): string {
  if (!error) return "none";
  return typeof error.code === "string" && error.code.length > 0 ? error.code : "unspecified";
}

// ── Safety gate — evaluated before any client exists ─────────────────────────
//
// Ordering is the enforcement mechanism for M1/"--allow-write-probes cannot
// bypass the guard": the gate is evaluated here, at module top level, before a
// single Supabase client is constructed and before any flag influences control
// flow. A refusal exits the process, so there is no code path on which a flag
// could reach a hosted request that the gate did not clear.

section("Prerequisites and safety gate");

const URL = (process.env["STAGING_SUPABASE_URL"] ?? "").trim();
const ANON = (process.env["STAGING_SUPABASE_ANON_KEY"] ?? "").trim();
const SERVICE = (process.env["STAGING_SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();
const ORG_A = (process.env["STAGING_ORG_A_ID"] ?? "").trim();
const ORG_B = (process.env["STAGING_ORG_B_ID"] ?? "").trim();

/**
 * The production URL witness. Either variable may carry it, but one of them
 * MUST: without a production URL to compare against, "this is not production"
 * is an unanswered question, and the gate refuses rather than assuming.
 */
const PRODUCTION_WITNESS =
  (process.env["PRODUCTION_SUPABASE_URL"] ?? "").trim() ||
  (process.env["VITE_SUPABASE_URL"] ?? "").trim();

const gate = evaluateProbeGate({
  stagingUrl: URL,
  productionUrlWitness: PRODUCTION_WITNESS,
  anonKey: ANON,
  serviceKey: SERVICE,
  orgAId: ORG_A,
  orgBId: ORG_B,
});

if (!gate.allowed) {
  for (const message of gate.messages) console.error(`  REFUSED         ${message}`);
  console.error(
    `\n  REFUSING TO RUN — no hosted request was made. Nothing was verified, and staging\n` +
      `  verification has NOT passed.\n\n` +
      `  Codes: ${gate.refusals.join(", ")}\n` +
      `  See docs/STAGING_VERIFICATION.md for what each prerequisite is and why it is\n` +
      `  mandatory. --allow-write-probes does not relax any of the above.\n`,
  );
  process.exit(2);
}

pass(
  "Safety gate cleared: staging URL present, production URL witness present and different, " +
    "keys distinct and in the correct roles, organizations distinct.",
);
info(
  `Key roles as claimed: anon slot = ${describeKeyRole(ANON)}, service slot = ${describeKeyRole(SERVICE)} ` +
    "(claim only — no key material is read out, logged or verified against a signature).",
);
if (!allowWriteProbes) {
  info("Write probes disabled (default). Run with --allow-write-probes to include them.");
  info("Default mode also skips every RPC this checkout cannot prove read-only — see the header.");
}

// ── Bounded execution ────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = readTimeoutMs(process.env, "STAGING_REQUEST_TIMEOUT_MS", 15_000);
const GLOBAL_TIMEOUT_MS = readTimeoutMs(process.env, "STAGING_GLOBAL_TIMEOUT_MS", 300_000);
const deadline = createDeadline(GLOBAL_TIMEOUT_MS);
let timedOut = false;

info(
  `Bounded run: ${REQUEST_TIMEOUT_MS}ms per request, ${GLOBAL_TIMEOUT_MS}ms overall. ` +
    "An unreachable staging project ends the run instead of hanging.",
);

/** A hard stop, so no hosted call can hold the process open past the budget. */
const watchdog = setTimeout(() => {
  console.error(
    `\n  GLOBAL TIMEOUT — the run exceeded ${GLOBAL_TIMEOUT_MS}ms and was stopped.\n` +
      `  Staging verification has NOT passed.\n`,
  );
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
watchdog.unref?.();

/** fetch with a per-request abort, injected into every Supabase client. */
const boundedFetch: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const upstream = init?.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: boundedFetch },
} as const;

/**
 * Await a hosted call under both budgets. A thrown error (abort, DNS failure,
 * TLS failure) is returned rather than propagated, so the caller reports it as
 * INCONCLUSIVE instead of the run dying mid-section with a partial tally.
 */
async function attempt<T>(label: string, work: () => PromiseLike<T>): Promise<T | Error> {
  if (deadline.expired()) {
    timedOut = true;
    return new Error(`global timeout reached before: ${label}`);
  }
  const budget = Math.max(1, Math.min(REQUEST_TIMEOUT_MS + 1_000, deadline.remaining()));
  try {
    return await withTimeout(Promise.resolve(work()), budget, label);
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (/timed out/i.test(wrapped.message) || wrapped.name === "AbortError") timedOut = true;
    return wrapped;
  }
}

const anon: SupabaseClient = createClient(URL, ANON, clientOptions);
const admin: SupabaseClient = createClient(URL, SERVICE, clientOptions);

// ── Expected surface, derived from the migrations in this checkout ───────────

const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]));
const migrationContents = migrationFiles.map((f) =>
  fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"),
);
const expectedTables = collectMigrationTables(migrationContents);
const grantedRpcNames = new Set(collectAuthenticatedRpcs(migrationContents));
const rpcSignatures = collectRpcSignatures(migrationContents).filter((s) =>
  grantedRpcNames.has(s.name),
);
const triggerProtectedTables = collectTriggerProtectedTables(migrationContents);

// ── 1. Schema parity against the hosted project ──────────────────────────────

section("1. Schema parity (service role)");

const presentTables: string[] = [];
const absentTables: string[] = [];
/** Service-role row count per present table — the witness H1 depends on. */
const adminRowCounts = new Map<string, number | null>();

for (const table of expectedTables) {
  const result = await attempt(`count ${table}`, () =>
    admin.from(table).select("*", { head: true, count: "exact" }),
  );
  if (result instanceof Error) {
    unclear(`Table ${table}: hosted request did not complete — presence not determined.`);
    continue;
  }
  const { error, count } = result;
  if (!error) {
    presentTables.push(table);
    adminRowCounts.set(table, typeof count === "number" ? count : null);
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

// ── 2. RLS: an anonymous client must read nothing it should not ──────────────
//
// H1: a zero-row anonymous read is only evidence when the service role can see
// rows in that same table. On an empty table the two hypotheses — "RLS blocked
// the read" and "there was nothing to read" — produce identical output, so the
// table is reported INCONCLUSIVE and never counted as RLS-proven. No row is
// inserted to force the question; manufacturing evidence by writing to a hosted
// project is not something a read-only verifier gets to do.

section("2. Row Level Security — anonymous client");

let rlsProven = 0;
let rlsEmpty = 0;
let rlsUnclear = 0;

for (const table of presentTables) {
  const result = await attempt(`anon read ${table}`, () => anon.from(table).select("*").limit(1));
  if (result instanceof Error) {
    rlsUnclear++;
    unclear(`RLS on ${table}: hosted request did not complete — RLS not exercised.`);
    continue;
  }
  const { data, error } = result;
  const adminCount = adminRowCounts.get(table) ?? null;
  const verdict = classifyRlsObservation({
    errorCode: error?.code ?? null,
    anonRowCount: (data ?? []).length,
    adminRowCount: adminCount,
  });

  if (verdict.verdict === "PASS") {
    rlsProven++;
  } else if (verdict.verdict === "FAIL") {
    fail(
      `RLS on ${table}: anonymous client received ${(data ?? []).length} row(s) — tenant data is exposed.`,
    );
  } else if (verdict.reason === "table_empty") {
    rlsEmpty++;
  } else if (verdict.reason === "admin_count_unavailable") {
    rlsUnclear++;
    unclear(
      `RLS on ${table}: the service-role row count is unavailable, so a zero-row anonymous read ` +
        `proves nothing.`,
    );
  } else {
    rlsUnclear++;
    unclear(
      `RLS on ${table}: refused with code ${safeCode(error)} — refusal not attributable to RLS.`,
    );
  }
}

if (presentTables.length === 0) {
  missing("No tables present on staging — RLS could not be exercised.");
} else {
  if (rlsProven > 0) {
    pass(
      `RLS positively proven on ${rlsProven} of ${presentTables.length} table(s): the service role ` +
        `sees rows there and the anonymous client saw none (or was refused by authorization).`,
    );
  }
  if (rlsEmpty > 0) {
    unclear(
      `${rlsEmpty} of ${presentTables.length} table(s) are EMPTY on staging. An anonymous read of an ` +
        `empty table returns zero rows whether or not RLS is enforced, so these prove nothing and ` +
        `are NOT counted as RLS-proven. Seed representative rows in each organization on staging ` +
        `and re-run; this tool will not insert canary rows into a hosted project.`,
    );
  }
  if (rlsProven === 0 && rlsEmpty === 0 && rlsUnclear === 0) {
    unclear("No table produced a usable RLS observation.");
  }
}

// ── 3. Unauthenticated RPC access ────────────────────────────────────────────
//
// M3: default mode invokes only RPCs proven read-only by static analysis of
// this checkout's migrations. M4: each is called with type-correct placeholder
// arguments derived from its declared signature, so a function with required
// parameters reaches the authorization decision instead of bouncing off
// PGRST202 ("not found") forever and reading as permanently inconclusive.

section("3. Unauthenticated RPC access");

const readOnlyRpcs = rpcSignatures.filter((s) => !s.mutating);
const mutatingRpcs = rpcSignatures.filter((s) => s.mutating);

let rpcDenied = 0;
let rpcProbed = 0;

async function probeRpc(signature: RpcSignature): Promise<void> {
  rpcProbed++;
  const args = rpcDummyArgs(signature);
  const argNote =
    Object.keys(args).length === 0
      ? "no required arguments"
      : `${Object.keys(args).length} placeholder argument(s)`;
  const result = await attempt(`anon rpc ${signature.name}`, () => anon.rpc(signature.name, args));
  if (result instanceof Error) {
    unclear(`RPC ${signature.name}: hosted request did not complete — denial not proven.`);
    return;
  }
  const { error } = result;
  const verdict = classifyRpcProbe(error ?? null);
  if (verdict.verdict === "PASS") {
    rpcDenied++;
  } else if (verdict.verdict === "FAIL") {
    fail(
      `RPC ${signature.name} executed for an ANONYMOUS caller — it must require authentication.`,
    );
  } else if (verdict.reason === "not_resolvable_for_role") {
    unclear(
      `RPC ${signature.name}: not resolvable for the anon role (code ${safeCode(error)}), called with ` +
        `${argNote}. PostgREST reports a missing function and an unmatched signature identically, so ` +
        `this is NOT proof of denial by authorization.`,
    );
  } else {
    unclear(
      `RPC ${signature.name}: refused with code ${safeCode(error)} — denial not attributable to authorization.`,
    );
  }
}

for (const signature of readOnlyRpcs) {
  await probeRpc(signature);
}

if (mutatingRpcs.length > 0) {
  if (allowWriteProbes) {
    info(
      `Probing ${mutatingRpcs.length} mutating RPC(s) because --allow-write-probes was passed. ` +
        `If the hosted project has wrongly granted one to anon, this WILL execute it.`,
    );
    for (const signature of mutatingRpcs) {
      await probeRpc(signature);
    }
  } else {
    unclear(
      `${mutatingRpcs.length} RPC(s) granted to \`authenticated\` are not provably read-only and were ` +
        `NOT invoked: ${mutatingRpcs.map((s) => s.name).join(", ")}. Calling them anonymously is how ` +
        `you would find out they are exposed — and also how you would execute them. Their anonymous ` +
        `denial is therefore UNPROVEN here; re-run with --allow-write-probes against a disposable ` +
        `staging project to prove it, or audit the grants directly.`,
    );
  }
}

if (rpcSignatures.length === 0) {
  missing("No authenticated-granted RPCs found in local migrations — nothing to probe.");
} else if (rpcProbed > 0 && rpcDenied === rpcProbed) {
  pass(`All ${rpcProbed} probed RPC(s) refused the anonymous caller with an authorization code.`);
}

// ── 4. Hosted migration history ──────────────────────────────────────────────

section("4. Hosted migration history");

{
  const result = await attempt("hosted migration history", () =>
    admin.schema("supabase_migrations").from("schema_migrations").select("version"),
  );
  if (result instanceof Error) {
    unclear("Hosted migration history: request did not complete — parity not determined.");
  } else {
    const { data, error } = result;
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

/** Sign in and return a client bound to that session, or undefined on failure. */
async function signIn(
  acc: Account,
): Promise<{ client: SupabaseClient; token: string } | undefined> {
  const client = createClient(URL, ANON, clientOptions);
  const result = await attempt(`sign in ${acc.label}`, () =>
    client.auth.signInWithPassword({ email: acc.email, password: acc.password }),
  );
  if (result instanceof Error) {
    unclear(`${acc.label}: sign-in request did not complete.`);
    return undefined;
  }
  const { data, error } = result;
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

    // 5a. Cross-tenant read using the real Org B id — the IDOR case.
    //
    // This carries exactly the same empty-table trap as H1, one level deeper:
    // Org A reading zero Org B rows proves isolation only if Org B HAS rows in
    // that table. The witness is therefore a service-role count scoped to Org B,
    // not the table's total, and the same classifier decides the verdict.
    let leaks = 0;
    let proven = 0;
    let noOrgBRows = 0;
    let checked = 0;
    for (const table of tenantScoped) {
      checked++;
      const witness = await attempt(`org B row count ${table}`, () =>
        admin.from(table).select("*", { head: true, count: "exact" }).eq("organization_id", ORG_B),
      );
      const orgBRowCount =
        witness instanceof Error || witness.error || typeof witness.count !== "number"
          ? null
          : witness.count;

      const result = await attempt(`cross-tenant read ${table}`, () =>
        sessionA.client.from(table).select("id").eq("organization_id", ORG_B).limit(1),
      );
      if (result instanceof Error) {
        unclear(
          `Cross-tenant read of ${table}: request did not complete — isolation not exercised.`,
        );
        continue;
      }
      const { data, error } = result;
      const verdict = classifyRlsObservation({
        errorCode: error?.code ?? null,
        anonRowCount: (data ?? []).length,
        adminRowCount: orgBRowCount,
      });

      if (verdict.verdict === "FAIL") {
        leaks++;
        fail(
          `TENANT ISOLATION BREACH: Org A member read ${(data ?? []).length} row(s) from ${table} belonging to Org B.`,
        );
      } else if (verdict.verdict === "PASS") {
        proven++;
      } else if (verdict.reason === "table_empty") {
        noOrgBRows++;
      } else if (verdict.reason === "admin_count_unavailable") {
        unclear(
          `Cross-tenant read of ${table}: Org B's row count is unavailable, so Org A reading zero ` +
            `rows proves nothing.`,
        );
      } else {
        unclear(
          `Cross-tenant read of ${table}: code ${safeCode(error)} — denial not attributable to RLS.`,
        );
      }
    }
    if (checked === 0) {
      missing("No tenant-scoped tables present on staging — cross-tenant read was not exercised.");
    } else {
      if (leaks === 0 && proven > 0) {
        pass(
          `Tenant isolation positively proven on ${proven} of ${checked} tenant-scoped table(s): ` +
            `Org B holds rows there and the Org A member read none of them.`,
        );
      }
      if (noOrgBRows > 0) {
        unclear(
          `${noOrgBRows} of ${checked} tenant-scoped table(s) hold NO Org B rows on staging. Org A ` +
            `reading zero rows from an organization that has none proves nothing about isolation, ` +
            `so these are NOT counted as proven. Seed Org B data and re-run.`,
        );
      }
    }

    // 5b. Cross-tenant write attempt (opt-in only).
    //
    // M2: a refusal only counts when it is an AUTHORIZATION refusal. A trigger
    // raising, a check constraint, a malformed id or a validation error all
    // refuse the write without the authorization decision ever being reached,
    // so none of them proves tenant isolation. The target is therefore chosen
    // to exclude trigger-protected tables, and the update is a no-op by value —
    // it sets organization_id to the value it already filters on, so even in
    // the failing case where the write is accepted, no column changes.
    if (allowWriteProbes) {
      const target = selectWriteProbeTarget(tenantScoped, triggerProtectedTables);
      if (target === undefined) {
        missing(
          "No tenant-scoped table on staging is free of triggers, so no write probe target is " +
            "trustworthy — a trigger can refuse before authorization is reached, which would prove " +
            "nothing. Cross-tenant WRITE denial was NOT verified.",
        );
      } else {
        const result = await attempt(`cross-tenant write ${target}`, () =>
          sessionA.client
            .from(target)
            .update({ organization_id: ORG_B })
            .eq("organization_id", ORG_B),
        );
        if (result instanceof Error) {
          unclear(`Cross-tenant write against ${target}: request did not complete.`);
        } else {
          const verdict = classifyWriteProbe(result.error ?? null);
          if (verdict.verdict === "PASS") {
            pass(
              `Org A member's cross-tenant UPDATE against ${target} was refused by AUTHORIZATION ` +
                `(code ${safeCode(result.error)}).`,
            );
          } else if (verdict.verdict === "FAIL") {
            fail(
              `TENANT ISOLATION BREACH: Org A member's UPDATE against Org B rows in ${target} was accepted.`,
            );
          } else {
            unclear(
              `Cross-tenant UPDATE against ${target} was refused with code ${safeCode(result.error)}, ` +
                `which is not an authorization denial. The request did not reach the authorization ` +
                `decision, so tenant isolation on writes remains UNPROVEN.`,
            );
          }
        }
      }
    } else {
      missing(
        "Cross-tenant WRITE denial not probed — re-run with --allow-write-probes against staging only.",
      );
    }

    // 5c. Sign-out must revoke the access token server-side.
    const revokedToken = sessionA.token;
    await attempt("sign out Owner A", () => sessionA.client.auth.signOut());
    const revokedProbe = createClient(URL, ANON, {
      ...clientOptions,
      global: { ...clientOptions.global, headers: { Authorization: `Bearer ${revokedToken}` } },
    });
    const afterSignOut = await attempt("probe revoked token", () =>
      revokedProbe.auth.getUser(revokedToken),
    );
    if (afterSignOut instanceof Error) {
      unclear("Revoked-token probe did not complete — revocation not verified.");
    } else if (afterSignOut.error || !afterSignOut.data.user) {
      pass("Access token is rejected after sign-out — revocation is enforced server-side.");
    } else {
      fail(
        "Access token still resolves to a user AFTER sign-out — session revocation is not enforced.",
      );
    }

    // 5d. A structurally invalid token must never authenticate.
    const invalid = await attempt("probe invalid token", () =>
      anon.auth.getUser("invalid.token.value"),
    );
    if (invalid instanceof Error) {
      unclear("Invalid-token probe did not complete.");
    } else if (invalid.error || !invalid.data.user) {
      pass("Invalid session token is rejected.");
    } else {
      fail("Invalid session token resolved to a user — token validation is not enforced.");
    }

    // 5e. User A → sign-out → User B must yield a different identity.
    const sessionB = await signIn(ownerB);
    if (sessionB) {
      const who = await attempt("identify User B", () => sessionB.client.auth.getUser());
      const aProbe = await attempt("re-probe User A token", () => anon.auth.getUser(revokedToken));
      if (who instanceof Error || aProbe instanceof Error) {
        unclear("Session-transition probe did not complete.");
      } else {
        const bId = who.data.user?.id ?? "";
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
      }
      await attempt("sign out Owner B", () => sessionB.client.auth.signOut());
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
      const result = await attempt(`${acc.label} audit_logs read`, () =>
        s.client.from("audit_logs").select("id").eq("organization_id", ORG_A).limit(1),
      );
      if (result instanceof Error) {
        unclear(`${acc.label}: audit_logs read did not complete — role enforcement not verified.`);
        await attempt(`sign out ${acc.label}`, () => s.client.auth.signOut());
        continue;
      }
      const { data, error } = result;
      const rows = (data ?? []).length;
      if (acc === staffA) {
        if (!error && rows > 0) {
          fail(
            "Staff account read audit_logs — audit access must be restricted to privileged roles.",
          );
        } else if (isAuthorizationDenial(error?.code)) {
          pass(`Staff account is refused audit_logs by authorization (code ${safeCode(error)}).`);
        } else if (!error && rows === 0) {
          // Same empty-table trap as H1: zero rows only means something when
          // the service role can see rows there.
          const auditCount = adminRowCounts.get("audit_logs") ?? null;
          if (auditCount === null) {
            unclear(
              "Staff audit_logs read returned zero rows, but the service-role count is unavailable — " +
                "restriction not proven.",
            );
          } else if (auditCount === 0) {
            unclear(
              "Staff audit_logs read returned zero rows, but audit_logs is EMPTY on staging — an " +
                "unrestricted read of an empty table looks identical. Restriction NOT proven; seed " +
                "audit rows for Org A and re-run.",
            );
          } else {
            pass(
              `Staff account read zero audit_logs rows while the service role sees ${auditCount} — ` +
                "audit access is restricted.",
            );
          }
        } else {
          unclear(
            `Staff audit_logs read was refused with code ${safeCode(error)} — refusal not attributable ` +
              "to authorization, so the restriction is not proven.",
          );
        }
      } else {
        info(
          `Manager audit_logs read returned ${rows} row(s) (code ${safeCode(error)}) — compare against PERMISSIONS_MATRIX.md.`,
        );
      }
      await attempt(`sign out ${acc.label}`, () => s.client.auth.signOut());
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

clearTimeout(watchdog);

console.log(`\n${"═".repeat(64)}`);
console.log(
  `  ${passed} passed, ${failed} failed, ${inconclusive} inconclusive, ${unconfigured} not configured.`,
);
console.log("═".repeat(64));

if (timedOut) {
  console.error(
    `\n  One or more hosted requests timed out. Results above are partial and must NOT be recorded\n` +
      `  as a staging verification.\n`,
  );
}

if (failed > 0) {
  console.error(`\n  STAGING VERIFICATION FAILED — ${failed} check(s) did not hold.\n`);
  process.exit(1);
}
if (inconclusive > 0 || unconfigured > 0 || timedOut) {
  console.error(
    `\n  STAGING VERIFICATION INCOMPLETE — ${inconclusive} inconclusive, ${unconfigured} not configured.\n` +
      `  Do NOT record this run as "staging verified". Only the ${passed} PASS line(s) above were proven.\n`,
  );
  process.exit(1);
}
console.log(`\n  All ${passed} staging checks passed.\n`);
