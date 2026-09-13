import { useEffect, useState } from "react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { haptic } from "@/lib/haptics";
import { notifyInfo } from "@/lib/feedback";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useLongPress } from "@/hooks/use-long-press";
import { useNavSignals } from "@/hooks/use-nav-signals";
import { recallTabPath, rememberTabPath } from "@/lib/tab-memory";
import {
  APP_NAV_TABS,
  resolveAppNavActiveTab,
  type AppNavRoute,
  type AppNavTabConfig,
  type AppNavTabId,
} from "./app-nav-config";
import { ApsiMark } from "./mascot/ApsiMark";
import { ApsiSheet } from "./ApsiSheet";
import { CountBadge, DotBadge } from "./Badge";

/** Where a tab goes when it is tapped while already open (pop to root). */
const TAB_ROOT: Record<Exclude<AppNavTabId, "apsi">, AppNavRoute> = {
  home: "/app",
  inbox: "/app/inbox",
  sales: "/app/sales",
  business: "/app/business",
};

interface AppNavBarProps {
  className?: string;
}

/**
 * APSA's primary navigation: five fixed slots with Apsi raised in the middle.
 *
 * Three commitments hold this together.
 *
 * The bar is identical for everyone. A cashier and the owner see the same five
 * slots in the same order, so "it's the third one along" is true on both their
 * phones. Role changes what is *inside* Sales and Business, never the bar.
 *
 * Leaving a tab does not throw it away. Each tab remembers the path the
 * merchant was on and returns there; tapping the tab you are already on pops
 * back to its root, the way every phone OS has behaved for a decade.
 *
 * Two badges, ever. A count on Inbox for conversations nobody has answered, a
 * dot on Home when there is something to look at. Hubs never carry one.
 */
