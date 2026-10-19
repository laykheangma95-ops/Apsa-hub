/**
 * Runs the native-PostgreSQL migration 062 role-authority proofs
 * (migration-062-native-roles.runtime.ts) in an isolated process against
 * APSA_TEST_PG_URL. CI provides a PostgreSQL service and sets it, and there a
 * missing URL is a failure, never a silent skip: real role switching is the
 * point. Locally, without a server, the proof is skipped and says so.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const url = process.env["APSA_TEST_PG_URL"];
const inCi = process.env["CI"] === "true";

if (!url && !inCi) {
  it.skip("migration 062 role authority on native PostgreSQL (set APSA_TEST_PG_URL)", () => {});
} else {
  it("migration 062 role authority holds on native PostgreSQL, by role-switched calls", () => {
    expect(url, "CI must provide APSA_TEST_PG_URL (PostgreSQL service)").toBeTruthy();
    const result = spawnSync(
      process.execPath,
      ["test", path.join(root, "src/tests/migration-062-native-roles.runtime.ts")],
      { cwd: root, encoding: "utf8", timeout: 170_000, env: process.env },
    );
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    else
      console.info(/\[migration-062-native-roles\][^\n]*/.exec(result.stdout + result.stderr)?.[0]);
    expect(result.status).toBe(0);
  }, 180_000);
}
