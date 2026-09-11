/**
 * Tests for listDeliveriesForMerchant (src/server/deliveries/service.ts) — the
 * production Deliveries list backend. Distinct from the existing
 * delivery-domain.test.ts, which covers listDeliveries()/getDeliveryById()/
 * create/transition. Same withDb harness pattern (self-contained per file, as
 * every *-domain.test.ts in this repo already does).
 *
 * Run: bun test src/tests/delivery-list.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000001";
const USER_A = "aaaaaaaa-1111-0000-0000-000000000001";

const ORDER_1 = "aaaaaaaa-2222-0000-0000-000000000001";
const ORDER_2 = "aaaaaaaa-2222-0000-0000-000000000002";
const ORDER_3 = "aaaaaaaa-2222-0000-0000-000000000003";
const CUSTOMER_1 = "aaaaaaaa-6666-0000-0000-000000000001";
const CUSTOMER_2 = "aaaaaaaa-6666-0000-0000-000000000002";

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };
type Call = { table: string; select: string; args: unknown[] };

function source(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

function makeCtx(permissions: string[]): AuthorizationContext {
  const set = new Set(permissions);
  return {
    userId: USER_A,
    organizationId: ORG_A,
    roleId: "role-a",
    systemRole: "MANAGER",
    permissions: set,
    can: (key: string) => set.has(key),
    require: (key: string) => {
      if (!set.has(key)) throw new ForbiddenError(`Missing permission: ${key}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

/**
 * A small, faithful stand-in for PostgREST.
 *
 * The previous revision of this harness stubbed `.limit()`/`.range()` as
 * no-ops, which is exactly why the 200-row truncation defect this suite now
 * covers could not be caught: every fixture fit in one window no matter what
 * the caller asked for. This one really applies `.eq`, `.in`, multi-key
 * `.order`, `.limit` and `.range`, so a row cap in the implementation shows up
 * as missing rows in a test — the way it would in production.
 *
 * `dbMaxRows` additionally models PostgREST's own response ceiling
 * (`db-max-rows`, commonly 1000 on a hosted Supabase project) — a cap the
 * CALLER does not request and cannot see, applied to every response
 * regardless of what `.limit()`/`.range()` asked for, silently, with
 * `error: null`. Defaults to unbounded so every pre-existing test is
 * unaffected; only the tests that reproduce the P1 cap defect configure it.
 */
function fakeQuery(
  rows: Record<string, unknown>[],
  record: (select: string) => void,
  dbMaxRows: number = Number.POSITIVE_INFINITY,
) {
  let out = [...rows];
  let selected = "*";
  const orderKeys: { column: string; ascending: boolean }[] = [];

  function applyOrder() {
    if (orderKeys.length === 0) return;
    out.sort((a, b) => {
      for (const { column, ascending } of orderKeys) {
        const av = a[column] as string | number;
        const bv = b[column] as string | number;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return ascending ? cmp : -cmp;
      }
      return 0;
    });
  }

  const query = {
    select: (columns?: string) => {
      selected = columns ?? "*";
      record(selected);
      return query;
    },
    eq: (column: string, value: unknown) => {
      out = out.filter((r) => r[column] === value);
      return query;
    },
    in: (column: string, values: unknown[]) => {
      out = out.filter((r) => values.includes(r[column]));
      return query;
    },
    order: (column: string, opts?: { ascending?: boolean }) => {
      orderKeys.push({ column, ascending: opts?.ascending !== false });
      return query;
    },
    limit: (n: number) => {
      applyOrder();
      orderKeys.length = 0;
      out = out.slice(0, Math.min(n, dbMaxRows));
      return query;
    },
    range: (from: number, to: number) => {
      applyOrder();
      orderKeys.length = 0;
      out = out.slice(from, from + Math.min(to - from + 1, dbMaxRows));
      return query;
    },
    single: async () => {
      applyOrder();
      return { data: out[0] ?? null, error: null } as QueryResult;
    },
    maybeSingle: async () => {
      applyOrder();
      return { data: out[0] ?? null, error: null } as QueryResult;
    },
    then: (resolve: (v: QueryResult) => void, reject?: (e: unknown) => void) => {
      applyOrder();
      const capped = Number.isFinite(dbMaxRows) ? out.slice(0, dbMaxRows) : out;
      return Promise.resolve({ data: capped, error: null } as QueryResult).then(resolve, reject);
    },
  };
  return query;
}

/** Tables as plain row arrays — the fake applies the real filters over them. */
type Tables = Record<string, Record<string, unknown>[]>;

