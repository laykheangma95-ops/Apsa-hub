import { describe, expect, it } from "bun:test";

describe("multi-organization canonical resolution", () => {
  it("runs isolated runtime checks without mutating the shared test module cache", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/multi-org-resolution.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
  });
});

describe("no second membership-selection rule in the API layer", () => {
  it("only the /app guard and route resolver read memberships directly, and both use the canonical picker", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const files = readdirSync("src/api").filter((f) => f.endsWith(".ts"));
    const direct = files.filter((f) =>
      readFileSync(`src/api/${f}`, "utf8").includes('.from("memberships")'),
    );
    expect(direct.sort()).toEqual(["app-guard.ts", "auth.ts"]);
    for (const f of direct) {
      expect(readFileSync(`src/api/${f}`, "utf8")).toContain("pickCanonicalActiveMembership(");
    }
    for (const f of files) {
      expect({
        f,
        asc: /"joined_at",\s*\{\s*ascending:\s*true/.test(readFileSync(`src/api/${f}`, "utf8")),
      }).toEqual({
        f,
        asc: false,
      });
    }
  });
});
