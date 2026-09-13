/**
 * The navigation redesign's structural contract.
 *
 * Everything here is either a pure function over the nav config or a
 * source-level check on the shell. That is deliberate: the properties worth
 * protecting are the ones a well-meaning future change breaks quietly — a
 * sixth tab, a badge on a hub, a tile that greys out instead of disappearing,
 * an old deep link that stops resolving.
 *
 * Run: bun test src/tests/app-nav.test.ts
 */
import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  APP_NAV_TABS,
  APP_NAV_TAB_ORDER,
  BUSINESS_GROUPS,
  SALES_TILES,
  defaultSalesTileOrder,
  hubRootForPath,
  resolveAppNavActiveTab,
  resolveHubDeepLink,
  visibleHubGroups,
  visibleHubTiles,
} from "@/design-system/app-nav-config";
import { createFixtureCapabilityView, type UiPermissionKey } from "@/lib/capabilities";
import { unansweredConversationCount } from "@/hooks/use-nav-signals";
import en from "../locales/en.json";
import km from "../locales/km.json";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.resolve(ROOT, rel), "utf-8");

const view = (permissions: readonly UiPermissionKey[]) => createFixtureCapabilityView(permissions);

/**
 * The four roles from the capability matrix, expressed as the permission sets
 * the server actually grants them — never as role names, which the UI is not
 * allowed to reason about.
 */
const OWNER = view([
  "messages.read",
  "messages.reply",
  "orders.read",
  "orders.create",
  "payments.read",
  "delivery.read",
  "products.read",
  "customers.read",
  "team.read",
  "organization.read",
]);
const CASHIER = view(["orders.read", "orders.create", "payments.read", "customers.read"]);
const SALES_STAFF = view([
  "messages.read",
  "orders.read",
  "delivery.read",
  "payments.read",
  "products.read",
  "customers.read",
]);
const CUSTOMER_SERVICE = view(["messages.read", "orders.read", "delivery.read", "customers.read"]);
const UNRESOLVED = view([]);

describe("the bar itself", () => {
  it("has exactly five slots in a fixed order with Apsi in the middle", () => {
    expect(APP_NAV_TABS.map((tab) => tab.id)).toEqual([
      "home",
      "inbox",
      "apsi",
      "sales",
      "business",
    ]);
    expect(APP_NAV_TABS).toHaveLength(5);
    expect(APP_NAV_TABS[2]!.kind).toBe("apsi");
    expect([...APP_NAV_TAB_ORDER]).toEqual(APP_NAV_TABS.map((tab) => tab.id));
  });

  it("is identical for every role — tabs carry no capability requirement", () => {
    for (const tab of APP_NAV_TABS) {
      expect(tab).not.toHaveProperty("requiresAll");
      expect(tab).not.toHaveProperty("requiresAny");
    }
  });

  it("badges only Inbox (count) and Home (dot); hubs never carry one", () => {
    const badges = Object.fromEntries(APP_NAV_TABS.map((tab) => [tab.id, tab.badge]));
    expect(badges).toEqual({
      home: "dot",
      inbox: "count",
      apsi: "none",
      sales: "none",
      business: "none",
    });
  });

  it("carries the Khmer-first labels the design calls for", () => {
    const kmTabs = (km as { appNav: { tabs: Record<string, string> } }).appNav.tabs;
    expect(kmTabs).toEqual({
      home: "ទំព័រដើម",
      inbox: "សារ",
      apsi: "Apsi",
      sales: "លក់",
      business: "អាជីវកម្ម",
    });
    const enTabs = (en as { appNav: { tabs: Record<string, string> } }).appNav.tabs;
    for (const [id, label] of Object.entries(enTabs)) {
      expect(label.length).toBeGreaterThan(0);
      // Khmer has no uppercase, and neither does the English side of this bar.
      expect(label).not.toBe(label.toUpperCase());
      expect(kmTabs[id]!.length).toBeGreaterThan(0);
    }
  });

  it("never uppercases a label or truncates one", () => {
    const source = read("src/design-system/AppNavBar.tsx");
    expect(source).not.toMatch(/uppercase/);
    expect(source).not.toMatch(/\btruncate\b/);
    // chip-text is the utility that lets Khmer wrap instead of clipping.
    expect(source).toContain("chip-text");
  });

  it("raises the centre control and rings it in the bar's own surface", () => {
    const source = read("src/design-system/AppNavBar.tsx");
    expect(source).toContain("--apsi-button-raise");
    expect(source).toContain("--apsi-button-size");
    expect(source).toContain("ring-[3px] ring-surface-primary");
    expect(source).toContain("gradient-apsi");
    // press-tactile is the shared 0.94 press; the Apsi button must not invent
    // its own pressed state.
    expect(source).toContain("press-tactile");
  });
});

