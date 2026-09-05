import { it, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Isolate repository mocks and the local PostgreSQL runtime from other suites.
it("production Conversation SQL, authorization and adapter contracts", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/conversation-production.runtime.ts")],
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

describe("mock IDs stay outside production server functions", () => {
  it("rejects non-UUID write and pagination inputs before importing a server function", async () => {
    const api = await import("../api/inbox");
    await expect(api.markRealConversationRead("mock", "mock-message")).rejects.toThrow(
      "invalid_reference",
    );
    await expect(api.updateRealConversationStatus("mock", "closed")).rejects.toThrow(
      "invalid_reference",
    );
    await expect(api.assignRealConversation("mock", null)).rejects.toThrow("invalid_reference");
    await expect(api.getOlderConversationMessages("mock", "mock-message")).rejects.toThrow(
      "invalid_reference",
    );
  });
});
