import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Boxes,
  CircleUserRound,
  CreditCard,
  Home,
  Inbox,
  MapPin,
  Menu,
  Package,
  Plug,
  RotateCcw,
  ScanLine,
  Search,
  Settings,
  ShoppingBag,
  Truck,
  Users,
} from "lucide-react";

export type BusinessNavVariant = "online-seller" | "mart";
export type MobileNavTabId = "home" | "inbox" | "resolve" | "sales" | "more" | "stock";
export type MobileNavActionAvailability = "live" | "assistive" | "coming-soon";

export interface MobileNavTabConfig {
  id: MobileNavTabId;
  labelKey: string;
  icon: LucideIcon;
  kind: "route" | "sheet";
  to?: "/app" | "/app/inbox";
}

export interface MobileNavActionConfig {
  id: string;
  labelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  availability: MobileNavActionAvailability;
  to?: "/app" | "/app/inbox" | "/app/pos" | "/app/team";
}

export interface MobileNavSheetGroup {
  id: string;
  titleKey: string;
  actions: readonly MobileNavActionConfig[];
}

export interface BusinessNavVariantConfig {
  tabs: readonly MobileNavTabConfig[];
  resolveGroups: readonly MobileNavSheetGroup[];
  salesGroups: readonly MobileNavSheetGroup[];
  moreGroups: readonly MobileNavSheetGroup[];
}

const ONLINE_SELLER_CONFIG: BusinessNavVariantConfig = {
  tabs: [
    { id: "home", labelKey: "nav.home", icon: Home, kind: "route", to: "/app" },
    { id: "inbox", labelKey: "nav.inbox", icon: Inbox, kind: "route", to: "/app/inbox" },
    { id: "resolve", labelKey: "nav.resolve", icon: Search, kind: "sheet" },
    { id: "sales", labelKey: "nav.sales", icon: ShoppingBag, kind: "sheet" },
    { id: "more", labelKey: "nav.more", icon: Menu, kind: "sheet" },
  ],
  resolveGroups: [
    {
      id: "resolve-tools",
      titleKey: "nav.resolveGroups.quickTools",
      actions: [
        {
          id: "scan-barcode",
          labelKey: "nav.resolveActions.scanBarcode.label",
          descriptionKey: "nav.resolveActions.scanBarcode.description",
          icon: ScanLine,
          availability: "coming-soon",
        },
        {
          id: "find-customer",
          labelKey: "nav.resolveActions.findCustomer.label",
          descriptionKey: "nav.resolveActions.findCustomer.description",
          icon: Users,
          availability: "assistive",
          to: "/app/inbox",
        },
        {
          id: "find-order",
          labelKey: "nav.resolveActions.findOrder.label",
          descriptionKey: "nav.resolveActions.findOrder.description",
          icon: Package,
          availability: "coming-soon",
        },
        {
          id: "check-payment",
          labelKey: "nav.resolveActions.checkPayment.label",
          descriptionKey: "nav.resolveActions.checkPayment.description",
          icon: CreditCard,
          availability: "coming-soon",
        },
        {
          id: "track-delivery",
          labelKey: "nav.resolveActions.trackDelivery.label",
          descriptionKey: "nav.resolveActions.trackDelivery.description",
          icon: Truck,
          availability: "coming-soon",
        },
      ],
    },
  ],
  salesGroups: [
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
        },
        {
          id: "new-order",
          labelKey: "nav.salesActions.newOrder.label",
          descriptionKey: "nav.salesActions.newOrder.description",
          icon: Package,
          availability: "assistive",
          to: "/app/inbox",
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
          availability: "coming-soon",
        },
        {
          id: "payments",
          labelKey: "nav.salesActions.payments.label",
          descriptionKey: "nav.salesActions.payments.description",
          icon: CreditCard,
          availability: "coming-soon",
        },
        {
          id: "delivery",
          labelKey: "nav.salesActions.delivery.label",
          descriptionKey: "nav.salesActions.delivery.description",
          icon: Truck,
          availability: "coming-soon",
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
  ],
  moreGroups: [
    {
      id: "more-business",
      titleKey: "nav.moreGroups.business",
      actions: [
        {
          id: "products-stock",
          labelKey: "nav.moreActions.productsStock.label",
          descriptionKey: "nav.moreActions.productsStock.description",
          icon: Boxes,
          availability: "coming-soon",
        },
        {
          id: "customers",
          labelKey: "nav.moreActions.customers.label",
          descriptionKey: "nav.moreActions.customers.description",
          icon: Users,
          availability: "coming-soon",
        },
        {
          id: "analytics",
          labelKey: "nav.moreActions.analytics.label",
          descriptionKey: "nav.moreActions.analytics.description",
          icon: BarChart3,
          availability: "coming-soon",
        },
        {
          id: "staff-team",
          labelKey: "nav.moreActions.staffTeam.label",
          descriptionKey: "nav.moreActions.staffTeam.description",
          icon: Users,
          availability: "live",
          to: "/app/team",
        },
      ],
    },
    {
      id: "more-admin",
      titleKey: "nav.moreGroups.admin",
      actions: [
        {
          id: "promotions-crm",
          labelKey: "nav.moreActions.promotionsCrm.label",
          descriptionKey: "nav.moreActions.promotionsCrm.description",
          icon: Search,
          availability: "coming-soon",
        },
        {
          id: "locations",
          labelKey: "nav.moreActions.locations.label",
          descriptionKey: "nav.moreActions.locations.description",
          icon: MapPin,
          availability: "coming-soon",
        },
        {
          id: "integrations",
          labelKey: "nav.moreActions.integrations.label",
          descriptionKey: "nav.moreActions.integrations.description",
          icon: Plug,
          availability: "coming-soon",
        },
        {
          id: "settings",
          labelKey: "nav.moreActions.settings.label",
          descriptionKey: "nav.moreActions.settings.description",
          icon: Settings,
          availability: "coming-soon",
        },
        {
          id: "profile-account",
          labelKey: "nav.moreActions.profileAccount.label",
          descriptionKey: "nav.moreActions.profileAccount.description",
          icon: CircleUserRound,
          availability: "coming-soon",
        },
      ],
    },
  ],
};

