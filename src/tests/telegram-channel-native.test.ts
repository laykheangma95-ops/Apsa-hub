/**
 * Runs the native-PostgreSQL Telegram lifecycle proofs
 * (telegram-channel-native.runtime.ts) in an isolated process against
 * APSA_TEST_PG_URL: a backend killed mid-ingest, racing duplicate updates,
 * overlapping connects and racing reply attempts need a real server. CI
 * provides one, and there a missing URL is a failure, never a silent skip.
 * Locally, without a server, the proof is skipped and says so.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const url = process.env["APSA_TEST_PG_URL"];
const inCi = process.env["CI"] === "true";

if (!url && !inCi) {
  it.skip("Telegram 064 lifecycle concurrency on native PostgreSQL (set APSA_TEST_PG_URL)", () => {});
} else {
  it("Telegram 064 crash, replay, lease and attempt races hold on native PostgreSQL", () => {
    expect(url, "CI must provide APSA_TEST_PG_URL (PostgreSQL service)").toBeTruthy();
    const result = spawnSync(
      process.execPath,
      ["test", path.join(root, "src/tests/telegram-channel-native.runtime.ts")],
      { cwd: root, encoding: "utf8", timeout: 170_000, env: process.env },
    );
    if (result.status !== 0) console.error(result.stdout, result.stderr);
    else console.info(/\[telegram-channel-native\][^\n]*/.exec(result.stdout + result.stderr)?.[0]);
    expect(result.status).toBe(0);
  }, 180_000);
}
