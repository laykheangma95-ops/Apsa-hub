/**
 * UI capability model — pure unit tests.
 *
 * Covers the fail-closed reader, the tenant/identity guard, and the two
 * declarative maps the UI gates on (nav config, Smart Actions). No network, no
 * DB, no React — this is the layer that decides what a merchant is offered,
 * and it must be provably closed by default.
 *
 * Run: bun test src/tests/capability-model.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  capabilityQueryKey,
  createCapabilityView,
  createFixtureCapabilityView,
  isUiPermissionKey,
  UI_PERMISSION_KEYS,
  UNRESOLVED_CAPABILITIES,
  type CapabilityResult,
} from "@/lib/capabilities";
import {
  filterBusinessNavConfig,
  getBusinessNavConfig,
  isNavEntryAvailable,
} from "@/design-system/mobile-nav-config";
import {
  filterSmartActionSuggestion,
  SMART_ACTION_PERMISSION,
  SMART_ACTION_IDS,
} from "@/lib/conversation/smart-actions";

const USER = "user-a";
const ORG = "org-a";

function activeResult(permissions: readonly string[]): CapabilityResult {
  return {
    status: "active",
    userId: USER,
    organizationId: ORG,
    role: "MANAGER",
    permissions: permissions as never,
  };
}

function viewFor(
  result: CapabilityResult | undefined,
  overrides: Partial<{
    isPending: boolean;
    isError: boolean;
    expectedUserId: string;
    expectedOrganizationId: string;
  }> = {},
) {
  return createCapabilityView({
    result,
    isPending: false,
    isError: false,
    expectedUserId: USER,
    expectedOrganizationId: ORG,
    ...overrides,
  });
}

// ── U1: fail closed ───────────────────────────────────────────────────────────

describe("U1: the capability reader fails closed", () => {
  it("grants nothing before a snapshot has resolved", () => {
    expect(UNRESOLVED_CAPABILITIES.state).toBe("pending");
    for (const key of UI_PERMISSION_KEYS) {
      expect(UNRESOLVED_CAPABILITIES.can(key)).toBe(false);
    }
  });

  it("grants nothing when the capability query errored", () => {
    const view = viewFor(undefined, { isError: true });
    expect(view.state).toBe("denied");
    expect(view.reason).toBe("unavailable");
    expect(view.can("orders.read")).toBe(false);
  });

  it("grants nothing when the query settled with no data", () => {
    const view = viewFor(undefined);
    expect(view.state).toBe("denied");
    expect(view.can("orders.read")).toBe(false);
  });

  it.each(["unauthenticated", "email_unverified", "no_membership"] as const)(
    "grants nothing for a %s result and reports the reason",
    (status) => {
      const view = viewFor({ status });
      expect(view.state).toBe("denied");
      expect(view.reason).toBe(status);
      expect(view.can("team.read")).toBe(false);
      expect(view.role).toBeNull();
      expect(view.organizationId).toBeNull();
    },
  );

  it("keeps a snapshot it already holds when a background refetch fails, and only then", () => {
    // Deliberate: a timed-out refresh on a patchy connection must not empty the
    // merchant's navigation. The snapshot is still the last thing the server
    // said about this exact member, and every action behind it is re-authorized.
    const stillGood = viewFor(activeResult(["orders.read"]), { isError: true });
    expect(stillGood.state).toBe("ready");
    expect(stillGood.can("orders.read")).toBe(true);

    // Revocation does NOT arrive as an error — it is a successful response —
    // so it still fails closed immediately.
    const revoked = viewFor({ status: "no_membership" }, { isError: true });
    expect(revoked.state).toBe("denied");
    expect(revoked.can("orders.read")).toBe(false);
  });

  it("canAll on an empty list is false — an empty requirement never auto-grants", () => {
    const view = viewFor(activeResult(["orders.read"]));
    expect(view.canAll([])).toBe(false);
    expect(view.canAny([])).toBe(false);
  });
});

// ── U1b: canSensitive — the narrowed reader for values whose display discloses ─
//
// can() tolerates a retained snapshot whose background refresh failed (U1
// above, deliberately). canSensitive() must not: a permission revoked during
// exactly that unconfirmed window would still read as granted, so anything
// whose mere display is a disclosure (product cost) has to fail closed there.

describe("U1b: canSensitive fails closed wherever the snapshot is unconfirmed", () => {
  it("is true only for a confirmed, granted, ready snapshot", () => {
    const view = viewFor(activeResult(["products.view_cost", "orders.read"]));
    expect(view.state).toBe("ready");
    expect(view.stale).toBe(false);
    expect(view.canSensitive("products.view_cost")).toBe(true);
    // Not granted stays not granted — canSensitive never widens anything.
    expect(view.canSensitive("products.update_cost")).toBe(false);
  });

  it("refuses a retained snapshot whose latest refresh errored, while can() still allows it", () => {
    // THE P1: same user, same organization, prior authorized snapshot retained,
    // background capability query rejected. state is still "ready" and the
    // snapshot still lists products.view_cost.
    const staleView = viewFor(activeResult(["products.view_cost", "orders.read"]), {
      isError: true,
    });

    expect(staleView.state).toBe("ready");
    expect(staleView.stale).toBe(true);
    expect(staleView.can("products.view_cost")).toBe(true);

    // ...but nothing sensitive may be drawn from it.
    expect(staleView.canSensitive("products.view_cost")).toBe(false);
    expect(staleView.canSensitive("products.update_cost")).toBe(false);
  });

  it("fails closed for pending, denied, no-membership, identity mismatch and error alike", () => {
    // Pending — nothing resolved yet.
    expect(UNRESOLVED_CAPABILITIES.stale).toBe(false);
    expect(UNRESOLVED_CAPABILITIES.canSensitive("products.view_cost")).toBe(false);

    // Errored with nothing retained.
    expect(viewFor(undefined, { isError: true }).canSensitive("products.view_cost")).toBe(false);

    // Settled with no data.
    expect(viewFor(undefined).canSensitive("products.view_cost")).toBe(false);

    // Every denial reason, including a revocation arriving as a success.
    for (const status of ["unauthenticated", "email_unverified", "no_membership"] as const) {
      expect(viewFor({ status }).canSensitive("products.view_cost")).toBe(false);
      expect(viewFor({ status }, { isError: true }).canSensitive("products.view_cost")).toBe(false);
    }

    // Identity mismatch — snapshot issued to another user, or another org.
    expect(
      viewFor(activeResult(["products.view_cost"]), {
        expectedUserId: "user-b",
      }).canSensitive("products.view_cost"),
    ).toBe(false);
    expect(
      viewFor(activeResult(["products.view_cost"]), {
        expectedOrganizationId: "org-b",
      }).canSensitive("products.view_cost"),
    ).toBe(false);
  });

  it("does not widen or break the non-sensitive stale tolerance it sits beside", () => {
    // Requirement: the global stale-background-refetch tolerance stays exactly
    // as it was for ordinary navigation/UI. Only canSensitive is narrower.
    const staleView = viewFor(activeResult(["orders.read", "messages.read", "team.read"]), {
      isError: true,
    });

    expect(staleView.state).toBe("ready");
    expect(staleView.can("orders.read")).toBe(true);
    expect(staleView.can("messages.read")).toBe(true);
    expect(staleView.canAll(["orders.read", "messages.read"])).toBe(true);
    expect(staleView.canAny(["orders.read", "team.invite"])).toBe(true);
    // And it still grants nothing the snapshot did not list.
    expect(staleView.can("team.invite")).toBe(false);
  });

  it("a fixture view is confirmed — design gallery and tests are not stale", () => {
    const fixture = createFixtureCapabilityView(["products.view_cost"]);
    expect(fixture.stale).toBe(false);
    expect(fixture.canSensitive("products.view_cost")).toBe(true);
  });
});

// ── U2: server authority ──────────────────────────────────────────────────────

describe("U2: only server-supplied permissions grant anything", () => {
  it("grants exactly the keys the server returned, and nothing adjacent", () => {
    const view = viewFor(activeResult(["orders.read", "messages.read"]));
    expect(view.state).toBe("ready");
    expect(view.can("orders.read")).toBe(true);
    expect(view.can("messages.read")).toBe(true);
    expect(view.can("orders.refund")).toBe(false);
    expect(view.can("team.invite")).toBe(false);
  });

  it("never infers a permission from the role label", () => {
    // An OWNER label with an empty permission list grants nothing: the label
    // is display-only and the UI has no role→permission table to fall back on.
    const view = viewFor({
      status: "active",
      userId: USER,
      organizationId: ORG,
      role: "OWNER",
      permissions: [],
    });
    expect(view.state).toBe("ready");
    expect(view.role).toBe("OWNER");
    for (const key of UI_PERMISSION_KEYS) {
      expect(view.can(key)).toBe(false);
    }
  });

  it("ignores permission keys outside the declared UI vocabulary", () => {
    const view = viewFor(activeResult(["orders.read", "totally.made.up"]));
    expect(view.can("orders.read")).toBe(true);
    expect(isUiPermissionKey("totally.made.up")).toBe(false);
  });
});

// ── U3: tenant / identity guard ───────────────────────────────────────────────

describe("U3: a snapshot only counts for the identity it was issued to", () => {
  it("refuses a snapshot belonging to another user", () => {
    const view = viewFor(activeResult(["orders.read"]), { expectedUserId: "user-b" });
    expect(view.state).toBe("denied");
    expect(view.can("orders.read")).toBe(false);
    expect(view.organizationId).toBeNull();
  });

  it("refuses a snapshot belonging to another organization", () => {
    const view = viewFor(activeResult(["orders.read"]), { expectedOrganizationId: "org-b" });
    expect(view.state).toBe("denied");
    expect(view.can("orders.read")).toBe(false);
    expect(view.organizationId).toBeNull();
  });

  it("partitions the React Query cache by user and organization", () => {
    expect(capabilityQueryKey(USER, ORG)).toEqual(["capabilities", USER, ORG]);
    expect(capabilityQueryKey(USER, ORG)).not.toEqual(capabilityQueryKey(USER, "org-b"));
    expect(capabilityQueryKey(USER, ORG)).not.toEqual(capabilityQueryKey("user-b", ORG));
  });
});

// ── U4: navigation gating ─────────────────────────────────────────────────────

describe("U4: bottom navigation shows only supported destinations", () => {
  const ownerish = createFixtureCapabilityView(UI_PERMISSION_KEYS);
  const cashierish = createFixtureCapabilityView([
    "orders.read",
    "orders.create",
    "products.read",
    "customers.read",
    "payments.read",
    "messages.read",
  ]);

  it("an owner-equivalent permission set keeps every tab", () => {
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), ownerish);
    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "inbox", "resolve", "sales", "more"]);
  });

  it("drops the Inbox tab for a member without messages.read", () => {
    const noInbox = createFixtureCapabilityView(["orders.read"]);
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), noInbox);
    expect(config.tabs.map((tab) => tab.id)).not.toContain("inbox");
    expect(config.tabs.map((tab) => tab.id)).toContain("home");
  });

  it("drops the Sales tab only when no sales destination is reachable", () => {
    const salesless = createFixtureCapabilityView(["messages.read", "team.read"]);
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), salesless);
    expect(config.tabs.map((tab) => tab.id)).not.toContain("sales");
  });

  it("hides the Team entry for a member without team.read", () => {
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), cashierish);
    const actionIds = config.moreGroups.flatMap((group) =>
      group.actions.map((action) => action.id),
    );
    expect(actionIds).not.toContain("staff-team");
    // Settings stays: every active member has account + language settings.
    expect(actionIds).toContain("settings");
  });

  it("hides the Deliveries entry for a member without delivery.read", () => {
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), cashierish);
    const salesIds = config.salesGroups.flatMap((group) => group.actions.map((a) => a.id));
    expect(salesIds).not.toContain("delivery");
    expect(salesIds).toContain("orders");
  });

  it("hides every gated destination when capabilities have not resolved", () => {
    const config = filterBusinessNavConfig(
      getBusinessNavConfig("online-seller"),
      UNRESOLVED_CAPABILITIES,
    );
    expect(config.tabs.map((tab) => tab.id)).toEqual(["home", "resolve", "more"]);
    const allActions = [
      ...config.resolveGroups,
      ...config.salesGroups,
      ...config.moreGroups,
    ].flatMap((group) => group.actions);
    expect(allActions.every((action) => !action.requiresAll && !action.requiresAny)).toBe(true);
  });

  it("drops a sheet group once every action in it is gated away", () => {
    const config = filterBusinessNavConfig(
      getBusinessNavConfig("online-seller"),
      createFixtureCapabilityView([]),
    );
    for (const group of [...config.resolveGroups, ...config.salesGroups, ...config.moreGroups]) {
      expect(group.actions.length).toBeGreaterThan(0);
    }
  });

  it("an entry with no requirement is available in any state", () => {
    expect(isNavEntryAvailable({}, UNRESOLVED_CAPABILITIES)).toBe(true);
  });
});

// ── U5: Smart Actions ─────────────────────────────────────────────────────────

describe("U5: conversation Smart Actions never suggest refused work", () => {
  it("every action id has a declared permission", () => {
    for (const id of SMART_ACTION_IDS) {
      expect(SMART_ACTION_PERMISSION[id]).toBeDefined();
      expect(isUiPermissionKey(SMART_ACTION_PERMISSION[id])).toBe(true);
    }
  });

  it("drops order suggestions for a member without orders.create and promotes a survivor", () => {
    const replyOnly = createFixtureCapabilityView(["messages.reply"]);
    const filtered = filterSmartActionSuggestion(
      {
        primary: "prepare_order",
        secondary: ["ask_quantity", "view_customer"],
        items: [],
      } as never,
      replyOnly,
    );
    expect(filtered.primary).toBe("ask_quantity");
    expect(filtered.secondary).toEqual([]);
  });

  it("suggests nothing at all when the member can carry out none of it", () => {
    const filtered = filterSmartActionSuggestion(
      { primary: "prepare_order", secondary: ["send_price"], items: [] } as never,
      UNRESOLVED_CAPABILITIES,
    );
    expect(filtered.primary).toBeNull();
    expect(filtered.secondary).toEqual([]);
  });
});
