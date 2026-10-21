/**
 * Runs the native-PostgreSQL proofs of migration 061's staging exception
 * (migration-061-staging-exception-native.runtime.ts) in an isolated process against
 * APSA_TEST_PG_URL: Supabase's role split (a superuser supabase_admin with its
 * own default privileges, separate databases per case) needs a real server.
 * CI provides one, and there a missing URL is a failure, never a silent skip.
 * Locally, without a server, the proof is skipped and says so.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const url = process.env["APSA_TEST_PG_URL"];
const inCi = process.env["CI"] === "true";

if (!url && !inCi) {
  it.skip("061 staging exception on native PostgreSQL (set APSA_TEST_PG_URL)", () => {});
} else {
  it("061 staging exception: exact managed-default match only; every mutation aborts", () => {
    expect(url, "CI must provide APSA_TEST_PG_URL (PostgreSQL service)").toBeTruthy();
    const result = spawnSync(
      process.execPath,
      ["test", path.join(root, "src/tests/migration-061-staging-exception-native.runtime.ts")],
      { cwd: root, encoding: "utf8", timeout: 170_000, env: process.env },
    );
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    else
      console.info(
        /\[061-staging-exception-native\][^\n]*/.exec(result.stdout + result.stderr)?.[0],
      );
    expect(result.status).toBe(0);
  }, 180_000);
}
