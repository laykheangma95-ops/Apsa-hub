import { describe, expect, it } from "bun:test";

describe("sign-in flow", () => {
  it("runs isolated sign-in flow checks", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/tests/sign-in-flow.runtime.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  });
});
