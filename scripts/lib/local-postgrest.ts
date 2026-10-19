/**
 * A throwaway local PostgREST over a throwaway local database, loopback only.
 *
 * provision() creates a fresh database on a loopback PostgreSQL, applies the
 * Supabase baseline (roles anon/authenticated/service_role, schema auth with
 * auth.users and auth.uid(), Supabase's default privileges — as in
 * src/tests/migration-062-native-roles.runtime.ts) and then EVERY migration
 * in order, and starts a real PostgREST binary on it with `db-max-rows` set to
 * `cap` and a JWT secret that exists only for this run. stop() ends the server
 * and drops the database.
 *
 * Used by scripts/run-catalog-postgrest-gate.ts and
 * scripts/products-mobile-harness.ts. Never point it at a hosted project: both
 * URLs are refused unless they are loopback.
 */
import { SQL } from "bun";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

export function loopbackOnly(raw: string) {
  const host = new URL(raw).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    throw new Error(`Refusing a non-loopback test target: ${host}`);
  }
}

export const BASELINE = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
  -- As Supabase's: the legacy per-claim setting, else PostgREST's claims object.
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
    SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
                    nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
  GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

export function jwt(secret: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export interface Target {
  databaseUrl: string;
  postgrestUrl: string;
  /** A service_role JWT for this server. */
  token: string;
  /** The server's JWT secret, for minting other roles' tokens in this run. */
  secret: string;
  cap: number;
  stop: () => Promise<void>;
  versions: { postgres: string; postgrest: string };
}

export async function provision(adminUrl: string, bin: string, cap: number): Promise<Target> {
  loopbackOnly(adminUrl);
  const name = `apsa_local_pgrst_${randomBytes(6).toString("hex")}`;
  const admin = new SQL(adminUrl);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
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
  // A port the OS just handed out, rather than a guess that may be taken.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const server: ChildProcess = spawn(bin, [], {
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
  const postgrest = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();

  return {
    databaseUrl,
    postgrestUrl,
    token,
    secret,
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
