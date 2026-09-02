import { Link } from "@tanstack/react-router";
import { Home, Inbox, MoreHorizontal, Plus, ShoppingBag, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/types";

interface BottomNavProps {
  workspace?: Workspace;
  onCreate?: () => void;
  className?: string;
}

const linkClass =
  "tap-target flex flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-caption text-text-secondary transition-colors";

export function BottomNav({ workspace = "business", onCreate, className }: BottomNavProps) {
  const { t } = useTranslation();
  const isBusiness = workspace === "business";

  return (
    <nav
      aria-label={t("nav.home")}
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-border-default bg-surface-primary pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      <div className="relative mx-auto flex max-w-[560px] items-stretch">
        <Link
          to="/app"
          className={linkClass}
          activeOptions={{ exact: true }}
          activeProps={{ className: "text-action-primary" }}
        >
          <Home className="size-5" aria-hidden />
          <span className="chip-text">{t("nav.home")}</span>
        </Link>
        <Link
          to="/app/inbox"
          className={linkClass}
          activeProps={{ className: "text-action-primary" }}
        >
          <Inbox className="size-5" aria-hidden />
          <span className="chip-text">{t("nav.inbox")}</span>
        </Link>

        {isBusiness ? (
          <div className="flex w-16 shrink-0 justify-center">
            <button
              type="button"
              onClick={onCreate}
              aria-label={t("nav.create")}
              className="absolute -top-5 flex size-14 items-center justify-center rounded-full bg-action-primary text-text-on-action shadow-[0_8px_20px_rgba(37,99,217,0.35)] transition-colors hover:bg-action-primary-hover active:bg-action-primary-pressed"
            >
              <Plus className="size-6" aria-hidden />
            </button>
          </div>
        ) : null}

        {isBusiness ? (
          <Link
            to="/app/pos"
            className={linkClass}
            activeProps={{ className: "text-action-primary" }}
          >
            <ShoppingBag className="size-5" aria-hidden />
            <span className="chip-text">{t("nav.pos")}</span>
          </Link>
        ) : (

          <span className={cn(linkClass, "opacity-60")} aria-disabled>
            <Users className="size-5" aria-hidden />
            <span className="chip-text">{t("nav.contacts")}</span>
          </span>
        )}
        <span className={cn(linkClass, "opacity-60")} aria-disabled>
          <MoreHorizontal className="size-5" aria-hidden />
          <span className="chip-text">{t("nav.more")}</span>
        </span>
      </div>
    </nav>
  );
}
