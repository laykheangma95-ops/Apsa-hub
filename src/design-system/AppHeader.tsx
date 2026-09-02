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
  children?: ReactNode;
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
        "tap-target inline-flex items-center rounded-full border border-current/25 px-3 text-label",
        className,
      )}
    >
      {language === "km" ? "ខ្មែរ" : "EN"}
    </button>
  );
}

export function AppHeader({
  title,
  subtitle,
  onBack,
  onShopSwitch,
  notificationCount = 0,
  variant = "plain",
  children,
  className,
}: AppHeaderProps) {
  const { t } = useTranslation();
  const gradient = variant === "gradient";

  return (
    <header
      className={cn(
        "px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-4",
        gradient
          ? "gradient-brand rounded-b-3xl text-text-inverse"
          : "border-b border-border-default bg-surface-primary text-text-primary",
        className,
      )}
    >
      <div className="mx-auto flex max-w-[560px] items-center gap-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("common.back")}
            className="tap-target -ml-2 flex items-center justify-center rounded-full"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </button>
        ) : null}

        <button
          type="button"
          onClick={onShopSwitch}
          className="tap-target flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="text-h3 block truncate">{title}</span>
            {subtitle ? (
              <span className={cn("text-caption block", gradient ? "opacity-85" : "text-text-secondary")}>
                {subtitle}
              </span>
            ) : null}
          </span>
          {onShopSwitch ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : null}
        </button>

        <LanguageToggle />

        <button
          type="button"
          aria-label={t("common.notifications")}
          className="tap-target relative flex items-center justify-center rounded-full"
        >
          <Bell className="size-5" aria-hidden />
          {notificationCount > 0 ? (
            <span className="text-caption absolute top-1 right-0 flex size-4 items-center justify-center rounded-full bg-status-danger text-text-inverse">
              {notificationCount}
            </span>
          ) : null}
        </button>
      </div>
      {children ? <div className="mx-auto mt-4 max-w-[560px]">{children}</div> : null}
    </header>
  );
}