async function withDb<T>(
  tables: Tables,
  run: () => Promise<T>,
  dbMaxRows: number = Number.POSITIVE_INFINITY,
): Promise<{ result: T; calls: Call[] }> {
  const { setDeliveryRepositoryDbForTests } = await import("../server/deliveries/repository");
  const calls: Call[] = [];
  const testDb = {
    from: (table: string) => {
      const call: Call = { table, select: "*", args: [] };
      calls.push(call);
      return fakeQuery(
        tables[table] ?? [],
        (select) => {
          call.select = select;
        },
        dbMaxRows,
      );
    },
  };
  const restore = setDeliveryRepositoryDbForTests(testDb);
  try {
    return { result: await run(), calls };
  } finally {
    restore();
  }
}

const deliveryRow = (overrides: Record<string, unknown> = {}) => ({
  id: "row",
  organization_id: ORG_A,
  order_id: ORDER_1,
  location_id: null,
  provider_id: null,
  provider_key: null,
  provider_name: "J&T Express",
  external_tracking_number: null,
  cod_amount_minor: null,
  cod_currency: null,
  status: "pending",
  created_by: USER_A,
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
  ...overrides,
});

const allPermissions = ["delivery.read", "customers.read"];

describe("listDeliveriesForMerchant — requires delivery.read", () => {
  it("throws Forbidden and reads nothing when the caller lacks delivery.read", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { calls } = await withDb({}, async () => {
      await expect(listDeliveriesForMerchant(makeCtx([]), {})).rejects.toThrow(ForbiddenError);
      return null;
    });
    expect(calls).toHaveLength(0);
  });
});

describe("listDeliveriesForMerchant — latest attempt per order (requirement 5)", () => {
  it("shows only the newest delivery for an order with multiple attempts, never a resolved failure", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    // Repo orders newest-first; the failed attempt is older, the pending retry is current.
    const rows = [
      deliveryRow({
        id: "delivery-retry",
        order_id: ORDER_1,
        status: "pending",
        created_at: "2026-09-06T00:00:00.000Z",
      }),
      deliveryRow({
        id: "delivery-failed",
        order_id: ORDER_1,
        status: "failed",
        created_at: "2026-09-05T00:00:00.000Z",
      }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("delivery-retry");
    expect(result.items[0]?.status).toBe("pending");
  });

  it("excludes an order from the completed scope once a newer active delivery supersedes its old failure", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({
        id: "delivery-retry",
        order_id: ORDER_1,
        status: "in_transit",
        created_at: "2026-09-06T00:00:00.000Z",
      }),
      deliveryRow({
        id: "delivery-failed",
        order_id: ORDER_1,
        status: "failed",
        created_at: "2026-09-05T00:00:00.000Z",
      }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { scope: "completed" }),
    );
    expect(result.items).toHaveLength(0);
  });

  it("includes an order in the active scope once its current delivery is the newer, non-terminal one", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({
        id: "delivery-retry",
        order_id: ORDER_1,
        status: "in_transit",
        created_at: "2026-09-06T00:00:00.000Z",
      }),
      deliveryRow({
        id: "delivery-failed",
        order_id: ORDER_1,
        status: "failed",
        created_at: "2026-09-05T00:00:00.000Z",
      }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { scope: "active" }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("delivery-retry");
  });
});

describe("listDeliveriesForMerchant — filters", () => {
  it("status filter takes priority over scope and matches exactly", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({ id: "d1", order_id: ORDER_1, status: "failed" }),
      deliveryRow({ id: "d2", order_id: ORDER_2, status: "delivered" }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
          { organization_id: ORG_A, id: ORDER_2, order_number: "ORD-0002", customer_id: null },
        ],
      },
      () =>
        listDeliveriesForMerchant(makeCtx(allPermissions), {
          status: "failed",
          scope: "completed",
        }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("failed");
  });

  it("search matches order code, courier and customer name case-insensitively", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({
        id: "d1",
        order_id: ORDER_1,
        provider_name: "J&T Express",
        status: "pending",
      }),
      deliveryRow({
        id: "d2",
        order_id: ORDER_2,
        provider_name: "Capital Delivery",
        status: "pending",
      }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          {
            organization_id: ORG_A,
            id: ORDER_1,
            order_number: "ORD-0001",
            customer_id: CUSTOMER_1,
          },
          {
            organization_id: ORG_A,
            id: ORDER_2,
            order_number: "ORD-0002",
            customer_id: CUSTOMER_2,
          },
        ],
        customers: [
          { organization_id: ORG_A, id: CUSTOMER_1, display_name: "Sok Dara" },
          { organization_id: ORG_A, id: CUSTOMER_2, display_name: "Chan Vibol" },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { search: "sok" }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.orderCode).toBe("ORD-0001");
  });

  it("applies limit/offset after filtering and dedup", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" }),
      deliveryRow({ id: "d2", order_id: ORDER_2, status: "pending" }),
      deliveryRow({ id: "d3", order_id: ORDER_3, status: "pending" }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
          { organization_id: ORG_A, id: ORDER_2, order_number: "ORD-0002", customer_id: null },
          { organization_id: ORG_A, id: ORDER_3, order_number: "ORD-0003", customer_id: null },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { limit: 1, offset: 1 }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.orderCode).toBe("ORD-0002");
  });
});

