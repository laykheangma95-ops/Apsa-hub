import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Home, Inbox, ShoppingBag, Sparkles, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { ApsiConsoleSheet } from "@/components/apsi/ApsiConsoleSheet";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useAppPrincipal } from "@/hooks/use-app-principal";
import { listRealOrders } from "@/lib/api";
import { ordersKeys } from "@/lib/orders-query";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Order, Workspace } from "@/types";
import { BottomSheet } from "./BottomSheet";
import {
  filterBusinessNavConfig,
  getBusinessNavConfig,
  isNavEntryAvailable,
  resolveMobileNavActiveTab,
  type BusinessNavVariant,
  type MobileNavRequirement,
  type MobileNavActionAvailability,
  type MobileNavActionConfig,
  type MobileNavRoute,
  type MobileNavSheetGroup,
  type MobileNavTabConfig,
  type MobileNavTabId,
} from "./mobile-nav-config";

export type NavTab = MobileNavRequirement & {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  to: "/app" | "/app/inbox" | "/app/pos" | "/app/settings";
  exact?: boolean;
};

/**
 * The wide-viewport tab row. Same five-control model as the phone bar: Home,
 * Inbox, the Apsi console in the centre, Sales, My.
 */
export const SELLER_TABS: { left: NavTab[]; right: NavTab[] } = {
  left: [
    { id: "home", labelKey: "nav.home", icon: Home, to: "/app", exact: true },
    {
      id: "inbox",
      labelKey: "nav.inbox",
      icon: Inbox,
      to: "/app/inbox",
      requiresAll: ["messages.read"],
    },
  ],
  right: [
    {
      id: "sales",
      labelKey: "nav.sales",
      icon: ShoppingBag,
      to: "/app/pos",
      requiresAll: ["orders.create"],
    },
    // The identity anchor. No permission gate: every active member has an
    // account, a language preference and a way to sign out.
    { id: "my", labelKey: "nav.my", icon: UserRound, to: "/app/settings" },
  ],
};

/**
 * Badges are a claim that a person is waiting. Only Inbox may make it.
 *
 * Apsi is a pull tool — a merchant goes to it, it never summons them — and a
 * red dot there would spend the one signal that means "a customer has not been
 * answered". Sales and Home are excluded for the same reason: "things are
 * happening" is not "someone is waiting", and a nav full of red teaches the
 * merchant to ignore all of it.
 */
export type BadgeableTabId = Extract<MobileNavTabId, "inbox">;

