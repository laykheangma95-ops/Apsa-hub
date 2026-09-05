/** Production Delivery/Fulfillment domain tests. */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError } from "../server/auth/authorization";
import type { AuthorizationContext } from "../server/auth/authorization";
import type { DeliveryStatus } from "../server/deliveries/state-machine";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_A = "aaaaaaaa-1111-0000-0000-000000000001";
const ORDER_A = "aaaaaaaa-2222-0000-0000-000000000001";
const DELIVERY_A = "aaaaaaaa-3333-0000-0000-000000000001";
const LOCATION_A = "aaaaaaaa-4444-0000-0000-000000000001";
const PROVIDER_A = "aaaaaaaa-5555-0000-0000-000000000001";

type QueryResult = { data: unknown; error: { code?: string; message: string } | null };
type RpcCall = { fn: string; args: Record<string, unknown> };

const noRow: QueryResult = { data: null, error: { code: "PGRST116", message: "no rows" } };
const empty: QueryResult = { data: [], error: null };

function source(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
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
    then: (resolve: (value: QueryResult) => void, reject?: (error: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

interface FakeOptions {
  tables?: Record<string, QueryResult[]>;
  rpc?: Record<string, QueryResult>;
  rpcHandler?: (name: string, args: Record<string, unknown>) => Promise<QueryResult>;
}

async function withDb<T>(options: FakeOptions, run: (calls: RpcCall[]) => Promise<T>): Promise<T> {
  const { setDeliveryRepositoryDbForTests } = await import("../server/deliveries/repository");
  const queues = Object.fromEntries(
    Object.entries(options.tables ?? {}).map(([table, results]) => [table, [...results]]),
  ) as Record<string, QueryResult[]>;
  const calls: RpcCall[] = [];
  const testDb = {
    from: (table: string) => fakeQuery(queues[table]?.shift() ?? empty),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ fn: name, args });
      if (options.rpcHandler) return options.rpcHandler(name, args);
      return options.rpc?.[name] ?? { data: { status: "success" }, error: null };
    },
  };
  const restore = setDeliveryRepositoryDbForTests(testDb);
  try {
    return await run(calls);
  } finally {
    restore();
  }
}

const order = (overrides: Record<string, unknown> = {}): QueryResult => ({
  data: {
    id: ORDER_A,
    organization_id: ORG_A,
    location_id: LOCATION_A,
    currency: "USD",
    lifecycle_status: "confirmed",
    fulfillment_status: "unfulfilled",
    ...overrides,
  },
  error: null,
});

const delivery = (overrides: Record<string, unknown> = {}): QueryResult => ({
  data: {
    id: DELIVERY_A,
    organization_id: ORG_A,
    order_id: ORDER_A,
    location_id: LOCATION_A,
    provider_id: PROVIDER_A,
    provider_key: "manual-vet",
    provider_name: "VET Express",
    external_tracking_number: "VET-42",
    cod_amount_minor: 2500,
    cod_currency: "USD",
    status: "pending",
    created_by: USER_A,
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  },
  error: null,
});

const provider: QueryResult = {
  data: {
    id: PROVIDER_A,
    organization_id: ORG_A,
    provider_key: "manual-vet",
    name: "VET Express",
    active: true,
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
  },
  error: null,
};

const location: QueryResult = { data: { id: LOCATION_A, organization_id: ORG_A }, error: null };
const history = (from: string | null, to: string): QueryResult => ({
  data: [
    {
      id: "history-1",
      organization_id: ORG_A,
      delivery_id: DELIVERY_A,
      from_status: from,
      to_status: to,
      changed_by: USER_A,
      reason: from === null ? "Delivery created" : null,
      created_at: "2026-09-05T00:00:00.000Z",
    },
  ],
  error: null,
});

const allPermissions = ["delivery.read", "delivery.create", "delivery.update"];
const migration = () => source("supabase/migrations/027_delivery_fulfillment_domain.sql");

