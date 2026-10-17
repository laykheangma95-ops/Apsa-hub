/**
 * Home Command Center (liquid-glass redesign) — permanent regressions.
 *
 * Covers what the redesign decided, so a later change has to un-decide it on
 * purpose:
 *   1. Quick Action destinations — four existing flows, nothing invented.
 *   2. Permission gating — each card on the key its server enforces, fail-closed.
 *   3. Needs Attention accordion — collapsed by default, accessible wiring, and
 *      a badge that counts kinds of work, never a sum of overlapping counts.
 *   4. Accurate attention counts and the Home → Orders filtered link.
 *   5. Principal isolation — member/organization switches and session expiry.
 *   6. Khmer/English copy, navigation consistency, reduced motion, layout CSS.
 *
 * Real-browser geometry (square tiles, screen fit) lives in
 * home-quick-actions-fit.browser.ts.
 *
 * Run: bun test src/tests/home-command-center.test.ts
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { HomeQuickActions } from "@/components/home/HomeQuickActions";
import { Disclosure, GlassActionTile } from "@/design-system";
import { SELLER_TABS } from "@/design-system";
import { filterBusinessNavConfig, getBusinessNavConfig } from "@/design-system/mobile-nav-config";
import {
  createFixtureCapabilityView,
  UI_PERMISSION_KEYS,
  type UiPermissionKey,
} from "@/lib/capabilities";
import {
  attentionDestination,
  attentionItems,
  attentionNoticeKey,
  attentionSummary,
  attentionSummaryKey,
} from "@/lib/home-attention";
import { homeGreetingKey } from "@/lib/home-greeting";
import {
  enforceHomeCachePrincipal,
  enforceHomeFinanceCache,
  homeQueryKey,
  isHomeAccessError,
  resolveHomeFinanceAccess,
} from "@/lib/home-query";
import {
  HOME_QUICK_ACTION_IDS,
  homeQuickActionAvailable,
  homeQuickActionPermissions,
  homeQuickActions,
  homeQuickActionTarget,
} from "@/lib/home-quick-actions";
import { LanguageProvider } from "@/lib/i18n";
import { ORGANIZATION_PROFILE_QUERY_KEY, enforceSettingsCachePrincipal } from "@/lib/settings-view";
import type { HomeSection, HomeSummary } from "@/types";
import en from "@/locales/en.json";
import km from "@/locales/km.json";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
/** Source without comments, so prose can never satisfy a wiring assertion. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const HOME = "src/routes/app.index.tsx";

const allow = (...keys: UiPermissionKey[]) => {
  const granted = new Set<UiPermissionKey>(keys);
  return (key: UiPermissionKey) => granted.has(key);
};

function available<T>(data: T): HomeSection<T> {
  return { status: "available", data };
}

function summaryWith(overrides: Partial<HomeSummary> = {}): HomeSummary {
  return {
    range: "today",
    orders: available({ periodCount: 9, awaitingPaymentCount: 0, actionNeededCount: 0 }),
    payments: available({ needsReviewCount: 0 }),
    finance: available({ netCollectedForCreatedOrders: [] }),
    inventory: available({ outOfStockVariantCount: 0 }),
    delivery: available({ actionCount: 0 }),
    ...overrides,
  };
}

function copy(dict: unknown, key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }, dict);
  if (typeof value !== "string") throw new Error(`missing copy: ${key}`);
  return value;
}

function render(language: "en" | "km", element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(LanguageProvider, { initialLanguage: language }, element),
  );
}

// ── 1. Destinations ──────────────────────────────────────────────────────────

describe("Quick Action destinations", () => {
  it("are exactly New sale, New order, Pack orders, Inbox — in that 2 × 2 order", () => {
    expect([...HOME_QUICK_ACTION_IDS]).toEqual(["newSale", "newOrder", "packOrders", "inbox"]);
  });

  it("open the existing POS, Create Order sheet, Ready-to-Pack queue and Inbox", () => {
    expect(homeQuickActionTarget("newSale")).toEqual({ kind: "route", to: "/app/pos" });
    expect(homeQuickActionTarget("newOrder")).toEqual({ kind: "createOrderSheet" });
    expect(homeQuickActionTarget("packOrders")).toEqual({ kind: "route", to: "/app/pack" });
    expect(homeQuickActionTarget("inbox")).toEqual({ kind: "route", to: "/app/inbox" });
  });

  it("only ever route to screens that exist", () => {
    for (const id of HOME_QUICK_ACTION_IDS) {
      const target = homeQuickActionTarget(id);
      if (target.kind !== "route") continue;
      const file = `src/routes/${target.to.slice(1).replace(/\//g, ".")}.tsx`;
      expect({ id, exists: existsSync(join(ROOT, file)) }).toEqual({ id, exists: true });
    }
  });

  it("Pack orders is the packing queue, not a relabelled Orders list", () => {
    const pack = code("src/routes/app.pack.tsx");
    expect(pack).toContain('createFileRoute("/app/pack")');
    expect(pack).toContain("listReadyToPack()");
  });

  it("New order opens the real create-order sheet in place, with Orders' cache effects", () => {
    const home = code(HOME);
    expect(home).toContain('if (action.target.kind === "createOrderSheet") {');
    expect(home).toContain("setCreateOrderOpen(true);");
    expect(home).toMatch(/\{canCreateOrder \? \(\s*<CreateRealOrderSheet/);
    expect(home).toContain("userId={session.userId}");
    expect(home).toContain("organizationId={organizationId}");
    expect(home).toContain("queryKey: ordersKeys.list(session.userId, organizationId)");
    expect(home).toContain("queryKey: HOME_QUERY_PREFIX");
    expect(home).toContain("queryKey: customerKeys.principal(session.userId, organizationId)");
  });

  it("every other card navigates to its target route, and nowhere else", () => {
    const home = code(HOME);
    expect(home).toContain("void navigate({ to: action.target.to });");
    // No hard-coded alternative destinations survive from the old grid.
    expect(home).not.toContain('navigate({ to: "/app/orders" })');
    expect(home).not.toContain('navigate({ to: "/app/products" })');
  });
});

// ── 2. Permission gating ─────────────────────────────────────────────────────

describe("Quick Action permission gating", () => {
  it("keys each card to the permission its destination's server requires", () => {
    expect(homeQuickActionPermissions("newSale")).toEqual(["orders.create"]);
    // The create-order sheet's product picker is mandatory and reads the
    // catalog, so New order needs products.read as well as orders.create.
    expect(homeQuickActionPermissions("newOrder")).toEqual(["orders.create", "products.read"]);
    expect(homeQuickActionPermissions("packOrders")).toEqual(["orders.read"]);
    expect(homeQuickActionPermissions("inbox")).toEqual(["messages.read"]);

    // The server halves of those keys.
    const orders = read("src/server/orders/service.ts");
    expect(orders).toContain('"orders.create"');
    const fulfillment = read("src/server/fulfillment/service.ts");
    expect(fulfillment).toMatch(
      /export async function listReadyToPack\([\s\S]*?ctx\.require\("orders\.read"\)/,
    );
    // The sheet's catalog read: getProducts → listProductsFn → products.read.
    const sheet = read("src/components/orders/CreateRealOrderSheet.tsx");
    expect(sheet).toContain("queryFn: getProducts,");
    const products = read("src/server/products/service.ts");
    expect(products).toContain('ctx.require("products.read");');
  });

  it("New order is available only when BOTH of its keys are granted", () => {
    const combos: [UiPermissionKey[], boolean][] = [
      [["orders.create", "products.read"], true],
      [["orders.create"], false],
      [["products.read"], false],
      [[], false],
    ];
    for (const [keys, expected] of combos) {
      expect({ keys, available: homeQuickActionAvailable("newOrder", allow(...keys)) }).toEqual({
        keys,
        available: expected,
      });
      const tile = homeQuickActions(allow(...keys)).find((a) => a.id === "newOrder");
      expect(tile?.available).toBe(expected);
    }
    // New sale keeps its single key; this repair touches only New order.
    expect(homeQuickActionAvailable("newSale", allow("orders.create"))).toBe(true);
  });

  it("the create-order sheet is mounted behind the tile's own two-key gate", () => {
    const home = code(HOME);
    expect(home).toContain(
      'const canCreateOrder = homeQuickActionAvailable("newOrder", (key) => capabilities.can(key));',
    );
    expect(home).toContain("open={createOrderOpen && canCreateOrder}");
    expect(home).toContain("if (!canCreateOrder) setCreateOrderOpen(false);");
    expect(home).toContain("if (!action.available) return;");
  });

  it("fails closed: an unresolved snapshot offers no card", () => {
    expect(homeQuickActions(() => false).every((a) => !a.available)).toBe(true);
  });

  it("offers exactly the cards a role can use, and keeps the other tiles in place", () => {
    const cashier = homeQuickActions(allow("orders.create", "orders.read", "products.read"));
    expect(cashier.map((a) => [a.id, a.available])).toEqual([
      ["newSale", true],
      ["newOrder", true],
      ["packOrders", true],
      ["inbox", false],
    ]);
    // Without the catalog, New order cannot be built, so it is not offered.
    const noCatalog = homeQuickActions(allow("orders.create", "orders.read"));
    expect(noCatalog.map((a) => [a.id, a.available])).toEqual([
      ["newSale", true],
      ["newOrder", false],
      ["packOrders", true],
      ["inbox", false],
    ]);
    const support = homeQuickActions(allow("messages.read"));
    expect(support.map((a) => [a.id, a.available])).toEqual([
      ["newSale", false],
      ["newOrder", false],
      ["packOrders", false],
      ["inbox", true],
    ]);
  });

  it("an unavailable card is a plain tile, never a button", () => {
    const markup = render(
      "en",
      createElement(HomeQuickActions, {
        actions: homeQuickActions(allow("messages.read")),
        onAction: () => {},
        gridRef: null,
        heldSize: null,
      }),
    );
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup.match(/data-unavailable=""/g)).toHaveLength(3);
    expect(markup.match(/Not available for your role/g)).toHaveLength(3);
  });

  it("an available card is one native button whose name is its visible text", () => {
    const markup = renderToStaticMarkup(
      createElement(GlassActionTile, {
        icon: () => null,
        title: "New sale",
        description: "Check out at the counter",
        tone: "sky",
        onPress: () => {},
        unavailableLabel: "x",
      }),
    );
    expect(markup).toMatch(/^<button type="button"/);
    expect(markup).not.toContain("aria-label");
    expect(markup).toContain(">New sale<");
  });

  it("the business name read is gated on organization.read and invents nothing", () => {
    const home = code(HOME);
    expect(home).toContain('const canReadOrganization = capabilities.can("organization.read");');
    expect(home).toContain("enabled: canReadOrganization,");
    expect(home).toContain(
      'const businessName = identity.kind === "ready" ? identity.organizationName : null;',
    );
  });

  it("offers no notification bell or business switcher (neither has a backend)", () => {
    const header = code("src/components/home/HomeHeader.tsx");
    expect(header).not.toContain("Bell");
    expect(header).not.toContain("onShopSwitch");
    expect(header).not.toContain("WorkspaceSwitcherSheet");
  });

  it("the money line stays behind the server's finance section status", () => {
    const card = code("src/components/home/TodaySalesCard.tsx");
    expect(card).toContain('summary.finance.status === "permission_denied"');
    expect(card).toContain('"home.financialsUnavailable"');
    // AND behind access that is still confirmed now (resolveHomeFinanceAccess).
    expect(card).toContain(
      'const finance = summary && financeAccess === "granted" ? summary.finance : null;',
    );
    expect(card).toContain('finance?.status === "available"');
    expect(card).not.toContain("summary.finance.data");
    // One formatted line per currency — never summed or converted.
    expect(card).toContain("netCollectedForCreatedOrders.map((amount) =>");
    expect(card).toContain("formatMoney(amount)");
    expect(card).not.toMatch(/reduce\(|KHR_PER_USD|\+ amount/);
  });
});

// ── 3. Accordion ─────────────────────────────────────────────────────────────

describe("Needs Attention accordion", () => {
  it("is collapsed on every visit", () => {
    expect(code(HOME)).toContain("const [attentionOpen, setAttentionOpen] = useState(false);");
  });

  it("renders a native button with aria-expanded/aria-controls and a labelled region", () => {
    for (const open of [false, true]) {
      const markup = renderToStaticMarkup(
        createElement(Disclosure, {
          id: "t",
          title: "Needs attention",
          summary: "2 kinds of work waiting",
          open,
          onOpenChange: () => {},
          children: createElement("a", { href: "#x" }, "row"),
        }),
      );
      expect(markup).toContain(
        `<button type="button" id="t-trigger" aria-expanded="${open}" aria-controls="t-panel"`,
      );
      expect(markup).toContain('id="t-panel" role="region" aria-labelledby="t-trigger"');
      expect(markup).toContain(`data-open="${open}"`);
      // Closed content is inert (and visibility:hidden in CSS), not merely clipped.
      if (open) expect(markup).not.toContain("inert");
      else expect(markup).toContain('inert=""');
      // The trigger sits inside a heading, so it is reachable by heading navigation.
      expect(markup).toMatch(/<h2><button/);
    }
  });

  it("the badge counts kinds of work — overlapping counts are never summed", () => {
    // 5 unpaid and 7 needing action may be the same orders: two rows, not 12.
    const summary = summaryWith({
      orders: available({ periodCount: 9, awaitingPaymentCount: 5, actionNeededCount: 7 }),
      payments: available({ needsReviewCount: 3 }),
    });
    const rows = attentionItems(summary);
    const state = attentionSummary({ kind: "ready", summary }, rows.length);
    expect(state).toEqual({ kind: "count", rows: 3, complete: true });
    expect(attentionSummaryKey(state)).toBe("home.attentionSummary.count");
    expect(code(HOME)).toContain("{ count: collapsed.rows }");
    expect(code(HOME)).not.toMatch(/reduce\(\(\w+, item\) => \w+ \+ item\.count/);
  });

  it("says 'clear' only on a complete picture with no rows", () => {
    const clean = summaryWith();
    expect(attentionSummary({ kind: "ready", summary: clean }, 0)).toEqual({ kind: "clear" });

    const partial = summaryWith({ payments: { status: "error" } });
    expect(attentionSummary({ kind: "ready", summary: partial }, 0)).toEqual({
      kind: "incomplete",
    });
    const partialRows = summaryWith({
      payments: { status: "error" },
      orders: available({ periodCount: 1, awaitingPaymentCount: 1, actionNeededCount: 0 }),
    });
    const state = attentionSummary({ kind: "ready", summary: partialRows }, 1);
    expect(attentionSummaryKey(state)).toBe("home.attentionSummary.countIncomplete");

    const denied: HomeSummary = {
      ...clean,
      orders: { status: "permission_denied" },
      payments: { status: "permission_denied" },
      inventory: { status: "permission_denied" },
      delivery: { status: "permission_denied" },
    };
    expect(attentionSummary({ kind: "ready", summary: denied }, 0)).toEqual({
      kind: "unavailable",
    });
  });

  it("never claims anything while loading or after a failed fetch", () => {
    expect(attentionSummary({ kind: "loading" }, 0)).toEqual({ kind: "loading" });
    expect(attentionSummary({ kind: "error" }, 0)).toEqual({ kind: "error" });
  });

  it("holds the tiles' size in the tap that opens it", () => {
    const home = code(HOME);
    expect(home).toMatch(
      /function toggleAttention\(next: boolean\) \{\s*if \(next\) tiles\.hold\(\);\s*else tiles\.release\(\);\s*setAttentionOpen\(next\);/,
    );
  });
});

// ── 4. Counts and the filtered Orders link ───────────────────────────────────

describe("attention counts and destinations", () => {
  it("each row carries the server's count unchanged", () => {
    const rows = attentionItems(
      summaryWith({
        orders: available({ periodCount: 4, awaitingPaymentCount: 2, actionNeededCount: 6 }),
        payments: available({ needsReviewCount: 1 }),
        inventory: available({ outOfStockVariantCount: 8 }),
        delivery: available({ actionCount: 3 }),
      }),
    );
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ["awaiting_payment", 2],
      ["orders_needing_action", 6],
      ["payments_needing_review", 1],
      ["low_stock", 8],
      ["awaiting_delivery", 3],
    ]);
  });

  it("a denied, failed or truncated section adds no row", () => {
    const rows = attentionItems(
      summaryWith({
        orders: { status: "permission_denied" },
        payments: { status: "error" },
        delivery: { status: "truncated" },
        inventory: available({ outOfStockVariantCount: 2 }),
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["low_stock"]);
  });

  it("Orders awaiting payment still opens Orders on the Awaiting payment filter (PR #125)", () => {
    expect(attentionDestination("awaiting_payment", () => true)).toEqual({
      to: "/app/orders",
      search: { filter: "awaiting_payment" },
    });
    expect(attentionDestination("orders_needing_action", () => true)).toEqual({
      to: "/app/orders",
      search: {},
    });
    expect(attentionDestination("awaiting_payment", () => false)).toBeNull();
    expect(code(HOME)).toContain(
      "onClick={destination ? () => void navigate(destination) : undefined}",
    );
  });

  it("the full notice and per-domain lines are still inside the panel", () => {
    const home = code(HOME);
    expect(home).toContain("attentionNoticeKey(summary, attention.length)");
    expect(home).toContain("{t(noticeKey)}");
    expect(home).toContain("home.sectionState.");
    expect(attentionNoticeKey(summaryWith(), 0)).toBe("home.noAttention");
  });
});

// ── 5. Principal isolation ───────────────────────────────────────────────────

describe("member, organization and session changes", () => {
  it("Home's data is keyed by the server-derived principal", () => {
    expect(homeQueryKey("u1", "o1", "today")).not.toEqual(homeQueryKey("u2", "o1", "today"));
    expect(homeQueryKey("u1", "o1", "today")).not.toEqual(homeQueryKey("u1", "o2", "today"));
    const home = code(HOME);
    expect(home).toContain("const { session, organizationId } = Route.useRouteContext();");
    expect(home).toContain("homeQueryKey(session.userId, organizationId, HOME_RANGE)");
  });

  it("a principal switch drops the previous member's Home summary and business name", () => {
    const client = new QueryClient();
    enforceHomeCachePrincipal(client, "u1", "o1");
    enforceSettingsCachePrincipal(client, "u1", "o1");
    client.setQueryData(homeQueryKey("u1", "o1", "today"), summaryWith());
    client.setQueryData(ORGANIZATION_PROFILE_QUERY_KEY, { displayName: "Shop One" });

    // Same principal: nothing is dropped.
    enforceHomeCachePrincipal(client, "u1", "o1");
    enforceSettingsCachePrincipal(client, "u1", "o1");
    expect(client.getQueryData(homeQueryKey("u1", "o1", "today"))).toBeDefined();
    expect(client.getQueryData(ORGANIZATION_PROFILE_QUERY_KEY)).toBeDefined();

    // A different member (sign-out → sign-in, or an expired session followed by
    // another login in the same tab) or a different organization.
    enforceHomeCachePrincipal(client, "u2", "o1");
    enforceSettingsCachePrincipal(client, "u2", "o1");
    expect(client.getQueryData(homeQueryKey("u1", "o1", "today"))).toBeUndefined();
    expect(client.getQueryData(ORGANIZATION_PROFILE_QUERY_KEY)).toBeUndefined();
  });

  it("the /app layout enforces both partitions before Home renders", () => {
    const layout = code("src/routes/app.tsx");
    expect(layout).toContain(
      "enforceHomeCachePrincipal(queryClient, session.userId, organizationId);",
    );
    expect(layout).toContain(
      "enforceSettingsCachePrincipal(queryClient, session.userId, organizationId);",
    );
    // Session expiry: the guard redirects before any child (Home) renders.
    expect(layout).toMatch(/if \(!result\.ok\) \{\s*throw redirect\(\{ to: result\.redirect \}\);/);
  });

  it("the create-order sheet is handed the principal, which it resets on", () => {
    const sheet = code("src/components/orders/CreateRealOrderSheet.tsx");
    expect(sheet).toMatch(
      /principal\.userId === userId && principal\.organizationId === organizationId\) return;/,
    );
  });
});

// ── 6. Copy, navigation, motion, layout ──────────────────────────────────────

const NEW_KEYS = [
  "home.greet.morning",
  "home.greet.afternoon",
  "home.greet.evening",
  "home.today.title",
  "home.today.definition",
  "home.today.none",
  "home.today.orders_one",
  "home.today.orders_other",
  "home.today.analytics",
  "home.today.analyticsLabel",
  "home.attentionSummary.loading",
  "home.attentionSummary.error",
  "home.attentionSummary.unavailable",
  "home.attentionSummary.count_one",
  "home.attentionSummary.count_other",
  "home.attentionSummary.countIncomplete_one",
  "home.attentionSummary.countIncomplete_other",
  "home.attentionSummary.incomplete",
  "home.attentionSummary.clear",
  "home.quick.newSale.title",
  "home.quick.newSale.description",
  "home.quick.newOrder.title",
  "home.quick.newOrder.description",
  "home.quick.packOrders.title",
  "home.quick.packOrders.description",
  "home.quick.inbox.title",
  "home.quick.inbox.description",
  "home.quick.unavailable",
];

describe("Khmer and English", () => {
  it("every new string exists in both languages, Khmer in Khmer script", () => {
    for (const key of NEW_KEYS) {
      const english = copy(en, key);
      const khmer = copy(km, key);
      expect(english.length).toBeGreaterThan(0);
      expect({ key, khmerScript: /[ក-៿]/.test(khmer) }).toEqual({ key, khmerScript: true });
      // Placeholders survive translation.
      expect({ key, placeholders: khmer.match(/\{\{\w+\}\}/g) ?? [] }).toEqual({
        key,
        placeholders: english.match(/\{\{\w+\}\}/g) ?? [],
      });
    }
  });

  it("the tiles render each language's own titles", () => {
    const props = {
      actions: homeQuickActions(() => true),
      onAction: () => {},
      gridRef: null,
      heldSize: null,
    };
    const english = render("en", createElement(HomeQuickActions, props));
    const khmer = render("km", createElement(HomeQuickActions, props));
    for (const id of HOME_QUICK_ACTION_IDS) {
      expect(english).toContain(copy(en, `home.quick.${id}.title`));
      expect(khmer).toContain(copy(km, `home.quick.${id}.title`));
    }
    expect(khmer).not.toContain(copy(en, "home.quick.newSale.title"));
  });

  it("greets on the Cambodia clock, whatever the machine's zone", () => {
    // 01:30Z is 08:30 in Phnom Penh; 07:00Z is 14:00; 12:30Z is 19:30.
    expect(homeGreetingKey(new Date("2026-10-16T01:30:00Z"))).toBe("home.greet.morning");
    expect(homeGreetingKey(new Date("2026-10-16T07:00:00Z"))).toBe("home.greet.afternoon");
    expect(homeGreetingKey(new Date("2026-10-16T12:30:00Z"))).toBe("home.greet.evening");
    expect(homeGreetingKey(new Date("2026-10-15T22:00:00Z"))).toBe("home.greet.morning");
    expect(homeGreetingKey(new Date("2026-10-15T21:59:00Z"))).toBe("home.greet.evening");
  });

  it("no hard-coded colours or uppercase in the new components", () => {
    for (const file of [
      "src/components/home/HomeHeader.tsx",
      "src/components/home/HomeQuickActions.tsx",
      "src/components/home/TodaySalesCard.tsx",
      "src/design-system/GlassActionTile.tsx",
      "src/design-system/Disclosure.tsx",
    ]) {
      const source = code(file);
      expect({ file, hex: /#[0-9a-fA-F]{3,8}\b/.test(source) }).toEqual({ file, hex: false });
      expect({ file, upper: /uppercase/.test(source) }).toEqual({ file, upper: false });
    }
  });
});

describe("navigation consistency", () => {
  it("each card goes where the bottom nav sends the same work, behind the same key", () => {
    const tab = (id: string) =>
      [...SELLER_TABS.left, ...SELLER_TABS.right].find((entry) => entry.id === id);
    expect(tab("inbox")?.to).toBe("/app/inbox");
    expect(tab("inbox")?.requiresAll).toEqual(homeQuickActionPermissions("inbox"));
    expect(tab("sales")?.to).toBe("/app/pos");
    expect(tab("sales")?.requiresAll).toEqual(homeQuickActionPermissions("newSale"));

    const owner = createFixtureCapabilityView(UI_PERMISSION_KEYS);
    const config = filterBusinessNavConfig(getBusinessNavConfig("online-seller"), owner);
    const actions = JSON.stringify(config);
    expect(actions).toContain('"to":"/app/pack"');
  });

  it("Home keeps the shared bottom nav", () => {
    expect(code(HOME)).toContain('<BottomNav workspace="business" />');
  });
});

describe("reduced motion and layout CSS", () => {
  const css = read("src/styles.css");

  it("every new transition runs on the motion tokens reduced-motion collapses", () => {
    const block = css.slice(
      css.indexOf(".home-column {"),
      css.indexOf("@media (prefers-reduced-motion"),
    );
    const durations = block.match(/transition[^;]*;/g) ?? [];
    expect(durations.length).toBeGreaterThan(0);
    for (const rule of durations.join(" ").match(/\d+m?s\b/g) ?? []) {
      // Only zero delays are literal; every duration is a --dur-* token.
      expect(rule).toBe("0s");
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--dur-base: 0\.01ms;/);
  });

  it("tiles are square by aspect-ratio and sized from the space left, never a fixed height", () => {
    expect(css).toMatch(/\.glass-tile \{[\s\S]*?aspect-ratio: 1 \/ 1;/);
    expect(css).toMatch(/\.home-actions \{[\s\S]*?container-type: size;/);
    expect(css).toContain("min-height: 100svh;");
    expect(css).toMatch(/--tile-size: min\(\s*\(100cqw - var\(--tile-gap\)\) \/ 2,/);
    // Below the floor the page scrolls rather than the tiles shrinking further.
    expect(css).toContain("min-height: calc(var(--tile-min) * 2 + var(--tile-gap));");
    expect(css).toMatch(/\.home-actions-grid \{[^}]*\}/);
    expect(css).not.toMatch(/\.glass-tile \{[^}]*\bheight: \d+px/);
  });

  it("the tile focus ring is visible and offset from the blue", () => {
    expect(css).toMatch(
      /button\.glass-tile:focus-visible \{\s*outline: 3px solid var\(--border-focus\);\s*outline-offset: 3px;/,
    );
  });
});

// ── Financial privacy helpers (src/lib/home-query.ts) ────────────────────────

describe("Home finance access", () => {
  const owner = createFixtureCapabilityView(UI_PERMISSION_KEYS);
  const noReconcile = createFixtureCapabilityView(
    UI_PERMISSION_KEYS.filter((key) => key !== "payments.reconcile"),
  );

  it("is granted only for a confirmed snapshot holding both finance keys and a good read", () => {
    expect(resolveHomeFinanceAccess(owner, false)).toBe("granted");
    expect(resolveHomeFinanceAccess(owner, true)).toBe("unverified");
    expect(resolveHomeFinanceAccess(noReconcile, false)).toBe("denied");
    expect(resolveHomeFinanceAccess({ ...owner, stale: true }, false)).toBe("unverified");
    expect(resolveHomeFinanceAccess({ ...owner, state: "pending" }, false)).toBe("unverified");
    expect(resolveHomeFinanceAccess({ ...owner, state: "denied" }, false)).toBe("unverified");
  });

  it("recognises only real access refusals as access loss", () => {
    expect(isHomeAccessError(new Error("Not authenticated"))).toBe(true);
    expect(isHomeAccessError(new Error("No active organization membership"))).toBe(true);
    expect(isHomeAccessError(new Error("Home requires an operational read permission"))).toBe(true);
    expect(isHomeAccessError(Object.assign(new Error("x"), { status: 401 }))).toBe(true);
    expect(isHomeAccessError(Object.assign(new Error("x"), { statusCode: 403 }))).toBe(true);
    expect(isHomeAccessError(new Error("getHome finance orders: connection reset"))).toBe(false);
    expect(isHomeAccessError(Object.assign(new Error("x"), { status: 500 }))).toBe(false);
    expect(isHomeAccessError("Not authenticated")).toBe(false);
  });

  it("evicts a principal's Home entries once when confirmation is lost, and only theirs", () => {
    const client = new QueryClient();
    const mine = homeQueryKey("u1", "o1", "today");
    const theirs = homeQueryKey("u2", "o1", "today");
    client.setQueryData(mine, { held: true });
    client.setQueryData(theirs, { held: true });

    enforceHomeFinanceCache(client, "u1", "o1", true);
    expect(client.getQueryData(mine)).toEqual({ held: true });

    enforceHomeFinanceCache(client, "u1", "o1", false);
    expect(client.getQueryData(mine)).toBeUndefined();
    expect(client.getQueryData(theirs)).toEqual({ held: true });

    // Still lost: a later entry (e.g. a counts-only refetch) is left alone.
    client.setQueryData(mine, { refetched: true });
    enforceHomeFinanceCache(client, "u1", "o1", false);
    expect(client.getQueryData(mine)).toEqual({ refetched: true });
  });

  it("Home wires the gate in before its read and polls while money can show", () => {
    const home = code(HOME);
    const gate = home.indexOf("enforceHomeFinanceCache(queryClient");
    const read = home.indexOf("const homeQuery = useQuery(");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(read);
    expect(home).toContain("useSensitiveCapabilityRevalidation(");
    expect(home).toContain("data: homeAccessLost ? undefined : homeQuery.data,");
    expect(home).toContain("financeAccess={financeAccess}");
  });
});
