import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

it("Migration 049 analytics_period_status_counts_v1 executes correctly against every migration in PGlite", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/analytics-period-status-counts.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 130000);
