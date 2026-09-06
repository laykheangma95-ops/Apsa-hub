import { ArrowLeft, Bell, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/i18n";
import type { ReactNode } from "react";

interface AppHeaderProps {
  title: string;
  subtitle?: string | undefined;
  onBack?: () => void;
  onShopSwitch?: () => void;
  notificationCount?: number;
  variant?: "plain" | "gradient";
  /** Trailing control that replaces the default bell (a screen's own action). */
  action?: ReactNode;
  /**
   * Context that belongs to the screen, not to the bar: a greeting, a search
   * field, a filter row. It scrolls away with the content so the pinned chrome
   * stays a single 52px line — on a 568px phone the old always-sticky variant
   * held a quarter of the viewport hostage.
   */
  children?: ReactNode;
  /** Set false to let `children` scroll under a pinned bar (the default). */
  stickyChildren?: boolean;
  className?: string;
}

export function LanguageToggle({ className }: { className?: string }) {
  const { language, toggleLanguage } = useLanguage();
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={toggleLanguage}
      aria-label={t("common.language")}
      className={cn(
        "press-tactile tap-target inline-flex shrink-0 items-center justify-center rounded-full border border-current/20 px-2.5 text-label",
        className,
      )}
    >
      {/* Khmer never sits in a Latin-cased label — each side shows its own script. */}
      {language === "km" ? "ខ្មែរ" : "EN"}
    </button>
  );
}

/**
 * The one pinned line at the top of every screen.
 *
 * It answers "where am I" and "how do I get back" in a fixed 52px band, and
 * nothing else. Anything a merchant scrolls past — greetings, search, filter
 * chips — is passed as `children` and rendered below the pinned band so the
 * list underneath keeps the screen.
 */
export function AppHeader({
  title,
  subtitle,
  onBack,
  onShopSwitch,
  notificationCount = 0,
  variant = "plain",
  action,
  children,
  stickyChildren = false,
  className,
}: AppHeaderProps) {
  const { t } = useTranslation();
  const gradient = variant === "gradient";
  const showBell = action === undefined;

  const bar = (
    <div
      className={cn(
        "pad-safe-top pb-2",
        gradient
          ? "gradient-brand text-text-inverse"
          : "glass-bar border-b border-[var(--glass-border)] text-text-primary",
      )}
    >
      <div className="mx-auto flex max-w-[var(--screen-max)] items-center gap-1 px-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("common.back")}
            className="press-tactile tap-target flex shrink-0 items-center justify-center rounded-full"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </button>
        ) : (
          <span className="w-2 shrink-0" aria-hidden />
        )}

        {onShopSwitch ? (
          <button
            type="button"
            onClick={onShopSwitch}
            aria-haspopup="dialog"
            className="press-tactile tap-target flex min-w-0 flex-1 items-center gap-1 rounded-2xl px-1 text-left"
          >
            <HeaderTitle title={title} subtitle={subtitle} gradient={gradient} />
            <ChevronDown className="size-4 shrink-0 opacity-70" aria-hidden />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center px-1">
            <HeaderTitle title={title} subtitle={subtitle} gradient={gradient} />
          </div>
        )}

        <LanguageToggle />

        {action}

        {showBell ? (
          <button
            type="button"
            aria-label={
              notificationCount > 0
                ? t("common.notificationsWithCount", { count: notificationCount })
                : t("common.notifications")
            }
            className="press-tactile tap-target relative flex shrink-0 items-center justify-center rounded-full"
          >
            <Bell className="size-5" aria-hidden />
            {notificationCount > 0 ? (
              <span
                aria-hidden
                className="text-caption tnum absolute top-1.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-danger px-1 leading-none text-text-inverse ring-2 ring-[var(--surface-glass)]"
              >
                {notificationCount > 9 ? "9+" : notificationCount}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
    </div>
  );

  if (stickyChildren) {
    return (
      <header className={cn("sticky top-0 z-30", className)}>
        {bar}
        {children ? (
          <div
            className={cn(
              gradient
                ? "gradient-brand px-4 pb-4"
                : "glass-bar border-b border-[var(--glass-border)] px-4 pb-3",
            )}
          >
            <div className="mx-auto max-w-[var(--screen-max)]">{children}</div>
          </div>
        ) : null}
      </header>
    );
  }

  // Default: only the bar is pinned. `children` scroll away with the page.
  return (
    <>
      <header className={cn("sticky top-0 z-30", className)}>{bar}</header>
      {children ? (
        <div className={cn(gradient ? "gradient-brand px-4 pb-5" : "px-4 pt-3")}>
          <div className="mx-auto max-w-[var(--screen-max)]">{children}</div>
        </div>
      ) : null}
    </>
  );
}

function HeaderTitle({
  title,
  subtitle,
  gradient,
}: {
  title: string;
  subtitle?: string | undefined;
  gradient: boolean;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="text-h3 block truncate">{title}</span>
      {subtitle ? (
        <span
          className={cn("text-caption block truncate", gradient ? "opacity-85" : "text-text-muted")}
        >
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}