describe("deep links into the new hierarchy", () => {
  it("keeps every pre-existing signed-in route working, under the right tab", () => {
    expect(resolveAppNavActiveTab("/app")).toBe("home");
    expect(resolveAppNavActiveTab("/app/inbox")).toBe("inbox");
    expect(resolveAppNavActiveTab("/app/inbox/cv-1")).toBe("inbox");
    expect(resolveAppNavActiveTab("/app/pos")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/orders")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/orders/ord-1")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/payments")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/payments/pay-1")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/deliveries/dlv-1")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/sales")).toBe("sales");
    expect(resolveAppNavActiveTab("/app/products")).toBe("business");
    expect(resolveAppNavActiveTab("/app/products/p-1")).toBe("business");
    expect(resolveAppNavActiveTab("/app/customers/cus-1")).toBe("business");
    expect(resolveAppNavActiveTab("/app/team")).toBe("business");
    expect(resolveAppNavActiveTab("/app/settings")).toBe("business");
    expect(resolveAppNavActiveTab("/app/business")).toBe("business");
  });

  it("does not mistake a prefix for a path", () => {
    // "/app/order-templates" is not "/app/orders".
    expect(resolveAppNavActiveTab("/app/order-templates")).toBeUndefined();
    expect(resolveAppNavActiveTab("/sign-in")).toBeUndefined();
  });

  it("sends a screen's back button to the hub that contains it", () => {
    expect(hubRootForPath("/app/orders/ord-1")).toBe("/app/sales");
    expect(hubRootForPath("/app/products/p-1")).toBe("/app/business");
    expect(hubRootForPath("/app/inbox/cv-1")).toBe("/app/inbox");
    expect(hubRootForPath("/app")).toBe("/app");
  });

  it("resolves new-IA URLs to the screens that actually exist", () => {
    expect(resolveHubDeepLink("sales", "orders")).toBe("/app/orders");
    expect(resolveHubDeepLink("sales", "pos")).toBe("/app/pos");
    expect(resolveHubDeepLink("sales", "payments")).toBe("/app/payments");
    expect(resolveHubDeepLink("sales", "delivery")).toBe("/app/deliveries");
    expect(resolveHubDeepLink("business", "products")).toBe("/app/products");
    expect(resolveHubDeepLink("business", "team")).toBe("/app/team");
    expect(resolveHubDeepLink("business", "settings")).toBe("/app/settings");
  });

  it("lands on the hub rather than a 404 for anything it does not recognise", () => {
    expect(resolveHubDeepLink("sales", "not-a-thing")).toBe("/app/sales");
    expect(resolveHubDeepLink("sales", undefined)).toBe("/app/sales");
    expect(resolveHubDeepLink("business", "")).toBe("/app/business");
    // Deeper paths resolve on their first segment rather than failing.
    expect(resolveHubDeepLink("sales", "orders/ord-1")).toBe("/app/orders");
  });
});

