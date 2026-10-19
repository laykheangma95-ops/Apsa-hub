/**
 * The Products catalogue's real-PostgREST gate, end to end, on loopback only.
 *
 * For each row cap it builds a throwaway database on APSA_TEST_PG_URL (the
 * Supabase baseline of src/tests/migration-062-native-roles.runtime.ts, then
 * EVERY migration in order), starts a real PostgREST binary on it with
 * `db-max-rows` set to that cap, mints a service_role JWT with a random
 * per-run secret, and runs src/tests/products-catalog-postgrest.test.ts
 * against it. The database is dropped and the server stopped afterwards.
 *
 * With --negative-controls it then re-runs the suite (at the first cap) once
 * per deliberate regression below — each one restores a pre-#126 behaviour or
 * removes one protection — and passes only if EVERY regression makes the
 * suite fail on the cases named for it. Source files are restored from memory
 * in a `finally`, whatever happens.
 *
 * Nothing here can reach a hosted project: both URLs must be loopback, and
 * the JWT secret exists only for this run.
 *
 *   APSA_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *   APSA_TEST_POSTGREST_BIN=/path/to/postgrest \
 *   bun run scripts/run-catalog-postgrest-gate.ts [--caps 40,150,1000] [--negative-controls]
 *     [--only <negative-control name fragment>] [--log-dir <directory>]
 */
import { SQL } from "bun";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const adminUrl = process.env["APSA_TEST_PG_URL"];
const bin = process.env["APSA_TEST_POSTGREST_BIN"];
if (!adminUrl || !bin) {
  console.error("APSA_TEST_PG_URL and APSA_TEST_POSTGREST_BIN are required.");
  process.exit(2);
}

const args = process.argv.slice(2);
const capsArg = args.includes("--caps") ? args[args.indexOf("--caps") + 1] : "40,150,1000";
const caps = capsArg!.split(",").map((value) => Number(value));
if (caps.some((cap) => !Number.isInteger(cap) || cap < 10)) {
  console.error(`--caps must be integers of at least 10 (got ${capsArg})`);
  process.exit(2);
}
const negativeControls = args.includes("--negative-controls");
// Only the negative controls whose name contains this text.
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
// Every run's full output, one file each, for a reviewer.
const logDir = args.includes("--log-dir") ? args[args.indexOf("--log-dir") + 1] : undefined;
if (logDir) mkdirSync(logDir, { recursive: true });
const keepLog = (name: string, output: string) => {
  if (logDir) writeFileSync(path.join(logDir, `${name.replace(/[^a-z0-9]+/gi, "-")}.log`), output);
};

function loopbackOnly(raw: string) {
  const host = new URL(raw).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(`Refusing a non-loopback test target: ${host}`);
  }
}
loopbackOnly(adminUrl);

const BASELINE = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

