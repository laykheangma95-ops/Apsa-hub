import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  CreditCard,
  Home,
  Inbox,
  Package,
  RotateCcw,
  ScanLine,
  Sparkles,
  Truck,
  UserRound,
  Users,
  ShoppingBag,
} from "lucide-react";

import type { CapabilityView, UiPermissionKey } from "@/lib/capabilities";

export type BusinessNavVariant = "online-seller" | "mart";

/**
 * The five primary controls, in tab order.
 *
 * `ask` is the centre control and is deliberately NOT a destination: it opens
 * the Apsi service console over whatever the member is already doing. `my` is
 * the terminal-right identity anchor and replaces the former `more` grab-bag —
 * it routes to the existing Settings screen rather than duplicating one.
 */
export type MobileNavTabId = "home" | "inbox" | "ask" | "sales" | "my" | "stock";
export type MobileNavActionAvailability = "live" | "assistive" | "coming-soon";

/**
 * What the member must be able to do for an entry to be worth showing.
 *
 * These are the real, server-enforced permission keys — not a role matrix.
 * `requiresAll` is every key; `requiresAny` is at least one. An entry with
 * neither is available to any active member (Home, My, and the
 * not-built-yet placeholders, which are disabled for everyone anyway).
 */
export interface MobileNavRequirement {
  requiresAll?: readonly UiPermissionKey[];
  requiresAny?: readonly UiPermissionKey[];
  /**
   * At least one of these key SETS must be satisfied in full.
   *
   * A hub tab is worth a slot when at least one destination inside it is
   * actually reachable, and reachability for a destination that needs two
   * grants is an AND. Flattening those into `requiresAny` would light the
   * Sales tab for a member who holds `messages.read` but not `orders.create`
   * — half of what "New order" needs — and open a sheet with nothing in it.
   */
  requiresAnyOf?: readonly (readonly UiPermissionKey[])[];
}

/**
 * Every destination a nav entry may point at.
 *
 * Declared once and reused by BottomNav's own handlers, which previously
 * repeated this union by hand in four places — so adding a hub meant editing
 * five lists and the build only caught it because they disagreed.
 */
export type MobileNavRoute =
  | "/app"
  | "/app/inbox"
  | "/app/pos"
  | "/app/team"
  | "/app/orders"
  | "/app/products"
  | "/app/inventory"
  | "/app/deliveries"
  | "/app/payments"
  | "/app/settings";

export interface MobileNavTabConfig extends MobileNavRequirement {
  id: MobileNavTabId;
  labelKey: string;
  icon: LucideIcon;
  /**
   * `route` navigates and stays there. `console` opens the Apsi service
   * console — a tool, not a place, so it never replaces the current route.
   * `sheet` opens that tab's own hub sheet.
   */
  kind: "route" | "sheet" | "console";
  to?: MobileNavRoute;
}

export interface MobileNavActionConfig extends MobileNavRequirement {
  id: string;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  availability: MobileNavActionAvailability;
  to?: MobileNavRoute;
}

export interface MobileNavSheetGroup {
  id: string;
  titleKey: string;
  actions: readonly MobileNavActionConfig[];
}

export interface BusinessNavVariantConfig {
  tabs: readonly MobileNavTabConfig[];
  /**
   * The service shortcuts under the Apsi console's search field. They route
   * into the domain that OWNS each record — Apsi finds and routes, it never
   * becomes a second copy of Orders, Payments or Deliveries.
   */
  askGroups: readonly MobileNavSheetGroup[];
  salesGroups: readonly MobileNavSheetGroup[];
}

/*
 * Availability vocabulary, unchanged from the Resolve sheet this replaces:
 *
 *   live       — this row opens the screen that does exactly what it says.
 *   assistive  — this row opens the screen that OWNS the record, which is not
 *                a dedicated finder; the description says what the member
 *                actually gets there.
 *   coming-soon — no destination exists. Never attached to a route.
 *
 * Overstating any of these is the failure mode this vocabulary exists to
 * prevent: a merchant sent to a dead row, or a row that promises a search the
 * backend cannot run.
 */
