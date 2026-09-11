import { describe, expect, it } from "bun:test";

describe("settings account profile + sign-out audit", () => {
  it("runs isolated runtime checks without mutating the shared test module cache", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/settings-account-profile.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  });
});