describe("listDeliveriesForMerchant — customer visibility is server-gated", () => {
  it("redacts customerName (but keeps hasCustomer=true) when the caller lacks customers.read", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" })];
    const { result, calls } = await withDb(
      {
        deliveries: rows,
        orders: [
          {
            organization_id: ORG_A,
            id: ORDER_1,
            order_number: "ORD-0001",
            customer_id: CUSTOMER_1,
          },
        ],
        customers: [
          { organization_id: ORG_A, id: CUSTOMER_1, display_name: "Should Never Appear" },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(["delivery.read"]), {}),
    );
    expect(result.items[0]?.hasCustomer).toBe(true);
    expect(result.items[0]?.customerName).toBeNull();
    // The gate is enforced before the query even runs — customers is never read.
    expect(calls.some((c) => c.table === "customers")).toBe(false);
  });

  it("resolves customerName when the caller holds customers.read", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" })];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          {
            organization_id: ORG_A,
            id: ORDER_1,
            order_number: "ORD-0001",
            customer_id: CUSTOMER_1,
          },
        ],
        customers: [{ organization_id: ORG_A, id: CUSTOMER_1, display_name: "Sok Dara" }],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result.items[0]?.hasCustomer).toBe(true);
    expect(result.items[0]?.customerName).toBe("Sok Dara");
  });

  it("never throws and degrades to null/false when an order or customer reference can't be resolved (e.g. filtered out by org scope)", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" })];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [], // simulates a cross-org order id resolving to nothing
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.orderCode).toBeNull();
    expect(result.items[0]?.hasCustomer).toBe(false);
    expect(result.items[0]?.customerName).toBeNull();
  });
});

