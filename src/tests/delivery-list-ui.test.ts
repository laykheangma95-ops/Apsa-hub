/**
 * Deliveries List UI — pure-function and structural tests.
 *
 * Pure logic (client-side search matching, server->UI mapping) is unit-tested
 * directly. What remains — which server function the list route calls,
 * whether it ever falls back to mock data, tap-through wiring to the existing
 * (unmodified) Delivery Detail screen — is proven by reading the actual
 * source text, the same approach as delivery-ui-integration.test.ts.
 *
 * Bundle-boundary (routes never statically import server-only modules) is
 * already covered generically for every file under src/routes by
 * src/tests/bundle-boundary.test.ts — the new route file is covered there
 * without any change to that test.
 *
 * Run: bun test src/tests/delivery-list-ui.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { filterDeliveryListBySearch, mapDeliveryListItemToUi } from "@/lib/deliveries";
import type { DeliveryListItem } from "@/server/deliveries/service";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8").replace(/\r\n/g, "\n");
}

const API_INDEX = "src/lib/api/index.ts";
const LIST_ROUTE = "src/routes/app.deliveries.tsx";
const DETAIL_ROUTE = "src/routes/app.deliveries.$id.tsx";
const DELIVERIES_API = "src/api/deliveries.ts";
const SERVICE = "src/server/deliveries/service.ts";
const NAV_CONFIG = "src/design-system/mobile-nav-config.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// mapDeliveryListItemToUi — pure mapping
// ═══════════════════════════════════════════════════════════════════════════════

const SERVER_ITEM: DeliveryListItem = {
  id: "11111111-0000-0000-0000-000000000001",
  organizationId: "aaaaaaaa-0000-0000-0000-000000000001",
  orderId: "22222222-0000-0000-0000-000000000001",
  locationId: null,
  providerId: null,
  providerKey: null,
  providerName: "J&T Express",
  externalTrackingNumber: "TRK-1",
  codAmount: { amount: 1000, currency: "USD" },
  status: "in_transit",
  createdBy: "user-1",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  orderCode: "ORD-0042",
  customerName: "Sok Dara",
  hasCustomer: true,
  actionNeeded: false,
};

describe("mapDeliveryListItemToUi", () => {
  it("carries every list-specific field through unchanged — the server is authoritative", () => {
    const ui = mapDeliveryListItemToUi(SERVER_ITEM);
    expect(ui.orderCode).toBe("ORD-0042");
    expect(ui.customerName).toBe("Sok Dara");
    expect(ui.hasCustomer).toBe(true);
    expect(ui.actionNeeded).toBe(false);
    expect(ui.status).toBe("in_transit");
    expect(ui.codAmount).toEqual({ amount: 1000, currency: "USD" });
  });

  it("never fabricates a payment field from codAmount", () => {
    const ui = mapDeliveryListItemToUi(SERVER_ITEM);
    expect(Object.keys(ui)).not.toContain("paymentStatus");
    expect(Object.keys(ui)).not.toContain("paid");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// filterDeliveryListBySearch — pure client-side narrowing
// ═══════════════════════════════════════════════════════════════════════════════

function item(overrides: Partial<ReturnType<typeof mapDeliveryListItemToUi>>) {
  return {
    ...mapDeliveryListItemToUi(SERVER_ITEM),
    id: overrides.id ?? SERVER_ITEM.id,
    ...overrides,
  };
}

describe("filterDeliveryListBySearch", () => {
  const rows = [
    item({ id: "1", orderCode: "ORD-0001", providerName: "J&T Express", customerName: "Sok Dara" }),
    item({
      id: "2",
      orderCode: "ORD-0002",
      providerName: "Capital Delivery",
      customerName: "Chan Vibol",
    }),
    item({
      id: "3",
      orderCode: "ORD-0003",
      providerName: "VET Express",
      customerName: null,
      hasCustomer: false,
      externalTrackingNumber: "SPECIAL-TRACK-9",
    }),
  ];

  it("returns everything unchanged for an empty/whitespace query", () => {
    expect(filterDeliveryListBySearch(rows, "")).toHaveLength(3);
    expect(filterDeliveryListBySearch(rows, "   ")).toHaveLength(3);
  });

  it("matches order code case-insensitively", () => {
    expect(filterDeliveryListBySearch(rows, "ord-0002").map((r) => r.id)).toEqual(["2"]);
  });

  it("matches courier/provider name", () => {
    expect(filterDeliveryListBySearch(rows, "capital").map((r) => r.id)).toEqual(["2"]);
  });

  it("matches customer name only when present, never guesses for a redacted/absent one", () => {
    expect(filterDeliveryListBySearch(rows, "vibol").map((r) => r.id)).toEqual(["2"]);
    expect(filterDeliveryListBySearch(rows, "dara").map((r) => r.id)).toEqual(["1"]);
  });

  it("matches the tracking number", () => {
    expect(filterDeliveryListBySearch(rows, "special-track").map((r) => r.id)).toEqual(["3"]);
  });

  it("returns nothing for a query matching no field", () => {
    expect(filterDeliveryListBySearch(rows, "no such thing")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Structural — production API usage, no mock fallback, tap-through, boundaries
// ═══════════════════════════════════════════════════════════════════════════════

describe("Deliveries list uses the production Delivery API, never mock data", () => {
  it("listRealDeliveries calls listDeliveriesForMerchantFn with no demo-mode/mock fallback", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function listRealDeliveries"),
      apiIndex.indexOf("export async function listRealDeliveries") + 1200,
    );
    expect(fn).toMatch(/listDeliveriesForMerchantFn/);
    expect(fn).not.toMatch(/try\s*{/);
    expect(fn).not.toMatch(/catch/);
    expect(fn).not.toMatch(/isDemoModeError/);
  });

  it("the list route calls listRealDeliveries, never imports src/server/** or src/lib/mock/** directly", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toContain("listRealDeliveries");
    expect(route).not.toMatch(/from ["']@\/server\//);
    expect(route).not.toMatch(/from ["']@\/lib\/mock\//);
  });

  it("no client-supplied organizationId/userId reaches listDeliveriesForMerchantFn — the server derives both from session", () => {
    const api = readSource(DELIVERIES_API);
    const fn = api.slice(
      api.indexOf("export const listDeliveriesForMerchantFn"),
      api.indexOf("export const listDeliveriesForMerchantFn") + 1200,
    );
    expect(fn).toContain("resolveAuthContext");
    expect(fn).not.toMatch(/organizationId:\s*data/);
    expect(fn).not.toMatch(/userId:\s*data/);
  });
});

describe("Deliveries list taps through to the existing Delivery Detail screen — no duplication", () => {
  it("the row links to /app/deliveries/$id, the same route delivery-domain already owns", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toMatch(/to="\/app\/deliveries\/\$id"/);
    expect(route).toMatch(/params=\{\{\s*id:\s*item\.id\s*\}\}/);
  });

  it("no second Delivery Detail implementation was added — the detail route file is untouched in structure", () => {
    const detail = readSource(DETAIL_ROUTE);
    expect(detail).toContain("RealDeliveryDetailScreen");
    expect(detail).toContain("MockDeliveryDetailScreen");
    // Only one file defines these — the list route must not re-declare them.
    const list = readSource(LIST_ROUTE);
    expect(list).not.toContain("function RealDeliveryDetailScreen");
    expect(list).not.toContain("function MockDeliveryDetailScreen");
  });

  it("the list route renders <Outlet /> so the nested $id route can render, mirroring app.orders.tsx", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toMatch(/<Outlet\s*\/>/);
  });
});

describe("Deliveries list is reachable from the app shell", () => {
  it("the sales-manage nav action points at /app/deliveries and is marked live", () => {
    const config = readSource(NAV_CONFIG);
    const block = config.slice(
      config.indexOf('id: "delivery",'),
      config.indexOf('id: "delivery",') + 300,
    );
    expect(block).toContain('to: "/app/deliveries"');
    expect(block).toContain('availability: "live"');
  });
});

describe("No new Delivery domain, no new migration", () => {
  it("listDeliveriesForMerchant is implemented in the existing service.ts, reusing repo.listDeliveries as its base read", () => {
    const service = readSource(SERVICE);
    const fn = service.slice(service.indexOf("export async function listDeliveriesForMerchant"));
    expect(fn).toContain("repo.listDeliveries(ctx.organizationId");
    expect(fn).toContain('ctx.require("delivery.read")');
  });

  it("no new supabase migration file was added for this feature", () => {
    const files = fs.readdirSync(path.resolve(ROOT, "supabase/migrations"));
    const newest = files.filter((f) => /^0[3-9][0-9]_/.test(f) || /^0[4-9][0-9]_/.test(f)).sort();
    // The Deliveries list ships with no schema change; the highest existing
    // migration at the time this phase was built is 042 (Team/Staff, PR #39).
    for (const f of newest) {
      expect(Number(f.slice(0, 3))).toBeLessThanOrEqual(42);
    }
  });
});