const ASK_GROUPS: readonly MobileNavSheetGroup[] = [
  {
    id: "ask-find",
    titleKey: "nav.askGroups.find",
    actions: [
      {
        id: "find-customer",
        labelKey: "nav.askActions.findCustomer.label",
        descriptionKey: "nav.askActions.findCustomer.description",
        icon: Users,
        availability: "assistive",
        to: "/app/inbox",
        requiresAll: ["messages.read"],
      },
      {
        id: "find-order",
        labelKey: "nav.askActions.findOrder.label",
        descriptionKey: "nav.askActions.findOrder.description",
        icon: Package,
        availability: "assistive",
        to: "/app/orders",
        requiresAll: ["orders.read"],
      },
      {
        id: "check-payment",
        labelKey: "nav.askActions.checkPayment.label",
        descriptionKey: "nav.askActions.checkPayment.description",
        icon: CreditCard,
        availability: "assistive",
        to: "/app/payments",
        requiresAll: ["payments.read"],
      },
      {
        id: "track-delivery",
        labelKey: "nav.askActions.trackDelivery.label",
        descriptionKey: "nav.askActions.trackDelivery.description",
        icon: Truck,
        availability: "assistive",
        to: "/app/deliveries",
        requiresAll: ["delivery.read"],
      },
    ],
  },
  {
    id: "ask-products",
    titleKey: "nav.askGroups.products",
    actions: [
      {
        id: "find-product",
        labelKey: "nav.askActions.findProduct.label",
        descriptionKey: "nav.askActions.findProduct.description",
        icon: Package,
        availability: "assistive",
        to: "/app/products",
        requiresAll: ["products.read"],
      },
      {
        id: "check-stock",
        labelKey: "nav.askActions.checkStock.label",
        descriptionKey: "nav.askActions.checkStock.description",
        icon: Boxes,
        availability: "assistive",
        to: "/app/inventory",
        requiresAll: ["inventory.read"],
      },
      {
        /*
         * Typed / pasted barcodes ARE looked up, by the console's own search
         * field, against the real lookupByBarcode server function. What does
         * not exist is CAMERA capture, and this row says only that. Wiring it
         * to anything would be a simulated scanner.
         */
        id: "scan-barcode",
        labelKey: "nav.askActions.scanBarcode.label",
        descriptionKey: "nav.askActions.scanBarcode.description",
        icon: ScanLine,
        availability: "coming-soon",
        requiresAll: ["products.read"],
      },
    ],
  },
];

const SALES_GROUPS: readonly MobileNavSheetGroup[] = [
  {
    id: "sales-start",
    titleKey: "nav.salesGroups.start",
    actions: [
      {
        id: "new-sale",
        labelKey: "nav.salesActions.newSale.label",
        descriptionKey: "nav.salesActions.newSale.description",
        icon: ShoppingBag,
        availability: "live",
        to: "/app/pos",
        requiresAll: ["orders.create"],
      },
      {
        id: "new-order",
        labelKey: "nav.salesActions.newOrder.label",
        descriptionKey: "nav.salesActions.newOrder.description",
        icon: Package,
        availability: "assistive",
        to: "/app/inbox",
        requiresAll: ["orders.create", "messages.read"],
      },
    ],
  },
  {
    id: "sales-manage",
    titleKey: "nav.salesGroups.manage",
    actions: [
      {
        id: "orders",
        labelKey: "nav.salesActions.orders.label",
        descriptionKey: "nav.salesActions.orders.description",
        icon: Package,
        availability: "live",
        to: "/app/orders",
        requiresAll: ["orders.read"],
      },
      {
        id: "payments",
        labelKey: "nav.salesActions.payments.label",
        descriptionKey: "nav.salesActions.payments.description",
        icon: CreditCard,
        availability: "live",
        to: "/app/payments",
        requiresAll: ["payments.read"],
      },
      {
        id: "delivery",
        labelKey: "nav.salesActions.delivery.label",
        descriptionKey: "nav.salesActions.delivery.description",
        icon: Truck,
        availability: "live",
        to: "/app/deliveries",
        requiresAll: ["delivery.read"],
      },
      {
        id: "returns-refunds",
        labelKey: "nav.salesActions.returnsRefunds.label",
        descriptionKey: "nav.salesActions.returnsRefunds.description",
        icon: RotateCcw,
        availability: "coming-soon",
      },
    ],
  },
  {
    /*
     * The catalogue and the stock workspace stay SEPARATE entries: one answers
     * "what do we sell and for how much", the other "how much do we have".
     * Collapsing them would put a Product-domain gate over an Inventory-domain
     * screen. Each is gated on the key its own server function requires.
     *
     * Both moved here from the former "More" sheet: they are operational
     * business tools, and §15 of the approved model puts Products and
     * Inventory in the Sales family. Account and configuration live under My.
     */
    id: "sales-catalogue",
    titleKey: "nav.salesGroups.catalogue",
    actions: [
      {
        id: "product-catalog",
        labelKey: "nav.salesActions.productCatalog.label",
        descriptionKey: "nav.salesActions.productCatalog.description",
        icon: Package,
        availability: "live",
        to: "/app/products",
        requiresAll: ["products.read"],
      },
      {
        // Gated on inventory.read — the key listOrganizationStock requires.
        id: "products-stock",
        labelKey: "nav.salesActions.productsStock.label",
        descriptionKey: "nav.salesActions.productsStock.description",
        icon: Boxes,
        availability: "live",
        to: "/app/inventory",
        requiresAll: ["inventory.read"],
      },
    ],
  },
];

