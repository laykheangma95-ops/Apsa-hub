import { describe, expect, it } from "bun:test";

describe("onboarding flow", () => {
  it("runs isolated onboarding organization-creation checks", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/tests/onboarding-flow.runtime.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  });
});
