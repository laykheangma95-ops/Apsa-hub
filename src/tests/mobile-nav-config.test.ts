import { describe, expect, it } from "bun:test";
import { getBusinessNavConfig, resolveMobileNavActiveTab } from "@/design-system/mobile-nav-config";

describe("mobile nav config", () => {
  it("keeps the online-seller primary tab order stable", () => {
    const config = getBusinessNavConfig("online-seller");

    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "inbox", "resolve", "sales", "more"]);
  });

  it("includes the required resolve actions with honest availability states", () => {
    const config = getBusinessNavConfig("online-seller");
    const actions = config.resolveGroups.flatMap((group) => group.actions);

    expect(actions.map((action) => action.id)).toEqual([
      "scan-barcode",
      "find-customer",
      "find-order",
      "check-payment",
      "track-delivery",
    ]);
    expect(actions.find((action) => action.id === "find-customer")?.availability).toBe("assistive");

    /*
     * The only remaining "coming soon" here is the barcode scanner, which
     * genuinely does not exist. find-order, check-payment and track-delivery
     * were coming-soon while /app/orders, /app/payments and /app/deliveries
     * were already live, so the Resolve sheet dead-ended a merchant looking
     * for a record the app could in fact show them.
     */
    expect(
      actions.filter((action) => action.availability === "coming-soon").map((a) => a.id),
    ).toEqual(["scan-barcode"]);
  });

  /*
   * The rule, rather than a count that silently rots: an entry may only claim
   * "coming soon" when it has no destination at all. The moment a route is
   * attached, the label has to stop saying the workflow does not exist.
   */
  it("never marks an action coming-soon when it already points at a live route", () => {
    for (const variant of ["online-seller", "mart"] as const) {
      const config = getBusinessNavConfig(variant);
      const actions = [
        ...config.resolveGroups,
        ...config.salesGroups,
        ...config.moreGroups,
      ].flatMap((group) => group.actions);

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
    const actions = [...config.resolveGroups, ...config.salesGroups, ...config.moreGroups].flatMap(
      (group) => group.actions,
    );

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

  it("maps signed-in routes to the correct active mobile tab", () => {
    expect(resolveMobileNavActiveTab("/app", "online-seller")).toBe("home");
    expect(resolveMobileNavActiveTab("/app/inbox", "online-seller")).toBe("inbox");
    expect(resolveMobileNavActiveTab("/app/inbox/cv-1", "online-seller")).toBe("inbox");
    expect(resolveMobileNavActiveTab("/app/pos", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/orders/ord-1", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/deliveries/dlv-1", "online-seller")).toBe("sales");
    expect(resolveMobileNavActiveTab("/app/team", "online-seller")).toBe("more");
    expect(resolveMobileNavActiveTab("/app/customers/cus-1", "online-seller")).toBe("more");
  });

  it("keeps a future mart variant available without changing the current shell", () => {
    const config = getBusinessNavConfig("mart");

    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "sales", "resolve", "stock", "more"]);
  });
});
