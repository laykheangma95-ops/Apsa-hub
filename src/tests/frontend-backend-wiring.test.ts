/**
 * Frontend ↔ backend wiring — regression guards for the V1 wiring audit.
 *
 *   1. PRODUCTION NEVER SERVES FIXTURES. Every prototype-only path in
 *      src/lib/api/index.ts refuses in a production build, so a typed URL such
 *      as /app/orders/ord-1 is "not found" rather than a fabricated order, and
 *      a server failure is never answered with fixture rows.
 *   2. TEAM NAMES THE REAL BUSINESS. The Team header reads the Organization
 *      profile, not the in-memory workspace fixture, and does not offer a
 *      workspace switch the backend cannot perform.
 *   3. INBOX HAS NO FIXTURE STAFF READ. Assignee names come from the server.
 *   4. SETTINGS CACHE IS PRINCIPAL-ISOLATED. The account/business profile
 *      entries are dropped when the signed-in principal changes.
 *   5. MUTATIONS REFRESH EVERY SCREEN THEY MAKE STALE.
 *
 * Run: bun test src/tests/frontend-backend-wiring.test.ts
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { QueryClient } from "@tanstack/react-query";

import * as api from "@/lib/api";
import {
  PROTOTYPE_UNAVAILABLE,
  isDemoModeError,
  prototypeFixturesAllowed,
} from "@/lib/api/prototype-gate";
import { ORGANIZATION_PROFILE_QUERY_KEY, enforceSettingsCachePrincipal } from "@/lib/settings-view";
import { inventoryKeys } from "@/lib/inventory";
import { usd } from "@/lib/money";

const repoRoot = path.resolve(import.meta.dir, "../..");
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), "utf8");
/** Code only — comments may describe what the code no longer does. */
const code = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const env = process.env as Record<string, string | undefined>;
const originalProd = env["PROD"];

function asProduction() {
  env["PROD"] = "true";
}

afterEach(() => {
  if (originalProd === undefined) delete env["PROD"];
  else env["PROD"] = originalProd;
});

async function expectUnavailable(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow(PROTOTYPE_UNAVAILABLE);
}

describe("1. production builds never serve prototype fixtures", () => {
  it("the gate is open under bun test and closed when PROD is set", () => {
    expect(prototypeFixturesAllowed()).toBe(true);
    asProduction();
    expect(prototypeFixturesAllowed()).toBe(false);
  });

  it("non-UUID detail ids are unavailable, not fabricated records", async () => {
    asProduction();
    await expectUnavailable(api.getOrderDetail("ord-1"));
    await expectUnavailable(api.getDeliveryDetail("dlv-1"));
    await expectUnavailable(api.getCustomer360("cus-1"));
    await expectUnavailable(api.getCustomer("cus-1"));
    await expectUnavailable(api.getConversation("conv-1"));
    await expectUnavailable(api.addCustomerNote("cus-1", "note"));
  });

  it("prototype writes never report success", async () => {
    asProduction();
    await expectUnavailable(
      api.recordPayment({ orderId: "ord-1", method: "cash", amount: usd(100) }),
    );
    await expectUnavailable(
      api.createRefund({ orderId: "ord-1", method: "cash", amount: usd(100), reason: "x" }),
    );
    await expectUnavailable(api.createReturn({ orderId: "ord-1", reason: "x", restock: true }));
    await expectUnavailable(api.arrangeDelivery({ orderId: "ord-1", courierId: "cr-1" }));
    await expectUnavailable(api.applyDeliveryAction("dlv-1", "mark_delivered"));
    await expectUnavailable(
      api.createSale({
        items: [],
        subtotal: usd(0),
        discount: usd(0),
        total: usd(0),
        paymentMethod: "cash",
      }),
    );
    await expectUnavailable(
      api.createOrder({
        customerId: "cus-1",
        channel: "facebook",
        items: [],
        subtotal: usd(0),
        discount: usd(0),
        deliveryFee: usd(0),
        total: usd(0),
      }),
    );
    await expectUnavailable(api.switchWorkspace("shop-2"));
  });

  it("fixture reads (workspaces, staff, couriers, recent products, orders) are unavailable", async () => {
    asProduction();
    await expectUnavailable(api.getWorkspaces());
    await expectUnavailable(api.getStaff());
    await expectUnavailable(api.getCouriers());
    await expectUnavailable(api.getRecentProducts());
    await expectUnavailable(api.getOrders());
    await expectUnavailable(api.getShops());
    await expectUnavailable(api.getActiveShop());
  });

  it("a server failure is a failure in production, never demo-mode fixture rows", () => {
    // "No Start context" is the exact error the demo-mode fallback matches on.
    // In production that fallback must not fire, whatever the message says.
    const runtimeMissing = new Error("No Start context found");
    expect(isDemoModeError(runtimeMissing)).toBe(true);
    asProduction();
    expect(isDemoModeError(runtimeMissing)).toBe(false);
    expect(isDemoModeError(new Error("AsyncLocalStorage unavailable"))).toBe(false);
  });

  it("the API boundary uses the gated fallback, not a private copy", () => {
    const source = code("src/lib/api/index.ts");
    expect(source).toContain('isDemoModeError } from "@/lib/api/prototype-gate"');
    expect(source).not.toContain("function isDemoModeError");
  });

  it("dev/test prototype behaviour is unchanged when the gate is open", async () => {
    const detail = await api.getOrderDetail("ord-1");
    expect(detail.order.id).toBe("ord-1");
  });
});

