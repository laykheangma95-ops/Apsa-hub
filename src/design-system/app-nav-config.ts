import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Boxes,
  Calculator,
  CreditCard,
  Home,
  Inbox,
  MapPin,
  Package,
  Plug,
  ReceiptText,
  Settings,
  ShoppingBag,
  Store,
  Truck,
  UserCog,
  Users,
} from "lucide-react";

import type { CapabilityView, UiPermissionKey } from "@/lib/capabilities";

/**
 * APSA's primary information architecture.
 *
 * Five slots, fixed order, the same five for every role — a merchant and their
 * cashier point at the same place on the same screen when one of them is on
 * the phone explaining something. What changes by role is what is *inside*
 * Sales and Business, never the bar itself.
 *
 * Tabs are modes, not modules: "what happened", "who is talking to me", "ask",
 * "selling right now", "running the business". Anything that is not one of
 * those five daily modes lives inside a hub or behind Apsi search. There is no
 * sixth tab, and adding one is a design change, not a config change.
 */
export type AppNavTabId = "home" | "inbox" | "apsi" | "sales" | "business";

export const APP_NAV_TAB_ORDER: readonly AppNavTabId[] = [
  "home",
  "inbox",
  "apsi",
  "sales",
  "business",
] as const;

/** Every destination the new shell can send a merchant to. Declared once. */
export type AppNavRoute =
  | "/app"
  | "/app/inbox"
  | "/app/sales"
  | "/app/business"
  | "/app/pos"
  | "/app/orders"
  | "/app/payments"
  | "/app/deliveries"
  | "/app/products"
  | "/app/team"
  | "/app/settings";

/**
 * What a member must be able to do for a hub entry to be worth showing.
 * Server-enforced permission keys, never a role name — see
 * src/lib/capabilities.ts.
 */
export interface NavRequirement {
  requiresAll?: readonly UiPermissionKey[];
  requiresAny?: readonly UiPermissionKey[];
}

/**
 * What a badge on a tab is allowed to mean.
 *
 * "count" — a number of things somebody must act on (Inbox: unanswered
 * conversations). "dot" — work exists, no useful number (Home: attention
 * items). "none" — this tab never carries a badge, however busy it is.
 *
 * Sales and Business are deliberately "none". They are hubs: everything under
 * them is already counted on Home or Inbox, and a badge on a container just
 * teaches merchants that badges mean nothing.
 */
export type NavBadgeKind = "count" | "dot" | "none";

export interface AppNavTabConfig {
  id: AppNavTabId;
  labelKey: string;
  icon: LucideIcon;
  /** "apsi" is the raised centre control — a sheet, never a route. */
  kind: "route" | "apsi";
  to?: AppNavRoute;
  badge: NavBadgeKind;
  /** Long-press shortcut, announced in the tab's accessible description. */
  longPress?: "inbox-unread" | "sales-primary" | "home-refresh";
}

export const APP_NAV_TABS: readonly AppNavTabConfig[] = [
  {
    id: "home",
    labelKey: "appNav.tabs.home",
    icon: Home,
    kind: "route",
    to: "/app",
    badge: "dot",
    longPress: "home-refresh",
  },
  {
    id: "inbox",
    labelKey: "appNav.tabs.inbox",
    icon: Inbox,
    kind: "route",
    to: "/app/inbox",
    badge: "count",
    longPress: "inbox-unread",
  },
  { id: "apsi", labelKey: "appNav.tabs.apsi", icon: ShoppingBag, kind: "apsi", badge: "none" },
  {
    id: "sales",
    labelKey: "appNav.tabs.sales",
    icon: ShoppingBag,
    kind: "route",
    to: "/app/sales",
    badge: "none",
    longPress: "sales-primary",
  },
  {
    id: "business",
    labelKey: "appNav.tabs.business",
    icon: Store,
    kind: "route",
    to: "/app/business",
    badge: "none",
  },
];

// ── Hub tiles ────────────────────────────────────────────────────────────────

/**
 * Whether a tile leads to a screen that exists.
 *
 * "live" — a real screen. "planned" — the surface is part of the IA but has no
 * screen in the app yet. A planned tile says so in one quiet line; it is never
 * dressed up as a working destination, and it is never an "access denied"
 * either — that distinction matters, because one is "not built" and the other
 * would be a lie about this member's permissions.
 */
export type HubTileAvailability = "live" | "planned";

export interface HubTileConfig extends NavRequirement {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  availability: HubTileAvailability;
  to?: AppNavRoute;
}

export interface HubGroupConfig {
  id: string;
  titleKey: string;
  tiles: readonly HubTileConfig[];
}

/**
 * Sales — the operational hub. Everything a merchant touches while money is
 * moving today.
 *
 * Order is the shipped default; a member may reorder or hide tiles, and the
 * capability filter runs first either way (see visibleHubTiles).
 */
