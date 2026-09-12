/**
 * Team/Staff domain tests — isolation wrapper.
 *
 * The real suite lives in src/tests/team-domain.runtime.ts. It rebinds
 * auditLog()/auditLogRequired() through bun's mock.module(), which merges into
 * the live module namespace and is NOT undone by mock.restore() — so running it
 * in the shared test process left every later file (notably
 * src/tests/tenant-isolation.test.ts and its U2 mandatory-audit guard
 * assertions) exercising a no-op double instead of the real audit guard.
 *
 * Spawning it keeps the audit mocks inside their own process, the same split
 * payment-domain.test.ts and payments-operations-ui.test.ts already use.
 *
 * Run: bun test src/tests/team-domain.test.ts
 */
import { describe, expect, it } from "bun:test";

describe("team/staff domain", () => {
  it("runs isolated team domain checks without mutating the shared test module cache", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/tests/team-domain.runtime.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  }, 60000);
});
