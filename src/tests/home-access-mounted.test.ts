/**
 * Spawns src/tests/home-access-mounted.runtime.ts in its own process: it
 * registers happy-dom globals and module mocks that must not leak into the
 * rest of the suite.
 *
 * Run: bun test src/tests/home-access-mounted.test.ts
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Home: money hides on revocation/expiry and New Order needs both of its keys (mounted)", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/home-access-mounted.runtime.ts")],
    // A large buffer: a runaway child must fail on its own test results,
    // never be killed (ENOBUFS) for the volume of its warnings.
    { cwd: process.cwd(), encoding: "utf8", timeout: 240000, maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) console.error(failureDigest(result));
  expect(result.status).toBe(0);
}, 250000);

/**
 * What a CI log can show of a failed run: how the child ended, every failing
 * test and timeout, and what came just before the first failure — not
 * megabytes of repeated warnings, which a log viewer truncates.
 */
function failureDigest(result: ReturnType<typeof spawnSync>): string {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const lines = output.split("\n");
  const first = lines.findIndex((line) => line.startsWith("(fail)"));
  const notable = lines.filter((line) =>
    /^\(fail\)|timed out|Timed out waiting|^error:|^\s+at .*runtime\.ts/.test(line),
  );
  return [
    `child status=${String(result.status)} signal=${String(result.signal)} error=${result.error?.message ?? "none"} output=${output.length} chars`,
    "--- before the first failure ---",
    ...(first >= 0 ? lines.slice(Math.max(0, first - 40), first + 1) : lines.slice(-40)),
    "--- failures, timeouts and errors (first 80) ---",
    ...[...new Set(notable)].slice(0, 80),
  ]
    .map((line) => line.slice(0, 300))
    .join("\n");
}
