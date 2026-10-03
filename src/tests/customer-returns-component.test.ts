/**
 * Runs the mounted Customer Returns regressions in an isolated module process.
 *
 * The runtime replaces only router and server-function boundaries. Isolation is
 * required so those replacements cannot alter other route tests, and so React
 * Query observes the runtime's browser-like environment before module load.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");

it("Customer Returns screens discard late responses for retired identities and never show a cached order when denied", () => {
  const result = spawnSync(
    process.execPath,
    ["test", path.join(root, "src/tests/customer-returns-component.runtime.ts")],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );

  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 65_000);
