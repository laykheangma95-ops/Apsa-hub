/**
 * The customer-service search foundation: order code, customer name, customer
 * phone — and the one rule that makes the third of those safe to ship.
 *
 * APSA's two highest-value missing workflows were "find an order by its code"
 * and "find a customer by name or phone". Both existed only as accidents
 * before this phase: an order code was reachable only if the order happened to
 * have a delivery row, and a customer was reachable only if they happened to
 * be in the first page of the customer list a picker had loaded. Each failure
 * mode looked identical to "this record does not exist", which is what a staff
 * member then tells the person on the phone.
 *
 * ── WHAT THIS FILE IS MOSTLY ABOUT ───────────────────────────────────────────
 *
 * Phone search is gated on `customers.view_sensitive`, and the gate is
 * ORDERING, not masking. A member who could match on the phone column and
 * receive a blanked phone back has still learned that a customer with that
 * number exists in this organization: WHICH ROWS COME BACK is the disclosure,
 * not the digits printed on them. So the tests below assert against a
 * recording DB double that no phone read was ISSUED — never merely that its
 * result was hidden.
 *
 * Run: bun test src/tests/customer-search.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import {
  escapeLikePattern,
  looksLikeCustomerPhoneQuery,
  normalizeCustomerNameQuery,
  phoneDigitsMatch,
  toPhoneDigits,
} from "@/lib/customer-search";
import { looksLikeOrderCode, normalizeOrderCode } from "@/lib/order-code";
import { customerKeys } from "@/lib/customers-query";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "user-aaaa-0000-0000-0000-000000000001";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_CODE = "APSA-2026-000123";

// ── Authorization doubles ─────────────────────────────────────────────────────

function ctxWith(permissions: readonly string[], organizationId = ORG_A): AuthorizationContext {
  const perms = new Set<string>(permissions);
  return {
    userId: USER_A,
    organizationId,
    roleId: "role",
    systemRole: "MANAGER",
    permissions: perms,
    can: (key: string) => perms.has(key),
    require: (key: string) => {
      if (!perms.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

// ── Recording DB double ───────────────────────────────────────────────────────
//
// A minimal fluent stand-in for the supabase-js builder, which RECORDS every
// filter it is handed. That recording is what turns "the phone was hidden"
// into "the phone was never read" — the only one of those two that is a
// security property.

interface RecordedQuery {
  table: string;
  filters: Array<[string, unknown]>;
  ilike: Array<[string, string]>;
  notNull: string[];
  order: Array<[string, boolean]>;
  range: [number, number] | null;
}

interface CustomerDbOptions {
  /** Rows the query resolves to, per table. */
  rows?: Record<string, unknown[]>;
  error?: { message: string } | null;
  /** Called with each recorded query; may return rows to override `rows`. */
  onQuery?: (q: RecordedQuery) => unknown[] | undefined;
}

