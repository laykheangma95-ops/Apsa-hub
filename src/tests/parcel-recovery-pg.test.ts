/**
 * Runs the real-PostgreSQL parcel recovery concurrency proofs
 * (parcel-recovery-pg.runtime.ts) in an isolated process against
 * APSA_TEST_PG_URL. CI provides a PostgreSQL service and sets it, and there a
 * missing URL is a failure, never a silent skip: lock contention cannot be
 * proven on PGlite. Locally, without a server, the proof is skipped and says so.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const url = process.env["APSA_TEST_PG_URL"];
const inCi = process.env["CI"] === "true";

if (!url && !inCi) {
  it.skip("parcel recovery under real PostgreSQL lock contention (set APSA_TEST_PG_URL)", () => {});
} else {
  it("parcel recovery is atomic under real PostgreSQL lock contention", () => {
    expect(url, "CI must provide APSA_TEST_PG_URL (PostgreSQL service)").toBeTruthy();
    const result = spawnSync(
      process.execPath,
      ["test", path.join(root, "src/tests/parcel-recovery-pg.runtime.ts")],
      { cwd: root, encoding: "utf8", timeout: 170_000, env: process.env },
    );
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    expect(result.status).toBe(0);
  }, 180_000);
}
