/**
 * Real Order UI Integration — structural assertions.
 *
 * The pure logic behind this phase (mapping, lifecycle rules, error
 * classification) is unit-tested directly in src/tests/orders-ui.test.ts.
 * What remains — which server function a route/component calls, what a
 * payload object does and does not contain, whether a mutation refreshes the
 * cache on success — is proven here the same way src/tests/
 * order-inventory-integration.test.ts proves "no application code writes the
 * ledger": by reading the actual source text rather than rendering React
 * (this repo has no component-rendering test harness; see
 * src/tests/mobile-nav-config.test.ts and src/lib/order-draft.ts for the
 * established precedent of testing pure logic directly and everything else
 * structurally).
 *
 * Bundle-boundary (routes/api never statically import server-only modules)
 * is already covered generically for every file under src/routes and
 * src/api by src/tests/bundle-boundary.test.ts — it walks the directories,
 * so the new files in this phase are covered without any change there.
 *
 * Run: bun test src/tests/order-ui-integration.test.ts
 */
import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const API_INDEX = "src/lib/api/index.ts";
const ORDER_LIST_ROUTE = "src/routes/app.orders.tsx";
const ORDER_DETAIL_ROUTE = "src/routes/app.orders.$id.tsx";
const CREATE_SHEET = "src/components/orders/CreateRealOrderSheet.tsx";
const CANCEL_SHEET = "src/components/orders/CancelOrderSheet.tsx";
const ORDERS_LIB = "src/lib/orders.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ORDER LIST uses the production API, not mock data
// ═══════════════════════════════════════════════════════════════════════════════

