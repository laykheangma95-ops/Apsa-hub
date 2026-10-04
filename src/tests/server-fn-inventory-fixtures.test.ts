/**
 * The method guard's own regression tests: deliberately unsafe server
 * functions, written as in-memory source fixtures, that the inventory
 * (helpers/server-fn-inventory.ts) and policy (helpers/server-fn-policy.ts)
 * MUST reject. server-fn-method-guard.test.ts applies the same code to the real
 * repository; these prove it cannot be bypassed by the shapes below.
 *
 * In particular (independent review P2): an aliased named import and a
 * namespace import of createServerFn both compile into real TanStack server
 * functions that default to GET. A spelling-based detector missed both.
 */
import { describe, expect, it } from "bun:test";
import { inventorySources, type SourceFile } from "./helpers/server-fn-inventory";
import { checkServerFnPolicy, type ReadOnlyRegistry } from "./helpers/server-fn-policy";

const NO_READS: ReadOnlyRegistry = {};

function check(text: string, registry: ReadOnlyRegistry = NO_READS, file = "src/api/fixture.ts") {
  const sources: SourceFile[] = [{ file, text }];
  const inventory = inventorySources(sources);
  return { inventory, violations: checkServerFnPolicy(inventory, registry) };
}

const handler = `.handler(async ({ data }) => createParcelForOrder(data))`;