export function AppNavBar({ className }: AppNavBarProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  /* Path plus query string: a deep-linkable filter lives in the URL, and a tab
     that forgets it is a tab that forgets the filter. */
  const href = useRouterState({ select: (state) => state.location.href });
  const capabilities = useCapabilities();
  const signals = useNavSignals();
  const [apsiOpen, setApsiOpen] = useState(false);

  const activeTab = resolveAppNavActiveTab(pathname);

  /*
   * Record where the merchant is, so the tab can bring them back. Recorded on
   * every path inside the tab, detail screens included — coming back to Inbox
   * and landing on the thread you were reading is the entire point.
   */
  useEffect(() => {
    if (activeTab && activeTab !== "apsi") rememberTabPath(activeTab, href);
  }, [activeTab, href]);

  /*
   * The Sales hold-shortcut is derived from what the member can do, never from
   * a role name: somebody who can ring up a sale gets the counter, somebody
   * who cannot gets the order queue. Both are real destinations for whoever
   * sees them, so the gesture never dead-ends.
   */
  const salesShortcut: AppNavRoute = capabilities.can("orders.create") ? "/app/pos" : "/app/orders";

  function goToPath(path: string) {
    void router.navigate({ to: path });
  }

  function openTab(tab: AppNavTabConfig) {
    if (tab.kind === "apsi") {
      haptic("light");
      setApsiOpen(true);
      return;
    }
    const id = tab.id as Exclude<AppNavTabId, "apsi">;
    haptic("light");

    // Already here: pop to the tab's root rather than doing nothing, so a
    // merchant three screens deep always has one tap back to the top.
    if (activeTab === id) {
      void navigate({ to: TAB_ROOT[id] });
      return;
    }

    const remembered = recallTabPath(id);
    if (remembered && remembered !== href) {
      goToPath(remembered);
      return;
    }
    void navigate({ to: TAB_ROOT[id] });
  }

  function longPressAction(tab: AppNavTabConfig): (() => void) | undefined {
    if (!tab.longPress) return undefined;

    if (tab.longPress === "inbox-unread") {
      return () => {
        haptic("medium");
        /*
         * Expressed as a URL, not as hidden state: Inbox reads its status
         * filter from the query string, so this works whether Inbox is already
         * open or not, and the merchant can see — and share — what they are
         * looking at.
         */
        notifyInfo(t("appNav.shortcuts.inboxUnread"));
        void navigate({ to: "/app/inbox", search: { status: "unread" } });
      };
    }

    if (tab.longPress === "sales-primary") {
      return () => {
        haptic("medium");
        goToPath(salesShortcut);
      };
    }

    return () => {
      haptic("medium");
      signals.refreshHomeAttention();
      notifyInfo(t("appNav.shortcuts.homeRefreshed"));
    };
  }

  return (
    <>
      <nav
        aria-label={t("appNav.primary")}
        className={cn(
          /*
           * Flush to the bottom edge with a hairline, not floating: the raised
           * Apsi control is the one thing that breaks the line, and it only
           * reads as raised if everything beside it is flat.
           */
          "fixed inset-x-0 bottom-0 z-50 border-t border-border-default bg-surface-primary",
          className,
        )}
      >
        <div className="mx-auto max-w-[var(--screen-max)] pb-[env(safe-area-inset-bottom)]">
          <ul className="grid grid-cols-5 items-stretch">
            {APP_NAV_TABS.map((tab) => (
              <li key={tab.id} className="min-w-0">
                <NavSlot
                  tab={tab}
                  active={tab.kind === "apsi" ? apsiOpen : activeTab === tab.id}
                  count={tab.badge === "count" ? signals.unansweredConversations : 0}
                  dot={tab.badge === "dot" && signals.homeNeedsAttention}
                  onPress={() => openTab(tab)}
                  onLongPress={longPressAction(tab)}
                />
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <ApsiSheet open={apsiOpen} onOpenChange={setApsiOpen} />
    </>
  );
}

interface NavSlotProps {
  tab: AppNavTabConfig;
  active: boolean;
  count: number;
  dot: boolean;
  onPress: () => void;
  onLongPress: (() => void) | undefined;
}

function NavSlot({ tab, active, count, dot, onPress, onLongPress }: NavSlotProps) {
  const { t } = useTranslation();
  const handlers = useLongPress(onLongPress, onPress);
  const label = t(tab.labelKey);
  const isApsi = tab.kind === "apsi";

  const accessibleLabel =
    count > 0
      ? t("appNav.tabWithCount", { tab: label, count })
      : dot
        ? t("appNav.tabWithAttention", { tab: label })
        : label;

  return (
    <button
      type="button"
      {...handlers}
      aria-label={accessibleLabel}
      aria-current={active && !isApsi ? "page" : undefined}
      {...(isApsi ? { "aria-haspopup": "dialog" as const, "aria-expanded": active } : {})}
      className={cn(
        /*
         * min-h, not h. Khmer wraps rather than truncating (CLAUDE.md), so
         * "អាជីវកម្ម" is allowed to take a second line and push the bar a few
         * pixels taller instead of being clipped mid-cluster. Every screen's
         * clearance comes from --nav-clearance, which already allows for it.
         */
        "press-tactile relative flex w-full min-h-[var(--nav-bar-height)] flex-col items-center justify-center gap-0.5 px-0.5 pt-1.5 pb-1 text-center select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--border-focus)]",
        active ? "text-action-primary" : "text-text-secondary",
      )}
    >
      {isApsi ? (
        /*
         * A placeholder the exact size of the other tabs' icons, with the real
         * control positioned over it. Two things fall out of that: the "Apsi"
         * label sits on the same line as every other label because its slot's
         * flow content is identical, and the circle's raise is measured from
         * the bar's own top edge rather than emerging from whatever the
         * centring maths happened to leave over.
         */
        <span className="flex size-[22px] items-center justify-center">
          <ApsiControl active={active} />
        </span>
      ) : (
        <span className="relative flex items-center justify-center">
          <tab.icon
            className="size-[22px]"
            strokeWidth={active ? 2.2 : 1.8}
            /* "Filled when active" without a second icon set: the same glyph,
               flooded at low opacity so weight changes but the shape does not. */
            {...(active ? { fill: "currentColor", fillOpacity: 0.16 } : {})}
            aria-hidden
          />
          {count > 0 ? (
            <CountBadge
              count={count}
              tone="danger"
              className="absolute -top-1 -right-2"
              ringClassName="ring-2 ring-surface-primary"
            />
          ) : null}
          {dot && count === 0 ? (
            <DotBadge
              tone="danger"
              className="absolute -top-0.5 -right-1"
              ringClassName="ring-2 ring-surface-primary"
            />
          ) : null}
        </span>
      )}

      <span
        className={cn(
          "chip-text block max-w-full text-[11px] leading-[13px]",
          active ? "font-semibold" : "font-medium",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * The raised centre control.
 *
 * It sits 16px proud of the bar with a 3px ring in the bar's own surface
 * colour, so the bar appears to part around it rather than the button sitting
 * on top of it. The ring is what sells the effect — without it the circle
 * looks pasted on.
 */
function ApsiControl({ active }: { active: boolean }) {
  return (
    <span
      style={{
        // Measured from the top of the tab button, which is the top of the
        // bar: the circle stands --apsi-button-raise proud of the hairline.
        top: "calc(-1 * var(--apsi-button-raise))",
      }}
      className={cn(
        "gradient-apsi elevation-action absolute left-1/2 flex size-[var(--apsi-button-size)] -translate-x-1/2 items-center justify-center rounded-full text-text-on-action ring-[3px] ring-surface-primary transition-[filter] duration-[var(--dur-fast)]",
        active ? "brightness-95" : undefined,
      )}
    >
      <ApsiMark size={26} expression={active ? "listening" : "idle"} />
    </span>
  );
}