/**
 * The Sales tab is only worth a slot if at least one thing inside it is
 * reachable. Derived from the group contents rather than hand-listed, so a new
 * Sales destination can never be gated behind a tab that hides it.
 *
 * Rows with no destination (the honest "coming soon" placeholders) are
 * excluded: a sheet containing nothing but disabled rows is not a reason to
 * spend a tab.
 */
const SALES_TAB_REQUIREMENTS: readonly (readonly UiPermissionKey[])[] = SALES_GROUPS.flatMap(
  (group) =>
    group.actions
      .filter((action) => Boolean(action.to))
      .map((action) => action.requiresAll ?? ([] as readonly UiPermissionKey[])),
);

const HOME_TAB: MobileNavTabConfig = {
  id: "home",
  labelKey: "nav.home",
  icon: Home,
  kind: "route",
  to: "/app",
};

/**
 * The centre control. No permission requirement of its own: the console is
 * permission-aware on the inside (every shortcut and every lookup is gated on
 * the key its own server function requires), so a member with nothing to look
 * up sees an honest empty console rather than a missing tab.
 */
const ASK_TAB: MobileNavTabConfig = {
  id: "ask",
  labelKey: "nav.ask",
  icon: Sparkles,
  kind: "console",
};

const SALES_TAB: MobileNavTabConfig = {
  id: "sales",
  labelKey: "nav.sales",
  icon: ShoppingBag,
  kind: "sheet",
  requiresAnyOf: SALES_TAB_REQUIREMENTS,
};

/**
 * The identity / safety anchor, and the terminal-right tab.
 *
 * It routes to the EXISTING Settings screen — which already holds account
 * identity, business profile, the Team link, app/language preferences and
 * sign-out — rather than introducing a second settings architecture. Sections
 * inside it are already permission-gated individually.
 */
const MY_TAB: MobileNavTabConfig = {
  id: "my",
  labelKey: "nav.my",
  icon: UserRound,
  kind: "route",
  to: "/app/settings",
};

const ONLINE_SELLER_CONFIG: BusinessNavVariantConfig = {
  tabs: [
    HOME_TAB,
    {
      id: "inbox",
      labelKey: "nav.inbox",
      icon: Inbox,
      kind: "route",
      to: "/app/inbox",
      requiresAll: ["messages.read"],
    },
    ASK_TAB,
    SALES_TAB,
    MY_TAB,
  ],
  askGroups: ASK_GROUPS,
  salesGroups: SALES_GROUPS,
};

