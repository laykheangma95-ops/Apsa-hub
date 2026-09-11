/**
 * Capability layer boundary tests — source-level structural checks.
 *
 * The whole point of this phase is that the browser stopped deciding access.
 * These checks make that hard to undo by accident:
 *
 *   1. No client-side role→permission matrix comes back.
 *   2. The mock `currentRole` / `permissionsFor` layer stays deleted.
 *   3. The capability server function accepts no input and keeps the
 *      service-role client behind a dynamic import.
 *   4. /app protection stays in beforeLoad; the capability loader is additive.
 *   5. The design-gallery fixture never reaches a signed-in route.
 *   6. Sign-out still drops every cached query (capability snapshot included)
 *      and still revokes the session before the best-effort audit.
 *
 * Run: bun test src/tests/capability-boundary.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

function read(rel: string): string {
  const abs = path.resolve(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : "";
}

function findFiles(dir: string, exts: string[]): string[] {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  (function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(path.relative(ROOT, full));
    }
  })(abs);
  return out;
}

const BROWSER_SOURCE = [
  ...findFiles("src/routes", [".ts", ".tsx"]),
  ...findFiles("src/components", [".ts", ".tsx"]),
  ...findFiles("src/design-system", [".ts", ".tsx"]),
  ...findFiles("src/hooks", [".ts", ".tsx"]),
  ...findFiles("src/lib", [".ts", ".tsx"]),
];

// ── U1: the mock role layer is gone and does not come back ───────────────────

describe("U1: no client-side role matrix", () => {
  it("src/lib/permissions.ts (the mock permissionsFor matrix) no longer exists", () => {
    expect(fs.existsSync(path.resolve(ROOT, "src/lib/permissions.ts"))).toBe(false);
  });

  it("no browser-bundled module exports or calls permissionsFor()", () => {
    const offenders = BROWSER_SOURCE.filter((file) => /\bpermissionsFor\b/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("no browser-bundled module reads a mock currentRole", () => {
    const offenders = BROWSER_SOURCE.filter((file) => /\bcurrentRole\b/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("the capability model holds no role→permission table", () => {
    const source = read("src/lib/capabilities.ts");
    // A hardcoded matrix would have to name the system roles.
    expect(source).not.toMatch(/\bMANAGER\b\s*:/);
    expect(source).not.toMatch(/\bCASHIER\b\s*:/);
    expect(source).not.toMatch(/Record<\s*(StaffRole|SystemRole)\s*,/);
  });
});

// ── U2: the capability server function is the only source of truth ───────────

describe("U2: capability resolution is server-side and input-free", () => {
  const source = read("src/api/capabilities.ts");

  it("declares no validator, so no request body can reach the handler", () => {
    expect(source).toContain("createServerFn().handler(");
    expect(source).not.toContain(".validator(");
  });

  it("takes the user from the cookie session, never from a parameter", () => {
    expect(source).toContain("await getSessionFn()");
    expect(source).toMatch(/\.eq\("user_id", session\.userId\)/);
  });

  it("filters the membership read to active rows only", () => {
    expect(source).toMatch(/\.eq\("status", "active"\)/);
  });

  it("never filters membership by a caller-supplied organization id", () => {
    expect(source).not.toMatch(/\.eq\("organization_id"/);
  });

  it("resolves permissions through the existing AuthorizationService", () => {
    expect(source).toContain("AuthorizationService.forRequest");
  });

  it("keeps server-only modules behind dynamic imports", () => {
    expect(source).toMatch(/await import\(["']@\/lib\/supabase\/server["']\)/);
    expect(source).toMatch(/await import\(["']@\/server\/auth\/authorization["']\)/);
    const staticImports = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import ") && !/^import\s+type\b/.test(line.trim()));
    expect(staticImports.filter((line) => line.includes("supabase/server"))).toEqual([]);
    expect(staticImports.filter((line) => line.includes("@/server/"))).toEqual([]);
  });
});

// ── U3: the /app guard is untouched, the loader is additive ──────────────────

describe("U3: /app protection stays in beforeLoad", () => {
  const source = read("src/routes/app.tsx");

  it("still guards in beforeLoad and still redirects", () => {
    expect(source).toMatch(/beforeLoad:\s*async/);
    expect(source).toContain("checkAppGuardFn()");
    expect(source).toContain("throw redirect({ to: result.redirect })");
  });

  it("does not replace the guard with a client-side capability check", () => {
    expect(source).not.toMatch(/import.*useEffect/);
    // The capability call is a loader, i.e. it runs after — never instead of — beforeLoad.
    expect(source.indexOf("beforeLoad")).toBeLessThan(source.indexOf("loader:"));
  });

  it("feeds the provider identity from the server-derived route context", () => {
    expect(source).toContain("Route.useRouteContext()");
    expect(source).toContain("userId={session.userId}");
    expect(source).toContain("organizationId={organizationId}");
  });
});

// ── U4: the design-gallery fixture never reaches a signed-in route ───────────

describe("U4: the capability fixture is gallery/test scaffolding only", () => {
  it("is not imported by any /app route or shared app component", () => {
    const offenders = BROWSER_SOURCE.filter(
      (file) =>
        !file.startsWith("src/routes/design") &&
        file !== "src/hooks/use-capabilities.tsx" &&
        file !== "src/lib/capabilities.ts" &&
        /CapabilityFixtureProvider|createFixtureCapabilityView/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });
});

// ── U5: sign-out still clears everything, in the right order ─────────────────

describe("U5: sign-out keeps its hardened behaviour", () => {
  it("Settings still clears the whole React Query cache on sign-out", () => {
    const source = read("src/routes/app.settings.tsx");
    expect(source).toContain("queryClient.clear()");
    // Nothing may be re-seeded before the clear runs.
    expect(source.indexOf("await signOutFn()")).toBeLessThan(source.indexOf("queryClient.clear()"));
  });

  it("signOutFn still revokes the session before the best-effort audit", () => {
    const source = read("src/api/auth.ts");
    const revokeIdx = source.indexOf("await client.auth.signOut()");
    const clearIdx = source.indexOf("await clearSessionCookies();\n\n  // 4.");
    const auditIdx = source.indexOf("auditSignOutBestEffort(userId)");
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(clearIdx);
    expect(clearIdx).toBeLessThan(auditIdx);
  });

  it("the capability query is partitioned per user and organization, so a cleared cache cannot be refilled from another session", () => {
    const source = read("src/hooks/use-capabilities.tsx");
    expect(source).toContain("capabilityQueryKey(userId, organizationId)");
    expect(source).toContain("expectedUserId: userId");
    expect(source).toContain("expectedOrganizationId: organizationId");
  });
});

// ── U6: every UI permission key is one the server actually enforces ──────────

describe("U6: the UI consults only server-enforced permission keys", () => {
  /**
   * A key counts as enforced when the server either requires/checks it
   * directly, or lists it in one of the Order state machine's transition
   * permission maps (which src/server/orders/service.ts feeds straight into
   * ctx.require). An incidental mention — an audit action name, a doc comment
   * — is deliberately NOT enough: that is exactly how a UI-only gate would
   * sneak in pretending to be authorization.
   */
  /** Comments document intent; only real code enforces anything. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  function enforcedPermissionKeys(): Set<string> {
    const sources = findFiles("src/server", [".ts"]).concat(findFiles("src/api", [".ts"]));
    const keys = new Set<string>();

    for (const file of sources) {
      const source = stripComments(read(file));
      for (const match of source.matchAll(
        /\b(?:require|can)\(\s*["']([a-z_]+\.[a-z_]+)["']\s*\)/g,
      )) {
        keys.add(match[1]!);
      }
    }

    // Transition permission maps: `confirmed: "orders.confirm",` etc.
    const stateMachine = read("src/server/orders/state-machine.ts");
    for (const mapName of [
      "LIFECYCLE_TRANSITION_PERMISSIONS",
      "FULFILLMENT_TRANSITION_PERMISSIONS",
    ]) {
      const start = stateMachine.indexOf(`export const ${mapName}`);
      if (start < 0) continue;
      const block = stripComments(stateMachine.slice(start, stateMachine.indexOf("};", start)));
      for (const match of block.matchAll(/:\s*["']([a-z_]+\.[a-z_]+)["']/g)) {
        keys.add(match[1]!);
      }
    }

    return keys;
  }

  function declaredUiKeys(): string[] {
    const source = read("src/lib/capabilities.ts");
    const start = source.indexOf("export const UI_PERMISSION_KEYS");
    const block = source.slice(start, source.indexOf("] as const;", start));
    return [...block.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((match) => match[1]!);
  }

  it("the enforced-key scan finds the keys it is supposed to find", () => {
    // Guards the test itself: if the scan silently matched nothing, every
    // assertion below would pass vacuously.
    const enforced = enforcedPermissionKeys();
    expect(enforced.size).toBeGreaterThan(20);
    expect(enforced.has("team.read")).toBe(true);
    expect(enforced.has("orders.confirm")).toBe(true);
    // An audit action name that no handler requires must NOT read as enforced.
    expect(enforced.has("orders.refund")).toBe(false);
  });

  it("every UI_PERMISSION_KEYS entry is required or checked by server code", () => {
    const enforced = enforcedPermissionKeys();
    const declared = declaredUiKeys();
    expect(declared.length).toBeGreaterThan(10);
    expect(declared.filter((key) => !enforced.has(key))).toEqual([]);
  });

  it("every declared key is actually consulted by a browser surface", () => {
    // The snapshot must stay minimal: a key nobody reads is data sent to the
    // browser for no reason.
    const uiSource = BROWSER_SOURCE.filter(
      (file) => file !== "src/lib/capabilities.ts" && !file.includes("mobile-nav-config"),
    )
      .map(read)
      .join("\n")
      .concat(read("src/design-system/mobile-nav-config.ts"));

    const unused = declaredUiKeys().filter((key) => !uiSource.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });
});