describe("listDeliveriesForMerchant — action-needed and COD are never payment signals", () => {
  it("flags actionNeeded only for failed, not for in-progress or terminal-success/cancelled", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({ id: "d1", order_id: ORDER_1, status: "failed" }),
      deliveryRow({ id: "d2", order_id: ORDER_2, status: "in_transit" }),
      deliveryRow({ id: "d3", order_id: ORDER_3, status: "delivered" }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
          { organization_id: ORG_A, id: ORDER_2, order_number: "ORD-0002", customer_id: null },
          { organization_id: ORG_A, id: ORDER_3, order_number: "ORD-0003", customer_id: null },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    const byId = Object.fromEntries(result.items.map((r) => [r.orderCode, r.actionNeeded]));
    expect(byId["ORD-0001"]).toBe(true);
    expect(byId["ORD-0002"]).toBe(false);
    expect(byId["ORD-0003"]).toBe(false);
  });

  it("carries codAmount through as an operational figure with no payment/paid field anywhere on the item", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [
      deliveryRow({
        id: "d1",
        order_id: ORDER_1,
        status: "pending",
        cod_amount_minor: 2500,
        cod_currency: "USD",
      }),
    ];
    const { result } = await withDb(
      {
        deliveries: rows,
        orders: [
          { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
        ],
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result.items[0]?.codAmount).toEqual({ amount: 2500, currency: "USD" });
    expect(Object.keys(result.items[0] ?? {})).not.toContain("paymentStatus");
    expect(Object.keys(result.items[0] ?? {})).not.toContain("paid");
  });
});

describe("Tenant isolation — structural (mirrors delivery-domain.test.ts's own convention)", () => {
  it("listOrderRefsForOrg and listCustomerRefsForOrg both scope by organization_id, same as every other repository read in this file", () => {
    const repoSource = source("src/server/deliveries/repository.ts");
    const orderRefsFn = repoSource.slice(
      repoSource.indexOf("export async function listOrderRefsForOrg"),
    );
    const customerRefsFn = repoSource.slice(
      repoSource.indexOf("export async function listCustomerRefsForOrg"),
    );
    expect(orderRefsFn.slice(0, 400)).toContain('.eq("organization_id", organizationId)');
    expect(customerRefsFn.slice(0, 400)).toContain('.eq("organization_id", organizationId)');
  });

  it("listDeliveriesForMerchant never accepts a client-supplied organizationId — it only ever reads ctx.organizationId", () => {
    const serviceSource = source("src/server/deliveries/service.ts");
    const fnSource = serviceSource.slice(
      serviceSource.indexOf("export async function listDeliveriesForMerchant"),
      serviceSource.indexOf("export async function listDeliveriesForMerchant") + 3000,
    );
    expect(fnSource).toContain("ctx.organizationId");
    expect(fnSource).not.toMatch(/options\.organizationId|data\.organizationId/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Large lists — the defect class the old implementation could not even express.
//
// The previous revision read one capped window of raw rows and *then* deduped
// and filtered, so any order whose latest attempt fell outside that window
// disappeared and a filter could report zero while hundreds of matching orders
// existed. Every test below puts more raw rows in the fixture than that old cap
// and asserts the complete answer; the harness above really applies `.limit()`
// and `.range()`, so a re-introduced cap fails these instead of passing them.
// ═══════════════════════════════════════════════════════════════════════════════

const OLD_RAW_CAP = 200;

/** Deliveries are laid out newest-first: index 0 is the most recent attempt in the org. */
function buildStream(
  specs: { orderId: string; status: string; id?: string; tracking?: string | null }[],
): { deliveries: Record<string, unknown>[]; orders: Record<string, unknown>[] } {
  const base = Date.UTC(2026, 8, 10, 0, 0, 0);
  const deliveries = specs.map((spec, index) =>
    deliveryRow({
      id: spec.id ?? `del-${index}`,
      order_id: spec.orderId,
      status: spec.status,
      external_tracking_number: spec.tracking ?? null,
      // Strictly decreasing, so index order *is* newest-first order.
      created_at: new Date(base - index * 60_000).toISOString(),
      updated_at: new Date(base - index * 60_000).toISOString(),
    }),
  );
  const orders = [...new Set(specs.map((s) => s.orderId))].map((orderId) => ({
    organization_id: ORG_A,
    id: orderId,
    order_number: `ORD-${orderId}`,
    customer_id: null,
  }));
  return { deliveries, orders };
}

/** Walks every page the way the screen's "load more" does, and reports what it saw. */
async function readAllPages(
  tables: Tables,
  options: Record<string, unknown>,
  pageSize = 50,
  dbMaxRows: number = Number.POSITIVE_INFINITY,
): Promise<{ orderCodes: string[]; pages: string[][]; truncated: boolean }> {
  const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
  const pages: string[][] = [];
  let truncated = false;
  let offset = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const { result } = await withDb(
      tables,
      () =>
        listDeliveriesForMerchant(makeCtx(allPermissions), {
          ...options,
          limit: pageSize,
          offset,
        }),
      dbMaxRows,
    );
    pages.push(result.items.map((i) => i.orderCode ?? "?"));
    truncated ||= result.truncated;
    if (!result.hasMore) break;
    offset += result.items.length;
  }
  return { orderCodes: pages.flat(), pages, truncated };
}

describe("listDeliveriesForMerchant — completeness beyond the old 200-row cap", () => {
  it("returns every order when the org has far more deliveries than the old raw cap", async () => {
    const specs = Array.from({ length: 600 }, (_, i) => ({
      orderId: `o${String(i).padStart(4, "0")}`,
      status: "in_transit",
    }));
    const { deliveries, orders } = buildStream(specs);
    expect(deliveries.length).toBeGreaterThan(OLD_RAW_CAP);

    const { orderCodes } = await readAllPages({ deliveries, orders }, {});
    expect(orderCodes).toHaveLength(600);
    // The order sitting at raw index 500 — far past the old cap — is present.
    expect(orderCodes).toContain("ORD-o0500");
    expect(new Set(orderCodes).size).toBe(600);
  });

  it("150 unresolved failed deliveries sitting past the old cap are not collapsed to zero", async () => {
    // 300 newer delivered rows would have entirely filled the old 200-row
    // window, leaving the failures invisible — the reviewer's reproduction.
    const specs = [
      ...Array.from({ length: 300 }, (_, i) => ({ orderId: `ok${i}`, status: "delivered" })),
      ...Array.from({ length: 150 }, (_, i) => ({ orderId: `bad${i}`, status: "failed" })),
    ];
    const { deliveries, orders } = buildStream(specs);

    const { result } = await withDb({ deliveries, orders }, () =>
      import("../server/deliveries/service").then((m) =>
        m.listDeliveriesForMerchant(makeCtx(allPermissions), { status: "failed" }),
      ),
    );
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.hasMore).toBe(true);
    expect(result.truncated).toBe(false);

    const { orderCodes } = await readAllPages({ deliveries, orders }, { status: "failed" });
    expect(orderCodes).toHaveLength(150);
    expect(orderCodes.every((code) => code.startsWith("ORD-bad"))).toBe(true);
  });

  it("the active filter reaches active deliveries buried under newer completed ones", async () => {
    const specs = [
      ...Array.from({ length: 400 }, (_, i) => ({ orderId: `done${i}`, status: "delivered" })),
      ...Array.from({ length: 30 }, (_, i) => ({ orderId: `live${i}`, status: "in_transit" })),
    ];
    const { deliveries, orders } = buildStream(specs);
    const { orderCodes } = await readAllPages({ deliveries, orders }, { scope: "active" });
    expect(orderCodes).toHaveLength(30);
    expect(orderCodes).toContain("ORD-live29");
  });

  it("the completed filter reaches completed deliveries buried under newer active ones", async () => {
    const specs = [
      ...Array.from({ length: 400 }, (_, i) => ({ orderId: `live${i}`, status: "in_transit" })),
      ...Array.from({ length: 25 }, (_, i) => ({ orderId: `done${i}`, status: "delivered" })),
    ];
    const { deliveries, orders } = buildStream(specs);
    const { orderCodes } = await readAllPages({ deliveries, orders }, { scope: "completed" });
    expect(orderCodes).toHaveLength(25);
    expect(orderCodes).toContain("ORD-done24");
  });

  it("heavy retry volume on a few orders no longer starves every other order off the list", async () => {
    // 5 orders with 60 attempts each = 300 raw rows that collapse to 5 list
    // rows; under the old cap they consumed the entire window.
    const specs: { orderId: string; status: string }[] = [];
    for (let o = 0; o < 5; o += 1) {
      specs.push({ orderId: `retry${o}`, status: "pending" });
      for (let a = 0; a < 59; a += 1) specs.push({ orderId: `retry${o}`, status: "failed" });
    }
    for (let i = 0; i < 50; i += 1) specs.push({ orderId: `plain${i}`, status: "in_transit" });
    const { deliveries, orders } = buildStream(specs);
    expect(deliveries.length).toBe(350);

    const { orderCodes } = await readAllPages({ deliveries, orders }, {});
    expect(orderCodes).toHaveLength(55);
    expect(orderCodes).toContain("ORD-plain49");
    expect(new Set(orderCodes).size).toBe(55);
  });

  it("search finds a delivery far past the old cap instead of reporting no matches", async () => {
    const specs = Array.from({ length: 500 }, (_, i) => ({
      orderId: `o${i}`,
      status: "in_transit",
      tracking: i === 420 ? "NEEDLE-IN-THE-TAIL" : `TRK-${i}`,
    }));
    const { deliveries, orders } = buildStream(specs);

    const { result } = await withDb({ deliveries, orders }, () =>
      import("../server/deliveries/service").then((m) =>
        m.listDeliveriesForMerchant(makeCtx(allPermissions), { search: "needle-in-the-tail" }),
      ),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.orderCode).toBe("ORD-o420");
    expect(result.hasMore).toBe(false);
  });

  it("a retried order is still excluded from the failed filter even when its failure is buried deep", async () => {
    // The retry is newest; its old failure sits past the old cap. The failed
    // filter must not resurrect the superseded attempt.
    const specs = [
      { orderId: "retried", status: "in_transit", id: "retry-current" },
      ...Array.from({ length: 400 }, (_, i) => ({ orderId: `other${i}`, status: "delivered" })),
      { orderId: "retried", status: "failed", id: "retry-old-failure" },
      { orderId: "genuine", status: "failed", id: "genuine-failure" },
    ];
    const { deliveries, orders } = buildStream(specs);

    const { orderCodes } = await readAllPages({ deliveries, orders }, { status: "failed" });
    expect(orderCodes).toEqual(["ORD-genuine"]);

    const active = await readAllPages({ deliveries, orders }, { scope: "active" });
    expect(active.orderCodes).toEqual(["ORD-retried"]);
  });
});

describe("listDeliveriesForMerchant — pagination contract", () => {
  const specs = Array.from({ length: 320 }, (_, i) => ({
    orderId: `o${String(i).padStart(4, "0")}`,
    status: "in_transit",
  }));
  const { deliveries, orders } = buildStream(specs);
  const tables: Tables = { deliveries, orders };

  it("pages cover the whole set with no duplicate and no missing order", async () => {
    const { pages, orderCodes } = await readAllPages(tables, {}, 50);
    expect(pages.length).toBe(7); // 6 full pages + a 20-row tail
    expect(orderCodes).toHaveLength(320);
    expect(new Set(orderCodes).size).toBe(320);

    const seen = new Set<string>();
    for (const page of pages) {
      for (const code of page) {
        expect(seen.has(code)).toBe(false);
        seen.add(code);
      }
    }
  });

  it("hasMore is observed, not guessed — false exactly on the final page", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const lastFull = await withDb(tables, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), { limit: 50, offset: 250 }),
    );
    expect(lastFull.result.items).toHaveLength(50);
    expect(lastFull.result.hasMore).toBe(true);

    const tail = await withDb(tables, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), { limit: 50, offset: 300 }),
    );
    expect(tail.result.items).toHaveLength(20);
    expect(tail.result.hasMore).toBe(false);
  });

  it("an offset past the end returns empty and says so, rather than hiding a reachable page", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result } = await withDb(tables, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), { limit: 50, offset: 320 }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("ordering is stable across repeated reads and tie-safe when timestamps collide", async () => {
    const collide = "2026-09-10T00:00:00.000Z";
    const tied = {
      deliveries: [
        deliveryRow({ id: "attempt-a", order_id: ORDER_1, status: "failed", created_at: collide }),
        deliveryRow({
          id: "attempt-b",
          order_id: ORDER_1,
          status: "delivered",
          created_at: collide,
        }),
      ],
      orders: [
        { organization_id: ORG_A, id: ORDER_1, order_number: "ORD-0001", customer_id: null },
      ],
    };
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");

    // id DESC breaks the tie, so "attempt-b" wins — deterministically, every time.
    for (let i = 0; i < 3; i += 1) {
      const { result } = await withDb(tied, () =>
        listDeliveriesForMerchant(makeCtx(allPermissions), {}),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.id).toBe("attempt-b");
      expect(result.items[0]?.status).toBe("delivered");
    }
  });
});

