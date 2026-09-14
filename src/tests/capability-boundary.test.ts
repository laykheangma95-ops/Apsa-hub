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
   * directly, lists it in one of the Order or Payment state machines'
   * transition permission maps (which src/server/orders/service.ts and
   * src/server/payments/service.ts feed straight into ctx.require), or
   * returns it from the Inventory service's requiredPermissionFor()
   * movement-type map (which recordMovement feeds straight into ctx.require
   * the same way). An incidental mention — an audit action name, a doc
   * comment — is deliberately NOT enough: that is exactly how a UI-only gate
   * would sneak in pretending to be authorization.
   */
  /** Comments document intent; only real code enforces anything. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  /**
   * A permission map is credited as enforcement only if the service it belongs
   * to actually feeds it into ctx.require(). Declaring a table is not enforcing
   * it: without this proof an unused permission map, a leftover from deleted
   * code, or a map whose require() call was removed would all still read as
   * "enforced" — exactly the UI-only gate this whole describe block exists to
   * catch. Comments are stripped first, so naming the map in prose proves
   * nothing either.
   *
   * Both real shapes count, and nothing else:
   *   direct    ctx.require(MAP[key])
   *   via local const permission = MAP[key]; ... ctx.require(permission)
   */
  function mapReachesRequire(serviceSource: string, mapName: string): boolean {
    const code = stripComments(serviceSource);
    const escaped = mapName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (new RegExp(String.raw`ctx\.require\(\s*${escaped}\s*\[`).test(code)) return true;

    for (const match of code.matchAll(
      new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*${escaped}\s*\[`, "g"),
    )) {
      const local = match[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(String.raw`ctx\.require\(\s*${local}\s*[),]`).test(code)) return true;
    }
    return false;
  }

  /**
   * Each permission table, the module that declares it, and the service that
   * must be shown to enforce it. Adding a map here without a service that
   * requires it fails `mapReachesRequire`, so the allowlist can no longer be
   * used to vouch for a table nobody checks.
   */
  const PERMISSION_MAPS: ReadonlyArray<{
    readonly declaredIn: string;
    readonly maps: readonly string[];
    readonly enforcedIn: string;
  }> = [
    {
      declaredIn: "src/server/orders/state-machine.ts",
      maps: ["LIFECYCLE_TRANSITION_PERMISSIONS", "FULFILLMENT_TRANSITION_PERMISSIONS"],
      enforcedIn: "src/server/orders/service.ts",
    },
    /*
     * RECORD_METHOD_PERMISSIONS is the same shape: recordPayment() looks the
     * payment method up in it and passes the result straight to ctx.require,
     * so payments.mark_cod (COD's own grant, seeded by migration 036) is
     * genuinely enforced without ever appearing as a literal inside a
     * require() call.
     */
    {
      declaredIn: "src/server/payments/state-machine.ts",
      maps: ["VERIFICATION_TRANSITION_PERMISSIONS", "RECORD_METHOD_PERMISSIONS"],
      enforcedIn: "src/server/payments/service.ts",
    },
  ];

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

    /*
     * Transition permission maps: `confirmed: "orders.confirm",` etc. A key
     * that only ever appears in one of these is still genuinely enforced —
     * the service looks the target up in the map and passes the result
     * straight to ctx.require, so the literal never appears inside a
     * require() call for the regex above to find.
     *
     * The Payment domain does exactly the same thing:
     * src/server/payments/service.ts#verifyPayment reads
     * VERIFICATION_TRANSITION_PERMISSIONS[to] and calls ctx.require(permission).
     */
    for (const { declaredIn, maps, enforcedIn } of PERMISSION_MAPS) {
      const stateMachine = read(declaredIn);
      const service = read(enforcedIn);
      for (const mapName of maps) {
        // No proof that the service requires it, no credit for its values.
        if (!mapReachesRequire(service, mapName)) continue;
        const start = stateMachine.indexOf(`export const ${mapName}`);
        if (start < 0) continue;
        const block = stripComments(stateMachine.slice(start, stateMachine.indexOf("};", start)));
        for (const match of block.matchAll(/:\s*["']([a-z_]+\.[a-z_]+)["']/g)) {
          keys.add(match[1]!);
        }
      }
    }

    /*
     * Inventory's movement-type -> permission map. Structurally identical to
     * the Order transition maps above: recordMovement() calls
     * ctx.require(requiredPermissionFor(input.movementType)), so every literal
     * this function can return IS a required key — the indirection is a switch
     * rather than an object, which is the only reason the direct scan misses it.
     */
    const inventoryService = read("src/server/inventory/service.ts");
    const permFnStart = inventoryService.indexOf("function requiredPermissionFor");
    // Same proof the maps above need: the switch only counts as enforcement
    // while recordMovement actually hands its result to ctx.require.
    const inventoryEnforced = /ctx\.require\(\s*requiredPermissionFor\(/.test(
      stripComments(inventoryService),
    );
    if (permFnStart >= 0 && inventoryEnforced) {
      const permFnEnd = inventoryService.indexOf("\n}", permFnStart);
      const block = stripComments(inventoryService.slice(permFnStart, permFnEnd));
      for (const match of block.matchAll(/return\s+["']([a-z_]+\.[a-z_]+)["']/g)) {
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

  /*
   * Guards the guard. The scan credits a permission table's values only
   * because a service was shown to pass that table into ctx.require — so if
   * the enforcement call is ever deleted, the map must stop counting and the
   * keys reachable only through it must disappear from the enforced set.
   *
   * Without this, the allowlist above would be a standing human attestation:
   * removing ctx.require(RECORD_METHOD_PERMISSIONS[input.method]) from
   * recordPayment() left every assertion in this file passing.
   */
  it("a declared permission map counts only while its service really requires it", () => {
    for (const { maps, enforcedIn } of PERMISSION_MAPS) {
      const service = read(enforcedIn);
      for (const mapName of maps) {
        expect(`${mapName} enforced in ${enforcedIn}: ${mapReachesRequire(service, mapName)}`).toBe(
          `${mapName} enforced in ${enforcedIn}: true`,
        );
      }
    }

    // Inventory's movement-type switch is credited on the same condition.
    expect(
      /ctx\.require\(\s*requiredPermissionFor\(/.test(read("src/server/inventory/service.ts")),
    ).toBe(true);
  });

  it("removing a map's real ctx.require stops crediting that map's keys", () => {
    // The probe an independent reviewer runs by hand, run in-memory instead:
    // strip the enforcement call and the map must stop reading as enforced.
    const service = read("src/server/payments/service.ts");
    expect(mapReachesRequire(service, "RECORD_METHOD_PERMISSIONS")).toBe(true);

    const withoutEnforcement = service.replace(
      /ctx\.require\(RECORD_METHOD_PERMISSIONS\[input\.method\]\);/,
      "/* enforcement removed */",
    );
    expect(withoutEnforcement).not.toBe(service); // the probe actually cut something
    expect(mapReachesRequire(withoutEnforcement, "RECORD_METHOD_PERMISSIONS")).toBe(false);

    // Naming the map in a comment or an import must never substitute for it.
    expect(
      mapReachesRequire(
        `import { RECORD_METHOD_PERMISSIONS } from "./state-machine";
         // ctx.require(RECORD_METHOD_PERMISSIONS[input.method]);
         /* see RECORD_METHOD_PERMISSIONS */`,
        "RECORD_METHOD_PERMISSIONS",
      ),
    ).toBe(false);

    // A table declared and read but never required is not enforcement either.
    expect(
      mapReachesRequire(
        `const permission = RECORD_METHOD_PERMISSIONS[input.method];
         logger.debug(permission);`,
        "RECORD_METHOD_PERMISSIONS",
      ),
    ).toBe(false);
  });

  it("the enforced-key scan finds the keys it is supposed to find", () => {
    // Guards the test itself: if the scan silently matched nothing, every
    // assertion below would pass vacuously.
    const enforced = enforcedPermissionKeys();
    expect(enforced.size).toBeGreaterThan(20);
    expect(enforced.has("team.read")).toBe(true);
    expect(enforced.has("orders.confirm")).toBe(true);
    // Only reachable through the Payment state machine's permission map.
    expect(enforced.has("payments.manual_confirm")).toBe(true);
    expect(enforced.has("payments.verify")).toBe(true);
    // Only reachable through the Payment record-method permission map.
    expect(enforced.has("payments.mark_cod")).toBe(true);
    // Reached only through the Inventory movement-type map, so this also
    // guards that the extra scan above still finds anything at all.
    expect(enforced.has("inventory.receive_stock")).toBe(true);
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
