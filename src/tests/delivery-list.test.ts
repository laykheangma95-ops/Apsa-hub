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
type Call = { table: string; args: unknown[] };

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

/** Table-scoped fake: each `.from(table)` call returns the whole matching row set for that table (filtered by the test's own `.eq`/`.in` no-ops — filtering happens in the fixture data itself, matching this repo's existing withDb convention of pre-scoped fixtures). */
function fakeQuery(result: QueryResult) {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: () => query,
    range: () => query,
    single: async () => result,
    maybeSingle: async () => result,
    then: (resolve: (v: QueryResult) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

async function withDb<T>(
  tables: Record<string, QueryResult>,
  run: () => Promise<T>,
): Promise<{ result: T; calls: Call[] }> {
  const { setDeliveryRepositoryDbForTests } = await import("../server/deliveries/repository");
  const calls: Call[] = [];
  const testDb = {
    from: (table: string) => {
      calls.push({ table, args: [] });
      return fakeQuery(tables[table] ?? { data: [], error: null });
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [{ id: ORDER_1, order_number: "ORD-0001", customer_id: null }],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("delivery-retry");
    expect(result[0]?.status).toBe("pending");
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [{ id: ORDER_1, order_number: "ORD-0001", customer_id: null }],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { scope: "completed" }),
    );
    expect(result).toHaveLength(0);
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [{ id: ORDER_1, order_number: "ORD-0001", customer_id: null }],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { scope: "active" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("delivery-retry");
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [
            { id: ORDER_1, order_number: "ORD-0001", customer_id: null },
            { id: ORDER_2, order_number: "ORD-0002", customer_id: null },
          ],
          error: null,
        },
      },
      () =>
        listDeliveriesForMerchant(makeCtx(allPermissions), {
          status: "failed",
          scope: "completed",
        }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("failed");
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [
            { id: ORDER_1, order_number: "ORD-0001", customer_id: CUSTOMER_1 },
            { id: ORDER_2, order_number: "ORD-0002", customer_id: CUSTOMER_2 },
          ],
          error: null,
        },
        customers: {
          data: [
            { id: CUSTOMER_1, display_name: "Sok Dara" },
            { id: CUSTOMER_2, display_name: "Chan Vibol" },
          ],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { search: "sok" }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.orderCode).toBe("ORD-0001");
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [
            { id: ORDER_1, order_number: "ORD-0001", customer_id: null },
            { id: ORDER_2, order_number: "ORD-0002", customer_id: null },
            { id: ORDER_3, order_number: "ORD-0003", customer_id: null },
          ],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), { limit: 1, offset: 1 }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.orderCode).toBe("ORD-0002");
  });
});

describe("listDeliveriesForMerchant — customer visibility is server-gated", () => {
  it("redacts customerName (but keeps hasCustomer=true) when the caller lacks customers.read", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" })];
    const { result, calls } = await withDb(
      {
        deliveries: { data: rows, error: null },
        orders: {
          data: [{ id: ORDER_1, order_number: "ORD-0001", customer_id: CUSTOMER_1 }],
          error: null,
        },
        customers: {
          data: [{ id: CUSTOMER_1, display_name: "Should Never Appear" }],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(["delivery.read"]), {}),
    );
    expect(result[0]?.hasCustomer).toBe(true);
    expect(result[0]?.customerName).toBeNull();
    // The gate is enforced before the query even runs — customers is never read.
    expect(calls.some((c) => c.table === "customers")).toBe(false);
  });

  it("resolves customerName when the caller holds customers.read", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" })];
    const { result } = await withDb(
      {
        deliveries: { data: rows, error: null },
        orders: {
          data: [{ id: ORDER_1, order_number: "ORD-0001", customer_id: CUSTOMER_1 }],
          error: null,
        },
        customers: {
          data: [{ id: CUSTOMER_1, display_name: "Sok Dara" }],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result[0]?.hasCustomer).toBe(true);
    expect(result[0]?.customerName).toBe("Sok Dara");
  });

  it("never throws and degrades to null/false when an order or customer reference can't be resolved (e.g. filtered out by org scope)", async () => {
    const { listDeliveriesForMerchant } = await import("../server/deliveries/service");
    const rows = [deliveryRow({ id: "d1", order_id: ORDER_1, status: "pending" })];
    const { result } = await withDb(
      {
        deliveries: { data: rows, error: null },
        orders: { data: [], error: null }, // simulates a cross-org order id resolving to nothing
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.orderCode).toBeNull();
    expect(result[0]?.hasCustomer).toBe(false);
    expect(result[0]?.customerName).toBeNull();
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [
            { id: ORDER_1, order_number: "ORD-0001", customer_id: null },
            { id: ORDER_2, order_number: "ORD-0002", customer_id: null },
            { id: ORDER_3, order_number: "ORD-0003", customer_id: null },
          ],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    const byId = Object.fromEntries(result.map((r) => [r.orderCode, r.actionNeeded]));
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
        deliveries: { data: rows, error: null },
        orders: {
          data: [{ id: ORDER_1, order_number: "ORD-0001", customer_id: null }],
          error: null,
        },
      },
      () => listDeliveriesForMerchant(makeCtx(allPermissions), {}),
    );
    expect(result[0]?.codAmount).toEqual({ amount: 2500, currency: "USD" });
    expect(Object.keys(result[0] ?? {})).not.toContain("paymentStatus");
    expect(Object.keys(result[0] ?? {})).not.toContain("paid");
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