describe("listDeliveriesForMerchant — the scan is bounded, and says so when it stops early", () => {
  it("reports truncated instead of silently presenting a partial list", async () => {
    // One pathological order with more attempts than the scan ceiling: the
    // scan cannot reach the end of the stream, and the result admits it.
    const specs = Array.from({ length: 10_400 }, () => ({
      orderId: "pathological",
      status: "failed",
    }));
    specs[0] = { orderId: "pathological", status: "pending" };
    const { deliveries, orders } = buildStream(specs);

    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result } = await withDb({ deliveries, orders }, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it("a normal large list is never marked truncated", async () => {
    const specs = Array.from({ length: 900 }, (_, i) => ({
      orderId: `o${i}`,
      status: "delivered",
    }));
    const { deliveries, orders } = buildStream(specs);
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result } = await withDb({ deliveries, orders }, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result.truncated).toBe(false);
    expect(result.hasMore).toBe(true);
  });
});

describe("Large-list scan stays tenant-scoped and permission-safe", () => {
  it("another org's deliveries are never scanned into the result, however deep the stream", async () => {
    const mine = Array.from({ length: 250 }, (_, i) => ({
      orderId: `mine${i}`,
      status: "delivered",
    }));
    const { deliveries, orders } = buildStream(mine);
    // Interleave a foreign org's rows — the fake applies .eq("organization_id") for real.
    const foreign = Array.from({ length: 250 }, (_, i) =>
      deliveryRow({
        id: `foreign-${i}`,
        organization_id: ORG_B,
        order_id: `theirs${i}`,
        status: "failed",
        created_at: new Date(Date.UTC(2026, 8, 11) - i * 60_000).toISOString(),
      }),
    );
    const foreignOrders = Array.from({ length: 250 }, (_, i) => ({
      organization_id: ORG_B,
      id: `theirs${i}`,
      order_number: `ORD-theirs${i}`,
      customer_id: null,
    }));

    const tables: Tables = {
      deliveries: [...foreign, ...deliveries],
      orders: [...foreignOrders, ...orders],
    };
    const { orderCodes } = await readAllPages(tables, {});
    expect(orderCodes).toHaveLength(250);
    expect(orderCodes.some((code) => code.includes("theirs"))).toBe(false);

    const failed = await readAllPages(tables, { status: "failed" });
    expect(failed.orderCodes).toHaveLength(0);
  });

  it("a deep scan still never reads customers when the caller lacks customers.read", async () => {
    const specs = Array.from({ length: 400 }, (_, i) => ({
      orderId: `o${i}`,
      status: "in_transit",
    }));
    const { deliveries } = buildStream(specs);
    const orders = Array.from({ length: 400 }, (_, i) => ({
      organization_id: ORG_A,
      id: `o${i}`,
      order_number: `ORD-o${i}`,
      customer_id: CUSTOMER_1,
    }));
    const customers = [
      { organization_id: ORG_A, id: CUSTOMER_1, display_name: "Should Never Appear" },
    ];

    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result, calls } = await withDb({ deliveries, orders, customers }, () =>
      listDeliveriesForMerchant(makeCtx(["delivery.read"]), { search: "should never appear" }),
    );
    // Searching cannot become a side channel onto names the caller may not see.
    expect(result.items).toHaveLength(0);
    expect(calls.some((c) => c.table === "customers")).toBe(false);
  });

  it("customer-name search works across the whole stream when customers.read is held", async () => {
    const specs = Array.from({ length: 400 }, (_, i) => ({
      orderId: `o${i}`,
      status: "in_transit",
    }));
    const { deliveries } = buildStream(specs);
    const orders = Array.from({ length: 400 }, (_, i) => ({
      organization_id: ORG_A,
      id: `o${i}`,
      order_number: `ORD-o${i}`,
      customer_id: i === 390 ? CUSTOMER_2 : CUSTOMER_1,
    }));
    const customers = [
      { organization_id: ORG_A, id: CUSTOMER_1, display_name: "Sok Dara" },
      { organization_id: ORG_A, id: CUSTOMER_2, display_name: "Chan Vibol" },
    ];

    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result } = await withDb({ deliveries, orders, customers }, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), { search: "vibol" }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.orderCode).toBe("ORD-o390");
    expect(result.items[0]?.customerName).toBe("Chan Vibol");
  });
});

