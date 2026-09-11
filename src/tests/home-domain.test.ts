import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import * as fs from "fs";
import * as path from "path";
import { ForbiddenError, type AuthorizationContext } from "../server/auth/authorization";
import { homeQueryKey } from "../lib/home-query";
import {
  collectCompletePages,
  countOutOfStockVariants,
  sumSettlementsByCurrency,
} from "../server/home/repository";
import { getHomeSummary, rangeBounds, type HomeDependencies } from "../server/home/service";
import type { HomeActiveVariantRow, HomeSettlementRow, HomeStockRow } from "../server/home/types";
import { paymentRowNeedsReview } from "../server/payments/reconciliation";
import type { PaymentReconciliationRow } from "../server/payments/types";

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_A = "11111111-0000-0000-0000-000000000001";
const USER_B = "22222222-0000-0000-0000-000000000002";

function source(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
}

function makeCtx(permissions: string[], organizationId = ORG_A, userId = USER_A) {
  const granted = new Set(permissions);
  return {
    userId,
    organizationId,
    roleId: "custom-role",
    systemRole: null,
    permissions: granted,
    can: (permission: string) => granted.has(permission),
    require: (permission: string) => {
      if (!granted.has(permission)) throw new ForbiddenError(`Missing permission: ${permission}`);
    },
    isOwner: () => false,
    requireOwner: () => {
      throw new ForbiddenError("Owner access required");
    },
  } as unknown as AuthorizationContext;
}

function dependencies(overrides: Partial<HomeDependencies> = {}): HomeDependencies {
  return {
    getOrderSummary: async () => ({
      periodCount: 3,
      awaitingPaymentCount: 2,
      actionNeededCount: 1,
    }),
    getPaymentAttention: async () => 4,
    getNetCollected: async () => [{ currency: "USD", amount: 8000 }],
    getOutOfStockCount: async () => 5,
    getDeliveryAttention: async () => ({ count: 6, complete: true }),
    ...overrides,
  };
}

function reconciliationRow(overrides: Partial<PaymentReconciliationRow>): PaymentReconciliationRow {
  return {
    organization_id: ORG_A,
    method: "khqr",
    currency: "USD",
    status: "pending",
    verification_state: "unverified",
    payment_count: 1,
    amount_minor_total: 100,
    ...overrides,
  };
}