function fakeCustomerDb(opts: CustomerDbOptions, recorded: RecordedQuery[]) {
  return {
    from(table: string) {
      const q: RecordedQuery = {
        table,
        filters: [],
        ilike: [],
        notNull: [],
        order: [],
        range: null,
      };
      recorded.push(q);

      const result = () => {
        if (opts.error) return { data: null, error: opts.error };
        const override = opts.onQuery?.(q);
        return { data: override ?? opts.rows?.[table] ?? [], error: null };
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          q.filters.push([col, val]);
          return builder;
        },
        not: (col: string, op: string, val: unknown) => {
          if (op === "is" && val === null) q.notNull.push(col);
          return builder;
        },
        ilike: (col: string, pattern: string) => {
          q.ilike.push([col, pattern]);
          return builder;
        },
        order: (col: string, o: { ascending: boolean }) => {
          q.order.push([col, o.ascending]);
          return builder;
        },
        limit: () => builder,
        range: (from: number, to: number) => {
          q.range = [from, to];
          return builder;
        },
        single: async () => result(),
        maybeSingle: async () => result(),
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };
}

async function withCustomerDb<T>(
  opts: CustomerDbOptions,
  fn: (recorded: RecordedQuery[]) => Promise<T>,
): Promise<T> {
  const { setCustomerRepositoryDbForTests } = await import("../server/customers/repository");
  const recorded: RecordedQuery[] = [];
  const restore = setCustomerRepositoryDbForTests(fakeCustomerDb(opts, recorded));
  try {
    return await fn(recorded);
  } finally {
    restore();
  }
}

function customerRow(over: Record<string, unknown> = {}) {
  return {
    id: "cus-1",
    organization_id: ORG_A,
    display_name: "Sokha",
    primary_phone: "012345678",
    primary_email: null,
    status: "active",
    language: null,
    first_seen_at: null,
    last_seen_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

async function searchCustomers(ctx: AuthorizationContext, query: string, over = {}) {
  const { searchCustomers: fn } = await import("../server/customers/service");
  return fn(ctx, { query, ...over });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ORDER CODE LOOKUP
// ═══════════════════════════════════════════════════════════════════════════════

const PGRST_NO_ROW = { code: "PGRST116", message: "no rows" };

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    organization_id: ORG_A,
    order_number: ORDER_CODE,
    customer_id: null,
    location_id: null,
    source: "POS",
    currency: "USD",
    subtotal_minor: 1980,
    discount_minor: 0,
    delivery_minor: 0,
    total_minor: 1980,
    lifecycle_status: "confirmed",
    payment_status: "unpaid",
    refund_status: "none",
    fulfillment_status: "unfulfilled",
    created_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    source_conversation_ref: null,
  };
}

interface OrderQuery {
  filters: Array<[string, unknown]>;
}

async function withOrderDb<T>(
  result: { data: unknown; error: { code?: string; message: string } | null },
  fn: (queries: OrderQuery[]) => Promise<T>,
): Promise<T> {
  const { setOrderRepositoryDbForTests } = await import("../server/orders/repository");
  const queries: OrderQuery[] = [];
  const db = {
    from: () => {
      const q: OrderQuery = { filters: [] };
      queries.push(q);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          q.filters.push([col, val]);
          return b;
        },
        order: () => b,
        limit: () => b,
        range: () => b,
        single: async () => result,
        then: (res: (v: unknown) => void) => Promise.resolve(result).then(res),
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const restore = setOrderRepositoryDbForTests(db);
  try {
    return await fn(queries);
  } finally {
    restore();
  }
}

async function findOrderByCode(ctx: AuthorizationContext, code: string) {
  const { findOrderByCode: fn } = await import("../server/orders/service");
  return fn(ctx, code);
}

describe("Order code lookup — the Orders domain answers about an order", () => {
  it("finds an order by its exact normalized code and returns the real order id", async () => {
    await withOrderDb({ data: orderRow(), error: null }, async (queries) => {
      const order = await findOrderByCode(ctxWith(["orders.read"]), ORDER_CODE);

      expect(order).toMatchObject({ id: ORDER_ID, orderNumber: ORDER_CODE });
      // The code is a human reference; the ID is what a caller routes with.
      expect(order!.id).toBe(ORDER_ID);
      expect(queries[0]!.filters).toEqual([
        ["organization_id", ORG_A],
        ["order_number", ORDER_CODE],
      ]);
    });
  });

  it("normalizes case, whitespace and Khmer digits into one exact lookup", async () => {
    for (const typed of [
      "apsa-2026-000123",
      "  APSA-2026-000123  ",
      "APSA-2026- 000123",
      "APSA-២០២៦-០០០១២៣",
    ]) {
      await withOrderDb({ data: orderRow(), error: null }, async (queries) => {
        await findOrderByCode(ctxWith(["orders.read"]), typed);
        // The NEEDLE is normalized, never the column — which is what keeps
        // uniq_orders_number_per_org usable as an index probe.
        expect({ typed, sent: queries[0]!.filters[1] }).toEqual({
          typed,
          sent: ["order_number", ORDER_CODE],
        });
      });
    }
  });

  it("never infers a year segment that was not typed", () => {
    // "APSA-123" is looked up verbatim and honestly finds nothing, rather than
    // being rewritten into a guess at which year's order was meant.
    expect(normalizeOrderCode(" apsa-123 ")).toBe("APSA-123");
    expect(looksLikeOrderCode("APSA-123")).toBe(true);
  });

  it("reports a code that matches no row as null, not as an error", async () => {
    await withOrderDb({ data: null, error: PGRST_NO_ROW }, async () => {
      expect(await findOrderByCode(ctxWith(["orders.read"]), ORDER_CODE)).toBeNull();
    });
  });

  it("makes another organization's code indistinguishable from an unissued one", async () => {
    /*
     * Order numbers are unique PER TENANT (uniq_orders_number_per_org), so
     * APSA-2026-000123 is a real order in many organizations at once. The
     * query carries the caller's own organization, so the other tenant's row
     * is filtered out AT THE QUERY — it is never read and then hidden, and the
     * caller gets the same null a never-issued code produces. No 403, no
     * "exists but not yours", nothing to distinguish the two.
     */
    await withOrderDb({ data: null, error: PGRST_NO_ROW }, async (queries) => {
      const asOrgB = await findOrderByCode(ctxWith(["orders.read"], ORG_B), ORDER_CODE);
      expect(asOrgB).toBeNull();
      expect(queries[0]!.filters).toContainEqual(["organization_id", ORG_B]);
    });
  });

  it("refuses a caller without orders.read before touching the database", async () => {
    await withOrderDb({ data: orderRow(), error: null }, async (queries) => {
      await expect(findOrderByCode(ctxWith(["customers.read"]), ORDER_CODE)).rejects.toThrow(
        ForbiddenError,
      );
      expect(queries).toEqual([]);
    });
  });

  it("never issues a query for an empty or oversized code", async () => {
    await withOrderDb({ data: null, error: PGRST_NO_ROW }, async (queries) => {
      expect(await findOrderByCode(ctxWith(["orders.read"]), "   ")).toBeNull();
      expect(await findOrderByCode(ctxWith(["orders.read"]), "A".repeat(500))).toBeNull();
      expect(queries).toEqual([]);
    });
  });

  it("accepts no organization from the caller, at the service or the API boundary", () => {
    const api = read("src/api/orders.ts");
    const fn = api.slice(
      api.indexOf("export const findOrderByCodeFn"),
      api.indexOf("export const listOrdersFn"),
    );
    expect(fn).toContain("code: z.string()");
    expect(fn).not.toMatch(/organizationId/);
    expect(fn).toContain("resolveAuthContext()");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CUSTOMER NAME SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

describe("Customer name search — server-side, bounded, org-scoped", () => {
  it("filters in Postgres, scoped to the caller's organization and active rows", async () => {
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async (recorded) => {
      await searchCustomers(ctxWith(["customers.read"]), "Sokha");

      const q = recorded[0]!;
      expect(q.table).toBe("customers");
      expect(q.filters).toContainEqual(["organization_id", ORG_A]);
      expect(q.filters).toContainEqual(["status", "active"]);
      expect(q.ilike).toEqual([["display_name", "%Sokha%"]]);
    });
  });

  it("orders deterministically so offset pages cannot repeat or skip a row", async () => {
    await withCustomerDb({ rows: { customers: [] } }, async (recorded) => {
      await searchCustomers(ctxWith(["customers.read"]), "Sokha");
      expect(recorded[0]!.order).toEqual([
        ["display_name", true],
        ["id", true],
      ]);
    });
  });

  it("returns EVERY match rather than choosing between customers with the same name", async () => {
    const rows = [
      customerRow({ id: "cus-1", display_name: "Sokha" }),
      customerRow({ id: "cus-2", display_name: "Sokha Chan" }),
      customerRow({ id: "cus-3", display_name: "Sokha Ly" }),
    ];
    await withCustomerDb({ rows: { customers: rows } }, async () => {
      const page = await searchCustomers(ctxWith(["customers.read"]), "Sokha");
      expect(page.items.map((c) => c.id)).toEqual(["cus-1", "cus-2", "cus-3"]);
      expect(page.field).toBe("name");
    });
  });

  it("reports more-exist from a probe row, never from a guess", async () => {
    // limit 2, and the server holds 3: the third is the probe and is dropped.
    const rows = [customerRow({ id: "a" }), customerRow({ id: "b" }), customerRow({ id: "c" })];
    await withCustomerDb({ rows: { customers: rows } }, async (recorded) => {
      const page = await searchCustomers(ctxWith(["customers.read"]), "Sokha", { limit: 2 });

      expect(page.items.map((c) => c.id)).toEqual(["a", "b"]);
      expect(page.hasMore).toBe(true);
      // It asked for limit + 1. The extra row is the completeness probe.
      expect(recorded[0]!.range).toEqual([0, 2]);
    });
  });

  it("pages by offset, keeping the range the server was asked for", async () => {
    await withCustomerDb({ rows: { customers: [] } }, async (recorded) => {
      const page = await searchCustomers(ctxWith(["customers.read"]), "Sokha", {
        limit: 10,
        offset: 20,
      });
      expect(recorded[0]!.range).toEqual([20, 30]);
      expect(page.offset).toBe(20);
      expect(page.hasMore).toBe(false);
    });
  });

  it("caps the limit so one request cannot ask for the whole tenant", async () => {
    await withCustomerDb({ rows: { customers: [] } }, async (recorded) => {
      await searchCustomers(ctxWith(["customers.read"]), "Sokha", { limit: 10_000 });
      const [from, to] = recorded[0]!.range!;
      expect(to - from).toBeLessThanOrEqual(50);
    });
  });

  it("scopes the query to the caller's own organization, never one they named", async () => {
    await withCustomerDb({ rows: { customers: [] } }, async (recorded) => {
      await searchCustomers(ctxWith(["customers.read"], ORG_B), "Sokha");
      expect(recorded[0]!.filters).toContainEqual(["organization_id", ORG_B]);
      expect(recorded[0]!.filters).not.toContainEqual(["organization_id", ORG_A]);
    });
  });

  it("refuses a caller without customers.read before any query is built", async () => {
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async (recorded) => {
      await expect(searchCustomers(ctxWith(["orders.read"]), "Sokha")).rejects.toThrow(
        ForbiddenError,
      );
      expect(recorded).toEqual([]);
    });
  });

  it("propagates a failed search rather than returning it as an empty page", async () => {
    await withCustomerDb({ error: { message: "connection reset" } }, async () => {
      // ERROR and EMPTY are different answers. A search that did not complete
      // must never reach a staff member as "this customer does not exist".
      await expect(searchCustomers(ctxWith(["customers.read"]), "Sokha")).rejects.toThrow(
        /searchCustomersByName/,
      );
    });
  });

  it("matches a literal % or _ as text instead of as a wildcard", async () => {
    await withCustomerDb({ rows: { customers: [] } }, async (recorded) => {
      await searchCustomers(ctxWith(["customers.read"]), "100% Shop_A");
      expect(recorded[0]!.ilike).toEqual([["display_name", "%100\\% Shop\\_A%"]]);
    });
    expect(escapeLikePattern("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
  });

  it("collapses whitespace in the needle without lowercasing the merchant's name", () => {
    expect(normalizeCustomerNameQuery("  Sokha   Chan ")).toBe("Sokha Chan");
    expect(normalizeCustomerNameQuery("Sokha")).toBe("Sokha");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PHONE SEARCH — the authorization gate
// ═══════════════════════════════════════════════════════════════════════════════

const AUTHORIZED = ["customers.read", "customers.view_sensitive"];

describe("Phone search requires customers.view_sensitive BEFORE it reads anything", () => {
  /*
   * The defining test of this phase.
   *
   * Not "the phone came back blank" — that is masking, and masking leaves the
   * search usable as an existence oracle, because WHICH CUSTOMERS COME BACK
   * for a typed number answers the question on its own. This asserts against a
   * recording double that the query was never built.
   */
  it("issues NO query at all for a phone search without the sensitive grant", async () => {
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async (recorded) => {
      const page = await searchCustomers(ctxWith(["customers.read"]), "012 345 678");

      expect(recorded).toEqual([]);
      expect(page.items).toEqual([]);
      expect(page.field).toBeNull();
      // DENIED is its own field. An empty item list alongside it says nothing
      // about whether such a customer exists, and the UI must not say it does.
      expect(page.phoneSearchDenied).toBe(true);
    });
  });

  it("does not fall back to a name search on the digits, which would be the same probe in disguise", async () => {
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async (recorded) => {
      await searchCustomers(ctxWith(["customers.read"]), "012 345 678");
      expect(recorded.some((q) => q.ilike.length > 0)).toBe(false);
    });
  });

  it("reads the phone column only for a caller holding BOTH grants", async () => {
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async (recorded) => {
      const page = await searchCustomers(ctxWith(AUTHORIZED), "012 345 678");

      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded[0]!.notNull).toContain("primary_phone");
      expect(page.field).toBe("phone");
      expect(page.phoneSearchDenied).toBe(false);
      expect(page.items.map((c) => c.id)).toEqual(["cus-1"]);
    });
  });

  it("withholds the phone VALUE as well from anyone without the grant", async () => {
    // Belt and braces: the name path is open to customers.read alone, and the
    // rows it returns must still come back with the phone stripped server-side.
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async () => {
      const page = await searchCustomers(ctxWith(["customers.read"]), "Sokha");
      expect(page.items[0]).toMatchObject({ phone: "", sensitiveVisible: false });
      expect(page.sensitiveVisible).toBe(false);
    });
  });

  it("scopes an authorized phone scan to the caller's organization and active rows", async () => {
    await withCustomerDb({ rows: { customers: [] } }, async (recorded) => {
      await searchCustomers(ctxWith(AUTHORIZED, ORG_B), "012 345 678");
      expect(recorded[0]!.filters).toContainEqual(["organization_id", ORG_B]);
      expect(recorded[0]!.filters).toContainEqual(["status", "active"]);
    });
  });

  it("says so when the bounded scan stopped before the tenant's rows ran out", async () => {
    /*
     * A full window of non-matching rows, every time. The scan walks until it
     * hits its safety limit and then reports `truncated` — it never presents a
     * short list as the whole truth.
     */
    const fullWindow = Array.from({ length: 500 }, (_, i) =>
      customerRow({ id: `c-${i}`, primary_phone: "099999999" }),
    );
    await withCustomerDb({ rows: { customers: fullWindow } }, async () => {
      const page = await searchCustomers(ctxWith(AUTHORIZED), "012 345 678");
      expect(page.items).toEqual([]);
      expect(page.truncated).toBe(true);
    });
  });

  it("refuses a caller with neither grant before anything is read", async () => {
    await withCustomerDb({ rows: { customers: [customerRow()] } }, async (recorded) => {
      await expect(searchCustomers(ctxWith([]), "012 345 678")).rejects.toThrow(ForbiddenError);
      expect(recorded).toEqual([]);
    });
  });
});

describe("Phone matching does exactly what it documents, and nothing more", () => {
  it("ignores separators and digit script on both sides", () => {
    for (const stored of [
      "012345678",
      "012 345 678",
      "012-345-678",
      "(012) 345.678",
      "០១២៣៤៥៦៧៨",
    ]) {
      expect({ stored, hit: phoneDigitsMatch(stored, "012 345 678") }).toEqual({
        stored,
        hit: true,
      });
    }
    expect(toPhoneDigits("+855 (12) 345-678")).toBe("85512345678");
  });

  it("matches a prefix, so a picker narrows as the merchant types", () => {
    expect(phoneDigitsMatch("0123456789", "012345678")).toBe(true);
  });

  it("performs NO country-code conversion, because no data contract defines one", () => {
    /*
     * "+855 12 345 678" and "012 345 678" are the same human number. APSA has
     * no stored phone normalization (primary_phone is free TEXT, and
     * DATA_MODEL.md §144's E.164 target has no implementation), so nothing in
     * the system says those two strings are one person. Deciding that here
     * would be inventing the contract inside a search predicate.
     */
    expect(phoneDigitsMatch("+855 12 345 678", "012345678")).toBe(false);
    expect(phoneDigitsMatch("012345678", "+85512345678")).toBe(false);

    /*
     * Suffix matching is that same assumption wearing a different hat: the
     * only reason "12345678" would find "+855 12 345 678" is a rule that says
     * the leading 855 is a country code and may be skipped. That is the
     * conversion, arrived at sideways. The match is a PREFIX of the stored
     * digit sequence, so it does not happen.
     */
    expect(phoneDigitsMatch("+855 12 345 678", "12345678")).toBe(false);
    expect(phoneDigitsMatch("85512345678", "5512345678")).toBe(false);
    // …while the prefix it IS documented to do still works.
    expect(phoneDigitsMatch("+855 12 345 678", "8551234")).toBe(false); // below the floor
    expect(phoneDigitsMatch("+855 12 345 678", "85512345")).toBe(true);
  });

  it("never matches on a fragment too short to identify anyone", () => {
    expect(phoneDigitsMatch("012345678", "012")).toBe(false);
    expect(phoneDigitsMatch("012345678", "")).toBe(false);
    expect(phoneDigitsMatch(null, "012345678")).toBe(false);
  });

  it("does not mistake a barcode for a phone number", () => {
    // An EAN-13 is a long digit run. Treating one as a phone number would send
    // a scanned product to the Customer domain and report it as not found.
    expect(looksLikeCustomerPhoneQuery("8850007123456")).toBe(false);
    expect(looksLikeCustomerPhoneQuery("012345678")).toBe(true);
    expect(looksLikeCustomerPhoneQuery("+855 12 345 678")).toBe(true);
    expect(looksLikeCustomerPhoneQuery("Sokha")).toBe(false);
    expect(looksLikeCustomerPhoneQuery("APSA-2026-000123")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CACHE IDENTITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Search caches are partitioned by principal and by the sensitive grant", () => {
  it("keys a customer search by user, organization, grant and term", () => {
    const key = customerKeys.search(USER_A, ORG_A, "012345678", true);
    expect(key).not.toEqual(customerKeys.search("other-user", ORG_A, "012345678", true));
    expect(key).not.toEqual(customerKeys.search(USER_A, ORG_B, "012345678", true));
    // The revocation case: same principal, same term, different grant.
    expect(key).not.toEqual(customerKeys.search(USER_A, ORG_A, "012345678", false));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. PICKER COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Customer pickers search the tenant, not a page they happen to hold", () => {
  const POS = "src/components/pos/PosCustomerSheet.tsx";
  const CREATE = "src/components/orders/CreateRealOrderSheet.tsx";
  const API = "src/lib/api/index.ts";

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the POS picker asks the server and never filters a list itself", () => {
    const src = stripComments(read(POS));
    expect(src).toContain("searchRealCustomers(query, canSensitive)");
    // The defect being fixed: one bounded page, filtered in the browser.
    expect(src).not.toMatch(/listRealCustomers/);
    expect(src).not.toMatch(/\.filter\(/);
  });

  it("the order-create picker asks the server the moment anything is typed", () => {
    const src = stripComments(read(CREATE));
    expect(src).toContain("searchRealCustomers(customerQuery.trim(), canSensitive)");
    expect(src).toContain("enabled: open && customerQuery.trim().length > 0");
    // The un-typed list is still one page — and is only ever shown as one.
    expect(src).toContain("enabled: open && customerQuery.trim().length === 0");

    /*
     * Scoped to the CUSTOMER list builder, not the whole file: the product
     * picker in this same sheet still filters the catalog locally, and product
     * search is a different domain that this phase deliberately does not touch.
     */
    const customerList = src.slice(
      src.indexOf("const customerList = useMemo("),
      src.indexOf("const phoneDenied ="),
    );
    expect(customerList).not.toMatch(/\.toLowerCase\(\)/);
    expect(customerList).not.toMatch(/\.filter\(/);
    expect(customerList).not.toMatch(/\.includes\(/);
  });

  it("neither picker can fall back to fixture customers on a failure", () => {
    for (const rel of [POS, CREATE]) {
      const src = read(rel);
      expect({ rel, mock: /@\/lib\/mock/.test(src) }).toEqual({ rel, mock: false });
    }
    const api = read(API);
    const fn = api.slice(
      api.indexOf("export async function searchRealCustomers"),
      api.indexOf("export interface QuickCustomerInput"),
    );
    expect(fn).not.toMatch(/isDemoModeError/);
    expect(fn).not.toMatch(/catch/);
  });

  it("both pickers tell 'more exist' apart from 'none exist'", () => {
    // A short list must never read as the whole tenant, or the twenty-first
    // customer is reported to a merchant as not existing.
    expect(read(POS)).toContain('t("pos.customer.more")');
    expect(read(CREATE)).toContain('t("orderCreate.moreCustomers")');
  });

  it("both pickers tell 'you may not search by phone' apart from 'not found'", () => {
    expect(read(POS)).toContain("pos.customer.phoneDenied");
    expect(read(CREATE)).toContain("orderCreate.phoneSearchDenied");
    for (const rel of [POS, CREATE]) {
      expect({ rel, denied: read(rel).includes("phoneSearchDenied") }).toEqual({
        rel,
        denied: true,
      });
    }
  });

  it("the Inbox order flow takes its customer from the conversation, not a picker", () => {
    // Audited for the same defect and found not to have it: the customer is
    // pre-filled from the conversation and locked, so no bounded list is
    // involved and there is nothing here to fix.
    for (const rel of [
      "src/components/inbox/CreateOrderSheet.tsx",
      "src/components/inbox/PrepareOrderSheet.tsx",
    ]) {
      const src = read(rel);
      expect({ rel, locked: src.includes("customer: Customer;") }).toEqual({ rel, locked: true });
      expect({ rel, picker: /searchCustomers|listRealCustomers/.test(src) }).toEqual({
        rel,
        picker: false,
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. MIGRATION DECISION — the indexes this phase relies on already exist
// ═══════════════════════════════════════════════════════════════════════════════

describe("No migration was required, and the schema says why", () => {
  it("the order-code lookup rides an index that migration 023 already creates", () => {
    const sql = read("supabase/migrations/023_orders.sql");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uniq_orders_number_per_org\s+ON public\.orders\(organization_id, order_number\)/,
    );
  });

  it("the phone scan rides the partial index migration 011 already creates", () => {
    const sql = read("supabase/migrations/011_customers.sql");
    expect(sql).toMatch(
      /CREATE INDEX idx_customers_primary_phone\s+ON public\.customers\(organization_id, primary_phone\)\s*\n?\s*WHERE primary_phone IS NOT NULL/,
    );
  });

  it("this phase adds no migration of its own", () => {
    const migrations = fs.readdirSync(path.join(ROOT, "supabase/migrations"));
    // 042 is the last migration on main. A new file here would mean this phase
    // silently changed the schema — which it must not do without first proving
    // the change is required and reporting it.
    expect(migrations.filter((f) => /^04[3-9]|^0[5-9]\d/.test(f))).toEqual([]);
  });
});
