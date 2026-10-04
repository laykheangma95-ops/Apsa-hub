/**
 * Runs the mounted Customer Intelligence capability-revocation regressions in
 * an isolated process: the runtime replaces router and server-function
 * boundaries with mock.module, which is process-wide.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

it("Customer Detail stops showing Customer Intelligence the moment a required grant is revoked, ignores late responses, and refetches on restore", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/customer-insights-revocation.runtime.ts")],
    { cwd: root, encoding: "utf8", timeout: 120_000 },
  );

  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 125_000);
