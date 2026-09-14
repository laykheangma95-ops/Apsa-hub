/**
 * Launch-safety: the production customer path has no mock in it.
 *
 * Two functions in src/lib/api/index.ts were returning fixture data on live
 * production screens:
 *
 *   getCustomers()      -> `return resolve(customers)` — the in-memory array
 *                          from src/lib/mock/customers.ts, rendered by the
 *                          Inbox over real conversations.
 *   getCustomerOrders() -> filtered the in-memory `orders` array, rendered as
 *                          a real customer's purchase history in the
 *                          Conversation customer sheet and used to pre-fill the
 *                          "Repeat order" Smart Action.
 *
 * Both now call the existing production server functions — listCustomersFn and
 * listOrdersFn — which resolve the organization from the caller's own
 * membership row and re-check `customers.read` / `orders.read` server-side.
 *
 * These tests are deliberately a mix of BEHAVIOUR and SOURCE assertions. The
 * behaviour tests prove there is no fallback (a server-boundary failure comes
 * back as a failure, never as fixture rows); the source tests prove the mock
 * cannot creep back in through an import, because a fallback added later would
 * make the behaviour tests pass again by returning data.
 *
 * What is deliberately NOT banned: fixtures in tests, and fixtures in the
 * design gallery (src/routes/design.tsx), which exists to render components
 * against sample data and has no production role.
 *
 * Run: bun test src/tests/customer-mock-boundary.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

import {
  getCustomerOrders,
  getCustomers,
  isProductionId,
  CUSTOMER_PAGE_LIMIT,
  CUSTOMER_ORDER_HISTORY_LIMIT,
} from "@/lib/api";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8").replace(/\r\n/g, "\n");
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The body of one top-level `export async function` in src/lib/api/index.ts. */
function apiFunctionBody(name: string): string {
  const source = stripComments(readSource("src/lib/api/index.ts"));
  const start = source.indexOf(`export async function ${name}(`);
  expect({ name, found: start > -1 }).toEqual({ name, found: true });

  /*
   * The body's opening brace is the first `{` AFTER the parameter list closes
   * — not simply the first `{` after the signature, which would land inside an
   * inline object type such as `options: { offset?: number }`.
   */
  let parens = 0;
  let paramsClosed = false;
  let open = -1;
  for (let i = source.indexOf("(", start); i < source.length; i += 1) {
    const ch = source[i];
    if (!paramsClosed) {
      if (ch === "(") parens += 1;
      else if (ch === ")") {
        parens -= 1;
        if (parens === 0) paramsClosed = true;
      }
      continue;
    }
    if (ch === "{") {
      open = i;
      break;
    }
  }
  expect({ name, bodyFound: open > -1 }).toEqual({ name, bodyFound: true });

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Every mock fixture module, by the specifier production code would import. */
const MOCK_MODULES = [
  "@/lib/mock/customers",
  "@/lib/mock/orders",
  "@/lib/mock/conversations",
  "@/lib/mock/products",
  "@/lib/mock/shop",
  "@/lib/mock/fulfillment",
];

/** The identifiers those modules export, as production code would name them. */
const MOCK_BINDINGS = ["customers", "orders", "conversations", "products", "staff", "shops"];

// ═══════════════════════════════════════════════════════════════════════════════
// A. No fallback: a backend failure is a failure
// ═══════════════════════════════════════════════════════════════════════════════

describe("A. the production customer reads have no mock fallback", () => {
  /*
   * bun test runs outside the TanStack Start server runtime, so a server
   * function call throws "No Start context". That is exactly the shape of
   * failure a fallback would swallow — several older functions in this file
   * (getProducts, getConversationPage) deliberately catch it and return
   * fixtures. These two must not: the whole point of the phase is that a
   * customer read fails loudly rather than inventing a customer.
   */
  it("getCustomers() propagates the server-boundary failure instead of returning fixtures", async () => {
    let thrown: unknown = null;
    let resolved: unknown = null;
    try {
      resolved = await getCustomers();
    } catch (err) {
      thrown = err;
    }

    expect(resolved).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    // Not a fabricated empty page either — a real error object.
    expect((thrown as Error).message.length).toBeGreaterThan(0);
  });

  it("getCustomerOrders() propagates the server-boundary failure for a real customer id", async () => {
    let thrown: unknown = null;
    let resolved: unknown = null;
    try {
      resolved = await getCustomerOrders("aaaaaaaa-0000-0000-0000-00000000000a");
    } catch (err) {
      thrown = err;
    }

    expect(resolved).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
  });

  it("getCustomerOrders() refuses a non-production id rather than serving mock history", async () => {
    // "cus-1" is a fixture id. It used to match rows in the in-memory `orders`
    // array; it now never reaches the server, and never resolves to anything.
    expect(isProductionId("cus-1")).toBe(false);
    await expect(getCustomerOrders("cus-1")).rejects.toThrow("invalid_reference");
  });

  it("an empty result is never substituted for a failure", () => {
    // Structural: neither function has a catch that returns a value. A
    // `catch { return [] }` would be a fake success — indistinguishable to the
    // merchant from "this customer has no orders".
    for (const name of ["getCustomers", "getCustomerOrders"]) {
      const body = apiFunctionBody(name);
      expect({ name, hasCatch: /catch\s*[({]/.test(body) }).toEqual({ name, hasCatch: false });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. The real API boundary is the one being called
// ═══════════════════════════════════════════════════════════════════════════════

describe("B. the production customer reads call the real server functions", () => {
  it("getCustomers() goes through listCustomersFn and nothing else", () => {
    const body = apiFunctionBody("getCustomers");
    expect(body).toContain('await import("@/api/customers")');
    expect(body).toContain("listCustomersFn");
    for (const binding of MOCK_BINDINGS) {
      expect({ binding, used: new RegExp(`\\bresolve\\(${binding}\\b`).test(body) }).toEqual({
        binding,
        used: false,
      });
    }
  });

  it("getCustomerOrders() reuses the existing Order list filter, not a new endpoint", () => {
    const body = apiFunctionBody("getCustomerOrders");
    expect(body).toContain('await import("@/api/orders")');
    expect(body).toContain("listOrdersFn");
    expect(body).toContain("customerId");
    // No parallel order-history backend was invented for this.
    expect(body).not.toContain("customerOrdersFn");
    expect(body).not.toContain("orderHistoryFn");
  });

  it("listOrdersFn really accepts a customerId filter, applied server-side", () => {
    const api = readSource("src/api/orders.ts");
    expect(api).toContain("customerId: z.string().uuid().optional()");
    expect(api).toContain("customer_id: data?.customerId");
    // Filtering happens in the repository query, not over a fetched page.
    const repo = readSource("src/server/orders/repository.ts");
    expect(repo).toContain("customer_id");
  });

  it("listCustomersFn really supports paging, and the caller uses it", () => {
    const api = readSource("src/api/customers.ts");
    expect(api).toContain("limit: z.number().int().min(1).max(200).optional()");
    expect(api).toContain("offset: z.number().int().min(0).optional()");

    const body = apiFunctionBody("getCustomers");
    expect(body).toContain("offset");
    expect(body).toContain("limit");
  });

  it("neither read talks to Supabase from the browser", () => {
    for (const name of ["getCustomers", "getCustomerOrders"]) {
      const body = apiFunctionBody(name);
      expect(body).not.toContain("supabase");
      expect(body).not.toContain("from(");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Pagination is honest — one page is never presented as every customer
// ═══════════════════════════════════════════════════════════════════════════════

describe("C. the customer list is honest about completeness", () => {
  it("a page reports whether more rows exist", () => {
    const body = apiFunctionBody("getCustomers");
    expect(body).toContain("hasMore");
    // The probe: ask for one more row than the page shows.
    expect(body).toContain("limit + 1");
  });

  it("the page size stays inside the server's own cap so the probe cannot be rejected", () => {
    // listCustomersFn validates max(200); asking for CUSTOMER_PAGE_LIMIT + 1
    // must still be accepted or the probe would turn every read into an error.
    expect(CUSTOMER_PAGE_LIMIT + 1).toBeLessThanOrEqual(200);
    expect(CUSTOMER_ORDER_HISTORY_LIMIT).toBeLessThanOrEqual(200);
  });

  it("the probe row is trimmed, so hasMore never adds a phantom customer", () => {
    const body = apiFunctionBody("getCustomers");
    expect(body).toContain("rows.slice(0, limit)");
  });

  it("the Inbox does not treat its one page as the whole customer set", () => {
    const route = stripComments(readSource("src/routes/app.inbox.tsx"));
    /*
     * The row's name comes from the SERVER's own resolved `customerName` first.
     * That value is present for every production conversation regardless of
     * which customers fit in the loaded page, so an incomplete page cannot
     * change what a row displays — and the page is never counted, totalled or
     * filtered over as if it were complete.
     */
    expect(route).toContain("conversation.customerName ??");
    expect(route).not.toMatch(/customersQuery\.data\.customers\.length/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. Permission and tenant scope stay server-side
// ═══════════════════════════════════════════════════════════════════════════════

describe("D. the real reads keep their server-side gates", () => {
  it("no organization id is ever sent from the browser", () => {
    for (const name of ["getCustomers", "getCustomerOrders"]) {
      const body = apiFunctionBody(name);
      expect(body).not.toContain("organization_id");
      expect(body).not.toContain("organizationId");
    }
  });

  it("the customer server function derives the organization from the membership row", () => {
    const api = readSource("src/api/customers.ts");
    expect(api).toContain('.from("memberships")');
    expect(api).toContain('.eq("user_id", session.userId)');
    expect(api).toContain('.eq("status", "active")');
    // Stated as a rule in the file itself, and true in the code above it.
    expect(api).toContain("organizationId is NEVER accepted from the caller");
  });

  it("listCustomers requires customers.read and gates the phone on view_sensitive", () => {
    const service = readSource("src/server/customers/service.ts");
    expect(service).toContain('ctx.require("customers.read")');
    expect(service).toContain('ctx.can("customers.view_sensitive")');
    expect(service).toContain('phone: sensitiveVisible ? (row.primary_phone ?? "") : ""');
  });

  it("a cross-organization customer id cannot widen the query", () => {
    /*
     * listOrders filters on the organization the SERVER resolved, so a
     * customer id guessed from another organization simply matches no row.
     * There is no separate "customer not found" answer to distinguish it from
     * "no orders" — no existence leak beyond the established contract.
     */
    const repo = readSource("src/server/orders/repository.ts");
    expect(repo).toContain("organization_id");
    const service = readSource("src/server/orders/service.ts");
    expect(service).toContain('ctx.require("orders.read")');
  });

  it("the surfaces that read order history check orders.read before asking", () => {
    const sheet = stripComments(readSource("src/components/inbox/CustomerDetailSheet.tsx"));
    expect(sheet).toContain('capabilities.can("orders.read")');
    expect(sheet).toContain("isProductionId(customer.id)");
  });

  it("the Inbox customer list is gated on customers.read", () => {
    const route = stripComments(readSource("src/routes/app.inbox.tsx"));
    expect(route).toContain('capabilities.can("customers.read")');
    expect(route).toContain("enabled: canReadCustomers");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. The mock boundary itself
// ═══════════════════════════════════════════════════════════════════════════════

describe("E. production code cannot import customer fixtures", () => {
  /** Every production route and component — the design gallery excluded. */
  function productionFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.resolve(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(rel);
      }
    };
    walk("src/routes");
    walk("src/components");
    walk("src/design-system");
    walk("src/hooks");
    return files.filter(
      (f) =>
        // The design gallery renders components against sample data and has no
        // production role — fixtures are its entire purpose.
        !f.startsWith("src/routes/design"),
    );
  }

  it("no production route, component, design-system module or hook imports a fixture", () => {
    for (const file of productionFiles()) {
      const source = readSource(file);
      for (const mod of MOCK_MODULES) {
        expect({ file, imports: source.includes(mod) }).toEqual({ file, imports: false });
      }
    }
  });

  it("the design gallery is still allowed its fixtures", () => {
    // Guards the guard: if this ever stops being true, the rule above became a
    // blanket ban rather than a production boundary, and someone should notice.
    const gallery = readSource("src/routes/design.tsx");
    expect(gallery).toContain("@/lib/mock/customers");
  });

  it("no /app route reaches the customer domain except through the API boundary", () => {
    for (const file of productionFiles().filter((f) => f.startsWith("src/routes/app."))) {
      const source = readSource(file);
      expect({ file, direct: source.includes("@/server/customers") }).toEqual({
        file,
        direct: false,
      });
      expect({ file, supabase: source.includes("@/lib/supabase/server") }).toEqual({
        file,
        supabase: false,
      });
    }
  });

  it("the Inbox facade still exports the customer reads it is supposed to", () => {
    // If getCustomers/getCustomerOrders were quietly dropped rather than fixed,
    // the tests above would pass on absence. They must still exist and be
    // reachable from the Inbox.
    const facade = readSource("src/api/inbox.ts");
    expect(facade).toContain("getCustomers");
    expect(facade).toContain("getCustomerOrders");
  });

  it("the Conversation Smart Action no longer falls back to fixture order history", () => {
    const route = stripComments(readSource("src/routes/app.inbox.$id.tsx"));
    // The production branch stays; the mock else-branch is gone.
    expect(route).toContain("getMostRecentRealOrderForCustomer(customer.id)");
    expect(route).not.toContain("getCustomerOrders(customer.id)");
  });

  it("the two migrated functions no longer read the fixture arrays at all", () => {
    for (const name of ["getCustomers", "getCustomerOrders"]) {
      const body = apiFunctionBody(name);
      // The exact pre-phase expressions.
      expect({ name, old: body.includes("resolve(customers)") }).toEqual({ name, old: false });
      expect({ name, old: body.includes("orders\n    .filter") }).toEqual({ name, old: false });
      expect({ name, old: /\borders\s*\.filter\(/.test(body) }).toEqual({ name, old: false });
    }
  });
});
