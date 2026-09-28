/**
 * Customer directory, name search and phone scan ordering — total and
 * page-stable under offset paging with equal timestamps.
 *
 * The behaviour runs in an isolated process
 * (customer-directory-ordering.runtime.ts): other test files replace
 * "@/server/customers/repository" with mock.module, which mutates the shared
 * module cache for the whole process, so an in-process import here could
 * receive a stub instead of the real repository.
 */
import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("directory, name search and phone scan ordering hold in an isolated process", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/customer-directory-ordering.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  // The child must have actually run all six checks, not zero.
  expect(result.stderr).toMatch(/\b6 pass\b/);
  expect(result.stderr).toMatch(/\b0 fail\b/);
}, 70000);