export const SALES_TILES: readonly HubTileConfig[] = [
  {
    id: "pos",
    labelKey: "appNav.tiles.pos",
    icon: Calculator,
    availability: "live",
    to: "/app/pos",
    requiresAll: ["orders.create"],
  },
  {
    id: "orders",
    labelKey: "appNav.tiles.orders",
    icon: ReceiptText,
    availability: "live",
    to: "/app/orders",
    requiresAll: ["orders.read"],
  },
  {
    id: "payments",
    labelKey: "appNav.tiles.payments",
    icon: CreditCard,
    availability: "live",
    to: "/app/payments",
    requiresAll: ["payments.read"],
  },
  {
    id: "delivery",
    labelKey: "appNav.tiles.delivery",
    icon: Truck,
    availability: "live",
    to: "/app/deliveries",
    requiresAll: ["delivery.read"],
  },
  {
    id: "products",
    labelKey: "appNav.tiles.products",
    icon: Package,
    availability: "live",
    to: "/app/products",
    requiresAll: ["products.read"],
  },
  {
    /*
     * Stock is a ledger domain with server functions but no screen of its own
     * yet (src/api/inventory.ts). It is gated on products.read because that is
     * the permission the catalogue screen it will live beside requires.
     */
    id: "stock",
    labelKey: "appNav.tiles.stock",
    icon: Boxes,
    availability: "planned",
    requiresAll: ["products.read"],
  },
];

/**
 * Business — management surfaces, grouped by what a merchant is trying to do,
 * not by which service owns the table. A flat list of nine icons is a junk
 * drawer; four named groups of two are a map.
 */
export const BUSINESS_GROUPS: readonly HubGroupConfig[] = [
  {
    id: "catalogue",
    titleKey: "appNav.groups.catalogue",
    tiles: [
      {
        id: "products",
        labelKey: "appNav.tiles.products",
        icon: Package,
        availability: "live",
        to: "/app/products",
        requiresAll: ["products.read"],
      },
      {
        id: "stock",
        labelKey: "appNav.tiles.stock",
        icon: Boxes,
        availability: "planned",
        requiresAll: ["products.read"],
      },
    ],
  },
  {
    id: "people",
    titleKey: "appNav.groups.people",
    tiles: [
      {
        /*
         * Customer 360 exists at /app/customers/$id, reachable from an order
         * or from Apsi search. A customer *list* screen does not exist yet,
         * so this tile is honest about that rather than pointing at a 404.
         */
        id: "customers",
        labelKey: "appNav.tiles.customers",
        icon: Users,
        availability: "planned",
        requiresAll: ["customers.read"],
      },
      {
        id: "team",
        labelKey: "appNav.tiles.team",
        icon: UserCog,
        availability: "live",
        to: "/app/team",
        requiresAll: ["team.read"],
      },
    ],
  },
  {
    id: "insights",
    titleKey: "appNav.groups.insights",
    tiles: [
      {
        id: "analytics",
        labelKey: "appNav.tiles.analytics",
        icon: BarChart3,
        availability: "planned",
        // Analytics reports across the whole organization; the same read the
        // organization profile requires is the narrowest honest gate today.
        requiresAll: ["organization.read"],
      },
      {
        id: "integrations",
        labelKey: "appNav.tiles.integrations",
        icon: Plug,
        availability: "planned",
        requiresAll: ["organization.read"],
      },
    ],
  },
  {
    id: "system",
    titleKey: "appNav.groups.system",
    tiles: [
      {
        id: "settings",
        labelKey: "appNav.tiles.settings",
        icon: Settings,
        availability: "live",
        to: "/app/settings",
      },
      {
        id: "locations",
        labelKey: "appNav.tiles.locations",
        icon: MapPin,
        availability: "planned",
        requiresAll: ["organization.read"],
      },
    ],
  },
];

// ── Capability filtering ─────────────────────────────────────────────────────

/**
 * Whether this member has the server-supported access a hub entry leads to.
 *
 * Fail-closed by construction: capabilities.canAll/canAny answer false in
 * every state except "ready", so an unresolved snapshot hides gated tiles
 * rather than advertising work the server will refuse.
 */
export function isHubEntryAvailable(
  entry: NavRequirement,
  capabilities: Pick<CapabilityView, "canAll" | "canAny">,
): boolean {
  if (entry.requiresAll && !capabilities.canAll(entry.requiresAll)) return false;
  if (entry.requiresAny && !capabilities.canAny(entry.requiresAny)) return false;
  return true;
}

/**
 * The tiles this member should see, in the order they should see them.
 *
 * Capability hiding happens first and is not negotiable — a hidden tile is
 * hidden, never greyed out with an "Access denied" label, because a denial
 * that names the thing it is denying still tells a cashier what the owner
 * has. A member's own hide/reorder preference is applied afterwards, and can
 * only ever remove from what capability already allowed.
 */
