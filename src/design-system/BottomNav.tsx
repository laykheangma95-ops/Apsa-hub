import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Home, Inbox, MoreHorizontal, ShoppingBag, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { getOrders } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Order, Workspace } from "@/types";
import { BottomSheet } from "./BottomSheet";
import { ResolveSheet } from "./ResolveSheet";
import {
  getBusinessNavConfig,
  resolveMobileNavActiveTab,
  type BusinessNavVariant,
  type MobileNavActionAvailability,
  type MobileNavActionConfig,
  type MobileNavSheetGroup,
  type MobileNavTabConfig,
  type MobileNavTabId,
} from "./mobile-nav-config";

export type NavTab = {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  to: "/app" | "/app/inbox" | "/app/pos" | "/app/team";
  exact?: boolean;
};

export const SELLER_TABS: { left: NavTab[]; right: NavTab[] } = {
  left: [
    { id: "home", labelKey: "nav.home", icon: Home, to: "/app", exact: true },
    { id: "inbox", labelKey: "nav.inbox", icon: Inbox, to: "/app/inbox" },
  ],
  right: [
    { id: "sales", labelKey: "nav.sales", icon: ShoppingBag, to: "/app/pos" },
    { id: "more", labelKey: "nav.more", icon: MoreHorizontal, to: "/app/team" },
  ],
};

interface BottomNavProps {
  workspace?: Workspace;
  /** Kept for callers that own a create flow; the centre control is Resolve. */
  onCreate?: () => void;
  tabs?: { left: NavTab[]; right: NavTab[] };
  className?: string;
  businessType?: BusinessNavVariant;
  /**
   * Unhandled work per tab. A badge is a claim on the merchant's attention, so
   * only counts that someone can act on belong here — never a total.
   */
  badges?: Partial<Record<MobileNavTabId, number>>;
}

const sheetActionClass =
  "press flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]";

const sheetSectionTitleClass = "text-label px-1 pb-2 text-text-muted";

const itemClass =
  "press-tactile tap-target group relative flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-text-secondary";

function TabItem({ tab }: { tab: NavTab }) {
  const { t } = useTranslation();
  const Icon = tab.icon;

  return (
    <Link
      to={tab.to}
      className={itemClass}
      {...(tab.exact ? { activeOptions: { exact: true } } : {})}
      activeProps={{ className: "text-action-primary", "data-active": "true" }}
    >
      <span className="relative flex items-center justify-center">
        <span
          aria-hidden
          className="absolute -inset-x-3 -inset-y-1.5 scale-75 rounded-full bg-action-primary-soft opacity-0 transition-[opacity,transform] duration-[var(--dur-base)] ease-[var(--ease-spring)] group-data-[active=true]:scale-100 group-data-[active=true]:opacity-100"
        />
        <Icon className="relative size-[22px]" strokeWidth={2} aria-hidden />
      </span>
      <span className="chip-text relative transition-colors duration-[var(--dur-fast)] group-data-[active=true]:font-semibold">
        {t(tab.labelKey)}
      </span>
    </Link>
  );
}

