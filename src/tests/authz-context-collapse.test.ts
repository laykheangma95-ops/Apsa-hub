/**
 * Authorization context collapse (src/server/auth/membership.ts,
 * src/server/auth/active-organization.ts, src/server/auth/membership-prefetch.ts).
 *
 * The behavioral checks — legacy ≡ new for every user × organization, role
 * distinctions, fail-closed denials, org switching, revocation, single-use
 * request-local reuse, and round-trip counts — run in an isolated child
 * process (authz-context-collapse.runtime.ts) because mock.module is global.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("authorization context collapse", () => {
  it("runs authz-context-collapse.runtime.ts in a child process", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "./src/tests/authz-context-collapse.runtime.ts"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
  });

  it("identity and org stay server-derived: status filter kept, no client org input", () => {
    const resolver = read("src/server/auth/active-organization.ts");
    expect(resolver).toMatch(/\.eq\("user_id", userId\)/);
    expect(resolver).toMatch(/\.eq\("status", "active"\)/);
    const membership = read("src/server/auth/membership.ts");
    expect(membership).toMatch(/\.eq\("user_id", userId\)/);
    expect(membership).toMatch(/\.eq\("organization_id", organizationId\)/);
    expect(membership).toMatch(/\.eq\("status", "active"\)/);
  });

  it("request-local reuse is keyed on the per-call boundary context, never module state", () => {
    const src = read("src/server/auth/membership-prefetch.ts");
    expect(src).toContain("new WeakMap<RequestContext");
    expect(src).toContain("serverFnBoundary");
    // No Map/TTL cache, no timers.
    expect(src).not.toMatch(/new Map\(|setTimeout|Date\.now\(\)|ttl/i);
  });
});