describe("The scan really is windowed — the harness would catch a re-introduced cap", () => {
  it("walks the stream in multiple bounded reads rather than one unbounded fetch", async () => {
    const specs = Array.from({ length: 1200 }, (_, i) => ({
      orderId: `o${i}`,
      status: "delivered",
    }));
    const { deliveries, orders } = buildStream(specs);
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result, calls } = await withDb({ deliveries, orders }, () =>
      // Ask for a page deep enough that one 500-row window cannot answer it.
      listDeliveriesForMerchant(makeCtx(allPermissions), { limit: 50, offset: 1000 }),
    );
    expect(result.items).toHaveLength(50);
    expect(result.items[0]?.orderCode).toBe("ORD-o1000");
    const deliveryReads = calls.filter((c) => c.table === "deliveries").length;
    expect(deliveryReads).toBeGreaterThan(1);
  });

  it("resolves each order's latest attempt with a three-column projection, not a full-row fan-out", async () => {
    const specs = [
      { orderId: "a", status: "delivered" },
      { orderId: "a", status: "failed" },
    ];
    const { deliveries, orders } = buildStream(specs);
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { calls } = await withDb({ deliveries, orders }, () =>
      listDeliveriesForMerchant(makeCtx(allPermissions), { status: "delivered" }),
    );
    expect(
      calls.some((c) => c.table === "deliveries" && c.select === "id, order_id, created_at"),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1 fix (Round 3) — listDeliveryAttemptRefsForOrders must be complete
// regardless of any PostgREST/Supabase `db-max-rows` response ceiling, and
// verification must never read "no ref for this order" as "superseded".
//
// The independent reviewer reproduced: a single order with a long
// non-candidate history sitting newest-in-the-org, verified alongside 49
// orders whose current delivery genuinely was failed. Under the OLD query
// shape (one `.in("order_id", chunk)` read spanning every attempt of every
// order in the chunk), a capped response (db-max-rows, commonly 1000 on a
// hosted Supabase project) let the heavy order's own history consume the
// entire cap, so the 49 real orders' single ref each never appeared in the
// capped response. The old code read that absence as "superseded" and
// dropped all 49 — presented as `truncated: false`, a certain zero that was
// actually unknown.
//
// The fix (repo.listDeliveryAttemptRefsForOrders) reads each order's latest
// attempt as its own `.limit(1)` query. `dbMaxRows` below models the
// PostgREST ceiling directly on the fake — every read, capped or not,
// returns at most `dbMaxRows` rows regardless of what the caller asked for —
// so these tests fail against the pre-fix `.in()` shape and pass against the
// per-order shape.
// ═══════════════════════════════════════════════════════════════════════════════

describe("listDeliveriesForMerchant — verification is complete under a PostgREST row cap (P1 fix)", () => {
  it("A. one order's massive attempt history cannot push a different order's ref out of a capped read", async () => {
    // "loud" carries far more history than any db-max-rows a real project
    // would configure; its true latest is non-failed, so it must be excluded.
    // "quiet" has exactly one attempt, genuinely failed, and must survive.
    const specs = [
      ...Array.from({ length: 1500 }, () => ({ orderId: "loud", status: "cancelled" })),
      { orderId: "quiet", status: "failed" },
      { orderId: "loud", status: "failed" }, // loud's own oldest attempt — still superseded
    ];
    const { deliveries, orders } = buildStream(specs);

    const capped = await readAllPages({ deliveries, orders }, { status: "failed" }, 50, 1000);
    const uncapped = await readAllPages(
      { deliveries, orders },
      { status: "failed" },
      50,
      Number.MAX_SAFE_INTEGER,
    );

    // The answer must not depend on the configured db-max-rows value.
    expect(capped.orderCodes).toEqual(["ORD-quiet"]);
    expect(uncapped.orderCodes).toEqual(["ORD-quiet"]);
    expect(capped.truncated).toBe(false);
  });

  it("B. reproduces the reviewer's exact finding: 49 legitimate failed deliveries no longer collapse to zero", async () => {
    const specs = [
      // Newest-in-the-org, non-candidate history — the exact shape that
      // consumed the old capped read.
      ...Array.from({ length: 1500 }, () => ({ orderId: "heavy", status: "cancelled" })),
      ...Array.from({ length: 49 }, (_, i) => ({ orderId: `real${i}`, status: "failed" })),
      { orderId: "heavy", status: "failed" }, // heavy's own old, superseded failure
    ];
    const { deliveries, orders } = buildStream(specs);

    const { orderCodes, truncated } = await readAllPages(
      { deliveries, orders },
      { status: "failed" },
      50,
      1000, // the common hosted-Supabase db-max-rows default
    );

    expect(orderCodes).toHaveLength(49);
    expect(orderCodes.every((code) => code.startsWith("ORD-real"))).toBe(true);
    expect(orderCodes).not.toContain("ORD-heavy");
    expect(truncated).toBe(false);
  });

  it("C/E. an unresolved verification (ref missing for a reason that is not supersession) is kept, never silently dropped, and marks the page truncated", async () => {
    const specs = [
      { orderId: "cannot-verify", status: "failed" },
      { orderId: "genuine", status: "failed" },
    ];
    const { deliveries, orders } = buildStream(specs);

    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { setDeliveryRepositoryDbForTests } = await import("../server/deliveries/repository");
    const restore = setDeliveryRepositoryDbForTests({
      from: (table: string) => {
        if (table !== "deliveries") return fakeQuery(orders, () => {});
        // Wrap the real fake so every chain (scanDeliveries's status/range
        // scan included) behaves exactly as in every other test, except the
        // one per-order verification read targeting "cannot-verify": that
        // one resolves empty — not a cap (the bounded per-order shape can't
        // hit one), but the same observable shape as any other transport
        // hiccup that returns no rows and no error.
        const real = fakeQuery(deliveries, () => {});
        let blocked = false;
        const wrapper = {
          select: (...args: [string?]) => {
            real.select(...args);
            return wrapper;
          },
          eq: (column: string, value: unknown) => {
            if (column === "order_id" && value === "cannot-verify") blocked = true;
            real.eq(column, value);
            return wrapper;
          },
          in: (...args: [string, unknown[]]) => {
            real.in(...args);
            return wrapper;
          },
          order: (...args: [string, { ascending?: boolean }?]) => {
            real.order(...args);
            return wrapper;
          },
          range: (...args: [number, number]) => {
            real.range(...args);
            return wrapper;
          },
          limit: (n: number) =>
            blocked ? Promise.resolve({ data: [], error: null }) : real.limit(n),
          single: () => real.single(),
          maybeSingle: () => real.maybeSingle(),
          then: (resolve: (v: QueryResult) => void, reject?: (e: unknown) => void) =>
            real.then(resolve, reject),
        };
        return wrapper;
      },
    });

    let result: Awaited<ReturnType<typeof listDeliveriesForMerchant>>;
    try {
      result = await listDeliveriesForMerchant(makeCtx(allPermissions), { status: "failed" });
    } finally {
      restore();
    }

    // The unresolved candidate is admitted, not guessed away as superseded —
    // and the page honestly reports it cannot be certain.
    expect(result.items.some((i) => i.orderCode === "ORD-cannot-verify")).toBe(true);
    expect(result.items.some((i) => i.orderCode === "ORD-genuine")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("D. a candidate that really is superseded is still excluded — the fix does not weaken this", async () => {
    const specs = [
      { orderId: "retried", status: "in_transit", id: "retry-current" },
      { orderId: "retried", status: "failed", id: "retry-old-failure" },
      { orderId: "genuine", status: "failed", id: "genuine-failure" },
    ];
    const { deliveries, orders } = buildStream(specs);

    const { orderCodes } = await readAllPages(
      { deliveries, orders },
      { status: "failed" },
      50,
      1000,
    );
    expect(orderCodes).toEqual(["ORD-genuine"]);
  });

  it("F. tenant isolation and customers.read gating hold under the new per-order verification reads", async () => {
    // An adversarial id collision across orgs: verification must still scope
    // by organization_id before order_id, exactly as the raw scan does.
    const mineRow = deliveryRow({
      id: "mine-failed",
      organization_id: ORG_A,
      order_id: "shared-id",
      status: "failed",
      created_at: "2026-09-05T00:00:00.000Z",
    });
    const theirsRow = deliveryRow({
      id: "theirs-failed",
      organization_id: ORG_B,
      order_id: "shared-id",
      status: "failed",
      created_at: "2026-09-06T00:00:00.000Z", // newer, so it would win if org-scoping were dropped
    });
    const orders = [
      {
        organization_id: ORG_A,
        id: "shared-id",
        order_number: "ORD-mine",
        customer_id: CUSTOMER_1,
      },
      { organization_id: ORG_B, id: "shared-id", order_number: "ORD-theirs", customer_id: null },
    ];
    const customers = [{ organization_id: ORG_A, id: CUSTOMER_1, display_name: "Should Not Leak" }];

    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const { result: withNames, calls } = await withDb(
      { deliveries: [mineRow, theirsRow], orders, customers },
      () => listDeliveriesForMerchant(makeCtx(["delivery.read"]), { status: "failed" }),
      1000,
    );

    expect(withNames.items).toHaveLength(1);
    expect(withNames.items[0]?.id).toBe("mine-failed");
    expect(withNames.items[0]?.orderCode).toBe("ORD-mine");
    // No customers.read held — the name must stay redacted, not silently resolved.
    expect(withNames.items[0]?.customerName).toBeNull();
    expect(calls.some((c) => c.table === "customers")).toBe(false);
  });
});