describe("hub contents are hidden by capability, never disabled", () => {
  it("gives an owner the full Sales grid", () => {
    expect(visibleHubTiles(SALES_TILES, OWNER).map((tile) => tile.id)).toEqual([
      "pos",
      "orders",
      "payments",
      "delivery",
      "products",
      "stock",
    ]);
  });

  it("gives a cashier the counter and the money, and no catalogue", () => {
    const ids = visibleHubTiles(SALES_TILES, CASHIER).map((tile) => tile.id);
    expect(ids).toContain("pos");
    expect(ids).toContain("orders");
    expect(ids).toContain("payments");
    expect(ids).not.toContain("products");
    expect(ids).not.toContain("stock");
  });

  it("gives customer-service staff the order queue but not the till", () => {
    const ids = visibleHubTiles(SALES_TILES, CUSTOMER_SERVICE).map((tile) => tile.id);
    expect(ids).toEqual(["orders", "delivery"]);
    expect(ids).not.toContain("pos");
    expect(ids).not.toContain("payments");
  });

  it("gives sales staff the catalogue and the queue", () => {
    const ids = visibleHubTiles(SALES_TILES, SALES_STAFF).map((tile) => tile.id);
    expect(ids).toContain("orders");
    expect(ids).toContain("products");
    expect(ids).not.toContain("pos");
  });

  it("shows nothing at all while the capability snapshot is unresolved", () => {
    expect(visibleHubTiles(SALES_TILES, UNRESOLVED)).toEqual([]);
  });

  it("keeps Team, Analytics and Settings out of a cashier's Business hub", () => {
    const groups = visibleHubGroups(BUSINESS_GROUPS, CASHIER);
    const ids = groups.flatMap((group) => group.tiles.map((tile) => tile.id));
    expect(ids).not.toContain("team");
    expect(ids).not.toContain("analytics");
    expect(ids).not.toContain("locations");
    // Settings is every member's own account surface, so it survives.
    expect(ids).toContain("settings");
  });

  it("drops a group entirely rather than leaving an empty heading", () => {
    for (const group of visibleHubGroups(BUSINESS_GROUPS, CASHIER)) {
      expect(group.tiles.length).toBeGreaterThan(0);
    }
    /*
     * An unresolved snapshot hides every gated surface. Settings survives
     * because it is ungated on purpose — it is the member's own account and
     * the way out of the app, and it must not disappear while a capability
     * fetch is in flight or has failed.
     */
    const unresolved = visibleHubGroups(BUSINESS_GROUPS, UNRESOLVED);
    expect(unresolved.map((group) => group.id)).toEqual(["system"]);
    expect(unresolved[0]!.tiles.map((tile) => tile.id)).toEqual(["settings"]);
  });

  it("gives an owner every Business group", () => {
    expect(visibleHubGroups(BUSINESS_GROUPS, OWNER).map((group) => group.id)).toEqual([
      "catalogue",
      "people",
      "insights",
      "system",
    ]);
  });

  it("never renders a denied tile: no hub surface carries a disabled state", () => {
    const sales = read("src/routes/app.sales.tsx");
    const business = read("src/routes/app.business.tsx");
    const grid = read("src/design-system/ServiceGrid.tsx");
    for (const source of [sales, business, grid]) {
      expect(source).not.toMatch(/CapabilityDeniedState/);
      expect(source).not.toMatch(/accessDenied|access_denied/i);
    }
  });
});

describe("a member's own grid arrangement", () => {
  it("can hide and reorder, but can never reveal a tile capability hid", () => {
    const arranged = visibleHubTiles(SALES_TILES, CUSTOMER_SERVICE, {
      order: ["pos", "payments", "products", "orders", "delivery"],
      hidden: ["delivery"],
    });
    expect(arranged.map((tile) => tile.id)).toEqual(["orders"]);
  });

  it("orders by preference and keeps unlisted tiles after the listed ones", () => {
    const arranged = visibleHubTiles(SALES_TILES, OWNER, { order: ["delivery", "pos"] });
    expect(arranged.slice(0, 2).map((tile) => tile.id)).toEqual(["delivery", "pos"]);
    expect(arranged).toHaveLength(6);
  });

  it("puts the till first only for somebody who can use it", () => {
    expect(defaultSalesTileOrder(OWNER)[0]).toBe("pos");
    expect(defaultSalesTileOrder(CASHIER)[0]).toBe("pos");
    expect(defaultSalesTileOrder(CUSTOMER_SERVICE)[0]).toBe("orders");
    expect(defaultSalesTileOrder(SALES_STAFF)[0]).toBe("orders");
  });
});

describe("badge counts", () => {
  it("counts only conversations nobody has answered", () => {
    expect(unansweredConversationCount({ unread: 3, needs_reply: 2, follow_up: 9, all: 40 })).toBe(
      5,
    );
  });

  it("reads a missing bucket as zero, never as unknown", () => {
    expect(unansweredConversationCount({})).toBe(0);
    expect(unansweredConversationCount({ unread: 1 })).toBe(1);
  });
});