const MART_CONFIG: BusinessNavVariantConfig = {
  tabs: [
    { id: "home", labelKey: "nav.home", icon: Home, kind: "route", to: "/app" },
    { id: "sales", labelKey: "nav.sales", icon: ShoppingBag, kind: "sheet" },
    { id: "resolve", labelKey: "nav.resolve", icon: Search, kind: "sheet" },
    { id: "stock", labelKey: "nav.stock", icon: Boxes, kind: "sheet" },
    { id: "more", labelKey: "nav.more", icon: Menu, kind: "sheet" },
  ],
  resolveGroups: ONLINE_SELLER_CONFIG.resolveGroups,
  salesGroups: ONLINE_SELLER_CONFIG.salesGroups,
  moreGroups: ONLINE_SELLER_CONFIG.moreGroups,
};

const VARIANT_CONFIGS: Record<BusinessNavVariant, BusinessNavVariantConfig> = {
  "online-seller": ONLINE_SELLER_CONFIG,
  mart: MART_CONFIG,
};

export function getBusinessNavConfig(variant: BusinessNavVariant = "online-seller") {
  return VARIANT_CONFIGS[variant];
}

export function resolveMobileNavActiveTab(
  pathname: string,
  variant: BusinessNavVariant = "online-seller",
): MobileNavTabId | undefined {
  if (variant === "mart") {
    if (pathname === "/app") return "home";
    if (
      pathname.startsWith("/app/pos") ||
      pathname.startsWith("/app/orders") ||
      pathname.startsWith("/app/deliveries")
    ) {
      return "sales";
    }
    if (pathname.startsWith("/app/team") || pathname.startsWith("/app/customers")) {
      return "more";
    }
    return undefined;
  }

  if (pathname === "/app") return "home";
  if (pathname.startsWith("/app/inbox")) return "inbox";
  if (
    pathname.startsWith("/app/pos") ||
    pathname.startsWith("/app/orders") ||
    pathname.startsWith("/app/deliveries")
  ) {
    return "sales";
  }
  if (pathname.startsWith("/app/team") || pathname.startsWith("/app/customers")) return "more";
  return undefined;
}