describe("Delivery status machine", () => {
  it("accepts exactly the minimal forward and failure/cancel edges", async () => {
    const { DELIVERY_TRANSITIONS, isValidDeliveryTransition } =
      await import("../server/deliveries/state-machine");
    expect(DELIVERY_TRANSITIONS).toEqual({
      pending: ["preparing", "cancelled"],
      preparing: ["ready", "cancelled"],
      ready: ["in_transit", "cancelled"],
      in_transit: ["delivered", "failed"],
      delivered: [],
      failed: [],
      cancelled: [],
    });
    expect(isValidDeliveryTransition("pending", "preparing")).toBe(true);
    expect(isValidDeliveryTransition("pending", "delivered")).toBe(false);
  });

  it("declares delivered, failed and cancelled terminal", async () => {
    const { isTerminalDeliveryStatus } = await import("../server/deliveries/state-machine");
    for (const status of ["delivered", "failed", "cancelled"] as const) {
      expect(isTerminalDeliveryStatus(status)).toBe(true);
    }
    expect(isTerminalDeliveryStatus("in_transit")).toBe(false);
  });

  it("has one authoritative mapping to the Order fulfillment axis", async () => {
    const { DELIVERY_TO_ORDER_FULFILLMENT } = await import("../server/deliveries/state-machine");
    expect(DELIVERY_TO_ORDER_FULFILLMENT).toEqual({
      pending: "processing",
      preparing: "processing",
      ready: "processing",
      in_transit: "processing",
      delivered: "fulfilled",
      failed: "unfulfilled",
      cancelled: "cancelled",
    });
  });
});

