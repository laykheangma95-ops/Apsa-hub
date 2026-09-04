import { describe, expect, it } from "bun:test";
import {
  getBusinessNavConfig,
  resolveMobileNavActiveTab,
} from "@/design-system/mobile-nav-config";

describe("mobile nav config", () => {
  it("keeps the online-seller primary tab order stable", () => {
    const config = getBusinessNavConfig("online-seller");

    expect(config.tabs.map((tab) => tab.id)).toEqual([
      "home",
      "inbox",
      "resolve",
      "sales",
      "more",
    ]);
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
    expect(actions.find((action) => action.id === "find-customer")?.availability).toBe(
      "assistive",
    );
    expect(actions.filter((action) => action.availability === "coming-soon").length).toBe(4);
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

    expect(config.tabs.map((tab) => tab.id)).toEqual([
      "home",
      "sales",
      "resolve",
      "stock",
      "more",
    ]);
  });
});
