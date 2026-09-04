import { describe, expect, it } from "bun:test";

describe("session cookie behavior", () => {
  it("runs public-auth cookie checks in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/tests/session.runtime.ts"], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });
});