export function BottomNav({
  workspace = "business",
  tabs = SELLER_TABS,
  className,
  businessType = "online-seller",
  badges = {},
}: BottomNavProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const config = getBusinessNavConfig(businessType);
  const activeTab = resolveMobileNavActiveTab(pathname, businessType);
  const isBusiness = workspace === "business";

  const [resolveOpen, setResolveOpen] = useState(false);
  const [desktopResolveOpen, setDesktopResolveOpen] = useState(false);
  const [salesOpen, setSalesOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const recentOrdersQuery = useQuery({
    queryKey: ["mobile-nav", "recent-orders"],
    queryFn: getOrders,
    enabled: salesOpen && isBusiness,
  });

  function closeAllSheets() {
    setResolveOpen(false);
    setSalesOpen(false);
    setMoreOpen(false);
  }

  function goTo(
    to: "/app" | "/app/inbox" | "/app/pos" | "/app/team" | "/app/orders" | "/app/deliveries",
  ) {
    closeAllSheets();
    void navigate({ to });
  }

  function openOrder(orderId: string) {
    closeAllSheets();
    void navigate({ to: "/app/orders/$id", params: { id: orderId } });
  }

  if (!isBusiness) return null;

  return (
    <>
      <nav
        aria-label={t("nav.primary")}
        className={cn(
          "glass-bar fixed inset-x-0 bottom-0 z-40 hidden border-t border-[var(--glass-border)] pb-[env(safe-area-inset-bottom)] lg:block",
          className,
        )}
      >
        <div className="relative mx-auto flex h-[var(--nav-height)] max-w-[560px] items-stretch px-1">
          {tabs.left.map((tab) => (
            <TabItem key={tab.id} tab={tab} />
          ))}
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              onClick={() => setDesktopResolveOpen(true)}
              aria-label={t("nav.resolve")}
              aria-haspopup="dialog"
              aria-expanded={desktopResolveOpen}
              title={t("nav.resolve")}
              className="press-tactile glass-panel tap-target -mt-5 flex size-[52px] items-center justify-center rounded-[18px] text-action-primary active:bg-action-primary-soft"
            >
              <Sparkles className="size-6" aria-hidden />
            </button>
          </div>
          {tabs.right.map((tab) => (
            <TabItem key={tab.id} tab={tab} />
          ))}
        </div>
      </nav>

      <nav
        aria-label={t("nav.primary")}
        className={cn("fixed inset-x-0 bottom-0 z-50 px-2 pb-2 lg:hidden", className)}
      >
        <div className="mx-auto max-w-[var(--screen-max)] pb-[env(safe-area-inset-bottom)]">
          <div className="glass-bar relative rounded-[26px] px-1.5 pt-1.5 pb-1.5">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-10 top-0 h-px bg-[linear-gradient(90deg,rgba(115,183,255,0),rgba(52,120,246,0.45),rgba(115,183,255,0))]"
            />
            <div className="grid grid-cols-5 items-stretch gap-0.5">
              {config.tabs.map((tab) => (
                <MobileTab
                  key={tab.id}
                  tab={tab}
                  activeTab={activeTab}
                  badge={badges[tab.id]}
                  resolveOpen={resolveOpen}
                  salesOpen={salesOpen}
                  moreOpen={moreOpen}
                  onRoute={goTo}
                  onOpenResolve={() => {
                    setSalesOpen(false);
                    setMoreOpen(false);
                    setResolveOpen(true);
                  }}
                  onOpenSales={() => {
                    setResolveOpen(false);
                    setMoreOpen(false);
                    setSalesOpen(true);
                  }}
                  onOpenMore={() => {
                    setResolveOpen(false);
                    setSalesOpen(false);
                    setMoreOpen(true);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </nav>

      <BottomSheet
        open={resolveOpen}
        onOpenChange={setResolveOpen}
        title={t("nav.resolveSheetTitle")}
        description={t("nav.resolveSheetLead")}
        snap="half"
      >
        <SheetGroupList groups={config.resolveGroups} onRoute={goTo} />
      </BottomSheet>

      <ResolveSheet open={desktopResolveOpen} onOpenChange={setDesktopResolveOpen} />

      <BottomSheet
        open={salesOpen}
        onOpenChange={setSalesOpen}
        title={t("nav.salesSheetTitle")}
        description={t("nav.salesSheetLead")}
        snap="full"
      >
        <SheetGroupList groups={config.salesGroups} onRoute={goTo} />
        <RecentOrders
          title={t("nav.salesRecent")}
          body={t("nav.salesRecentBody")}
          orders={recentOrdersQuery.data}
          loading={recentOrdersQuery.isPending}
          error={recentOrdersQuery.isError}
          onRetry={() => void recentOrdersQuery.refetch()}
          onOpen={openOrder}
        />
      </BottomSheet>

      <BottomSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title={t("nav.moreSheetTitle")}
        description={t("nav.moreSheetLead")}
        snap="full"
      >
        <SheetGroupList groups={config.moreGroups} onRoute={goTo} />
      </BottomSheet>
    </>
  );
}

interface MobileTabProps {
  tab: MobileNavTabConfig;
  activeTab: MobileNavTabId | undefined;
  badge?: number | undefined;
  resolveOpen: boolean;
  salesOpen: boolean;
  moreOpen: boolean;
  onRoute: (
    to: "/app" | "/app/inbox" | "/app/pos" | "/app/team" | "/app/orders" | "/app/deliveries",
  ) => void;
  onOpenResolve: () => void;
  onOpenSales: () => void;
  onOpenMore: () => void;
}

/**
 * One tab. Three jobs, in order: say where you are, say what needs attention,
 * take the tap. Everything else — hover states, decorative glow — is noise on
 * a surface this small.
 */
function MobileTab({
  tab,
  activeTab,
  badge,
  resolveOpen,
  salesOpen,
  moreOpen,
  onRoute,
  onOpenResolve,
  onOpenSales,
  onOpenMore,
}: MobileTabProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const active =
    tab.id === "resolve"
      ? resolveOpen
      : tab.id === "sales"
        ? salesOpen || activeTab === "sales"
        : tab.id === "more"
          ? moreOpen || activeTab === "more"
          : activeTab === tab.id;
  const isResolve = tab.id === "resolve";

  const content = (
    <>
      <span
        className={cn(
          "relative flex items-center justify-center rounded-2xl transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          isResolve ? "size-10" : "size-9",
          isResolve
            ? active
              ? "elevation-action bg-action-primary text-text-on-action"
              : "bg-action-primary-soft text-action-primary"
            : undefined,
        )}
      >
        {/* The active pill is one shared element that slides between tabs, so
            switching reads as movement rather than two separate blinks. */}
        {active && !isResolve ? (
          <motion.span
            aria-hidden
            layoutId="apsa-nav-active"
            className="absolute inset-0 rounded-2xl bg-action-primary-soft"
            transition={
              reduceMotion
                ? { duration: 0 }
                : { type: "spring", stiffness: 520, damping: 40, mass: 0.6 }
            }
          />
        ) : null}
        <tab.icon
          className={cn("relative", isResolve ? "size-[21px]" : "size-[20px]")}
          strokeWidth={active ? 2.2 : 1.9}
          aria-hidden
        />
        {badge && badge > 0 ? (
          <span
            aria-hidden
            className="text-caption tnum absolute -top-0.5 -right-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-status-danger px-1 leading-none text-text-inverse ring-2 ring-[color:var(--surface-glass)]"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "chip-text block max-w-full px-0.5 text-[11px] leading-[13px]",
          active ? "font-semibold" : "font-medium",
        )}
      >
        {t(tab.labelKey)}
      </span>
    </>
  );

  const buttonClass = cn(
    "press-tactile tap-target flex min-h-[56px] min-w-0 flex-col items-center justify-center gap-1 rounded-[20px] px-0.5 pt-1.5 pb-1 text-center",
    active ? "text-action-primary" : "text-text-secondary",
  );

  if (tab.kind === "route" && tab.to) {
    return (
      <button
        type="button"
        onClick={() => onRoute(tab.to!)}
        className={buttonClass}
        aria-current={active ? "page" : undefined}
        aria-label={
          badge && badge > 0
            ? t("nav.tabWithCount", { tab: t(tab.labelKey), count: badge })
            : undefined
        }
      >
        {content}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={tab.id === "resolve" ? onOpenResolve : tab.id === "sales" ? onOpenSales : onOpenMore}
      className={buttonClass}
      aria-haspopup="dialog"
      aria-expanded={tab.id === "resolve" ? resolveOpen : tab.id === "sales" ? salesOpen : moreOpen}
      aria-label={
        tab.id === "resolve"
          ? t("nav.openResolve")
          : tab.id === "sales"
            ? t("nav.openSales")
            : t("nav.openMore")
      }
    >
      {content}
    </button>
  );
}

function SheetGroupList({
  groups,
  onRoute,
}: {
  groups: readonly MobileNavSheetGroup[];
  onRoute: (
    to: "/app" | "/app/inbox" | "/app/pos" | "/app/team" | "/app/orders" | "/app/deliveries",
  ) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.id}>
          <h3 className={sheetSectionTitleClass}>{t(group.titleKey)}</h3>
          <div className="space-y-2">
            {group.actions.map((action) => (
              <SheetAction key={action.id} action={action} onRoute={onRoute} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SheetAction({
  action,
  onRoute,
}: {
  action: MobileNavActionConfig;
  onRoute: (
    to: "/app" | "/app/inbox" | "/app/pos" | "/app/team" | "/app/orders" | "/app/deliveries",
  ) => void;
}) {
  const { t } = useTranslation();
  const disabled = action.availability === "coming-soon";

  return (
    <button
      type="button"
      className={cn(
        sheetActionClass,
        disabled
          ? "cursor-not-allowed border-border-default bg-surface-secondary/75 text-text-muted"
          : "border-border-default bg-surface-primary text-text-primary hover:bg-surface-secondary/72 active:bg-surface-secondary",
      )}
      onClick={action.to ? () => onRoute(action.to!) : undefined}
      disabled={disabled}
      aria-disabled={disabled}
    >
      <span
        className={cn(
          "mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl",
          disabled
            ? "bg-surface-primary text-text-muted"
            : action.availability === "assistive"
              ? "bg-action-primary-soft text-action-primary"
              : "bg-[linear-gradient(180deg,rgba(52,120,246,0.14),rgba(52,120,246,0.05))] text-brand-primary",
        )}
      >
        <action.icon className="size-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-body block text-left">{t(action.labelKey)}</span>
          <AvailabilityBadge availability={action.availability} />
        </span>
        <span className="text-body-sm mt-1 block text-left text-text-secondary">
          {t(action.descriptionKey)}
        </span>
      </span>
      {!disabled ? (
        <ChevronRight className="mt-1 size-4 shrink-0 text-text-muted" aria-hidden />
      ) : null}
    </button>
  );
}

function AvailabilityBadge({ availability }: { availability: MobileNavActionAvailability }) {
  const { t } = useTranslation();

  if (availability === "live") {
    return (
      <span className="rounded-full bg-status-success-soft px-2 py-0.5 text-[10px] font-medium leading-4 text-status-success-text">
        {t("nav.availableNow")}
      </span>
    );
  }

  if (availability === "assistive") {
    return (
      <span className="rounded-full bg-action-primary-soft px-2 py-0.5 text-[10px] font-medium leading-4 text-action-primary">
        {t("nav.opensExisting")}
      </span>
    );
  }

  return (
    <span className="rounded-full bg-surface-primary px-2 py-0.5 text-[10px] font-medium leading-4 text-text-muted">
      {t("nav.comingSoon")}
    </span>
  );
}

function RecentOrders({
  title,
  body,
  orders,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  title: string;
  body: string;
  orders: Order[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpen: (orderId: string) => void;
}) {
  const { t } = useTranslation();
  const recentOrders = (orders ?? []).slice(0, 4);

  return (
    <section className="mt-5 border-t border-border-default pt-4">
      <h3 className="text-h3 text-text-primary">{title}</h3>
      <p className="text-body-sm mt-1 text-text-secondary">{body}</p>

      {loading ? (
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-[72px] animate-pulse rounded-2xl bg-surface-secondary" />
          ))}
        </div>
      ) : null}

      {error ? (
        <button
          type="button"
          onClick={onRetry}
          className="tap-target text-body-sm mt-3 rounded-2xl border border-border-default px-4 py-3 text-left text-action-primary"
        >
          {t("nav.retrySalesHub")}
        </button>
      ) : null}

      {!loading && !error && recentOrders.length === 0 ? (
        <p className="text-body-sm mt-3 rounded-2xl border border-dashed border-border-default px-4 py-4 text-text-secondary">
          {t("nav.salesRecentEmpty")}
        </p>
      ) : null}

      {!loading && !error && recentOrders.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {recentOrders.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => onOpen(order.id)}
                className="press flex w-full items-center gap-3 rounded-2xl border border-border-default bg-surface-primary px-4 py-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-body tnum text-text-primary">{order.code}</p>
                  <p className="text-body-sm mt-1 text-text-secondary">
                    {t(`status.${order.paymentStatus}`)} · {t(`status.${order.fulfillmentStatus}`)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-financial text-text-primary">{formatMoney(order.total)}</p>
                  <p className="text-caption mt-1 text-text-muted">{t("nav.openOrder")}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
