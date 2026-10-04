/**
 * Customer Intelligence V1 (migration 060).
 *
 *   - Spawns customer-intelligence.runtime.ts: the real service + repository +
 *     migration 060 over every migration in PGlite, as service_role, with
 *     planted cross-tenant rows (isolated process — it uses mock.module).
 *   - Pure checks of the service's mapping: integer money arithmetic, sections
 *     withheld even if the database returned them, refusal of non-integer or
 *     unknown values.
 *   - Static checks of the migration and the API boundary.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  averageMinor,
  customerInsightSections,
  getCustomerInsights,
  toCustomerInsights,
} from "@/server/customers/insights";
import type { PurchaseProfileRow } from "@/server/customers/types";
import type { AuthorizationContext } from "@/server/auth/authorization";

it("migration 060 + Customer Intelligence service execute correctly against every migration in PGlite", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve("src/tests/customer-intelligence.runtime.ts")],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 240000,
      env: { ...process.env, VITE_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    },
  );
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  expect(result.status).toBe(0);
}, 250000);

const ALL_SECTIONS = { money: true, payments: true, delivery: true, returns: true };
const NO_SECTIONS = { money: false, payments: false, delivery: false, returns: false };

function profile(overrides: Partial<PurchaseProfileRow> = {}): PurchaseProfileRow {
  return {
    customer_found: true,
    activity: {
      qualifying_order_count: 3,
      confirmed_order_count: 2,
      completed_order_count: 1,
      cancelled_order_count: 0,
      refunded_order_count: 0,
      first_order_at: "2026-09-01T00:00:00Z",
      last_order_at: "2026-09-10T00:00:00Z",
      last_order_id: "o3",
      last_order_source: "POS",
      distinct_product_count: 1,
      total_units: 3,
      conversation_linked_order_count: 0,
      source_counts: { POS: 3 },
    },
    top_products: [],
    last_order_products: [],
    money: [
      {
        currency: "USD",
        order_count: 3,
        ordered_minor: 1000,
        received_minor: 1000,
        refunded_minor: 0,
        net_minor: 1000,
        outstanding_minor: 0,
      },
    ],
    payments: { method_order_counts: { cash: 3 } },
    delivery: { orders_with_delivery: 0, failed_attempt_count: 0, current_status_counts: {} },
    returns: {
      return_count: 0,
      returned_order_count: 0,
      completed_return_count: 0,
      completed_returned_units: 0,
    },
    ...overrides,
  };
}

function fakeCtx(permissions: string[]): AuthorizationContext {
  return {
    organizationId: "org-from-membership",
    userId: "u",
    can: (k: string) => permissions.includes(k),
    require: (k: string) => {
      if (!permissions.includes(k)) throw new Error(`Missing permission: ${k}`);
    },
  } as unknown as AuthorizationContext;
}

describe("money arithmetic is integer, per currency", () => {
  it("average rounds half-up without floating point", () => {
    expect(averageMinor(1000, 3)).toBe(333); // 333.33…
    expect(averageMinor(1001, 2)).toBe(501); // 500.5 → 501
    expect(averageMinor(5, 2)).toBe(3); // 2.5 → 3
    expect(averageMinor(6500, 2)).toBe(3250);
    // Exact far beyond where double division would round wrongly.
    expect(averageMinor(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses to average over zero orders rather than invent 0", () => {
    expect(() => averageMinor(0, 0)).toThrow();
  });

  it("each currency keeps its own totals and its own average", () => {
    const r = toCustomerInsights(
      "c",
      profile({
        money: [
          {
            currency: "KHR",
            order_count: 1,
            ordered_minor: 40000,
            received_minor: 40000,
            refunded_minor: 0,
            net_minor: 40000,
            outstanding_minor: 0,
          },
          {
            currency: "USD",
            order_count: 2,
            ordered_minor: 6500,
            received_minor: 5000,
            refunded_minor: 0,
            net_minor: 5000,
            outstanding_minor: 1500,
          },
        ],
      }),
      ALL_SECTIONS,
    );
    if (r.money.status !== "available") throw new Error("unreachable");
    expect(r.money.data.map((m) => [m.currency, m.netPaid.amount, m.averageOrder.amount])).toEqual([
      ["KHR", 40000, 40000],
      ["USD", 5000, 3250],
    ]);
  });

  it("rejects an unknown currency, a fractional or an unsafe amount — never rounds it away", () => {
    const bad = (m: Partial<NonNullable<PurchaseProfileRow["money"]>[number]>) =>
      toCustomerInsights(
        "c",
        profile({ money: [{ ...profile().money![0]!, ...m }] }),
        ALL_SECTIONS,
      );
    expect(() => bad({ currency: "EUR" })).toThrow(/currency/);
    expect(() => bad({ ordered_minor: 10.5 })).toThrow(/ordered_minor/);
    expect(() => bad({ received_minor: 2 ** 60 })).toThrow(/received_minor/);
    expect(() => bad({ outstanding_minor: -1 })).toThrow(/outstanding_minor/);
  });
});

describe("sections are withheld by the service, not only by the database", () => {
  it("a denied section is permission_denied even if the row carried data", () => {
    const r = toCustomerInsights("c", profile(), NO_SECTIONS);
    expect(r.money).toEqual({ status: "permission_denied" });
    expect(r.payments).toEqual({ status: "permission_denied" });
    expect(r.delivery).toEqual({ status: "permission_denied" });
    expect(r.returns).toEqual({ status: "permission_denied" });
    expect(JSON.stringify(r)).not.toContain("1000");
  });

  it("an allowed section the database did not return is an error, not zeros", () => {
    const r = toCustomerInsights("c", profile({ money: null, delivery: null }), ALL_SECTIONS);
    expect(r.money).toEqual({ status: "error" });
    expect(r.delivery).toEqual({ status: "error" });
  });

  it("the grants decide which sections the database may read", () => {
    expect(customerInsightSections(fakeCtx(["customers.read", "orders.read"]))).toEqual(
      NO_SECTIONS,
    );
    expect(
      customerInsightSections(
        fakeCtx([
          "orders.read",
          "payments.reconcile",
          "customers.view_sensitive",
          "payments.read",
          "delivery.read",
          "orders.return",
        ]),
      ),
    ).toEqual(ALL_SECTIONS);
    // The financial boundary alone is not enough for spend on a customer.
    expect(customerInsightSections(fakeCtx(["orders.read", "payments.reconcile"])).money).toBe(
      false,
    );
  });

  it("passes the membership's organization — and only the decided sections — to the repository", async () => {
    const calls: unknown[][] = [];
    await getCustomerInsights(fakeCtx(["customers.read", "orders.read", "delivery.read"]), "cust", {
      getCustomerPurchaseProfile: async (...args) => {
        calls.push(args);
        return profile({ money: null, payments: null, returns: null });
      },
    });
    expect(calls).toEqual([
      [
        "org-from-membership",
        "cust",
        { money: false, payments: false, delivery: true, returns: false },
        5,
      ],
    ]);
  });

  it("a customer the database did not find is a 404, not an empty profile", async () => {
    await expect(
      getCustomerInsights(fakeCtx(["customers.read", "orders.read"]), "cust", {
        getCustomerPurchaseProfile: async () => ({ customer_found: false }),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("unknown enum values never reach the browser", () => {
  it("drops sources, methods and statuses APSA does not define", () => {
    const r = toCustomerInsights(
      "c",
      profile({
        activity: {
          ...profile().activity!,
          last_order_source: "MYSPACE",
          source_counts: { POS: 1, MYSPACE: 2 },
        },
        payments: { method_order_counts: { cash: 1, crypto: 4 } },
      }),
      ALL_SECTIONS,
    );
    expect(r.activity.lastOrderSource).toBeNull();
    expect(r.activity.sourceCounts).toEqual({ POS: 1 });
    if (r.payments.status !== "available") throw new Error("unreachable");
    expect(r.payments.data.methodOrderCounts).toEqual({ cash: 1 });
  });

  it("a blank variant snapshot is 'no variant', not an empty label", () => {
    const r = toCustomerInsights(
      "c",
      profile({
        top_products: [
          {
            product_id: "p",
            product_label: "Product",
            top_variant_label: "",
            units: 1,
            order_count: 1,
            variant_count: 1,
            last_purchased_at: "2026-09-01T00:00:00Z",
          },
        ],
      }),
      ALL_SECTIONS,
    );
    expect(r.topProducts[0]!.topVariantLabel).toBeNull();
  });
});

describe("migration 060 — static shape", () => {
  const sql = readFileSync("supabase/migrations/060_customer_purchase_profile.sql", "utf8");
  const code = sql.replace(/--.*$/gm, "");

  it("creates no table, view or materialized view — nothing to drift from authority", () => {
    expect(code).not.toMatch(/CREATE\s+(TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX)/i);
  });

  it("is SECURITY INVOKER, never SECURITY DEFINER, with a pinned search_path", () => {
    expect(code).toMatch(/SECURITY INVOKER/);
    expect(code).not.toMatch(/SECURITY DEFINER/);
    expect(code).toMatch(/SET search_path = public, pg_temp/);
  });

  it("revokes EXECUTE from PUBLIC, anon and authenticated and grants only service_role", () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.customer_purchase_profile_v1\([^)]*\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    const grants = [...code.matchAll(/GRANT\s+EXECUTE[^;]*TO\s+([a-z_, ]+);/gi)].map((m) =>
      m[1]!.trim(),
    );
    expect(grants).toEqual(["service_role"]);
  });

  it("filters every relation it reads on the organization parameter", () => {
    for (const alias of ["c", "o", "i", "p", "d", "r", "ri"]) {
      expect(code).toContain(`${alias}.organization_id = p_organization_id`);
    }
    expect(code).toContain("t.organization_id = p_organization_id");
  });
});

describe("API boundary", () => {
  const api = readFileSync("src/api/customers.ts", "utf8");
  const start = api.indexOf("export const getCustomerInsightsFn");
  const body = api.slice(start, api.indexOf("// ──", start));

  it("accepts a customer id only — no organization, no section selector", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('z.object({ id: z.string().uuid("Invalid customer ID") })');
    expect(body).not.toMatch(/organization|section|include/i);
    expect(body).toContain("await resolveAuthContext()");
  });

  it("the browser reads it only through the server function", () => {
    const lib = readFileSync("src/lib/api/index.ts", "utf8");
    const fn = lib.slice(lib.indexOf("export async function getCustomerInsights"));
    expect(fn.slice(0, 600)).toContain("getCustomerInsightsFn");
    expect(lib).not.toContain("customer_purchase_profile_v1");
  });
});
