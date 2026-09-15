/**
 * The approved five-control navigation model, as a contract.
 *
 * HOME · INBOX · ASK (Apsi) · SALES · MY. Each assertion below exists because
 * its opposite is a real product regression, not because the shape is pretty:
 * a sixth tab dilutes every other one, "More" coming back turns the terminal
 * slot into a junk drawer again, Apsi becoming a route breaks the one thing
 * that makes it useful from an open conversation, and a row that claims a
 * workflow APSA does not have sends a merchant to a dead end mid-sale.
 */
import { describe, expect, it } from "bun:test";
import {
  filterBusinessNavConfig,
  getBusinessNavConfig,
  resolveMobileNavActiveTab,
} from "@/design-system/mobile-nav-config";
import { createFixtureCapabilityView } from "@/lib/capabilities";
import { UI_PERMISSION_KEYS } from "@/lib/capabilities";

const owner = createFixtureCapabilityView(UI_PERMISSION_KEYS);

describe("mobile nav config", () => {
  it("is exactly the five approved primary controls, in order", () => {
    const config = getBusinessNavConfig("online-seller");

    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "inbox", "ask", "sales", "my"]);
    expect(config.tabs).toHaveLength(5);
  });

  it("never brings back a More tab", () => {
    for (const variant of ["online-seller", "mart"] as const) {
      const ids = getBusinessNavConfig(variant).tabs.map((tab) => tab.id) as string[];
      expect(ids).not.toContain("more");
      expect(ids).not.toContain("resolve");
    }
  });

  /*
   * A tab is a destination; Apsi is a tool. If the centre control ever becomes
   * a route, tapping it from an Inbox conversation throws the merchant out of
   * the conversation they were answering — the exact failure the console
   * exists to prevent.
   */
  it("makes the centre control a console, not a destination", () => {
    for (const variant of ["online-seller", "mart"] as const) {
      const config = getBusinessNavConfig(variant);
      const ask = config.tabs.find((tab) => tab.id === "ask");
      expect(ask).toBeDefined();
      expect(ask!.kind).toBe("console");
      expect(ask!.to).toBeUndefined();
      // Centre slot, literally: index 2 of five.
      expect(config.tabs.indexOf(ask!)).toBe(2);
    }
  });

  it("makes My the terminal-right identity anchor, reusing the Settings route", () => {
    for (const variant of ["online-seller", "mart"] as const) {
      const tabs = getBusinessNavConfig(variant).tabs;
      const last = tabs[tabs.length - 1]!;
      expect(last.id).toBe("my");
      expect(last.kind).toBe("route");
      expect(last.to).toBe("/app/settings");
    }
  });

  /*
   * Apsi has no permission gate of its own on purpose: the console is gated on
   * the inside, per lookup and per shortcut. A gate here would hide the whole
   * tool from a member who can still legitimately look several things up.
   */
  it("gates Apsi on nothing, so an unresolved snapshot still shows the console", () => {
    const ask = getBusinessNavConfig("online-seller").tabs.find((tab) => tab.id === "ask")!;
    expect(ask.requiresAll).toBeUndefined();
    expect(ask.requiresAny).toBeUndefined();
    expect(ask.requiresAnyOf).toBeUndefined();
  });

  it("offers the Apsi service shortcuts the approved model calls for", () => {
    const config = getBusinessNavConfig("online-seller");
    const actions = config.askGroups.flatMap((group) => group.actions);

    expect(actions.map((action) => action.id)).toEqual([
      "find-customer",
      "find-order",
      "check-payment",
      "track-delivery",
      "find-product",
      "check-stock",
      "scan-barcode",
    ]);
  });

  /*
   * Camera scanning genuinely does not exist. It is the ONLY Apsi shortcut
   * allowed to be unavailable, and it must never acquire a route — a row that
   * navigates somewhere while claiming to scan is a simulated feature.
   */
  it("admits camera barcode scanning is the one thing it cannot do", () => {
    const actions = getBusinessNavConfig("online-seller").askGroups.flatMap((g) => g.actions);
    const unavailable = actions.filter((a) => a.availability === "coming-soon");

    expect(unavailable.map((a) => a.id)).toEqual(["scan-barcode"]);
    expect(unavailable[0]!.to).toBeUndefined();
  });

  /*
   * The rule, rather than a count that silently rots: an entry may only claim
   * "coming soon" when it has no destination at all. The moment a route is
   * attached, the label has to stop saying the workflow does not exist.
   */
  it("never marks an action coming-soon when it already points at a live route", () => {
    for (const variant of ["online-seller", "mart"] as const) {
      const config = getBusinessNavConfig(variant);
      const actions = [...config.askGroups, ...config.salesGroups].flatMap(
        (group) => group.actions,
      );

      for (const action of actions) {
        if (action.availability === "coming-soon") {
          expect({ id: action.id, to: action.to }).toEqual({ id: action.id, to: undefined });
        } else {
          // Conversely, anything not marked coming-soon must actually go
          // somewhere — an enabled row with no route is a silent no-op.
          expect({ id: action.id, hasRoute: Boolean(action.to) }).toEqual({
            id: action.id,
            hasRoute: true,
          });
        }
      }
    }
  });

  /*
   * Every gated destination must be keyed to the permission its own server
   * functions require. A row gated on the wrong key either hides work the
   * member can do or offers work the server will refuse.
   */
  it("gates each live destination on the permission that destination requires", () => {
    const config = getBusinessNavConfig("online-seller");
    const actions = [...config.askGroups, ...config.salesGroups].flatMap((group) => group.actions);

    const expected: Record<string, readonly string[]> = {
      "/app/orders": ["orders.read"],
      "/app/payments": ["payments.read"],
      "/app/deliveries": ["delivery.read"],
      "/app/products": ["products.read"],
      "/app/inventory": ["inventory.read"],
      "/app/team": ["team.read"],
    };

    for (const action of actions) {
      const required = action.to ? expected[action.to] : undefined;
      if (!required) continue;
      for (const key of required) {
        expect({ id: action.id, has: action.requiresAll?.includes(key) ?? false }).toEqual({
          id: action.id,
          has: true,
        });
      }
    }
  });

  /*
   * Sales owns the operational family. Account and configuration belong to My,
   * and Apsi's lookups are not duplicated here as a second finder.
   */
  it("keeps Sales operational and free of account settings", () => {
    const config = getBusinessNavConfig("online-seller");
    const routes = config.salesGroups.flatMap((group) => group.actions.map((a) => a.to));

    expect(routes).toContain("/app/orders");
    expect(routes).toContain("/app/payments");
    expect(routes).toContain("/app/deliveries");
    expect(routes).toContain("/app/pos");
    expect(routes).toContain("/app/products");
    expect(routes).toContain("/app/inventory");
    expect(routes).not.toContain("/app/settings");
    expect(routes).not.toContain("/app/team");
  });

  it("maps signed-in routes to the correct active mobile tab", () => {
    expect(resolveMobileNavActiveTab("/app", "online-seller")).toBe("home");
    expect(resolveMobileNavActiveTab("/app/inbox", "online-seller")).toBe("inbox");
    expect(resolveMobileNavActiveTab("/app/inbox/cv-1", "online-seller")).toBe("inbox");
    expect(resolveMobileNavActiveTab("/app/pos", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/orders/ord-1", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/deliveries/dlv-1", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/products", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/inventory", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/customers/cus-1", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/settings", "online-seller")).toBe("my");
    expect(resolveMobileNavActiveTab("/app/team", "online-seller")).toBe("my");
  });

  /** Apsi is never "where you are" — no route may light the centre control. */
  it("never resolves any route to the Apsi tab", () => {
    const paths = [
      "/app",
      "/app/inbox",
      "/app/inbox/cv-1",
      "/app/pos",
      "/app/orders",
      "/app/orders/ord-1",
      "/app/payments",
      "/app/deliveries",
      "/app/products",
      "/app/inventory",
      "/app/customers/cus-1",
      "/app/settings",
      "/app/team",
    ];
    for (const variant of ["online-seller", "mart"] as const) {
      for (const path of paths) {
        expect(resolveMobileNavActiveTab(path, variant)).not.toBe("ask");
      }
    }
  });

  it("keeps a future mart variant on the same five-control model", () => {
    const config = getBusinessNavConfig("mart");

    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "sales", "ask", "stock", "my"]);
    expect(resolveMobileNavActiveTab("/app/inventory", "mart")).toBe("stock");
  });

  /*
   * Sales is a hub, and a hub tab that opens an empty sheet is worse than no
   * tab. Reachability for a destination needing two grants is an AND, so
   * holding half of one must not keep the tab.
   */
  it("keeps the Sales tab only when a whole destination inside it is reachable", () => {
    const halfOfNewOrder = createFixtureCapabilityView(["messages.read"]);
    const halfConfig = filterBusinessNavConfig(
      getBusinessNavConfig("online-seller"),
      halfOfNewOrder,
    );
    expect(halfConfig.tabs.map((tab) => tab.id)).not.toContain("sales");
    expect(halfConfig.salesGroups).toEqual([]);

    const canSeeOrders = createFixtureCapabilityView(["orders.read"]);
    const ordersConfig = filterBusinessNavConfig(
      getBusinessNavConfig("online-seller"),
      canSeeOrders,
    );
    expect(ordersConfig.tabs.map((tab) => tab.id)).toContain("sales");
  });

  it("keeps every tab for an owner-equivalent member", () => {
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), owner);
    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "inbox", "ask", "sales", "my"]);
  });
});