describe("Create Delivery", () => {
  it("creates for a confirmed org-scoped order and derives provider/currency server-side", async () => {
    const { createDelivery } = await import("../server/deliveries/service");
    const calls = await withDb(
      {
        tables: {
          orders: [order()],
          locations: [location],
          delivery_providers: [provider],
          deliveries: [{ data: null, error: null }, delivery()],
          delivery_status_history: [history(null, "pending")],
        },
        rpc: {
          create_delivery_v1: {
            data: { status: "success", delivery_id: DELIVERY_A },
            error: null,
          },
        },
      },
      async (recorded) => {
        const result = await createDelivery(makeCtx(allPermissions), {
          orderId: ORDER_A,
          providerId: PROVIDER_A,
          providerName: "client cannot override this",
          codAmountMinor: 2500,
        });
        expect(result.status).toBe("pending");
        expect(result.providerName).toBe("VET Express");
        expect(result.codAmount).toEqual({ amount: 2500, currency: "USD" });
        expect(result.history[0]?.fromStatus).toBeNull();
        return recorded;
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe("create_delivery_v1");
    expect(calls[0]?.args["p_organization_id"]).toBe(ORG_A);
    expect(calls[0]?.args["p_created_by"]).toBe(USER_A);
    expect(calls[0]?.args["p_provider_name"]).toBe("VET Express");
    expect(JSON.stringify(calls[0]?.args)).not.toContain("cod_currency");
  });

  it("rejects an invalid or cross-org order as not found before any write", async () => {
    const { createDelivery } = await import("../server/deliveries/service");
    const calls = await withDb({ tables: { orders: [noRow] } }, async (recorded) => {
      await expect(
        createDelivery(makeCtx(allPermissions), { orderId: ORDER_A, providerName: "Manual" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      return recorded;
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects draft, cancelled, completed and fulfilled orders", async () => {
    const { createDelivery } = await import("../server/deliveries/service");
    for (const row of [
      order({ lifecycle_status: "draft" }),
      order({ lifecycle_status: "cancelled" }),
      order({ lifecycle_status: "completed" }),
      order({ fulfillment_status: "fulfilled" }),
    ]) {
      await withDb({ tables: { orders: [row] } }, async () => {
        await expect(
          createDelivery(makeCtx(allPermissions), { orderId: ORDER_A, providerName: "Manual" }),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
    }
  });

  it("prevents a duplicate active Delivery", async () => {
    const { createDelivery } = await import("../server/deliveries/service");
    const calls = await withDb(
      { tables: { orders: [order()], locations: [location], deliveries: [delivery()] } },
      async (recorded) => {
        await expect(
          createDelivery(makeCtx(allPermissions), { orderId: ORDER_A, providerName: "Manual" }),
        ).rejects.toMatchObject({ statusCode: 409 });
        return recorded;
      },
    );
    expect(calls).toHaveLength(0);
    expect(migration()).toMatch(/CREATE UNIQUE INDEX uniq_deliveries_active_order/);
  });

  it("rejects cross-org location and provider references as not found", async () => {
    const { createDelivery } = await import("../server/deliveries/service");
    await withDb({ tables: { orders: [order()], locations: [noRow] } }, async () => {
      await expect(
        createDelivery(makeCtx(allPermissions), {
          orderId: ORDER_A,
          locationId: LOCATION_A,
          providerName: "Manual",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
    await withDb(
      { tables: { orders: [order()], locations: [location], delivery_providers: [noRow] } },
      async () => {
        await expect(
          createDelivery(makeCtx(allPermissions), {
            orderId: ORDER_A,
            providerId: PROVIDER_A,
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      },
    );
  });

  it("rejects invalid COD reference amounts and never changes payment status", async () => {
    const { createDelivery } = await import("../server/deliveries/service");
    await withDb({ tables: { orders: [order()], locations: [location] } }, async () => {
      await expect(
        createDelivery(makeCtx(allPermissions), {
          orderId: ORDER_A,
          providerName: "Manual",
          codAmountMinor: 1.5,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
    expect(executableSql(migration())).not.toMatch(/UPDATE public\.orders SET payment_status/);
  });
});

describe("Transitions and history", () => {
  const cases = [
    ["pending", "startPreparingDelivery", "preparing"],
    ["preparing", "markDeliveryReady", "ready"],
    ["ready", "markDeliveryInTransit", "in_transit"],
    ["in_transit", "markDeliveryDelivered", "delivered"],
  ] as const;

  for (const [from, functionName, to] of cases) {
    it(`${from} -> ${to} uses optimistic concurrency`, async () => {
      const service = await import("../server/deliveries/service");
      const calls = await withDb(
        {
          tables: {
            deliveries: [delivery({ status: from }), delivery({ status: to })],
            delivery_status_history: [history(from, to)],
          },
          rpc: {
            transition_delivery_status_v1: {
              data: { status: "success", from, to },
              error: null,
            },
          },
        },
        async (recorded) => {
          await service[functionName](makeCtx(allPermissions), DELIVERY_A);
          return recorded;
        },
      );
      expect(calls[0]?.args["p_expected_from"]).toBe(from);
      expect(calls[0]?.args["p_to"]).toBe(to);
    });
  }

  it("supports failed and cancelled terminal paths with reasons", async () => {
    const { cancelDelivery, markDeliveryFailed } = await import("../server/deliveries/service");
    for (const [from, to, call] of [
      ["pending", "cancelled", cancelDelivery],
      ["in_transit", "failed", markDeliveryFailed],
    ] as const) {
      await withDb(
        {
          tables: {
            deliveries: [delivery({ status: from }), delivery({ status: to })],
            delivery_status_history: [history(from, to)],
          },
          rpc: { transition_delivery_status_v1: { data: { status: "success" }, error: null } },
        },
        async (calls) => {
          await call(makeCtx(allPermissions), DELIVERY_A, "operational reason");
          expect(calls[0]?.args["p_reason"]).toBe("operational reason");
        },
      );
    }
  });

  it("rejects invalid edges and all transitions from terminal states", async () => {
    const { markDeliveryDelivered, startPreparingDelivery } =
      await import("../server/deliveries/service");
    await withDb({ tables: { deliveries: [delivery()] } }, async () => {
      await expect(
        markDeliveryDelivered(makeCtx(allPermissions), DELIVERY_A),
      ).rejects.toMatchObject({
        statusCode: 409,
      });
    });
    for (const terminal of ["delivered", "failed", "cancelled"] as const) {
      await withDb({ tables: { deliveries: [delivery({ status: terminal })] } }, async () => {
        await expect(
          startPreparingDelivery(makeCtx(allPermissions), DELIVERY_A),
        ).rejects.toMatchObject({ statusCode: 409 });
      });
    }
  });

  it("requires a reason for failure and cancellation", async () => {
    const { cancelDelivery, markDeliveryFailed } = await import("../server/deliveries/service");
    expect(() => cancelDelivery(makeCtx(allPermissions), DELIVERY_A, " ")).toThrow(
      "A cancellation reason is required",
    );
    expect(() => markDeliveryFailed(makeCtx(allPermissions), DELIVERY_A, "")).toThrow(
      "A failure reason is required",
    );
  });

  it("history is append-only and every accepted transition appends exactly once", () => {
    const sql = executableSql(migration());
    expect(sql).toMatch(/INSERT INTO public\.delivery_status_history[\s\S]+UPDATE public\.orders/);
    expect(sql).not.toMatch(/UPDATE public\.delivery_status_history/);
    expect(sql).not.toMatch(/DELETE FROM public\.delivery_status_history/);
  });
});

describe("Order fulfillment atomicity", () => {
  it("maps creation/processing, delivery, failure and cancellation inside the RPC", () => {
    const sql = executableSql(migration());
    expect(sql).toMatch(/p_to IN \('preparing', 'ready', 'in_transit'\) THEN 'processing'/);
    expect(sql).toMatch(/p_to = 'delivered' THEN 'fulfilled'/);
    expect(sql).toMatch(/p_to = 'cancelled' THEN 'cancelled'/);
    expect(sql).toMatch(/p_to = 'failed' THEN 'unfulfilled'/);
    expect(sql).toMatch(/UPDATE public\.orders SET fulfillment_status = v_order_fulfillment/);
    expect(sql).toMatch(/INSERT INTO public\.order_status_history/);
  });

  it("has no application-level dual writes", () => {
    const repository = source("src/server/deliveries/repository.ts");
    expect(repository).not.toMatch(/\.insert\(/);
    expect(repository).not.toMatch(/\.update\(/);
    expect(repository).toContain('db.rpc("create_delivery_v1"');
    expect(repository).toContain('db.rpc("transition_delivery_status_v1"');
  });

  it("a simulated mid-transition failure rolls back Delivery and Order together", async () => {
    const { markDeliveryDelivered } = await import("../server/deliveries/service");
    const state = { delivery: "in_transit", fulfillment: "processing", history: 4 };
    await withDb(
      {
        tables: { deliveries: [delivery({ status: "in_transit" })] },
        rpcHandler: async () => {
          const before = { ...state };
          try {
            state.delivery = "delivered";
            state.history += 1;
            throw new Error("simulated Order write failure");
          } catch {
            Object.assign(state, before);
            return { data: null, error: { message: "transaction rolled back" } };
          }
        },
      },
      async () => {
        await expect(markDeliveryDelivered(makeCtx(allPermissions), DELIVERY_A)).rejects.toThrow(
          "transaction rolled back",
        );
      },
    );
    expect(state).toEqual({ delivery: "in_transit", fulfillment: "processing", history: 4 });
  });
});

describe("Golden merchant fulfillment flow", () => {
  it("confirmed Order -> create -> process -> transit -> delivered ends fulfilled", async () => {
    const { DELIVERY_TO_ORDER_FULFILLMENT, isValidDeliveryTransition } =
      await import("../server/deliveries/state-machine");
    let deliveryStatus: DeliveryStatus = "pending";
    let orderFulfillment = DELIVERY_TO_ORDER_FULFILLMENT[deliveryStatus];
    expect(orderFulfillment).toBe("processing");

    for (const next of ["preparing", "ready", "in_transit", "delivered"] as const) {
      expect(isValidDeliveryTransition(deliveryStatus, next)).toBe(true);
      deliveryStatus = next;
      orderFulfillment = DELIVERY_TO_ORDER_FULFILLMENT[deliveryStatus];
    }
    expect(deliveryStatus).toBe("delivered");
    expect(orderFulfillment).toBe("fulfilled");
  });

  it("pre-transit cancellation ends both Delivery and Order fulfillment cancelled", async () => {
    const { DELIVERY_TO_ORDER_FULFILLMENT, isValidDeliveryTransition } =
      await import("../server/deliveries/state-machine");
    for (const from of ["pending", "preparing", "ready"] as const) {
      expect(isValidDeliveryTransition(from, "cancelled")).toBe(true);
      expect(DELIVERY_TO_ORDER_FULFILLMENT.cancelled).toBe("cancelled");
    }
  });
});

describe("Authorization, tenant isolation and concurrency", () => {
  it("enforces read/create/update permissions server-side", async () => {
    const { createDelivery, getDeliveryById, startPreparingDelivery } =
      await import("../server/deliveries/service");
    await expect(
      withDb({}, () => createDelivery(makeCtx([]), { orderId: ORDER_A, providerName: "Manual" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(withDb({}, () => getDeliveryById(makeCtx([]), DELIVERY_A))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      withDb({}, () => startPreparingDelivery(makeCtx([]), DELIVERY_A)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Org A cannot read or transition an Org B Delivery through a guessed UUID", async () => {
    const { getDeliveryById, startPreparingDelivery } =
      await import("../server/deliveries/service");
    await withDb({ tables: { deliveries: [noRow] } }, async (calls) => {
      await expect(getDeliveryById(makeCtx(allPermissions), DELIVERY_A)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(calls).toHaveLength(0);
    });
    await withDb({ tables: { deliveries: [noRow] } }, async (calls) => {
      await expect(
        startPreparingDelivery(makeCtx(allPermissions), DELIVERY_A),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(calls).toHaveLength(0);
    });
  });

  it("a stale/concurrent transition is rejected without a read-back", async () => {
    const { startPreparingDelivery } = await import("../server/deliveries/service");
    await withDb(
      {
        tables: { deliveries: [delivery()] },
        rpc: {
          transition_delivery_status_v1: {
            data: { status: "stale", current: "cancelled" },
            error: null,
          },
        },
      },
      async () => {
        await expect(
          startPreparingDelivery(makeCtx(allPermissions), DELIVERY_A),
        ).rejects.toMatchObject({ statusCode: 409 });
      },
    );
    expect(migration()).toMatch(/FOR UPDATE/);
    expect(migration()).toMatch(/v_current <> p_expected_from/);
  });

  it("replayed calls cannot duplicate history", () => {
    const sql = executableSql(migration());
    const stale = sql.indexOf("v_current <> p_expected_from");
    const append = sql.lastIndexOf("INSERT INTO public.delivery_status_history");
    expect(stale).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(stale);
    expect(sql.slice(stale, append)).toContain("RETURN jsonb_build_object('status', 'stale'");
  });
});

describe("RLS, RPC and browser boundary", () => {
  for (const table of ["delivery_providers", "deliveries", "delivery_status_history"]) {
    it(`${table} blocks direct JWT reads and writes`, () => {
      const sql = migration();
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(
        new RegExp(
          `REVOKE SELECT, INSERT, UPDATE, DELETE ON public\\.${table} FROM anon, authenticated`,
        ),
      );
    });
  }

  for (const fn of ["create_delivery_v1", "transition_delivery_status_v1"]) {
    it(`${fn} is executable only by service_role`, () => {
      const sql = migration();
      expect(sql).toMatch(
        new RegExp(
          `REVOKE EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]+FROM PUBLIC, anon, authenticated`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]+TO service_role`),
      );
    });
  }

  it("uses existing canonical permission names and safe built-in assignments", () => {
    const sql = migration();
    expect(executableSql(sql)).not.toMatch(/INSERT INTO public\.permissions/);
    for (const permission of ["delivery.read", "delivery.create", "delivery.update"]) {
      expect(sql).toContain(`'${permission}'`);
      expect(source("supabase/migrations/010_permission_vocabulary.sql")).toContain(
        `'${permission}'`,
      );
    }
    expect(sql).toContain("r.system_role IN ('OWNER', 'MANAGER')");
  });

  it("never accepts client organization_id or user_id authority", () => {
    const api = source("src/api/deliveries.ts");
    const service = source("src/server/deliveries/service.ts");
    expect(api).not.toMatch(/organizationId:\s*z\./);
    expect(api).not.toMatch(/userId:\s*z\./);
    expect(service).toContain("ctx.organizationId");
    expect(service).toContain("ctx.userId");
  });

  it("keeps server-only modules behind dynamic API-handler imports", () => {
    const api = source("src/api/deliveries.ts");
    expect(api).not.toMatch(/^import .*@\/lib\/supabase\/server/m);
    expect(api).not.toMatch(/^import .*@\/server\/deliveries\/service/m);
    expect(api).toContain('await import("@/lib/supabase/server")');
    expect(api).toContain('await import("@/server/deliveries/service")');
  });

  it("offers narrow transition handlers and no generic PATCH/status setter", () => {
    const api = source("src/api/deliveries.ts");
    for (const fn of [
      "startPreparingDeliveryFn",
      "markDeliveryReadyFn",
      "markDeliveryInTransitFn",
      "markDeliveryDeliveredFn",
      "markDeliveryFailedFn",
      "cancelDeliveryFn",
    ]) {
      expect(api).toContain(fn);
    }
    expect(api).not.toMatch(/patchDeliveryFn|updateDeliveryFn|setDeliveryStatusFn/);
  });

  it("database triggers independently enforce cross-org order/location/provider/history", () => {
    const sql = migration();
    for (const guard of [
      "cross_tenant_order",
      "cross_tenant_location",
      "cross_tenant_provider",
      "cross_tenant_delivery",
    ]) {
      expect(sql).toContain(guard);
    }
  });
});

describe("Migration and UI regression guards", () => {
  it("is forward-only and does not alter merged Order/Inventory migrations", () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/DROP TABLE|DROP TYPE|TRUNCATE/i);
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "supabase/migrations/026_order_inventory_integration.sql"),
      ),
    ).toBe(true);
  });

  it("does not replace mock Delivery UI or modify Order UI boundaries", () => {
    expect(source("src/routes/app.deliveries.$id.tsx")).toContain("@/lib/api");
    expect(source("src/lib/api/index.ts")).toContain("@/lib/mock/fulfillment");
    expect(source("src/routes/app.orders.$id.tsx")).not.toContain("@/server/deliveries");
    expect(source("src/components/orders/OrderActionSheets.tsx")).not.toContain(
      "@/server/deliveries",
    );
  });
});