describe("P2 — import aliases and namespaces are seen by binding", () => {
  it("A. aliased import + omitted method: detected as GET and rejected", () => {
    const { inventory, violations } = check(`
      import { createServerFn as csf } from "@tanstack/react-start";
      export const createParcelFn = csf().validator((d: unknown) => d)${handler};
    `);
    expect(inventory.definitions.map((d) => [d.name, d.method])).toEqual([
      ["createParcelFn", "default"],
    ]);
    expect(violations.notPost).toEqual(["createParcelFn (src/api/fixture.ts:3, method=default)"]);
    expect(violations.nonCanonical).toEqual(["aliased-import (src/api/fixture.ts:2)"]);
  });

  it("B. namespace import + omitted method: detected as GET and rejected", () => {
    const { inventory, violations } = check(`
      import * as TS from "@tanstack/react-start";
      export const createParcelFn = TS.createServerFn().validator((d: unknown) => d)${handler};
    `);
    expect(inventory.definitions.map((d) => [d.name, d.method])).toEqual([
      ["createParcelFn", "default"],
    ]);
    expect(violations.notPost).toHaveLength(1);
    expect(violations.nonCanonical).toEqual(["namespace-import (src/api/fixture.ts:2)"]);
  });

  it("B2. namespace element access is detected too", () => {
    const { inventory, violations } = check(`
      import * as TS from "@tanstack/react-start";
      export const createParcelFn = TS["createServerFn"]()${handler};
    `);
    expect(inventory.definitions.map((d) => d.name)).toEqual(["createParcelFn"]);
    expect(violations.notPost).toHaveLength(1);
  });

  it("an alias is rejected even when it declares POST (canonical form is mandatory)", () => {
    const { inventory, violations } = check(`
      import { createServerFn as csf } from "@tanstack/react-start";
      export const createParcelFn = csf({ method: "POST" })${handler};
    `);
    expect(inventory.definitions[0]?.method).toBe("POST");
    expect(violations.notPost).toEqual([]);
    expect(violations.nonCanonical).toEqual(["aliased-import (src/api/fixture.ts:2)"]);
  });

  it("the framework core package is a framework module too", () => {
    const { inventory, violations } = check(`
      import { createServerFn as csf } from "@tanstack/start-client-core";
      export const createParcelFn = csf()${handler};
    `);
    expect(inventory.definitions).toHaveLength(1);
    expect(violations.notPost).toHaveLength(1);
  });

  it("default import, re-export, dynamic import and escaped references are rejected", () => {
    const { violations } = check(`
      import Start from "@tanstack/react-start";
      import { createServerFn } from "@tanstack/react-start";
      export { createServerFn as makeFn } from "@tanstack/react-start";
      export * from "@tanstack/react-start";
      const factory = createServerFn;
      export async function later() {
        const mod = await import("@tanstack/react-start");
        const { getCookie } = await import("@tanstack/react-start/server");
        return [mod, getCookie, factory, Start];
      }
    `);
    expect(violations.nonCanonical.map((v) => v.split(" ")[0])).toEqual([
      "default-import",
      "re-export",
      "re-export",
      "escaped-reference",
      "dynamic-import",
    ]);
  });

  it("an unrelated local function called createServerFn is NOT the framework primitive", () => {
    const { inventory, violations } = check(`
      function createServerFn() { return { handler: (f: unknown) => f }; }
      export const notAServerFn = createServerFn().handler(() => 1);
    `);
    expect(inventory.definitions).toEqual([]);
    expect(violations.nonCanonical).toEqual([]);
  });

  it("a property named createServerFn on another object is not a reference", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      const registry = { createServerFn: 1 };
      export const n = registry.createServerFn;
      export const okFn = createServerFn({ method: "POST" }).handler(() => n);
    `);
    expect(violations.nonCanonical).toEqual([]);
    expect(violations.notPost).toEqual([]);
  });
});

describe("existing coverage, re-proven on fixtures", () => {
  it("canonical POST mutation is clean", () => {
    const { inventory, violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      export const createParcelFn = createServerFn({ method: "POST" })${handler};
    `);
    expect(inventory.definitions[0]?.effectiveMethod).toBe("POST");
    expect(Object.values(violations).flat()).toEqual([]);
  });

  it("canonical default-GET mutation is rejected", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      export const createParcelFn = createServerFn()${handler};
    `);
    expect(violations.notPost).toHaveLength(1);
  });

  it("explicit GET mutation is rejected", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      export const createParcelFn = createServerFn({ method: "GET" })${handler};
    `);
    expect(violations.notPost).toEqual(["createParcelFn (src/api/fixture.ts:3, method=GET)"]);
  });

  it("a runtime-computed method is rejected", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      const m = "POST" as const;
      export const createParcelFn = createServerFn({ method: m })${handler};
    `);
    expect(violations.nonLiteralMethod).toHaveLength(1);
  });

  it("a mutation registered as a read is rejected (name and handler)", () => {
    const { violations } = check(
      `
      import { createServerFn } from "@tanstack/react-start";
      export const createParcelFn = createServerFn()${handler};
    `,
      { createParcelFn: { reason: "sneaky" } },
    );
    expect(violations.misnamedReads).toEqual(["createParcelFn"]);
    expect(violations.writesInReads).toEqual(["createParcelFn → createParcelForOrder"]);
  });

  it("a mutation renamed to look like a read is caught by its handler", () => {
    const { violations } = check(
      `
      import { createServerFn } from "@tanstack/react-start";
      export const getParcelFn = createServerFn()${handler};
    `,
      { getParcelFn: { reason: "looks like a read" } },
    );
    expect(violations.misnamedReads).toEqual([]);
    expect(violations.writesInReads).toEqual(["getParcelFn → createParcelForOrder"]);
  });

  it("a mutation renamed to a neutral name is still rejected (not registered → must be POST)", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      export const syncParcelFn = createServerFn()${handler};
    `);
    expect(violations.notPost).toHaveLength(1);
  });

  it("a new route file is inventoried like an API file", () => {
    const { violations } = check(
      `
      import { createServerFn } from "@tanstack/react-start";
      export const createThingFn = createServerFn()${handler};
    `,
      NO_READS,
      "src/routes/app.new-thing.tsx",
    );
    expect(violations.notPost).toEqual([
      "createThingFn (src/routes/app.new-thing.tsx:3, method=default)",
    ]);
  });

  it("wrapper factories and non-exported declarations are reported as unbound", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      export function makeMutation() { return createServerFn()${handler}; }
      const hiddenFn = createServerFn()${handler};
      export { hiddenFn };
    `);
    expect(violations.unbound).toEqual(["src/api/fixture.ts:3", "src/api/fixture.ts:4"]);
  });

  it("a stale registry entry is rejected", () => {
    const { violations } = check(
      `
      import { createServerFn } from "@tanstack/react-start";
      export const getThingFn = createServerFn({ method: "POST" }).handler(() => 1);
    `,
      { getThingFn: { reason: "was a read" }, listGoneFn: { reason: "deleted" } },
    );
    expect(violations.staleReads).toEqual(["getThingFn", "listGoneFn"]);
  });

  it("duplicate server-function names are rejected", () => {
    const inventory = inventorySources([
      {
        file: "src/api/a.ts",
        text: `import { createServerFn } from "@tanstack/react-start";
          export const dupFn = createServerFn({ method: "POST" }).handler(() => 1);`,
      },
      {
        file: "src/api/b.ts",
        text: `import { createServerFn } from "@tanstack/react-start";
          export const dupFn = createServerFn({ method: "POST" }).handler(() => 2);`,
      },
    ]);
    expect(checkServerFnPolicy(inventory, NO_READS).duplicateNames).toEqual(["dupFn"]);
  });
});

describe("a local re-export of the binding is an escape", () => {
  it("`export { createServerFn }` without a module specifier is rejected", () => {
    const { violations } = check(`
      import { createServerFn } from "@tanstack/react-start";
      export { createServerFn };
    `);
    expect(violations.nonCanonical).toEqual(["escaped-reference (src/api/fixture.ts:3)"]);
  });
});