export function visibleHubTiles(
  tiles: readonly HubTileConfig[],
  capabilities: Pick<CapabilityView, "canAll" | "canAny">,
  preference?: HubTilePreference | undefined,
): readonly HubTileConfig[] {
  const allowed = tiles.filter((tile) => isHubEntryAvailable(tile, capabilities));
  if (!preference) return allowed;

  const hidden = new Set(preference.hidden ?? []);
  const shown = allowed.filter((tile) => !hidden.has(tile.id));
  const order = preference.order ?? [];
  if (order.length === 0) return shown;

  const rank = new Map(order.map((id, index) => [id, index]));
  return [...shown].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function visibleHubGroups(
  groups: readonly HubGroupConfig[],
  capabilities: Pick<CapabilityView, "canAll" | "canAny">,
): readonly HubGroupConfig[] {
  return groups
    .map((group) => ({
      ...group,
      tiles: group.tiles.filter((tile) => isHubEntryAvailable(tile, capabilities)),
    }))
    .filter((group) => group.tiles.length > 0);
}

/** A member's own Sales-grid arrangement. Presentation only; grants nothing. */
export interface HubTilePreference {
  order?: readonly string[];
  hidden?: readonly string[];
}

/**
 * The default Sales order for this member, derived from permissions rather
 * than from a role name.
 *
 * The top row is the three things this member reaches for first: somebody who
 * can take money at a counter opens POS; somebody who cannot is here to work
 * the order queue. Nothing is added or removed here — only ordered.
 */
export function defaultSalesTileOrder(
  capabilities: Pick<CapabilityView, "canAll" | "canAny">,
): readonly string[] {
  const takesPayment = capabilities.canAll(["orders.create"]);
  return takesPayment
    ? ["pos", "orders", "payments", "delivery", "products", "stock"]
    : ["orders", "delivery", "products", "payments", "pos", "stock"];
}

// ── Active-tab resolution and deep links ─────────────────────────────────────

/**
 * Which tab owns a path.
 *
 * Every route that existed before this navigation lands inside one of the five
 * modes, so an old bookmark or a shared link opens with the right tab lit and
 * the right hub behind the back button. This map is the single place that
 * knows it — the nav, the hubs and the redirect routes all read it.
 */
const TAB_PATH_PREFIXES: readonly { prefix: string; tab: AppNavTabId }[] = [
  { prefix: "/app/inbox", tab: "inbox" },
  { prefix: "/app/sales", tab: "sales" },
  { prefix: "/app/pos", tab: "sales" },
  { prefix: "/app/orders", tab: "sales" },
  { prefix: "/app/payments", tab: "sales" },
  { prefix: "/app/deliveries", tab: "sales" },
  { prefix: "/app/business", tab: "business" },
  { prefix: "/app/products", tab: "business" },
  { prefix: "/app/customers", tab: "business" },
  { prefix: "/app/team", tab: "business" },
  { prefix: "/app/settings", tab: "business" },
];

export function resolveAppNavActiveTab(pathname: string): AppNavTabId | undefined {
  if (pathname === "/app" || pathname === "/app/") return "home";
  const match = TAB_PATH_PREFIXES.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );
  return match?.tab;
}

/**
 * The hub a screen belongs to, so "back" from a deep-linked screen lands on
 * the hub that contains it instead of dumping the merchant on Home.
 */
export function hubRootForPath(pathname: string): AppNavRoute | undefined {
  const tab = resolveAppNavActiveTab(pathname);
  if (tab === "sales") return "/app/sales";
  if (tab === "business") return "/app/business";
  if (tab === "inbox") return "/app/inbox";
  if (tab === "home") return "/app";
  return undefined;
}

/**
 * New-IA aliases for screens that still live at their original paths.
 *
 * The screens themselves did not move — /app/orders is still /app/orders, and
 * every bookmark, notification link and shared URL that existed before this
 * change keeps working untouched. What this adds is the other direction: a URL
 * shaped like the new hierarchy resolves to the real screen instead of 404ing,
 * so links written against the IA people can now see in the app are correct
 * too. Keys are the splat under the hub root, lowercased and without slashes.
 */
export const SALES_DEEP_LINKS: Readonly<Record<string, AppNavRoute>> = {
  pos: "/app/pos",
  orders: "/app/orders",
  order: "/app/orders",
  payments: "/app/payments",
  payment: "/app/payments",
  delivery: "/app/deliveries",
  deliveries: "/app/deliveries",
  products: "/app/products",
  stock: "/app/products",
};

export const BUSINESS_DEEP_LINKS: Readonly<Record<string, AppNavRoute>> = {
  products: "/app/products",
  catalogue: "/app/products",
  catalog: "/app/products",
  stock: "/app/products",
  // No customer *list* screen exists yet; a link into it lands on the hub
  // that will hold it rather than on a route that does not resolve.
  customers: "/app/business",
  team: "/app/team",
  staff: "/app/team",
  analytics: "/app/business",
  integrations: "/app/business",
  settings: "/app/settings",
  locations: "/app/business",
};

/**
 * Resolve a hub splat to a real route.
 *
 * Anything unrecognised resolves to the hub root rather than to a 404: a link
 * into a hub is a link into that mode, and landing on the hub is always a
 * truthful answer to it.
 */
export function resolveHubDeepLink(
  hub: "sales" | "business",
  splat: string | undefined,
): AppNavRoute {
  const table = hub === "sales" ? SALES_DEEP_LINKS : BUSINESS_DEEP_LINKS;
  const key = (splat ?? "").split("/")[0]?.trim().toLowerCase() ?? "";
  return table[key] ?? (hub === "sales" ? "/app/sales" : "/app/business");
}