describe("Home admission and section permissions", () => {
  it("admits staff with orders.read and does not require organization administration", async () => {
    const summary = await getHomeSummary(makeCtx(["orders.read"]), "today", dependencies());
    expect(summary.orders).toEqual({
      status: "available",
      data: { periodCount: 3, awaitingPaymentCount: 2, actionNeededCount: 1 },
    });
    expect(summary.payments).toEqual({ status: "permission_denied" });
    expect(summary.inventory).toEqual({ status: "permission_denied" });
    expect(summary.delivery).toEqual({ status: "permission_denied" });
    expect(summary.finance).toEqual({ status: "permission_denied" });
  });

  it("loads each permitted domain independently and never turns denial into zero", async () => {
    const summary = await getHomeSummary(
      makeCtx(["payments.read", "inventory.read", "delivery.read"]),
      "week",
      dependencies(),
    );
    expect(summary.orders).toEqual({ status: "permission_denied" });
    expect(summary.payments).toEqual({
      status: "available",
      data: { needsReviewCount: 4 },
    });
    expect(summary.inventory).toEqual({
      status: "available",
      data: { outOfStockVariantCount: 5 },
    });
    expect(summary.delivery).toEqual({ status: "available", data: { actionCount: 6 } });
    expect(summary.finance).toEqual({ status: "permission_denied" });
  });

  it("requires both orders.read and payments.reconcile for the order-cohort financial total", async () => {
    const withoutOrders = await getHomeSummary(
      makeCtx(["payments.read", "payments.reconcile"]),
      "month",
      dependencies(),
    );
    expect(withoutOrders.finance.status).toBe("permission_denied");

    const withBoth = await getHomeSummary(
      makeCtx(["orders.read", "payments.reconcile"]),
      "month",
      dependencies(),
    );
    expect(withBoth.finance).toEqual({
      status: "available",
      data: { netCollectedForCreatedOrders: [{ currency: "USD", amount: 8000 }] },
    });
  });

  it("rejects an active member with no relevant operational read permission", async () => {
    await expect(
      getHomeSummary(makeCtx(["team.read"]), "today", dependencies()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps a domain outage local and marks an incomplete Delivery count as truncated", async () => {
    const summary = await getHomeSummary(
      makeCtx(["orders.read", "payments.read", "inventory.read", "delivery.read"]),
      "today",
      dependencies({
        getPaymentAttention: async () => {
          throw new Error("payment backend unavailable");
        },
        getDeliveryAttention: async () => ({ count: 200, complete: false }),
      }),
    );
    expect(summary.orders.status).toBe("available");
    expect(summary.payments).toEqual({ status: "error" });
    expect(summary.inventory.status).toBe("available");
    expect(summary.delivery).toEqual({ status: "truncated" });
  });

  it("returns real zero values for a genuinely empty organization", async () => {
    const summary = await getHomeSummary(
      makeCtx(["orders.read", "payments.read", "inventory.read", "delivery.read"]),
      "today",
      dependencies({
        getOrderSummary: async () => ({
          periodCount: 0,
          awaitingPaymentCount: 0,
          actionNeededCount: 0,
        }),
        getPaymentAttention: async () => 0,
        getOutOfStockCount: async () => 0,
        getDeliveryAttention: async () => ({ count: 0, complete: true }),
      }),
    );
    expect(summary.orders.status === "available" && summary.orders.data.periodCount).toBe(0);
    expect(summary.payments.status === "available" && summary.payments.data.needsReviewCount).toBe(
      0,
    );
    expect(
      summary.inventory.status === "available" && summary.inventory.data.outOfStockVariantCount,
    ).toBe(0);
    expect(summary.delivery.status === "available" && summary.delivery.data.actionCount).toBe(0);
  });
});

describe("Home tenant and cache isolation", () => {
  it("passes only the authorization context's organization to every aggregate", async () => {
    const seen: string[] = [];
    const deps = dependencies({
      getOrderSummary: async (organizationId) => {
        seen.push(organizationId);
        return { periodCount: 0, awaitingPaymentCount: 0, actionNeededCount: 0 };
      },
      getNetCollected: async (organizationId) => {
        seen.push(organizationId);
        return [];
      },
      getOutOfStockCount: async (organizationId) => {
        seen.push(organizationId);
        return 0;
      },
      getPaymentAttention: async (ctx) => {
        seen.push(ctx.organizationId);
        return 0;
      },
      getDeliveryAttention: async (ctx) => {
        seen.push(ctx.organizationId);
        return { count: 0, complete: true };
      },
    });
    await getHomeSummary(
      makeCtx(
        ["orders.read", "payments.read", "payments.reconcile", "inventory.read", "delivery.read"],
        ORG_B,
      ),
      "today",
      deps,
    );
    expect(seen).toEqual([ORG_B, ORG_B, ORG_B, ORG_B, ORG_B]);
  });

  it("partitions cached Home data by user, organization, and range", () => {
    const client = new QueryClient();
    const orgAKey = homeQueryKey(USER_A, ORG_A, "today");
    client.setQueryData(orgAKey, { secret: "org-a-home" });

    expect(client.getQueryData(homeQueryKey(USER_B, ORG_B, "today"))).toBeUndefined();
    expect(client.getQueryData(homeQueryKey(USER_A, ORG_B, "today"))).toBeUndefined();
    expect(client.getQueryData(homeQueryKey(USER_A, ORG_A, "week"))).toBeUndefined();
    expect(client.getQueryData(orgAKey)).toEqual({ secret: "org-a-home" });
  });

  it("keeps client organization IDs out of the API and scopes every repository source", () => {
    const api = source("src/api/home.ts");
    const repository = source("src/server/home/repository.ts");
    expect(api).toContain('.eq("user_id", session.userId)');
    expect(api).toContain("AuthorizationService.forRequest");
    expect(api).not.toMatch(/z\.object\(\{[^}]*organizationId/s);
    expect(repository.match(/\.eq\("organization_id", organizationId\)/g)?.length).toBeGreaterThan(
      4,
    );
    expect(repository).not.toContain(ORG_B);
  });
});

describe("Home aggregate completeness and semantics", () => {
  it("walks more than 1000 rows even when the server caps each response below the request", async () => {
    const all = Array.from({ length: 1_205 }, (_, id) => id);
    const seenOffsets: number[] = [];
    const collected = await collectCompletePages(async (offset, requested) => {
      seenOffsets.push(offset);
      const serverCap = 137;
      return {
        rows: all.slice(offset, offset + Math.min(requested, serverCap)),
        total: all.length,
      };
    });
    expect(collected).toEqual(all);
    expect(seenOffsets.length).toBeGreaterThan(8);
  });

  it("fails closed if a counted row set changes or ends early", async () => {
    await expect(
      collectCompletePages(async (offset) => ({
        rows: offset === 0 ? [1] : [],
        total: 2,
      })),
    ).rejects.toThrow("ended before");

    await expect(
      collectCompletePages(async (offset) => ({
        rows: [offset],
        total: offset === 0 ? 2 : 3,
      })),
    ).rejects.toThrow("changed");
  });

  it("keeps currencies separate and reflects partial/full refunds, overpayment, and COD only through ledger net", () => {
    const rows: HomeSettlementRow[] = [
      { order_id: "partial", organization_id: ORG_A, currency: "USD", net_minor: 8000 },
      { order_id: "full", organization_id: ORG_A, currency: "USD", net_minor: 0 },
      { order_id: "overpaid", organization_id: ORG_A, currency: "USD", net_minor: 11000 },
      // COD is not inferred as paid; the authoritative Payment view supplies zero.
      { order_id: "cod", organization_id: ORG_A, currency: "KHR", net_minor: 0 },
      ...Array.from({ length: 1_201 }, (_, index) => ({
        order_id: `scaled-${index}`,
        organization_id: ORG_A,
        currency: "KHR" as const,
        net_minor: 100,
      })),
    ];
    expect(sumSettlementsByCurrency(rows)).toEqual([
      { currency: "KHR", amount: 120_100 },
      { currency: "USD", amount: 19_000 },
    ]);
  });

  it("counts current Payment review states, including failed mismatch and >1000 pending records", () => {
    const rows = [
      reconciliationRow({ payment_count: 1_001 }),
      reconciliationRow({
        status: "failed",
        verification_state: "mismatch",
        payment_count: 2,
      }),
      reconciliationRow({ verification_state: "duplicate_suspected", payment_count: 3 }),
      reconciliationRow({ status: "paid", verification_state: "bank_verified", payment_count: 7 }),
      reconciliationRow({ status: "reversed", verification_state: "mismatch", payment_count: 9 }),
      reconciliationRow({
        status: "refunded",
        verification_state: "duplicate_suspected",
        payment_count: 11,
      }),
    ];
    expect(
      rows.reduce((count, row) => count + (paymentRowNeedsReview(row) ? row.payment_count : 0), 0),
    ).toBe(1_006);
  });

  it("counts active variants at all-location grain and includes zero/no-movement variants beyond 1000 rows", () => {
    const variants: HomeActiveVariantRow[] = Array.from({ length: 1_205 }, (_, index) => ({
      id: `variant-${index}`,
      product_id: `product-${index}`,
    }));
    const stock: HomeStockRow[] = [
      // variant-0 has no movement and is therefore zero.
      {
        organization_id: ORG_A,
        product_id: "product-1",
        variant_id: "variant-1",
        location_id: "location-a",
        quantity_on_hand: -2,
      },
      {
        organization_id: ORG_A,
        product_id: "product-1",
        variant_id: "variant-1",
        location_id: "location-b",
        quantity_on_hand: 2,
      },
      ...variants.slice(2).map((variant, index) => ({
        organization_id: ORG_A,
        product_id: variant.product_id,
        variant_id: variant.id,
        location_id: `location-${index}`,
        quantity_on_hand: 1,
      })),
    ];
    expect(stock.length).toBeGreaterThan(1_000);
    expect(countOutOfStockVariants(variants, stock)).toBe(2);
  });

  it("uses exact DB counts for Orders and counted pagination for finance/inventory", () => {
    const repository = source("src/server/home/repository.ts");
    expect(repository).toContain('{ count: "exact", head: true }');
    expect(repository).toContain('select("id, created_at", { count: "exact" })');
    expect(repository).toContain("collectCompletePages<HomeActiveVariantRow>");
    expect(repository).toContain("collectCompletePages<HomeStockRow>");
    expect(repository).not.toMatch(/\.limit\(1000|\.limit\(10000/);
  });
});

describe("Phnom Penh calendar boundaries", () => {
  it("keeps Today at local midnight around 00:01 and 23:59", () => {
    const afterMidnight = rangeBounds("today", new Date("2026-09-10T17:01:00.000Z"));
    const beforeMidnight = rangeBounds("today", new Date("2026-09-11T16:59:00.000Z"));
    expect(afterMidnight).toEqual({
      from: "2026-09-10T17:00:00.000Z",
      until: "2026-09-11T17:00:00.000Z",
    });
    expect(beforeMidnight).toEqual(afterMidnight);
  });

  it("uses Monday-through-Sunday Cambodia weeks across a UTC date mismatch", () => {
    expect(rangeBounds("week", new Date("2026-09-13T17:01:00.000Z"))).toEqual({
      from: "2026-09-13T17:00:00.000Z",
      until: "2026-09-20T17:00:00.000Z",
    });
    expect(rangeBounds("week", new Date("2026-09-20T16:59:00.000Z"))).toEqual({
      from: "2026-09-13T17:00:00.000Z",
      until: "2026-09-20T17:00:00.000Z",
    });
  });

  it("uses first local calendar day through first day of next month at month-end", () => {
    expect(rangeBounds("month", new Date("2026-09-30T16:59:00.000Z"))).toEqual({
      from: "2026-08-31T17:00:00.000Z",
      until: "2026-09-30T17:00:00.000Z",
    });
    expect(rangeBounds("month", new Date("2026-09-30T17:01:00.000Z"))).toEqual({
      from: "2026-09-30T17:00:00.000Z",
      until: "2026-10-31T17:00:00.000Z",
    });
  });
});

describe("Home production truth boundaries", () => {
  it("never falls back to Home mocks on a production API failure", () => {
    const api = source("src/lib/api/index.ts");
    const homeFunction = api.slice(
      api.indexOf("export async function getHomeSummary"),
      api.indexOf("function mockGetConversations"),
    );
    expect(homeFunction).not.toContain("catch");
    expect(homeFunction).not.toContain("homeSummaries");
    expect(fs.existsSync(path.resolve(process.cwd(), "src/lib/mock/home.ts"))).toBe(false);
  });

  it("removes fabricated shop/workspace identity and fabricated Apsi insight from Home", () => {
    const route = source("src/routes/app.index.tsx");
    expect(route).toContain("homeQueryKey(session.userId, organizationId, range)");
    expect(route).not.toContain("getActiveShop");
    expect(route).not.toContain("WorkspaceSwitcherSheet");
    expect(route).not.toContain("ApsiInsightCard");
    expect(route).not.toContain("greetingName");
  });

  it("uses existing Payment semantics and merged Delivery latest-attempt logic", () => {
    const service = source("src/server/home/service.ts");
    const deliveries = source("src/server/deliveries/service.ts");
    expect(service).toContain("getPaymentAttentionCount");
    expect(service).toContain("getDeliveryAttentionCount");
    expect(deliveries).toContain("listDeliveriesForMerchant(ctx");
    expect(deliveries).toContain("if (page.truncated) return { count, complete: false }");
  });

  it("does not introduce a migration or broad organization.read admission", () => {
    const service = source("src/server/home/service.ts");
    expect(service).not.toContain("organization.read");
    expect(service).not.toMatch(/systemRole|isOwner\(|OWNER|MANAGER/);
  });
});