describe("2. Team names the real business", () => {
  const team = code("src/routes/app.team.tsx");

  it("no longer reads the workspace fixture or offers a fake switch", () => {
    expect(team).not.toContain("getWorkspaces");
    expect(team).not.toContain("WorkspaceSwitcherSheet");
    expect(team).not.toContain("onShopSwitch");
    expect(team).not.toContain("@/lib/mock");
  });

  it("reads the Organization profile behind organization.read", () => {
    expect(team).toContain("getOrganizationProfileFn()");
    expect(team).toContain("queryKey: ORGANIZATION_PROFILE_QUERY_KEY");
    expect(team).toContain('capabilities.can("organization.read")');
  });
});

describe("3. Inbox list has no fixture staff read", () => {
  it("does not import or call getStaff", () => {
    expect(code("src/routes/app.inbox.tsx")).not.toContain("getStaff");
  });
});

describe("4. Settings cache is principal-isolated", () => {
  it("drops settings entries when the principal changes, keeps them otherwise", () => {
    const client = new QueryClient();
    enforceSettingsCachePrincipal(client, "user-a", "org-a");
    client.setQueryData(ORGANIZATION_PROFILE_QUERY_KEY, { displayName: "A" });
    client.setQueryData(["settings", "account-profile"], { email: "a@example.com" });

    enforceSettingsCachePrincipal(client, "user-a", "org-a");
    expect(client.getQueryData(ORGANIZATION_PROFILE_QUERY_KEY)).toEqual({ displayName: "A" });

    enforceSettingsCachePrincipal(client, "user-b", "org-a");
    expect(client.getQueryData(ORGANIZATION_PROFILE_QUERY_KEY)).toBeUndefined();
    expect(client.getQueryData(["settings", "account-profile"])).toBeUndefined();
  });

  it("is enforced once in the /app layout", () => {
    expect(code("src/routes/app.tsx")).toContain(
      "enforceSettingsCachePrincipal(queryClient, session.userId, organizationId)",
    );
  });
});

describe("5. mutations refresh every screen they make stale", () => {
  it("inventory principal key is the partition root", () => {
    expect(inventoryKeys.principal("u", "o")).toEqual(["inventory", "u", "o"]);
    expect(inventoryKeys.stockList("u", "o").slice(0, 3)).toEqual(["inventory", "u", "o"]);
  });

  it("order confirm/cancel, Prepare Order and POS sale refresh inventory", () => {
    expect(code("src/routes/app.orders.$id.tsx")).toContain(
      "inventoryKeys.principal(userId, routeOrganizationId)",
    );
    expect(code("src/routes/app.inbox.$id.tsx")).toContain(
      "inventoryKeys.principal(userId, routeOrganizationId)",
    );
    expect(code("src/components/pos/PosCheckoutSheet.tsx")).toContain(
      'queryKey: ["inventory", userId, organizationId]',
    );
  });

  it("payment verify/refund/reverse refresh orders and Home", () => {
    const source = code("src/routes/app.payments.$id.tsx");
    const body = source.slice(source.indexOf("function invalidatePayments()"));
    const fn = body.slice(0, body.indexOf("\n  }\n"));
    expect(fn).toContain("ordersKeys.principal(userId, routeOrganizationId)");
    expect(fn).toContain("HOME_QUERY_PREFIX");
  });

  it("delivery transitions refresh Home's delivery-attention count", () => {
    const source = code("src/routes/app.deliveries.$id.tsx");
    const body = source.slice(source.indexOf("function onTransitionSuccess("));
    const fn = body.slice(0, body.indexOf("\n  }\n"));
    expect(fn).toContain("HOME_QUERY_PREFIX");
  });

  it("stock movements refresh Home's out-of-stock count", () => {
    const source = code("src/routes/app.inventory.$variantId.tsx");
    const body = source.slice(source.indexOf("function refreshAfterMovement()"));
    const fn = body.slice(0, body.indexOf("\n  }\n"));
    expect(fn).toContain("HOME_QUERY_PREFIX");
  });
});
