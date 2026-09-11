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
import { mapDeliveryListItemToUi, mapDeliveryListPageToUi } from "@/lib/deliveries";
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
// mapDeliveryListPageToUi — the page contract the screen paginates over
// ═══════════════════════════════════════════════════════════════════════════════

describe("mapDeliveryListPageToUi", () => {
  it("carries items, hasMore and truncated through — the server owns all three", () => {
    const page = mapDeliveryListPageToUi({
      items: [SERVER_ITEM],
      hasMore: true,
      truncated: false,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.orderCode).toBe("ORD-0042");
    expect(page.hasMore).toBe(true);
    expect(page.truncated).toBe(false);
  });

  it("preserves a truncated page rather than presenting it as complete", () => {
    const page = mapDeliveryListPageToUi({ items: [], hasMore: false, truncated: true });
    expect(page.truncated).toBe(true);
    expect(page.items).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Search is server-side — the screen must not narrow the rows it happens to hold
// ═══════════════════════════════════════════════════════════════════════════════

describe("Deliveries list search runs against complete server-side truth", () => {
  it("no client-side search filter survives in the list route or the client lib", () => {
    const route = readSource(LIST_ROUTE);
    const lib = readSource("src/lib/deliveries.ts");
    // Narrowing in memory would report "no matches" for a delivery one page
    // down; the term must reach the server instead.
    expect(route).not.toContain("filterDeliveryListBySearch");
    expect(lib).not.toContain("filterDeliveryListBySearch");
  });

  it("the route debounces the search term and sends it to listRealDeliveries", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toContain("debouncedSearch");
    expect(route).toMatch(/search:\s*debouncedSearch/);
    expect(route).toContain("SEARCH_DEBOUNCE_MS");
  });

  it("the search term is part of the query key, so a new term refetches rather than reusing a page", () => {
    const route = readSource(LIST_ROUTE);
    const key = route.slice(route.indexOf("queryKey: ["), route.indexOf("queryKey: [") + 220);
    expect(key).toContain("debouncedSearch");
  });

  it("listRealDeliveries forwards search, limit and offset to the server function", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function listRealDeliveries("),
      apiIndex.indexOf("export async function listRealDeliveries(") + 1200,
    );
    expect(fn).toMatch(/search:\s*options\.search/);
    expect(fn).toMatch(/limit:\s*options\.limit/);
    expect(fn).toMatch(/offset:\s*options\.offset/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pagination and truncation are surfaced, not swallowed
// ═══════════════════════════════════════════════════════════════════════════════

describe("Deliveries list paginates and admits partial results", () => {
  it("uses an infinite query driven by the server's hasMore, not a single capped read", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toContain("useInfiniteQuery");
    expect(route).toMatch(/getNextPageParam/);
    expect(route).toContain("lastPage.hasMore");
  });

  it("renders a load-more control so additional current deliveries are reachable", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toContain("hasNextPage");
    expect(route).toContain("fetchNextPage");
    expect(route).toContain("deliveryList.loadMore");
  });

  it("shows an explicit partial-history notice when the server reports truncation", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toContain("truncated");
    expect(route).toContain("deliveryList.partial");
  });

  it("only claims emptiness when the result is complete — a truncated scan never renders the empty state", () => {
    const route = readSource(LIST_ROUTE);
    expect(route).toMatch(/const showEmpty =[\s\S]{0,160}!truncated/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Structural — production API usage, no mock fallback, tap-through, boundaries
// ═══════════════════════════════════════════════════════════════════════════════

describe("Deliveries list uses the production Delivery API, never mock data", () => {
  it("listRealDeliveries calls listDeliveriesForMerchantFn with no demo-mode/mock fallback", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function listRealDeliveries("),
      apiIndex.indexOf("export async function listRealDeliveries(") + 1200,
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
  it("listDeliveriesForMerchant is implemented in the existing service.ts, scanning via the repository rather than a new domain", () => {
    const service = readSource(SERVICE);
    const fn = service.slice(service.indexOf("export async function listDeliveriesForMerchant"));
    expect(fn).toContain("repo.scanDeliveries(ctx.organizationId");
    expect(fn).toContain('ctx.require("delivery.read")');
  });

  it("the Deliveries list is implemented without touching the schema", () => {
    // Deliberately not asserted by comparing migration numbers: a repo-wide
    // "nothing newer than 042" check fails on the next unrelated migration and
    // sends whoever triages it into this file for no reason. Whether *this*
    // branch changed a migration is a diff question, and
    // scripts/check-migration-safety.ts --base=origin/main already answers it.
    const service = readSource(SERVICE);
    const fn = service.slice(service.indexOf("export async function listDeliveriesForMerchant"));
    expect(fn).not.toMatch(/\.rpc\(/);
    expect(readSource("src/server/deliveries/repository.ts")).not.toMatch(
      /rpc\("list_latest_deliveries/,
    );
  });
});