function jwt(secret: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

interface Target {
  databaseUrl: string;
  postgrestUrl: string;
  token: string;
  cap: number;
  stop: () => Promise<void>;
  versions: { postgres: string; postgrest: string };
}

async function provision(cap: number): Promise<Target> {
  const name = `apsa_catalog_gate_${randomBytes(6).toString("hex")}`;
  const admin = new SQL(adminUrl!);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  const sql = new SQL({ url: databaseUrl, max: 2 });
  const postgres = ((await sql`select current_setting('server_version') as v`)[0] as { v: string })
    .v;
  await sql.unsafe(BASELINE);
  const migrations = readdirSync(path.join(root, "supabase/migrations"))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of migrations) {
    try {
      await sql.unsafe(readFileSync(path.join(root, "supabase/migrations", file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file}: ${String(error)}`);
    }
  }
  await sql.close();

  const secret = randomBytes(32).toString("hex");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server: ChildProcess = spawn(bin!, [], {
    env: {
      PATH: process.env["PATH"] ?? "",
      PGRST_DB_URI: databaseUrl,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: secret,
      PGRST_DB_MAX_ROWS: String(cap),
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(port),
      PGRST_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const postgrestUrl = `http://127.0.0.1:${port}`;
  const token = jwt(secret, { role: "service_role", exp: Math.floor(Date.now() / 1000) + 7200 });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${postgrestUrl}/products?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (attempt > 100) throw new Error("PostgREST did not become ready");
    await Bun.sleep(100);
  }
  const postgrest = spawnSync(bin!, ["--version"], { encoding: "utf8" }).stdout.trim();

  return {
    databaseUrl,
    postgrestUrl,
    token,
    cap,
    versions: { postgres, postgrest },
    stop: async () => {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

function runSuite(target: Target): { status: number; output: string } {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/products-catalog-postgrest.test.ts")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 900_000,
      // A regression can print tens of thousands of ids; the default 1 MB would cut the run.
      maxBuffer: 512 * 1024 * 1024,
      env: {
        ...process.env,
        APSA_TEST_POSTGREST_URL: target.postgrestUrl,
        APSA_TEST_POSTGREST_MAX_ROWS: String(target.cap),
        APSA_TEST_POSTGREST_JWT: target.token,
        APSA_TEST_DATABASE_URL: target.databaseUrl,
      },
    },
  );
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

const summary = (output: string) =>
  output
    .split("\n")
    .filter((line) => /^\s*\d+ (pass|fail|skip)\b|^\(fail\)/.test(line))
    .join("\n");

/**
 * Each regression: one exact replacement in one file (it must occur exactly
 * once), and test-name fragments of which every one must fail.
 */
const MUTATIONS: {
  name: string;
  file: string;
  find: string;
  replace: string;
  mustFail: string[];
}[] = [
  {
    name: "no probe row: a full page is taken as the end of the list",
    file: "src/server/products/service.ts",
    find: "    limit: limit + 1,\n",
    replace: "    limit,\n",
    mustFail: ["201 and 1,000 products", "beyond 200 and beyond the cap"],
  },
  {
    name: "a short (capped) answer is trusted as the end of a read",
    file: "src/server/products/repository.ts",
    find: "received === 0 || (received < asked && received < (await capFloor()));",
    replace: "received === 0 || received < asked;",
    mustFail: ["201 and 1,000 products", "beyond 200 and beyond the cap"],
  },
  {
    name: "the same-instant continuation read is dropped",
    file: "src/server/products/repository.ts",
    find: '            .lt("id", before.id)\n',
    replace: '            .lt("id", "00000000-0000-0000-0000-000000000000")\n',
    mustFail: ["same-instant burst larger than the cap"],
  },
  {
    name: "the product read is not scoped to the caller's organization",
    file: "src/server/products/repository.ts",
    find: '      .select(columns)\n      .eq("organization_id", organizationId)\n',
    replace: "      .select(columns)\n",
    mustFail: ["beyond 200 and beyond the cap", "SKU, barcode and name matches"],
  },
  {
    name: "variant search ignores the variant's status",
    file: "src/server/products/repository.ts",
    find: '      .eq("product_variants.status", "ACTIVE")\n',
    replace: "",
    mustFail: ["search through the real !inner embed"],
  },
  {
    name: "variants are read once, without continuing past the row cap",
    file: "src/server/products/repository.ts",
    find: "        rows.push(...batch);\n        if (batch.length === 0) break;\n",
    replace: "        rows.push(...batch);\n        break;\n",
    mustFail: ["variants: 2,500 on one product"],
  },
  {
    name: "the page read does not require products.read",
    file: "src/server/products/service.ts",
    find: '  ctx.require("products.read");\n\n  const canViewCost = ctx.can("products.view_cost");\n  const limit',
    replace: '  const canViewCost = ctx.can("products.view_cost");\n  const limit',
    mustFail: ["roles through the real membership read"],
  },
  {
    name: "cost is shown to a member without products.view_cost",
    file: "src/server/products/service.ts",
    find: '  const canViewCost = ctx.can("products.view_cost");\n  const limit',
    replace: "  const canViewCost = true;\n  const limit",
    mustFail: ["roles through the real membership read"],
  },
];

let failed = false;
const versionsSeen: string[] = [];

for (const cap of caps) {
  const target = await provision(cap);
  try {
    versionsSeen.push(
      `PostgreSQL ${target.versions.postgres}, ${target.versions.postgrest}, db-max-rows=${cap}`,
    );
    const run = runSuite(target);
    keepLog(`cap-${cap}`, run.output);
    console.info(
      `\n[catalog-postgrest-gate] cap ${cap}: exit ${run.status}\n${summary(run.output)}`,
    );
    if (run.status !== 0) {
      failed = true;
      console.error(run.output);
    }
  } finally {
    await target.stop();
  }
}

if (negativeControls) {
  const cap = caps[0]!;
  const target = await provision(cap);
  try {
    for (const mutation of MUTATIONS.filter((m) => !only || m.name.includes(only))) {
      const file = path.join(root, mutation.file);
      const original = readFileSync(file, "utf8");
      const occurrences = original.split(mutation.find).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Mutation "${mutation.name}": found ${occurrences} times in ${mutation.file}`,
        );
      }
      let run: { status: number; output: string };
      try {
        writeFileSync(file, original.replace(mutation.find, mutation.replace));
        run = runSuite(target);
      } finally {
        writeFileSync(file, original);
      }
      keepLog(`negative-control-${mutation.name}`, run.output);
      const failedNames = run.output.split("\n").filter((line) => line.startsWith("(fail)"));
      const missed = mutation.mustFail.filter(
        (fragment) => !failedNames.some((line) => line.includes(fragment)),
      );
      const caught = run.status !== 0 && missed.length === 0;
      if (!caught) failed = true;
      console.info(
        `\n[catalog-postgrest-gate] negative control (cap ${cap}) — ${mutation.name}: ` +
          `${caught ? "CAUGHT" : `NOT CAUGHT (missed: ${missed.join("; ") || "suite passed"})`}\n` +
          failedNames.join("\n"),
      );
    }
  } finally {
    await target.stop();
  }
}

console.info(`\n[catalog-postgrest-gate] ${versionsSeen.join(" | ")}`);
console.info(`[catalog-postgrest-gate] ${failed ? "FAILED" : "PASSED"}`);
process.exit(failed ? 1 : 0);