const MART_CONFIG: BusinessNavVariantConfig = {
  tabs: [
    HOME_TAB,
    SALES_TAB,
    ASK_TAB,
    {
      id: "stock",
      labelKey: "nav.stock",
      icon: Boxes,
      kind: "route",
      to: "/app/inventory",
      requiresAll: ["inventory.read"],
    },
    MY_TAB,
  ],
  askGroups: ASK_GROUPS,
  salesGroups: SALES_GROUPS,
};

const VARIANT_CONFIGS: Record<BusinessNavVariant, BusinessNavVariantConfig> = {
  "online-seller": ONLINE_SELLER_CONFIG,
  mart: MART_CONFIG,
};

export function getBusinessNavConfig(variant: BusinessNavVariant = "online-seller") {
  return VARIANT_CONFIGS[variant];
}

/*
 * Which tab a route belongs to.
 *
 * `ask` is deliberately unreachable from here: it is a tool, not a place, so
 * it is highlighted only while its console is open. Nothing can navigate "to
 * Apsi".
 */
export function resolveMobileNavActiveTab(
  pathname: string,
  variant: BusinessNavVariant = "online-seller",
): MobileNavTabId | undefined {
  if (pathname === "/app") return "home";

  // My owns account, business configuration and the team roster.
  if (pathname.startsWith("/app/settings") || pathname.startsWith("/app/team")) return "my";

  if (variant === "mart" && pathname.startsWith("/app/inventory")) return "stock";

  if (
    pathname.startsWith("/app/pos") ||
    pathname.startsWith("/app/orders") ||
    pathname.startsWith("/app/payments") ||
    pathname.startsWith("/app/deliveries") ||
    pathname.startsWith("/app/products") ||
    pathname.startsWith("/app/inventory") ||
    // Customer 360 is reached from an order or a conversation; it belongs to
    // the operational family, not to account settings.
    pathname.startsWith("/app/customers")
  ) {
    return "sales";
  }

  if (variant !== "mart" && pathname.startsWith("/app/inbox")) return "inbox";

  return undefined;
}

// ── Capability filtering ──────────────────────────────────────────────────────

/**
 * Whether an entry is worth showing to this member.
 *
 * Fail-closed by construction: `capabilities.can()` returns false in every
 * state except "ready", so an unresolved snapshot hides every gated entry
 * rather than advertising work the server will refuse.
 */
export function isNavEntryAvailable(
  entry: MobileNavRequirement,
  capabilities: Pick<CapabilityView, "canAll" | "canAny">,
): boolean {
  if (entry.requiresAll && !capabilities.canAll(entry.requiresAll)) return false;
  if (entry.requiresAny && !capabilities.canAny(entry.requiresAny)) return false;
  if (entry.requiresAnyOf && !entry.requiresAnyOf.some((keys) => capabilities.canAll(keys))) {
    return false;
  }
  return true;
}

/**
 * Drop every nav destination the member has no supported access to, then drop
 * any sheet group left with nothing in it — an empty section header is a
 * worse answer than no section at all.
 *
 * Pure: same config + same capabilities in, same config out. Hiding here is
 * presentation only; each destination is still guarded server-side.
 */
export function filterBusinessNavConfig(
  config: BusinessNavVariantConfig,
  capabilities: Pick<CapabilityView, "canAll" | "canAny">,
): BusinessNavVariantConfig {
  const filterGroups = (groups: readonly MobileNavSheetGroup[]): readonly MobileNavSheetGroup[] =>
    groups
      .map((group) => ({
        ...group,
        actions: group.actions.filter((action) => isNavEntryAvailable(action, capabilities)),
      }))
      /*
       * A group survives only if something inside it can actually be opened.
       * A section whose every remaining row is an honest "not built yet"
       * placeholder is noise: it tells the member nothing they can act on and
       * makes the sheet look fuller than it is.
       */
      .filter((group) => group.actions.some((action) => action.availability !== "coming-soon"));

  return {
    tabs: config.tabs.filter((tab) => isNavEntryAvailable(tab, capabilities)),
    askGroups: filterGroups(config.askGroups),
    salesGroups: filterGroups(config.salesGroups),
  };
}
