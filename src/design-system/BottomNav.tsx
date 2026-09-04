import { Link } from "@tanstack/react-router";
import { Home, Inbox, MoreHorizontal, ShoppingBag, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ResolveSheet } from "./ResolveSheet";
import type { Workspace } from "@/types";

/**
 * Tab bar shape is data-driven so future business types (mart, services) can
 * ship a different preset without rewriting the shell.
 */
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
}

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
}: BottomNavProps) {
  const { t } = useTranslation();
  const [resolveOpen, setResolveOpen] = useState(false);
  const showResolve = workspace === "business";

  return (
    <>
      <nav
        aria-label={t("nav.primary")}
        className={cn(
          "glass-bar fixed inset-x-0 bottom-0 z-40 border-t border-[var(--glass-border)] pb-[env(safe-area-inset-bottom)]",
          className,
        )}
      >
        <div className="relative mx-auto flex h-[var(--nav-height)] max-w-[560px] items-stretch px-1">
          {tabs.left.map((tab) => (
            <TabItem key={tab.id} tab={tab} />
          ))}

          {showResolve ? (
            <div className="flex flex-1 items-center justify-center">
              <button
                type="button"
                onClick={() => setResolveOpen(true)}
                aria-label={t("nav.resolve")}
                aria-haspopup="dialog"
                aria-expanded={resolveOpen}
                className="press-tactile glass-panel tap-target -mt-4 flex size-[54px] flex-col items-center justify-center rounded-[20px] text-action-primary active:bg-action-primary-soft"
              >
                <Sparkles className="size-5" aria-hidden />
                <span className="chip-text mt-0.5 leading-none">{t("nav.resolve")}</span>
              </button>
            </div>
          ) : null}

          {tabs.right.map((tab) => (
            <TabItem key={tab.id} tab={tab} />
          ))}
        </div>
      </nav>

      <ResolveSheet open={resolveOpen} onOpenChange={setResolveOpen} />
    </>
  );
}