interface BottomNavProps {
  workspace?: Workspace;
  /** Kept for callers that own a create flow; the centre control is Apsi. */
  onCreate?: () => void;
  tabs?: { left: NavTab[]; right: NavTab[] };
  className?: string;
  businessType?: BusinessNavVariant;
  /**
   * Unhandled work, per tab. Typed to the one tab allowed to carry a badge, so
   * restoring a badge on Apsi or Sales is a compile error rather than a
   * judgement call in review.
   */
  badges?: Partial<Record<BadgeableTabId, number>>;
}

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
  const capabilities = useCapabilities();
  /*
   * The nav shows destinations, so it shows only the destinations this member
   * actually has server-supported access to. An unresolved snapshot hides the
   * gated entries rather than guessing — the routes behind them stay guarded
   * on the server either way.
   */
  const config = useMemo(
    () => filterBusinessNavConfig(getBusinessNavConfig(businessType), capabilities),
    [businessType, capabilities],
  );
  const visibleTabs = useMemo(
    () => ({
      left: tabs.left.filter((tab) => isNavEntryAvailable(tab, capabilities)),
      right: tabs.right.filter((tab) => isNavEntryAvailable(tab, capabilities)),
    }),
    [tabs, capabilities],
  );
  const activeTab = resolveMobileNavActiveTab(pathname, businessType);
  const isBusiness = workspace === "business";

  const [askOpen, setAskOpen] = useState(false);
  const [salesOpen, setSalesOpen] = useState(false);

  function closeAllSheets() {
    setAskOpen(false);
    setSalesOpen(false);
  }

  function goTo(to: MobileNavRoute) {
    closeAllSheets();
    void navigate({ to });
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
          {visibleTabs.left.map((tab) => (
            <TabItem key={tab.id} tab={tab} />
          ))}
          <div className="flex flex-1 items-center justify-center">
            <button
              type="button"
              onClick={() => setAskOpen(true)}
              aria-label={t("nav.openAsk")}
              aria-haspopup="dialog"
              aria-expanded={askOpen}
              title={t("nav.openAsk")}
              className="press-tactile glass-panel tap-target -mt-5 flex size-[52px] items-center justify-center rounded-[18px] text-action-primary active:bg-action-primary-soft"
            >
              <Sparkles className="size-6" aria-hidden />
            </button>
          </div>
          {visibleTabs.right.map((tab) => (
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
            <div
              className="grid items-stretch gap-0.5"
              style={{
                gridTemplateColumns: `repeat(${Math.max(config.tabs.length, 1)}, minmax(0, 1fr))`,
              }}
            >
              {config.tabs.map((tab) => (
                <MobileTab
                  key={tab.id}
                  tab={tab}
                  activeTab={activeTab}
                  badge={tab.id === "inbox" ? badges.inbox : undefined}
                  askOpen={askOpen}
                  salesOpen={salesOpen}
                  onRoute={goTo}
                  onOpenAsk={() => {
                    setSalesOpen(false);
                    setAskOpen(true);
                  }}
                  onOpenSales={() => {
                    setAskOpen(false);
                    setSalesOpen(true);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </nav>

      {/*
       * One console for both breakpoints. Opening it never navigates: it is a
       * sheet over the current route, so an Inbox conversation is still there
       * when it closes.
       */}
      <ApsiConsoleSheet
        open={askOpen}
        onOpenChange={setAskOpen}
        groups={config.askGroups}
        onRoute={goTo}
      />

      <BottomSheet
        open={salesOpen}
        onOpenChange={setSalesOpen}
        title={t("nav.salesSheetTitle")}
        description={t("nav.salesSheetLead")}
        snap="full"
      >
        <SheetGroupList groups={config.salesGroups} onRoute={goTo} />
        <RecentOrders open={salesOpen} onClose={closeAllSheets} />
      </BottomSheet>
    </>
  );
}

interface MobileTabProps {
  tab: MobileNavTabConfig;
  activeTab: MobileNavTabId | undefined;
  badge?: number | undefined;
  askOpen: boolean;
  salesOpen: boolean;
  onRoute: (to: MobileNavRoute) => void;
  onOpenAsk: () => void;
  onOpenSales: () => void;
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
  askOpen,
  salesOpen,
  onRoute,
  onOpenAsk,
  onOpenSales,
}: MobileTabProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const isAsk = tab.kind === "console";
  /*
   * Apsi is lit only while its console is open. It is not a place, so no route
   * ever puts it in the "you are here" state.
   */
  const active = isAsk
    ? askOpen
    : tab.id === "sales"
      ? salesOpen || activeTab === "sales"
      : activeTab === tab.id;

  const content = (
    <>
      <span
        className={cn(
          "relative flex items-center justify-center rounded-2xl transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          isAsk ? "size-10" : "size-9",
          isAsk
            ? active
              ? "elevation-action bg-action-primary text-text-on-action"
              : "bg-action-primary-soft text-action-primary"
            : undefined,
        )}
      >
        {/* The active pill is one shared element that slides between tabs, so
            switching reads as movement rather than two separate blinks. */}
        {active && !isAsk ? (
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
          className={cn("relative", isAsk ? "size-[21px]" : "size-[20px]")}
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
      onClick={isAsk ? onOpenAsk : onOpenSales}
      className={buttonClass}
      aria-haspopup="dialog"
      aria-expanded={isAsk ? askOpen : salesOpen}
      aria-label={isAsk ? t("nav.openAsk") : t("nav.openSales")}
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
  onRoute: (to: MobileNavRoute) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="list-enter space-y-5">
      {groups.map((group) => (
        <section key={group.id}>
          <h3 className={sheetSectionTitleClass}>{t(group.titleKey)}</h3>
          <div className="list-enter space-y-2">
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
  onRoute: (to: MobileNavRoute) => void;
}) {
  const { t } = useTranslation();
  const disabled = action.availability === "coming-soon";

  return (
    <button
      type="button"
      className={cn(
        "press flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
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
        <span className="flex flex-wrap items-center gap-2">
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

/**
 * Recent orders in the Sales sheet — the production Order list, nothing else.
 *
 * This block used to key on `["mobile-nav","recent-orders"]` and call the
 * fixture `getOrders()` from src/lib/mock/orders.ts, so a live merchant saw
 * invented order codes and invented money in a production build, and the
 * entries were readable by whoever signed in next in the same tab. Both are
 * closed here:
 *
 *   - the data comes from `listRealOrders()` (the production Order server
 *     function, `orders.read`-gated and organization-scoped server-side) with
 *     NO fixture fallback in any branch — a failure is an error state;
 *   - the cache key is `ordersKeys.list(userId, organizationId)` from the
 *     merged PR #60 convention, partitioned by the principal the /app route
 *     guard resolved, so it shares one entry with the Orders screen rather
 *     than holding a second, unpartitioned copy of the same rows.
 *
 * Outside /app there is no principal, so nothing is fetched at all.
 */
function RecentOrders({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const capabilities = useCapabilities();
  const principal = useAppPrincipal();
  const canReadOrders = capabilities.can("orders.read");

  const query = useQuery({
    queryKey: principal ? ordersKeys.list(principal.userId, principal.organizationId) : [],
    queryFn: listRealOrders,
    enabled: open && Boolean(principal) && canReadOrders,
  });

  if (!principal || !canReadOrders) return null;

  const recentOrders: Order[] = (query.data ?? []).slice(0, 4);

  return (
    <section className="mt-5 border-t border-border-default pt-4">
      <h3 className="text-h3 text-text-primary">{t("nav.salesRecent")}</h3>
      <p className="text-body-sm mt-1 text-text-secondary">{t("nav.salesRecentBody")}</p>

      {query.isPending ? (
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-[72px] animate-pulse rounded-2xl bg-surface-secondary" />
          ))}
        </div>
      ) : null}

      {query.isError ? (
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="tap-target text-body-sm mt-3 rounded-2xl border border-border-default px-4 py-3 text-left text-action-primary"
        >
          {t("nav.retrySalesHub")}
        </button>
      ) : null}

      {!query.isPending && !query.isError && recentOrders.length === 0 ? (
        <p className="text-body-sm mt-3 rounded-2xl border border-dashed border-border-default px-4 py-4 text-text-secondary">
          {t("nav.salesRecentEmpty")}
        </p>
      ) : null}

      {!query.isPending && !query.isError && recentOrders.length > 0 ? (
        <ul className="list-enter mt-3 space-y-2">
          {recentOrders.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void navigate({ to: "/app/orders/$id", params: { id: order.id } });
                }}
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
