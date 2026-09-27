/**
 * /design must not exist on a production deployment.
 *
 * The component gallery at /design renders fixture business identities — named
 * customers from src/lib/mock/customers, a conversation from
 * src/lib/mock/conversations and a staff member from src/lib/mock/shop. Nothing
 * links to it, which is exactly why hiding a nav entry would have changed
 * nothing: it was reachable by typing the URL, and a production visitor got a
 * full gallery of fabricated people.
 *
 * These tests EXECUTE the route's own `beforeLoad` guard rather than matching
 * strings in its source, so they fail if the guard is deleted, inverted, moved
 * into the component (where fixture UI would render first and be hidden
 * afterwards), or made conditional on something other than the production gate.
 *
 * Run: bun test src/tests/design-route-production.test.ts
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import { Route as DesignRoute } from "@/routes/design";
import { prototypeFixturesAllowed } from "@/lib/api/prototype-gate";

const repoRoot = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
/** Code only — comments explain the gate and would match its own name. */
const code = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const env = process.env as Record<string, string | undefined>;
const originalProd = env["PROD"];

function asProduction() {
  env["PROD"] = "true";
}

afterEach(() => {
  if (originalProd === undefined) delete env["PROD"];
  else env["PROD"] = originalProd;
});

/**
 * The guard as the router will call it. TanStack Router passes a context
 * argument that this guard does not read, so an empty object is faithful.
 */
function runBeforeLoad(): unknown {
  const beforeLoad = DesignRoute.options.beforeLoad;
  if (typeof beforeLoad !== "function") {
    throw new Error("/design has no beforeLoad guard — production reachability is unguarded");
  }
  return (beforeLoad as (ctx: unknown) => unknown)({});
}

/** What TanStack Router's notFound() throws, without importing its internals. */
function isNotFound(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    (thrown as Record<string, unknown>)["isNotFound"] === true
  );
}

describe("1. the guard is route-level, not inside the component", () => {
  it("/design defines beforeLoad", () => {
    // beforeLoad runs before the route loads — on the server during SSR and
    // before navigation on the client. A check inside the component would
    // render fixture UI first and hide it afterwards.
    expect(typeof DesignRoute.options.beforeLoad).toBe("function");
  });
});

describe("2. production: /design does not resolve", () => {
  it("beforeLoad throws a not-found when the production gate is closed", () => {
    asProduction();
    expect(prototypeFixturesAllowed()).toBe(false);

    let thrown: unknown;
    try {
      runBeforeLoad();
      throw new Error("beforeLoad resolved in production — /design is still reachable");
    } catch (error) {
      thrown = error;
    }

    expect(isNotFound(thrown)).toBe(true);
  });

  it("decides per call, not once at module load", () => {
    /*
     * A guard written as `const allowed = prototypeFixturesAllowed()` at module
     * scope would be evaluated when the route module is first imported and then
     * never re-checked. Flipping the gate twice in one process is what
     * distinguishes a live check from a cached one.
     */
    expect(runBeforeLoad()).toBeUndefined();
    asProduction();
    expect(() => runBeforeLoad()).toThrow();
    delete env["PROD"];
    expect(runBeforeLoad()).toBeUndefined();
  });
});

describe("3. dev/test: the gallery still works", () => {
  it("beforeLoad resolves when the production gate is open", () => {
    expect(prototypeFixturesAllowed()).toBe(true);
    // No throw, and nothing returned that the router would treat as a redirect.
    expect(runBeforeLoad()).toBeUndefined();
  });
});

describe("4. the guard uses the shared production gate", () => {
  it("reads prototypeFixturesAllowed rather than its own environment check", () => {
    // One gate for every fixture-reachable path in the app (src/lib/api/index.ts
    // and this route), so production behaviour cannot drift between them.
    const source = code("src/routes/design.tsx");
    expect(source).toContain('from "@/lib/api/prototype-gate"');
    expect(source).toContain("prototypeFixturesAllowed()");
    expect(source).not.toMatch(/import\.meta\.env/);
    expect(source).not.toMatch(/process\.env/);
  });
});