describe("Order list uses the production API", () => {
  it("the list route calls listRealOrders, which calls listOrdersFn", () => {
    const route = readSource(ORDER_LIST_ROUTE);
    expect(route).toMatch(/listRealOrders/);
    expect(route).not.toMatch(/from ["']@\/lib\/mock\/orders["']/);

    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function listRealOrders"),
      apiIndex.indexOf("export async function getRealOrderDetail"),
    );
    expect(fn).toMatch(/await import\(["']@\/api\/orders["']\)/);
    expect(fn).toMatch(/listOrdersFn/);
    // No demo-mode mock fallback for the production list — unlike
    // getProducts()/getPosProducts() above it in the same file.
    expect(fn).not.toMatch(/isDemoModeError/);
    expect(fn).not.toMatch(/\.\.\.orders\]/);
  });

  it("the list route never reads mock organization/customer arrays directly", () => {
    const route = readSource(ORDER_LIST_ROUTE);
    expect(route).not.toMatch(/from ["']@\/lib\/mock\//);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ORDER DETAIL: production API for real UUIDs, mock path untouched
// ═══════════════════════════════════════════════════════════════════════════════

describe("Order detail branches on isProductionId — real orders never fall back to mock", () => {
  it("the route calls getRealOrderDetail for the production branch and getOrderDetail for the mock branch", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/isProductionId\(id\)\s*\?\s*<RealOrderDetailScreen/);
    expect(route).toMatch(/getRealOrderDetail\(id\)/);
    expect(route).toMatch(/getOrderDetail\(id\)/); // the untouched mock path
  });

  it("getRealOrderDetail has no try/catch demo-mode fallback — a real UUID lookup failure is never hidden behind mock data", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function getRealOrderDetail"),
      apiIndex.indexOf("export interface CreateRealOrderInput"),
    );
    expect(fn).toMatch(/getOrderByIdFn/);
    expect(fn).not.toMatch(/try\s*{/);
    expect(fn).not.toMatch(/catch/);
    expect(fn).not.toMatch(/isDemoModeError/);
  });

  it("the mock order detail screen (MockOrderDetailScreen) is unmodified in structure — still keyed off getOrderDetail/PERMISSION_DENIED", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    const mockScreen = route.slice(route.indexOf("function MockOrderDetailScreen"));
    expect(mockScreen).toMatch(/getOrderDetail\(id\)/);
    expect(mockScreen).toMatch(/PERMISSION_DENIED/);
    // The mock screen keeps its own payment/return/refund/delivery sheets —
    // those domains are explicitly out of scope for this phase.
    expect(mockScreen).toMatch(/RecordPaymentSheet/);
    expect(mockScreen).toMatch(/ReturnSheet/);
    expect(mockScreen).toMatch(/RefundSheet/);
    expect(mockScreen).toMatch(/ArrangeDeliverySheet/);
  });

  it("the real order screen does NOT render the payment/return/refund/delivery sheets (out of scope this phase)", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    const realScreen = route.slice(
      route.indexOf("function RealOrderDetailScreen"),
      route.indexOf("const EVENT_TONE"),
    );
    expect(realScreen).not.toMatch(
      /RecordPaymentSheet|ReturnSheet|RefundSheet|ArrangeDeliverySheet/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CREATE FLOW calls createOrderFn only, and never supplies price/total/org/user
// ═══════════════════════════════════════════════════════════════════════════════

describe("Create flow calls createOrderFn, never a client-computed price/total", () => {
  it("createRealOrder (lib/api) calls createOrderFn and nothing else server-side", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function createRealOrder"),
      apiIndex.indexOf("export async function confirmRealOrder"),
    );
    expect(fn).toMatch(/await import\(["']@\/api\/orders["']\)/);
    expect(fn).toMatch(/createOrderFn/);
    expect(fn).not.toMatch(/transitionOrderLifecycleFn|recordMovementFn/);
  });

  it("CreateRealOrderInput / the sheet's payload has no organizationId, userId, price, subtotal or total field", () => {
    const apiIndex = readSource(API_INDEX);
    const createInputBlock = apiIndex.slice(
      apiIndex.indexOf("export interface CreateRealOrderInput"),
      apiIndex.indexOf("export async function createRealOrder"),
    );
    for (const forbidden of [
      "organizationId",
      "organization_id",
      "userId",
      "user_id",
      "price:",
      "subtotal:",
      "total:",
    ]) {
      expect(createInputBlock).not.toContain(forbidden);
    }

    const sheet = readSource(CREATE_SHEET);
    const call = sheet.slice(
      sheet.indexOf("createRealOrder({"),
      sheet.indexOf("});", sheet.indexOf("createRealOrder({")),
    );
    for (const forbidden of [
      "organizationId",
      "organization_id",
      "userId",
      "user_id",
      "price",
      "total:",
    ]) {
      expect(call).not.toContain(forbidden);
    }
  });

  it("the sheet's on-screen subtotal/discount/total are a preview only — onCreated receives the server's own order", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/PREVIEW/); // documented in the file's own header comment
    expect(sheet).toMatch(/onCreated\(detail\.order\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4 & 5. CONFIRM / CANCEL call the lifecycle transition ONLY — never inventory
// ═══════════════════════════════════════════════════════════════════════════════

describe("Confirm and cancel call transitionOrderLifecycleFn only", () => {
  it("confirmRealOrder transitions lifecycle to 'confirmed' and touches nothing else", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function confirmRealOrder"),
      apiIndex.indexOf("export async function cancelRealOrder"),
    );
    expect(fn).toMatch(/transitionOrderLifecycleFn/);
    expect(fn).toMatch(/to:\s*"confirmed"/);
    expect(fn).not.toMatch(/recordMovementFn|inventory/i);
  });

  it("cancelRealOrder transitions lifecycle to 'cancelled' and touches nothing else", () => {
    const apiIndex = readSource(API_INDEX);
    const fn = apiIndex.slice(
      apiIndex.indexOf("export async function cancelRealOrder"),
      apiIndex.indexOf("export async function listRealCustomers"),
    );
    expect(fn).toMatch(/transitionOrderLifecycleFn/);
    expect(fn).toMatch(/to:\s*"cancelled"/);
    expect(fn).not.toMatch(/recordMovementFn|inventory/i);
  });

  it("neither function accepts or sends a quantity — stock movement is the server's own consequence", () => {
    const apiIndex = readSource(API_INDEX);
    const confirmFn = apiIndex.slice(
      apiIndex.indexOf("export async function confirmRealOrder"),
      apiIndex.indexOf("export async function cancelRealOrder"),
    );
    const cancelFn = apiIndex.slice(
      apiIndex.indexOf("export async function cancelRealOrder"),
      apiIndex.indexOf("export async function listRealCustomers"),
    );
    for (const fn of [confirmFn, cancelFn]) {
      expect(fn).not.toMatch(/quantity/i);
    }
  });

  it("the UI never imports src/api/inventory or src/server/inventory anywhere in this phase's new files", () => {
    for (const file of [
      API_INDEX,
      ORDER_LIST_ROUTE,
      ORDER_DETAIL_ROUTE,
      CREATE_SHEET,
      CANCEL_SHEET,
      ORDERS_LIB,
    ]) {
      const src = readSource(file);
      expect(src).not.toMatch(/@\/api\/inventory/);
      expect(src).not.toMatch(/@\/server\/inventory/);
      expect(src).not.toMatch(/recordMovementFn/);
    }
  });

  it("the Golden Merchant Flow's two buttons are gated by canConfirmOrder/canCancelOrder from src/lib/orders.ts", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/canConfirmOrder\(order\.lifecycleStatus\)/);
    expect(route).toMatch(/canCancelOrder\(order\.lifecycleStatus\)/);
    expect(route).toMatch(/confirmMutation\.mutate\(\)/);
    expect(route).toMatch(/cancelMutation\.mutate\(reason\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ERROR STATES — unauthorized / forbidden / not found / invalid / stale / server
// ═══════════════════════════════════════════════════════════════════════════════

describe("Error states are classified and mapped to translated copy, never raw error text", () => {
  it("the real detail screen redirects to /sign-in on 'unauthorized' rather than rendering inline copy", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    expect(route).toMatch(/classifyOrderError\(query\.error\) === "unauthorized"/);
    expect(route).toMatch(/navigate\(\{ to: "\/sign-in" \}\)/);
  });

  it("forbidden / not_found / stale / invalid each resolve to a distinct translated title+body pair", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    const copyFn = route.slice(
      route.indexOf("function useOrderErrorCopy"),
      route.indexOf("function RealOrderDetailScreen"),
    );
    expect(copyFn).toMatch(/case "forbidden":/);
    expect(copyFn).toMatch(/case "not_found":/);
    expect(copyFn).toMatch(/case "stale":/);
    expect(copyFn).toMatch(/case "invalid":/);
    // Never interpolates the raw Error object/message into the shown copy.
    expect(copyFn).not.toMatch(/err\.message|error\.message/);
  });

  it("a stale mutation error triggers a refetch so the merchant sees the real current status", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    const confirmBlock = route.slice(
      route.indexOf("const confirmMutation"),
      route.indexOf("const cancelMutation"),
    );
    expect(confirmBlock).toMatch(/classifyOrderError\(error\) === "stale"/);
    expect(confirmBlock).toMatch(/query\.refetch\(\)/);
  });

  it("no route or sheet in this phase interpolates a raw caught error's message into JSX", () => {
    for (const file of [ORDER_DETAIL_ROUTE, ORDER_LIST_ROUTE, CREATE_SHEET]) {
      const src = readSource(file);
      // A few safe, unrelated uses of ".message" would be fine, but this
      // phase should have none at all — every shown string is a t(...) key.
      expect(src).not.toMatch(/\{error\.message\}|\{err\.message\}/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. LOADING / EMPTY UX
// ═══════════════════════════════════════════════════════════════════════════════

describe("Loading and empty states use the existing APSA visual system", () => {
  it("both the list and the real detail screen render ListSkeleton while loading", () => {
    expect(readSource(ORDER_LIST_ROUTE)).toMatch(/ordersQuery\.isLoading[\s\S]{0,80}ListSkeleton/);
    expect(readSource(ORDER_DETAIL_ROUTE)).toMatch(/query\.isLoading[\s\S]{0,200}ListSkeleton/);
  });

  it("Orders screens use the Apsi-free OperationalState, never the Apsi-carrying EmptyState/ErrorState", () => {
    for (const file of [ORDER_LIST_ROUTE, ORDER_DETAIL_ROUTE, CREATE_SHEET]) {
      const src = readSource(file);
      expect(src).not.toMatch(/\bEmptyState\b/);
      expect(src).not.toMatch(/\bErrorState\b/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11 (remaining). Refresh-after-transition, and the create sheet's own guardrails
// ═══════════════════════════════════════════════════════════════════════════════

describe("Successful confirm/cancel refreshes the on-screen order", () => {
  it("both mutations write the fresh detail into the query cache with setQueryData on success", () => {
    const route = readSource(ORDER_DETAIL_ROUTE);
    const confirmBlock = route.slice(
      route.indexOf("const confirmMutation"),
      route.indexOf("const cancelMutation"),
    );
    const cancelBlock = route.slice(
      route.indexOf("const cancelMutation"),
      route.indexOf("const back ="),
    );
    expect(confirmBlock).toMatch(
      /onSuccess:\s*\(detail\)\s*=>\s*\{\s*queryClient\.setQueryData\(queryKey, detail\)/,
    );
    expect(cancelBlock).toMatch(
      /onSuccess:\s*\(detail\)\s*=>\s*\{\s*queryClient\.setQueryData\(queryKey, detail\)/,
    );
  });

  it("creating an order invalidates the order list query so the new order appears", () => {
    const route = readSource(ORDER_LIST_ROUTE);
    expect(route).toMatch(/invalidateQueries\(\{ queryKey: \["orders", "real"\] \}\)/);
  });
});

describe("Create flow guardrails", () => {
  it("a product with no resolved variantId cannot be submitted (disabled in the picker, guarded in submit)", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(/disabled=\{!item\.variantId\}/);
    expect(sheet).toMatch(/if \(!product\?\.variantId\) return;/);
  });

  it("a forbidden discount attempt surfaces the permission-specific copy, not the generic one", () => {
    const sheet = readSource(CREATE_SHEET);
    expect(sheet).toMatch(
      /classifyOrderError\(error\) === "forbidden"\s*\?\s*"permission"\s*:\s*"generic"/,
    );
    expect(sheet).toMatch(/orderCreate\.permission\.title/);
  });
});
